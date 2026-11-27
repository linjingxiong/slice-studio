"""Loopback Web application and versioned image-processing API."""

import argparse
import base64
import binascii
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import mimetypes
from pathlib import Path
import re
from threading import BoundedSemaphore, Event, Lock
from time import perf_counter
from urllib.parse import parse_qs, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

from engine import MAX_REGIONS, InputError, decode, detect, extract, load_source, png, render
import neural


ROOT = Path(__file__).resolve().parent
SAMPLES = {"1.jpg", "2.jpg", "3.jpg"}
MAX_FILE = 40 * 1024 * 1024
MAX_MESSAGE = 125 * 1024 * 1024
JOB_ID = re.compile(r"[a-f0-9-]{36}")
JOBS = {}
JOBS_LOCK = Lock()
WORKERS = BoundedSemaphore(1)


class Cancelled(Exception):
    pass


def encoded(array):
    return base64.b64encode(png(array)).decode("ascii")


def describe(region, background):
    return {"box": region.box, "mask": encoded(region.alpha), "background": background}


def exported(data, checkpoint):
    if len(data) < 4:
        raise ValueError("导出数据不完整。")
    offset = 4 + int.from_bytes(data[:4], "big")
    if offset < 5 or offset >= len(data) or len(data) - offset > MAX_FILE:
        raise ValueError("导出数据大小无效。")
    config = json.loads(data[4:offset])
    if not isinstance(config, dict) or config.get("format") not in {"png", "zip"}:
        raise ValueError("导出格式无效。")
    items = config.get("assets")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_REGIONS:
        raise ValueError("请选择 1 至 250 个素材。")
    if config["format"] == "png" and len(items) != 1:
        raise ValueError("PNG 导出需要一个素材。")
    source, profile = load_source(data[offset:])
    contents = BytesIO()
    manifest = {"version": 1, "source": str(config.get("source", ""))[:240],
                "width": source.shape[1], "height": source.shape[0], "assets": []}
    used = set()
    with ZipFile(contents, "w", ZIP_DEFLATED) as archive:
        for item in items:
            checkpoint()
            if not isinstance(item, dict):
                raise ValueError("素材数据无效。")
            name = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", str(item.get("name", ""))).strip(" .")[:90]
            name = name or "slice"
            if re.fullmatch(r"(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name, re.I):
                name = "_" + name
            filename = name + ".png"
            suffix = 2
            while filename.casefold() in used:
                filename = f"{name}-{suffix}.png"
                suffix += 1
            used.add(filename.casefold())
            box = item.get("box")
            if not isinstance(box, list) or len(box) != 4 or any(type(n) is not int for n in box):
                raise ValueError("素材坐标无效。")
            x, y, w, h = box
            if min(x, y) < 0 or min(w, h) < 1 or x + w > source.shape[1] or y + h > source.shape[0]:
                raise ValueError("素材范围超出原图。")
            mask = base64.b64decode(item["mask"], validate=True)
            with Image.open(BytesIO(mask), formats=("PNG",)) as image:
                if image.format != "PNG" or image.size != (w, h) or image.mode not in {"L", "RGBA"}:
                    raise ValueError("素材蒙版无效。")
                # Algorithm masks store L; browser-edited masks store coverage in A.
                alpha = np.array(image.getchannel("A") if image.mode == "RGBA" else image)
            background = item.get("background")
            if background is not None and (not isinstance(background, list) or len(background) != 3
                                           or any(type(n) is not int or not 0 <= n <= 255 for n in background)):
                raise ValueError("背景颜色无效。")
            payload = png(render(source, box, alpha, background, item.get("decontaminate") is True), profile)
            if config["format"] == "png":
                return payload, "image/png"
            archive.writestr(filename, payload)
            manifest["assets"].append({"file": filename, "name": item.get("name", name),
                                       "x": x, "y": y, "width": w, "height": h})
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return contents.getvalue(), "application/zip"


class Handler(BaseHTTPRequestHandler):
    server_version = "SliceStudio/1"

    def setup(self):
        self.request.settimeout(30)
        super().setup()

    def payload(self, status, body, content_type):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; "
                             "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, TimeoutError):
            pass

    def response(self, status, value):
        self.payload(status, json.dumps(value, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def local(self):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host")
        origin = self.headers.get("Origin")
        if host not in hosts or (origin and origin != f"http://{host}"):
            self.response(403, {"error": "请从本地工作台发起请求。"})
            return False
        return True

    def do_GET(self):
        if not self.local():
            return
        route = urlsplit(self.path).path
        if route == "/api/v1/status":
            samples = sorted(name for name in SAMPLES if (ROOT / "test-assets" / name).is_file())
            self.response(200, {"version": 1, "model": neural.available(), "samples": samples})
            return
        name = route.removeprefix("/samples/")
        if route.startswith("/samples/") and name in SAMPLES:
            path = ROOT / "test-assets" / name
        elif route == "/":
            path = ROOT / "web" / "index.html"
        elif route == "/favicon.ico":
            path = ROOT / "web" / "mark.svg"
        elif route.startswith("/web/") and re.fullmatch(r"[\w.-]+", route[5:]):
            path = ROOT / "web" / route[5:]
        else:
            path = None
        if not path or not path.is_file():
            self.response(404, {"error": "文件不存在。"})
            return
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.payload(200, path.read_bytes(), mime + ("; charset=utf-8" if path.suffix in {".html", ".js", ".css"} else ""))

    def do_POST(self):
        if not self.local():
            return
        if self.headers.get("X-Slice-Studio") != "1":
            self.response(403, {"error": "缺少工作台请求标识。"})
            return
        url = urlsplit(self.path)
        route = url.path
        job = self.headers.get("X-Slice-Job", "")
        if not JOB_ID.fullmatch(job):
            self.response(400, {"error": "任务编号无效。"})
            return
        if route == "/api/v1/cancel":
            with JOBS_LOCK:
                if job in JOBS:
                    JOBS[job].set()
            self.response(200, {"ok": True})
            return
        if route not in {"/api/v1/analyze", "/api/v1/extract", "/api/v1/export"}:
            self.response(404, {"error": "接口不存在。"})
            return
        stop = Event()
        with JOBS_LOCK:
            if job in JOBS:
                self.response(409, {"error": "任务已在运行。"})
                return
            JOBS[job] = stop

        def checkpoint():
            if stop.is_set():
                raise Cancelled()

        acquired = False
        try:
            acquired = WORKERS.acquire(timeout=3)
            if not acquired:
                self.response(503, {"error": "本地引擎正在处理，请稍后重试。"})
                return
            checkpoint()
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= (MAX_MESSAGE if route.endswith("/export") else MAX_FILE):
                self.response(413, {"error": "文件过大或为空。单张原图最多 40 MB。"})
                return
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("图像传输中断。")
            checkpoint()
            started = perf_counter()
            if route.endswith("/export"):
                payload, mime = exported(body, checkpoint)
                checkpoint()
                self.payload(200, payload, mime)
                return
            rgba = decode(body)
            query = parse_qs(url.query)
            if route.endswith("/analyze"):
                method = query.get("method", ["auto"])[0]
                sensitivity = int(query.get("sensitivity", ["50"])[0])
                if not 0 <= sensitivity <= 100 or method not in {"auto", "color", "sam"}:
                    raise ValueError("识别设置无效。")
                regions, bg, status = detect(rgba, sensitivity, checkpoint) if method != "sam" else ([], None, "complex")
                selected_engine = "color"
                use_model = method == "auto" and (status == "complex" or (not regions and bg is not None))
                if method == "sam" or (use_model and neural.available()):
                    regions = neural.propose(rgba, sensitivity, checkpoint)
                    bg, status, selected_engine = None, "ready", "sam"
                assets = [describe(region, bg) for region in regions]
            else:
                mode = query.get("mode", ["box"])[0]
                box = tuple(map(int, query.get("box", [""])[0].split(",")))
                if len(box) != 4 or mode not in {"box", "segment", "sam"}:
                    raise ValueError("选区或模式无效。")
                if mode == "sam":
                    region, bg = neural.box_mask(rgba, box, checkpoint), None
                else:
                    region, bg = extract(rgba, box, mode, checkpoint)
                assets = [describe(region, bg)]
                status, selected_engine = "ready", mode
            checkpoint()
            self.response(200, {"assets": assets, "status": status, "engine": selected_engine,
                                "milliseconds": round((perf_counter() - started) * 1000),
                                "size": [rgba.shape[1], rgba.shape[0]]})
        except Cancelled:
            self.response(409, {"error": "任务已取消。"})
        except InputError as error:
            self.response(422, {"error": str(error)})
        except (ValueError, KeyError, UnicodeError, binascii.Error, Image.DecompressionBombError, UnidentifiedImageError):
            self.response(422, {"error": "无法处理此数据。请检查原图格式、选区、蒙版和模型设置。"})
        except (cv2.error, RuntimeError) as error:
            self.log_error("%s", error)
            self.response(422, {"error": str(error) if isinstance(error, neural.ModelError) else "当前区域无法分割。请调整选区后重试。"})
        except (OSError, TypeError, TimeoutError) as error:
            self.log_error("%s", error)
            self.response(500, {"error": "本地处理失败，请检查数据或重试。"})
        finally:
            if acquired:
                WORKERS.release()
            with JOBS_LOCK:
                JOBS.pop(job, None)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    options = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", options.port), Handler) as server:
        print(f"Slice Studio · http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

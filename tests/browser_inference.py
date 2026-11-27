"""Compare the same MobileSAM box prompt in browser WASM and native ONNX Runtime."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
from threading import Thread
from time import perf_counter

import numpy as np
from playwright.sync_api import sync_playwright

from engine import decode
from neural import FILES, MODELS, box_mask


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "artifacts"
DIST = OUT / "browser-runtime" / "node_modules" / "onnxruntime-web" / "dist"
BOX = [13, 180, 90, 114]


class BenchmarkServer(BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.rsplit("/", 1)[-1]
        if self.path == "/":
            body, mime = b"<!doctype html><title>MobileSAM WASM benchmark</title>", "text/html"
        else:
            if name in FILES:
                path = MODELS / name
            elif name == "2.jpg":
                path = ROOT / "test-assets" / name
            else:
                path = DIST / name
            if not name or not path.is_file():
                self.send_error(404)
                return
            body = path.read_bytes()
            mime = {"mjs": "text/javascript", "wasm": "application/wasm"}.get(
                path.suffix[1:], mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            )
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.end_headers()
        self.wfile.write(body)


WASM = """
async ([x, y, w, h]) => {
  const ort = await import("/ort.wasm.min.mjs");
  ort.env.wasm.numThreads = 3;
  ort.env.wasm.wasmPaths = location.origin + "/";
  const options = {executionProviders: ["wasm"]};
  const started = performance.now();
  const encoder = await ort.InferenceSession.create("/mobile_sam_image_encoder.onnx", options);
  const decoder = await ort.InferenceSession.create("/sam_mask_decoder_single.onnx", options);
  const setupMs = Math.round(performance.now() - started);
  const img = await createImageBitmap(await (await fetch("/2.jpg")).blob());
  const sw = img.width, sh = img.height;
  const ew = Math.round(sw * 1024 / Math.max(sw, sh));
  const eh = Math.round(sh * 1024 / Math.max(sw, sh));
  const ctx = new OffscreenCanvas(ew, eh).getContext("2d");
  const tensor = (values, dims) => new ort.Tensor("float32", Float32Array.from(values), dims);
  const results = [];
  for (let trial = 0; trial < 3; trial++) {
    const before = performance.now();
    ctx.drawImage(img, 0, 0, ew, eh);
    const rgba = ctx.getImageData(0, 0, ew, eh).data;
    const rgb = new Float32Array(ew * eh * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) {
      rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2];
    }
    const enc = await encoder.run({input_image: new ort.Tensor("float32", rgb, [eh, ew, 3])});
    const output = await decoder.run({
      image_embeddings: enc.image_embeddings,
      point_coords: tensor([x * ew / sw, y * eh / sh, (x + w - 1) * ew / sw, (y + h - 1) * eh / sh], [1, 2, 2]),
      point_labels: tensor([2, 3], [1, 2]),
      mask_input: new ort.Tensor("float32", new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: tensor([0], [1]),
      orig_im_size: tensor([sh, sw], [2]),
    });
    const milliseconds = Math.round(performance.now() - before);
    let positive = 0;
    for (let row = y; row < y+h; row++) {
      for (let col = x; col < x+w; col++) positive += output.masks.data[row * sw + col] > 0 ? 1 : 0;
    }
    results.push({milliseconds, positive});
    for (const value of [...Object.values(enc), ...Object.values(output)]) value.dispose();
  }
  await decoder.release();
  await encoder.release();
  return {isolated: crossOriginIsolated, threads: ort.env.wasm.numThreads, setupMs, results};
}
"""


def main():
    if not (DIST / "ort.wasm.min.mjs").is_file():
        raise SystemExit("Install the test-only onnxruntime-web dependency first.")
    source = decode((ROOT / "test-assets" / "2.jpg").read_bytes())
    native = []
    for _ in range(3):
        start = perf_counter()
        result = box_mask(source, BOX, lambda: None)
        native.append({"milliseconds": round((perf_counter() - start) * 1000),
                       "positive": int(np.count_nonzero(result.alpha >= 128))})
    with ThreadingHTTPServer(("127.0.0.1", 0), BenchmarkServer) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chrome", headless=True)
                page = browser.new_page()
                page.goto(f"http://127.0.0.1:{server.server_port}/")
                wasm = page.evaluate(WASM, BOX)
                browser.close()
        finally:
            server.shutdown()
            thread.join()
    assert wasm["isolated"] and wasm["threads"] == 3
    assert all(item["positive"] > 500 for item in wasm["results"])
    output = json.dumps({"native": native, "wasm": wasm}, indent=2)
    (OUT / "browser-inference.json").write_text(output, encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()

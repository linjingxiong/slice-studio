"""CPU MobileSAM adapter. The browser never sends images off the local machine."""

from functools import lru_cache
from importlib.util import find_spec
from pathlib import Path

import cv2
import numpy as np

from engine import Region, trim

MODELS = Path(__file__).resolve().parent / "models"
FILES = {
    "mobile_sam_image_encoder.onnx": (
        28_157_093, "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749"
    ),
    "sam_mask_decoder_single.onnx": (
        16_501_323, "93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d"
    ),
}


class ModelError(RuntimeError):
    pass


def available():
    return find_spec("onnxruntime") is not None and all(
        (MODELS / name).is_file() and (MODELS / name).stat().st_size == size
        for name, (size, _) in FILES.items()
    )


@lru_cache(maxsize=1)
def sessions():
    if not available():
        raise ModelError("本地 MobileSAM 未安装。请运行模型安装命令，或选择颜色分割。")
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 3
    opts.inter_op_num_threads = 1
    opts.enable_mem_pattern = False
    try:
        return tuple(ort.InferenceSession(str(MODELS / name), sess_options=opts,
                                          providers=["CPUExecutionProvider"]) for name in FILES)
    except Exception as error:
        raise ModelError("MobileSAM 无法加载。请重新安装模型文件。") from error


class Prediction:
    def __init__(self, rgba, checkpoint):
        self.rgba = rgba
        self.checkpoint = checkpoint
        encoder, self.decoder = sessions()
        checkpoint()
        self.h, self.w = rgba.shape[:2]
        ratio = min(1, 768 / max(self.w, self.h))
        self.sw, self.sh = max(1, round(self.w * ratio)), max(1, round(self.h * ratio))
        ew = max(1, int(self.sw * 1024 / max(self.sw, self.sh) + .5))
        eh = max(1, int(self.sh * 1024 / max(self.sw, self.sh) + .5))
        interpolation = cv2.INTER_AREA if max(self.w, self.h) > 1024 else cv2.INTER_LINEAR
        rgb = cv2.resize(rgba[:, :, :3], (ew, eh), interpolation=interpolation)
        try:
            self.embedding = encoder.run(None, {encoder.get_inputs()[0].name: rgb.astype(np.float32)})[0]
        except Exception as error:
            raise ModelError("MobileSAM 图像编码失败。") from error
        self.scale = np.array([ew / self.sw, eh / self.sh], dtype=np.float32)

    def mask(self, points, labels):
        self.checkpoint()
        inputs = {
            "image_embeddings": self.embedding,
            "point_coords": np.asarray([points], dtype=np.float32) * self.scale,
            "point_labels": np.asarray([labels], dtype=np.float32),
            "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
            "has_mask_input": np.zeros((1,), dtype=np.float32),
            "orig_im_size": np.array([self.sh, self.sw], dtype=np.float32),
        }
        try:
            output = self.decoder.run(["masks", "iou_predictions"], inputs)
        except Exception as error:
            raise ModelError("MobileSAM 蒙版解码失败。") from error
        return output[0][0, 0], float(output[1][0, 0])

    def region(self, logits, box=None):
        if box is None:
            pts = cv2.findNonZero((logits > -1).astype(np.uint8))
            if pts is None:
                return None
            x, y, w, h = cv2.boundingRect(pts)
            x0 = max(0, (x - 1) * self.w // self.sw)
            y0 = max(0, (y - 1) * self.h // self.sh)
            x1 = min(self.w, ((x + w + 1) * self.w + self.sw - 1) // self.sw)
            y1 = min(self.h, ((y + h + 1) * self.h + self.sh - 1) // self.sh)
            box = (x0, y0, x1 - x0, y1 - y0)
        x, y, w, h = box
        # Translate directly into the crop grid to avoid a full-size float mask per item.
        sx, sy = self.sw / self.w, self.sh / self.h
        matrix = np.array([[sx, 0, (x + .5) * sx - .5], [0, sy, (y + .5) * sy - .5]], np.float32)
        raw = cv2.warpAffine(logits, matrix, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                             borderMode=cv2.BORDER_REPLICATE)
        alpha = np.rint(np.clip(raw * .5 + .5, 0, 1) * 255).astype(np.uint8)
        alpha = np.minimum(alpha, self.rgba[y:y+h, x:x+w, 3])
        return Region(box, alpha)


def box_mask(rgba, box, checkpoint):
    x, y, w, h = box
    if min(x, y) < 0 or min(w, h) < 5 or x+w > rgba.shape[1] or y+h > rgba.shape[0]:
        raise ValueError("选区无效。")
    run = Prediction(rgba, checkpoint)
    sx, sy = run.sw / run.w, run.sh / run.h
    logits, _ = run.mask([(x * sx, y * sy), ((x+w-1) * sx, (y+h-1) * sy)], [2, 3])
    region = run.region(logits, box)
    if not region.alpha.any():
        raise ModelError("模型未找到前景，请调整框选区域。")
    return region


def propose(rgba, sensitivity, checkpoint):
    run = Prediction(rgba, checkpoint)
    grid = 5 + sensitivity // 25
    accepted = []
    for y in np.linspace(.08, .92, grid) * (run.sh - 1):
        for x in np.linspace(.08, .92, grid) * (run.sw - 1):
            logits, score = run.mask([(x, y), (0, 0)], [1, -1])
            if score < .88 - sensitivity * .0021:
                continue
            hard = logits > 0
            area = np.count_nonzero(hard)
            if not .001 <= area / hard.size <= .66:
                continue
            if np.count_nonzero(logits > 1) < area * .77:
                continue
            compact = cv2.resize(hard.astype(np.uint8), (128, 128), interpolation=cv2.INTER_NEAREST).astype(bool)
            duplicate = next((i for i, (_, _, other) in enumerate(accepted)
                              if np.count_nonzero(compact & other) > .70 * np.count_nonzero(compact | other)), None)
            if duplicate is None:
                accepted.append((score, logits, compact))
            elif score > accepted[duplicate][0]:
                accepted[duplicate] = (score, logits, compact)
    regions = []
    pixels = 0
    for _, logits, _ in sorted(accepted, key=lambda candidate: candidate[0], reverse=True):
        checkpoint()
        region = run.region(logits)
        if region:
            result = trim(region.box, region.alpha)
            if result:
                pixels += result.alpha.size
                if pixels > 30_000_000:
                    break
                regions.append(result)
    regions.sort(key=lambda region: (region.box[1] // max(16, run.h // 16), region.box[0]))
    return regions

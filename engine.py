"""Local image decoding, instance proposals, matting and lossless export."""

from dataclasses import dataclass
from io import BytesIO

import cv2
import numpy as np
from PIL import Image, ImageOps

MAX_PIXELS = 24_000_000
MAX_REGIONS = 250
cv2.setNumThreads(2)


@dataclass
class Region:
    box: tuple[int, int, int, int]
    alpha: np.ndarray


class InputError(ValueError):
    pass


def load_source(data):
    with Image.open(BytesIO(data), formats=("PNG", "JPEG", "WEBP")) as image:
        if image.width * image.height > MAX_PIXELS:
            raise InputError("单张图像最多支持 2400 万像素。")
        if image.format == "PNG" and data[24] > 8:
            raise InputError("当前 PNG 导出采用 8 位通道，请导入 8 位或索引色 PNG。")
        if getattr(image, "is_animated", False):
            raise InputError("请选择静态图像。")
        profile = image.info.get("icc_profile")
        if not isinstance(profile, bytes) or profile[16:20] != b"RGB ":
            profile = None
        return np.array(ImageOps.exif_transpose(image).convert("RGBA")), profile


def decode(data):
    return load_source(data)[0]


def png(array, profile=None):
    buffer = BytesIO()
    Image.fromarray(array).save(buffer, format="PNG", compress_level=3, icc_profile=profile)
    return buffer.getvalue()


def background_model(rgb):
    """Estimate a dominant perimeter color and a JPEG noise threshold."""
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    border = np.concatenate((lab[0], lab[-1], lab[:, 0], lab[:, -1]))
    background = np.median(border, axis=0)
    border_distance = np.linalg.norm(border - background, axis=1)
    noise = max(4., float(np.quantile(border_distance, .7)) + 2.)
    delta = np.zeros(lab.shape[:2], dtype=np.float32)
    for channel in range(3):
        diff = np.subtract(lab[:, :, channel], background[channel], dtype=np.float32)
        np.square(diff, out=diff)
        delta += diff
    np.sqrt(delta, out=delta)
    valid = np.mean(border_distance <= max(9, min(noise, 15))) >= .68
    color_index = int(np.argmin(border_distance))
    rgb_border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]))
    return delta, min(noise, 16.), valid, rgb_border[color_index]


def soft_alpha(rgb, foreground, delta, noise, background):
    """Estimate coverage near the exterior using adjacent opaque foreground."""
    # Pad so crop edges participate in the distance-to-background estimate.
    inward = cv2.distanceTransform(np.pad(foreground, 1).astype(np.uint8),
                                   cv2.DIST_L2, 5)[1:-1, 1:-1]
    solid = foreground & ((delta >= max(46, noise * 3)) | ((inward >= 3) & (delta > 9)))
    if not np.any(solid):
        strength = max(noise + 1, float(np.quantile(delta[foreground], .85)))
        alpha = np.clip((delta - noise * .65) / (strength - noise * .65), 0, 1)
    else:
        distance, nearest = cv2.distanceTransformWithLabels(
            (~solid).astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL
        )
        palette = np.empty((int(nearest.max()) + 1, 3), dtype=np.float32)
        palette[nearest[solid]] = rgb[solid]
        base = background.astype(np.float32)
        reference = palette[nearest] - base
        projection = np.sum((rgb.astype(np.float32) - base) * reference, axis=2)
        alpha = np.clip(projection / np.maximum(np.sum(reference ** 2, axis=2), 1), 0, 1)
        # Protect thin pale material away from strongly pigmented pixels.
        weak = np.clip((delta - noise * .65) / max(12, noise * 2), 0, 1)
        alpha = np.maximum(alpha, weak * np.clip((distance - 2) / 5, 0, 1))
        alpha[solid] = 1
    return np.rint(np.where(foreground, alpha, 0) * 255).astype(np.uint8)


def detect(rgba, sensitivity=50, checkpoint=lambda: None):
    rgb = np.ascontiguousarray(rgba[:, :, :3])
    original = rgba[:, :, 3]
    transparent = np.any(original < 255)
    background = None
    if transparent:
        candidate = original > 0
        seeds = candidate
    else:
        delta, noise, valid, background = background_model(rgb)
        if not valid:
            return [], None, "complex"
        candidate = delta > noise * (1.65 - sensitivity / 100)
        seeds = delta > max(10, noise * (2.6 - sensitivity / 100))
    checkpoint()

    height, width = candidate.shape
    radius = max(1, min(3, round(max(height, width) / 1000)))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1,) * 2)
    joined = seeds.astype(np.uint8) if transparent else cv2.morphologyEx(
        seeds.astype(np.uint8), cv2.MORPH_CLOSE, kernel
    )
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)
    threshold = 1 if transparent else max(9, height * width * (0.00021 - sensitivity * .0000017))
    accepted = [
        index for index in range(1, count)
        if stats[index, 4] >= threshold and (transparent or min(stats[index, 2:4]) >= 4)
    ]
    accepted.sort(key=lambda index: int(stats[index, 4]), reverse=True)
    limited = len(accepted) > MAX_REGIONS
    if accepted and not transparent:
        kernel_bg = np.ones_like(joined)
        kernel_bg[np.isin(labels, accepted[:MAX_REGIONS])] = 0
        distance, nearest = cv2.distanceTransformWithLabels(
            kernel_bg, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_CCOMP
        )
    regions = []
    pixels = 0
    for index in accepted[:MAX_REGIONS]:
        checkpoint()
        x, y, w, h = map(int, stats[index, :4])
        if not transparent and w >= width * .97 and h >= height * .97:
            continue
        if not transparent:
            padding = 6
            x0, y0 = max(0, x - padding), max(0, y - padding)
            w, h = min(width, x+w+padding)-x0, min(height, y+h+padding)-y0
            x, y = x0, y0
        local = np.s_[y:y+h, x:x+w]
        foreground = (labels[local] == index) & candidate[local]
        if not transparent:
            seed_labels = nearest[local][labels[local] == index]
            foreground = (nearest[local] == seed_labels[0]) & (distance[local] <= padding) & candidate[local]
            # Preserve enclosed pale pixels without filling large transparent holes.
            contours, _ = cv2.findContours(foreground.astype(np.uint8), cv2.RETR_CCOMP,
                                           cv2.CHAIN_APPROX_SIMPLE)
            filled = foreground.astype(np.uint8)
            for contour in contours:
                if cv2.contourArea(contour, oriented=True) > 0 and cv2.contourArea(contour) < 55:
                    cv2.drawContours(filled, [contour], 0, 1, cv2.FILLED)
            foreground = filled.astype(bool)
        alpha = (np.where(foreground, original[local], 0) if transparent
                 else soft_alpha(rgb[local], foreground, delta[local], noise, background))
        region = trim((x, y, w, h), alpha)
        if region:
            pixels += region.alpha.size
            if pixels > 30_000_000:
                limited = True
                break
            regions.append(region)
    regions.sort(key=lambda region: (region.box[1] // max(16, height // 16), region.box[0]))
    return regions, None if background is None else background.tolist(), "limited" if limited else "ready"


def trim(box, alpha):
    points = cv2.findNonZero(alpha)
    if points is None:
        return None
    x, y, w, h = cv2.boundingRect(points)
    return Region((box[0] + x, box[1] + y, w, h), alpha[y:y+h, x:x+w].copy())


def extract(rgba, box, mode, checkpoint=lambda: None):
    x, y, w, h = box
    if min(x, y) < 0 or min(w, h) < 1 or x + w > rgba.shape[1] or y + h > rgba.shape[0]:
        raise InputError("选区超出图像范围。")
    crop = rgba[y:y+h, x:x+w]
    alpha = crop[:, :, 3].copy()
    if mode == "box" or np.any(rgba[:, :, 3] < 255):
        return Region(box, alpha), None
    if min(w, h) < 5:
        raise InputError("智能分割需要至少 5 × 5 像素的选区。")
    rgb = np.ascontiguousarray(crop[:, :, :3])
    delta, noise, valid, background = background_model(rgb)
    candidate = delta > noise
    if valid and np.any(candidate) and candidate.mean() < .93:
        alpha = soft_alpha(rgb, candidate, delta, noise, background)
        return Region(box, alpha), background.tolist()
    # GrabCut uses a full-resolution color ROI with a bounded working mask.
    ratio = min(1, 960 / max(w, h))
    small = cv2.resize(rgb, (max(5, round(w * ratio)), max(5, round(h * ratio))),
                       interpolation=cv2.INTER_AREA) if ratio < 1 else rgb
    sh, sw = small.shape[:2]
    mask = np.zeros((sh, sw), dtype=np.uint8)
    for iteration in range(3):
        checkpoint()
        if iteration == 0:
            bg = np.zeros((1, 65), dtype=np.float64)
            fg = np.zeros_like(bg)
        cv2.grabCut(small, mask, (1, 1, sw - 2, sh - 2), bg, fg, 1,
                    cv2.GC_INIT_WITH_RECT if iteration == 0 else cv2.GC_EVAL)
    mask = ((mask & 1) * 255).astype(np.uint8)
    if not mask.any():
        raise InputError("此选区未找到前景。请扩大边缘留白，或使用框选与蒙版编辑。")
    alpha = cv2.resize(mask, (w, h), interpolation=cv2.INTER_LINEAR) if ratio < 1 else mask
    return Region(box, alpha), None


def render(rgba, box, alpha, background=None, decontaminate=False):
    x, y, w, h = box
    if min(x, y) < 0 or min(w, h) < 1 or x+w > rgba.shape[1] or y+h > rgba.shape[0]:
        raise ValueError("素材范围超出原图。")
    if alpha.shape != (h, w):
        raise ValueError("蒙版尺寸与素材不一致。")
    result = rgba[y:y+h, x:x+w].copy()
    original = result[:, :, 3].copy()
    result[:, :, 3] = np.minimum(alpha, original)
    if decontaminate and background is not None:
        clean_edge(result, original, background)
    return result


def clean_edge(result, original, background):
    """Subtract matte near the silhouette and substantial transparent openings."""
    alpha = result[:, :, 3]
    kernel = np.ones((7, 7), np.uint8)
    airy = np.pad((alpha < 96).astype(np.uint8), 1, constant_values=1)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(airy, connectivity=8)
    openings = stats[:, cv2.CC_STAT_AREA] >= 24
    openings[0] = False
    outside = labels[0, 0]
    openings[outside] = False
    crop_labels = labels[1:-1, 1:-1]
    strength = cv2.dilate((crop_labels == outside).astype(np.uint8), kernel).astype(np.float32)
    if np.any(openings):
        distance = cv2.distanceTransform((~openings[crop_labels]).astype(np.uint8), cv2.DIST_C, 3)
        strength = np.maximum(strength, np.clip((7 - distance) / 4, 0, 1))
    edge = (original == 255) & (alpha > 0) & (strength > 0)
    if not np.any(edge):
        return
    rgb = result[:, :, :3]
    base = np.asarray(background, np.uint8)
    contrast = np.zeros(alpha.shape, np.uint8)
    for channel, value in enumerate(background):
        difference = cv2.absdiff(rgb[:, :, channel], float(value))
        np.maximum(contrast, difference, out=contrast)
    strongest = cv2.dilate(np.where(alpha >= 128, contrast, 0).astype(np.uint8), kernel)
    peak = strongest[edge].astype(np.float32)
    delta = contrast[edge].astype(np.float32)
    initial = alpha[edge].astype(np.float32) / 255
    coverage = initial.copy()
    # An already saturated mask can still cover white matte near a darker edge.
    fringe = (peak >= 35) & (delta < peak * .85)
    coverage[fringe] = np.minimum(coverage[fringe], delta[fringe] / peak[fringe] * .90)
    # Suppress the very faint transition from JPEG ringing to the original matte.
    fade = np.clip((delta - 7) / 10, 0, 1)
    coverage *= fade
    mix = strength[edge]
    coverage = initial + (coverage - initial) * mix
    weight = np.maximum(coverage[:, None], .08)
    original_rgb = rgb[edge].astype(np.float32)
    corrected = base + (original_rgb - base) / weight
    color = original_rgb + (np.clip(corrected, 0, 255) - original_rgb) * mix[:, None]
    rgb[edge] = np.rint(color).astype(np.uint8)
    alpha[edge] = np.rint(coverage * 255).astype(np.uint8)

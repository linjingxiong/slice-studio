export function surface(width, height) {
  return Object.assign(document.createElement("canvas"), { width, height });
}

export function readBase64(encoded) {
  const raw = atob(encoded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function loadMask(asset, maximum = Infinity) {
  const bytes = readBase64(asset.mask);
  const [, , width, height] = asset.box;
  const header = new DataView(bytes.buffer);
  if (bytes.length < 33 || header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a ||
      header.getUint32(16) !== width || header.getUint32(20) !== height ||
      bytes[24] !== 8 || ![0, 6].includes(bytes[25])) throw new Error("项目蒙版尺寸或格式无效。");
  const scale = Math.min(1, maximum / Math.max(width, height));
  const rasterWidth = Math.max(1, Math.round(width * scale));
  const rasterHeight = Math.max(1, Math.round(height * scale));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }),
    { colorSpaceConversion: "none", premultiplyAlpha: "none", resizeWidth: rasterWidth,
      resizeHeight: rasterHeight, resizeQuality: "high" });
  const canvas = surface(rasterWidth, rasterHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  if (bytes[25] === 0) {
    const pixels = ctx.getImageData(0, 0, rasterWidth, rasterHeight);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i + 3] = pixels.data[i];
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
  }
  return canvas;
}

export function serializeMask(canvas) {
  return canvas.toDataURL("image/png").split(",")[1];
}

export function edgeCleanupEnabled(asset) {
  return Boolean(asset.background) && asset.edgeCleanup !== false;
}

function boundaryMask(cover, width, height, minimumArea) {
  const outside = new Uint8Array(width * height);
  const queue = new Uint32Array(outside.length);
  for (let start = 0; start < outside.length; start++) {
    if (outside[start] || cover[start * 4 + 3] >= 96) continue;
    outside[start] = 1;
    queue[0] = start;
    let tail = 1, touchesEdge = false;
    for (let head = 0; head < tail; head++) {
      const row = Math.floor(queue[head] / width), column = queue[head] % width;
      touchesEdge ||= !row || !column || row === height - 1 || column === width - 1;
      for (let y = Math.max(0, row - 1); y <= Math.min(height - 1, row + 1); y++) {
        for (let x = Math.max(0, column - 1); x <= Math.min(width - 1, column + 1); x++) {
          const n = y * width + x;
          if (outside[n] || cover[n * 4 + 3] >= 96) continue;
          outside[n] = 1;
          queue[tail++] = n;
        }
      }
    }
    if (touchesEdge || tail >= minimumArea) {
      for (let i = 0; i < tail; i++) outside[queue[i]] = touchesEdge ? 2 : 3;
    }
  }
  return outside;
}

function expandBoundary(source, width, height, label, radius, band, weight) {
  const rows = new Uint8Array(source.length);
  for (let y = 0; y < height; y++) {
    let count = 0;
    const offset = y * width;
    for (let x = -radius; x < width; x++) {
      if (x + radius < width && source[offset + x + radius] === label) count++;
      if (x > radius && source[offset + x - radius - 1] === label) count--;
      if (x >= 0 && count) rows[offset + x] = 1;
    }
  }
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = -radius; y < height; y++) {
      if (y + radius < height) count += rows[(y + radius) * width + x];
      if (y > radius) count -= rows[(y - radius - 1) * width + x];
      if (y >= 0 && count) {
        const n = y * width + x;
        band[n] = Math.max(band[n], weight);
      }
    }
  }
}

export function compose(source, asset, mask, maximum = 960) {
  const [x, y, w, h] = asset.box;
  const scale = Math.min(1, maximum / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  const crop = surface(width, height);
  const ctx = crop.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(mask, 0, 0, width, height);
  const cover = ctx.getImageData(0, 0, width, height).data;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, x, y, w, h, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height);
  const estimate = edgeCleanupEnabled(asset) && asset.background;
  const contrasts = estimate && new Uint8Array(width * height);
  const radius = Math.max(1, Math.round(3 * scale));
  const band = estimate && new Uint8Array(width * height);
  if (estimate) {
    const areas = boundaryMask(cover, width, height, Math.max(3, Math.round(24 * scale ** 2)));
    expandBoundary(areas, width, height, 2, radius, band, 4);
    if (areas.includes(3)) {
      for (let weight = 1; weight <= 4; weight++) {
        const holeRadius = Math.max(1, Math.round((7 - weight) * scale));
        expandBoundary(areas, width, height, 3, holeRadius, band, weight);
      }
    }
    for (let n = 0; n < contrasts.length; n++) {
      const i = n * 4;
      contrasts[n] = Math.max(Math.abs(pixels.data[i] - estimate[0]),
        Math.abs(pixels.data[i + 1] - estimate[1]), Math.abs(pixels.data[i + 2] - estimate[2]));
    }
  }
  for (let i = 0; i < pixels.data.length; i += 4) {
    const natural = pixels.data[i + 3];
    let opacity = cover[i + 3];
    if (estimate && natural === 255 && opacity > 0 && band[i / 4]) {
      const initial = opacity;
      const mix = band[i / 4] / 4;
      const row = Math.floor(i / 4 / width), column = (i / 4) % width;
      let peak = 0;
      for (let y = Math.max(0, row - radius); y <= Math.min(height - 1, row + radius); y++) {
        for (let x = Math.max(0, column - radius); x <= Math.min(width - 1, column + radius); x++) {
          const n = y * width + x, nearby = cover[n * 4 + 3];
          if (nearby >= 128) peak = Math.max(peak, contrasts[n]);
        }
      }
      const delta = contrasts[i / 4];
      if (peak >= 35 && delta < peak * .85) opacity = Math.min(opacity, 255 * delta / peak * .90);
      opacity *= Math.min(1, Math.max(0, (delta - 7) / 10));
      opacity = initial + (opacity - initial) * mix;
      const weight = Math.max(.08, opacity / 255);
      for (let channel = 0; channel < 3; channel++) {
        const value = pixels.data[i + channel];
        const corrected = estimate[channel] + (value - estimate[channel]) / weight;
        pixels.data[i + channel] = value + (Math.min(255, Math.max(0, corrected)) - value) * mix;
      }
    }
    pixels.data[i + 3] = Math.min(natural, opacity);
  }
  ctx.putImageData(pixels, 0, 0);
  return crop;
}

export class Stage {
  constructor(element, canvas, draw) {
    this.element = element;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.draw = draw;
    this.image = null;
    this.zoom = 1;
    this.x = 0;
    this.y = 0;
    this.fitMode = true;
    this.frame = 0;
    const tile = surface(16, 16);
    const ctx = tile.getContext("2d");
    ctx.fillStyle = "#333942";
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = "#282d35";
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillRect(8, 8, 8, 8);
    this.checker = this.ctx.createPattern(tile, "repeat");
    new ResizeObserver(() => {
      if (this.fitMode) this.fit();
      this.invalidate();
    }).observe(element);
  }

  setImage(image) {
    this.image = image;
    this.canvas.hidden = !image;
    this.fit();
    this.invalidate();
  }

  fit() {
    this.fitMode = true;
    if (!this.image) return;
    const { clientWidth: w, clientHeight: h } = this.element;
    this.zoom = Math.min(1, Math.max(20, w - 52) / this.image.width, Math.max(20, h - 48) / this.image.height);
    this.x = (w - this.zoom * this.image.width) / 2;
    this.y = (h - this.zoom * this.image.height) / 2;
    this.invalidate();
  }

  scaleBy(factor, point = [this.element.clientWidth / 2, this.element.clientHeight / 2]) {
    if (!this.image) return;
    const next = Math.max(Math.min(this.zoom, .015), Math.min(16, this.zoom * factor));
    const ratio = next / this.zoom;
    this.x = point[0] - (point[0] - this.x) * ratio;
    this.y = point[1] - (point[1] - this.y) * ratio;
    this.zoom = next;
    this.fitMode = false;
    this.invalidate();
  }

  screen(event) {
    const box = this.element.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }

  point(event) {
    const [x, y] = this.screen(event);
    return [(x - this.x) / this.zoom, (y - this.y) / this.zoom];
  }

  clip(point) {
    return [Math.max(0, Math.min(this.image.width, point[0])),
      Math.max(0, Math.min(this.image.height, point[1]))];
  }

  box([x, y, w, h]) {
    return [this.x + x * this.zoom, this.y + y * this.zoom, w * this.zoom, h * this.zoom];
  }

  focus([x, y, w, h]) {
    this.x = this.element.clientWidth / 2 - (x + w / 2) * this.zoom;
    this.y = this.element.clientHeight / 2 - (y + h / 2) * this.zoom;
    this.fitMode = false;
    this.invalidate();
  }

  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const w = Math.round(this.element.clientWidth * dpr);
      const h = Math.round(this.element.clientHeight * dpr);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.clearRect(0, 0, w / dpr, h / dpr);
      if (this.image) this.draw(this.ctx);
    });
  }
}

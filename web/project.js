import { edgeCleanupEnabled, readBase64 } from "./canvas.js";

const API = "/api/v1";
export const MAX_ASSETS = 250;
const MAX_SOURCE = 40 * 1024 * 1024;

export function makeProject(source, name) {
  return { id: crypto.randomUUID(), name: name.replace(/\.[^.]+$/, ""), filename: name,
    source, assets: [], updated: Date.now() };
}

export function makeAsset(data, name) {
  return { ...data, id: crypto.randomUUID(), name };
}

const headers = job => ({ "X-Slice-Studio": "1", "X-Slice-Job": job });

export async function request(route, body, job, signal) {
  const response = await fetch(API + route, { method: "POST", headers: headers(job), body, signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "本地引擎未响应，请重试。");
  }
  return response;
}

export function stopJob(job) {
  return fetch(API + "/cancel", { method: "POST", headers: headers(job), keepalive: true }).catch(() => {});
}

export async function engineStatus() {
  const response = await fetch(API + "/status", { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error("本地引擎不可用");
  return response.json();
}

export function exportBody(project, assets, format) {
  const items = assets.map(asset => ({ ...asset, decontaminate: edgeCleanupEnabled(asset) }));
  const config = new TextEncoder().encode(JSON.stringify({ source: project.filename, format, assets: items }));
  const length = new ArrayBuffer(4);
  new DataView(length).setUint32(0, config.length);
  return new Blob([length, config, project.source], { type: "application/octet-stream" });
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function safeName(text) {
  return text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^[ .]+|[ .]+$/g, "").slice(0, 90) || "slice";
}

export async function decodeSource(blob) {
  if (!blob.size || blob.size > MAX_SOURCE) throw new Error("图片为空或超过 40 MB。");
  const signature = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const png = signature[0] === 137 && String.fromCharCode(...signature.slice(1, 4)) === "PNG";
  const jpg = signature[0] === 255 && signature[1] === 216;
  const webp = String.fromCharCode(...signature.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...signature.slice(8, 12)) === "WEBP";
  if (!png && !jpg && !webp) throw new Error("请选择有效的 PNG、JPG 或 WebP 图片。");
  if (png && signature[24] > 8) throw new Error("请选择 8 位或索引色 PNG。");
  if (webp && String.fromCharCode(...signature.slice(12, 16)) === "VP8X" && (signature[20] & 2)) {
    throw new Error("请选择静态 WebP 图片。");
  }
  const image = await createImageBitmap(blob, { imageOrientation: "from-image" })
    .catch(() => { throw new Error("无法解码此图片。"); });
  if (image.width * image.height > 24_000_000) {
    image.close();
    throw new Error("单张图片最多支持 2400 万像素。");
  }
  return image;
}

function toDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("无法读取原图。"));
    reader.readAsDataURL(blob);
  });
}

export async function portable(project) {
  const source = await toDataURL(project.source);
  return new Blob([JSON.stringify({ version: 1, name: project.name, filename: project.filename,
    source, assets: project.assets })], { type: "application/json" });
}

export async function readPortable(file) {
  if (file.size > 150 * 1024 * 1024) throw new Error("项目文件超过 150 MB。");
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error("项目文件无法读取。"); }
  if (!data || data.version !== 1 || typeof data.source !== "string" ||
      !/^data:[\w/+.-]*;base64,[A-Za-z0-9+/=]+$/.test(data.source) ||
      typeof data.filename !== "string" || typeof data.name !== "string" ||
      !Array.isArray(data.assets) || data.assets.length > MAX_ASSETS) throw new Error("项目文件格式不受支持。");
  const comma = data.source.indexOf(",");
  const source = new Blob([readBase64(data.source.slice(comma + 1))], {
    type: data.source.slice(5, comma - 7)
  });
  return { ...makeProject(source, data.filename.slice(0, 240)), name: data.name.slice(0, 160),
    assets: data.assets };
}

export function validAsset(item, image) {
  if (!item || !Array.isArray(item.box) || item.box.length !== 4 || !item.box.every(Number.isInteger) ||
      typeof item.name !== "string" || typeof item.mask !== "string" ||
      !/^[A-Za-z0-9+/=]+$/.test(item.mask) || item.mask.length > 40 * 1024 * 1024) return false;
  const [x, y, w, h] = item.box;
  return x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= image.width && y + h <= image.height &&
    (item.background === null || Array.isArray(item.background) && item.background.length === 3 &&
      item.background.every(n => Number.isInteger(n) && n >= 0 && n <= 255));
}

let database;
function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("slice-studio", 2);
    req.onupgradeneeded = event => {
      const projects = event.oldVersion === 0 ? req.result.createObjectStore("projects", { keyPath: "id" })
        : req.transaction.objectStore("projects");
      projects.createIndex("recent", ["updated", "name"]);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("项目库在另一个标签页中打开。"));
  });
  return database;
}

async function store(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("projects", mode);
    const req = action(tx.objectStore("projects"));
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = () => reject(tx.error || req.error);
  });
}

export const saveProject = project => store("readwrite", bucket => bucket.put(project));
export const getProject = id => store("readonly", bucket => bucket.get(id));
export async function listProjects() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("projects", "readonly");
    const query = tx.objectStore("projects").index("recent").openKeyCursor(null, "prev");
    const recent = [];
    query.onsuccess = () => {
      const cursor = query.result;
      if (!cursor) return;
      recent.push({ id: cursor.primaryKey, name: cursor.key[1] });
      if (recent.length < 8) cursor.continue();
    };
    tx.oncomplete = () => resolve(recent);
    tx.onabort = () => reject(tx.error);
  });
}

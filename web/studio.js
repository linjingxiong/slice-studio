import { icon } from "./icons.js";
import { Stage, surface, loadMask, serializeMask, compose, edgeCleanupEnabled } from "./canvas.js";
import {
  MAX_ASSETS, makeProject, makeAsset, decodeSource, request, stopJob, engineStatus,
  exportBody, safeName, download, portable, readPortable, validAsset,
  saveProject, getProject, listProjects
} from "./project.js";

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const viewport = $("viewport");
const stage = new Stage(viewport, $("canvas"), draw);
const hints = {
  box: "拖动创建矩形素材",
  segment: "框住对象，并在周围留一点背景",
  lasso: "沿对象轮廓连续拖动",
  brush: "在所选素材内恢复原图像素",
  erase: "在所选素材内降低蒙版覆盖",
  pan: "拖动平移画布"
};
let project, image, job, gesture, hover;
let ready = false, loading = false, space = false, model = false;
let history = [], future = [], selected = new Set(), tool = "select", view = "source";
let previews = new WeakMap(), thumbnailObserver;
let persist = Promise.resolve();
let contextAsset, preview;

function notify(message) {
  $("notice-text").textContent = message;
  $("notice").hidden = false;
  status(message);
}

function status(message) { $("status").textContent = message; }
function current() {
  return selected.size === 1 ? project?.assets.find(item => selected.has(item.id)) : null;
}

function refreshToolbar() {
  const locked = Boolean(job) || loading;
  $("empty").hidden = Boolean(image);
  $("project-name").textContent = project?.name || "未命名项目";
  $("project-name").title = project?.filename || "";
  $("analyze").disabled = !image || locked;
  $("export").disabled = !project?.assets.length || locked;
  $("all-assets").disabled = !project?.assets.length || locked;
  $("delete").disabled = !selected.size || locked;
  $("undo").disabled = !history.length || locked;
  $("redo").disabled = !future.length || locked;
  $("project-save").disabled = !project || locked;
  for (const id of ["import", "empty-import", "new-project", "project-open"]) $(id).disabled = locked;
  for (const button of all("[data-sample], [data-tool]")) button.disabled = locked;
  for (const id of ["fit", "zoom-label", "zoom-in", "zoom-out"]) $(id).disabled = !image;
  $("asset-count").textContent = project?.assets.length || 0;
  $("selection-state").textContent = selected.size ? `已选 ${selected.size} / ${project.assets.length}` : `${project?.assets.length || 0} 个素材`;
  $("dimensions").textContent = image ? `${image.width} × ${image.height} px` : "无图像";
  $("cancel").hidden = !job;
  $("progress").hidden = !locked;
  viewport.setAttribute("aria-busy", locked);
}

function updateOptions() {
  const brushing = tool === "brush" || tool === "erase";
  $("tool-hint").textContent = hints[tool] || "";
  $("brush-field").hidden = !brushing;
  $("segment-field").hidden = tool !== "segment";
  $("compare-field").hidden = view !== "compare";
  $("tool-options").hidden = !image || (!hints[tool] && view !== "compare");
  viewport.style.cursor = space || tool === "pan" ? (gesture ? "grabbing" : "grab") :
    tool === "select" ? "default" : "crosshair";
}

function setTool(value) {
  if (gesture) return;
  tool = value;
  for (const button of all("[data-tool]")) {
    button.classList.toggle("current", button.dataset.tool === tool);
    button.setAttribute("aria-pressed", button.dataset.tool === tool);
  }
  if ((tool === "brush" || tool === "erase") && (view === "source" || view === "outline")) setView("mask");
  updateOptions();
  stage.invalidate();
}

function setView(value) {
  view = value;
  for (const button of all("[data-view]")) {
    button.classList.toggle("active", button.dataset.view === view);
    button.setAttribute("aria-pressed", button.dataset.view === view);
  }
  updateOptions();
  stage.invalidate();
}

function queueSave() {
  const snapshot = { ...project, updated: Date.now() };
  $("saved").textContent = "正在保存…";
  persist = persist.catch(() => {}).then(() => saveProject(snapshot)).then(() => {
    if (project?.id === snapshot.id && project.assets === snapshot.assets) {
      try { localStorage.setItem("slice-studio-active", snapshot.id); } catch { /* storage restricted */ }
      $("saved").textContent = "已保存到本机";
    }
  }).catch(() => {
    if (project?.id !== snapshot.id) return;
    $("saved").textContent = "本机保存失败";
    notify("本机项目存储失败。可使用「下载项目文件」备份。");
  });
}

function snapshot() { return { assets: project.assets, selected: [...selected] }; }

function commit(assets, ids = [...selected]) {
  history.push(snapshot());
  if (history.length > 20) history.shift();
  future = [];
  applySnapshot({ assets, selected: ids });
}

function applySnapshot(next) {
  project = { ...project, assets: next.assets };
  selected = new Set(next.selected.filter(id => next.assets.some(asset => asset.id === id)));
  render();
  queueSave();
}

function undo(redo = false) {
  const from = redo ? future : history;
  const to = redo ? history : future;
  if (!from.length || job || gesture || loading) return;
  to.push(snapshot());
  applySnapshot(from.pop());
  status(redo ? "已重做" : "已撤销");
}

async function openProject(next, imported = false) {
  if (loading || job || gesture) return;
  loading = true;
  refreshToolbar();
  let decoded;
  try {
    if (typeof next === "function") next = await next();
    decoded = await decodeSource(next.source);
    if (!next.assets.every(asset => validAsset(asset, decoded))) throw new Error("项目含有无效素材。");
    if (imported) {
      for (const asset of next.assets) {
        const checked = await loadMask(asset);
        checked.width = 1;
      }
      next.assets = next.assets.map(asset => {
        const { box, mask, background } = asset;
        return { ...makeAsset({ box, mask, background }, asset.name.slice(0, 90)),
          edgeCleanup: typeof asset.edgeCleanup === "boolean" ? asset.edgeCleanup : undefined };
      });
    }
    image?.close();
    image = decoded;
    decoded = null;
    project = next;
    history = [];
    future = [];
    selected = new Set();
    previews = new WeakMap();
    stage.setImage(image);
    $("notice").hidden = true;
    setTool("select");
    setView(project.assets.length ? "outline" : "source");
    status(project.assets.length ? "已恢复项目" : "已导入，可开始识别");
    queueSave();
  } catch (error) {
    decoded?.close();
    notify(error.message || "无法打开项目。");
  } finally {
    loading = false;
    render();
  }
}

function openFile(file) {
  if (file) return openProject(makeProject(file, file.name));
}

async function processJob(label, action) {
  if (job || gesture || loading || !project) return;
  const run = { id: crypto.randomUUID(), controller: new AbortController() };
  job = run;
  $("notice").hidden = true;
  status(label);
  refreshToolbar();
  try {
    await action(run, (route, body) => request(route, body, run.id, run.controller.signal));
  } catch (error) {
    if (job === run && !run.controller.signal.aborted) {
      notify(error instanceof TypeError ? "无法连接本地引擎，请检查服务后重试。" : error.message);
      if (error instanceof TypeError) refreshEngine();
    }
  } finally {
    if (job === run) {
      job = null;
      refreshToolbar();
    }
  }
}

function cancel() {
  if (!job) return;
  const run = job;
  run.controller.abort();
  job = null;
  stopJob(run.id);
  status("已取消");
  refreshToolbar();
}

function nextAsset(data, existing) {
  let number = existing.length + 1;
  let name;
  do { name = `切片 ${String(number++).padStart(2, "0")}`; }
  while (existing.some(asset => asset.name === name));
  return makeAsset(data, name);
}

async function analyze() {
  if (!project) return;
  const method = $("method").value;
  const sensitivity = $("sensitivity").value;
  await processJob("正在识别素材…", async (run, send) => {
    const response = await send(`/analyze?method=${method}&sensitivity=${sensitivity}`, project.source);
    const result = await response.json();
    if (job !== run) return;
    if (result.status === "complex") {
      notify("边缘背景颜色不统一。可安装 MobileSAM，或使用分割工具框选对象。");
      return;
    }
    if (!result.assets.length) {
      notify("未检测到独立素材。可调整识别灵敏度、切换引擎或手动框选。");
      return;
    }
    const assets = project.assets.filter(asset => !asset.automatic);
    const matched = result.assets.slice(0, MAX_ASSETS - assets.length);
    if (!matched.length) return notify("项目已达到 250 个素材上限。");
    for (const data of matched) assets.push({ ...nextAsset(data, assets), automatic: true });
    commit(assets, []);
    setView("outline");
    const engine = result.engine === "sam" ? "MobileSAM" : "颜色分割";
    status(`${engine} · ${matched.length} 个候选 · ${result.milliseconds} ms`);
    if (result.status === "limited" || matched.length < result.assets.length) notify("已达到素材数量上限，部分候选未加入项目。");
  });
}

function addAsset(data) {
  if (project.assets.length >= MAX_ASSETS) return notify("项目最多可包含 250 个素材。");
  const asset = nextAsset(data, project.assets);
  commit([...project.assets, asset], [asset.id]);
  if (view === "source") setView("outline");
  $("asset-" + asset.id)?.scrollIntoView({ block: "nearest" });
}

async function extract(box, mode) {
  await processJob(mode === "box" ? "正在创建切片…" : "正在分割所选区域…", async (run, send) => {
    const response = await send(`/extract?mode=${mode}&box=${box.join(",")}`, project.source);
    const result = await response.json();
    if (job !== run) return;
    addAsset(result.assets[0]);
    status(`已添加素材 · ${result.milliseconds} ms`);
  });
}

function removeSelection() {
  if (!selected.size || job || loading || gesture) return;
  commit(project.assets.filter(item => !selected.has(item.id)), []);
  status("已删除所选素材，可撤销");
}

function selectAsset(asset, event = {}, scroll = false) {
  if (gesture) return;
  if (!asset) {
    if (!(event.shiftKey || event.ctrlKey || event.metaKey)) selected.clear();
  } else if (event.shiftKey || event.ctrlKey || event.metaKey) {
    if (selected.has(asset.id)) selected.delete(asset.id);
    else selected.add(asset.id);
  } else {
    selected = new Set([asset.id]);
  }
  updateSelection();
  if (scroll && asset) $("asset-" + asset.id)?.scrollIntoView({ block: "nearest" });
}

function thumb(asset) {
  if (!previews.has(asset)) {
    const original = image;
    previews.set(asset, loadMask(asset, 108).then(mask => {
      if (original !== image) return null;
      return compose(original, asset, mask, 108);
    }).then(result => { stage.invalidate(); return result; }).catch(() => null));
  }
  return previews.get(asset);
}

const stagePreviews = new Map();
function stagePreview(asset) {
  const maximum = current() === asset ? 960 : 270;
  const saved = stagePreviews.get(asset);
  if (saved?.maximum >= maximum) return saved.canvas;
  const original = image;
  const entry = { canvas: saved?.canvas, maximum };
  stagePreviews.set(asset, entry);
  loadMask(asset, maximum).then(mask => {
    if (image !== original || stagePreviews.get(asset) !== entry) return;
    entry.canvas = compose(original, asset, mask, maximum);
    stage.invalidate();
  }).catch(() => {});
  return null;
}

function render() {
  stagePreviews.clear();
  thumbnailObserver?.disconnect();
  $("assets").replaceChildren();
  if (!project?.assets.length) {
    const placeholder = document.createElement("div");
    placeholder.className = "panel-empty";
    placeholder.innerHTML = icon("layers") + "<span>暂无素材</span><small>智能识别或框选后在此查看</small>";
    $("assets").append(placeholder);
  } else {
    thumbnailObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbnailObserver.unobserve(entry.target);
        const { item, tile } = entry.target;
        thumb(item).then(canvas => {
          if (!canvas || !tile.isConnected) return;
          const copy = surface(canvas.width, canvas.height);
          copy.getContext("2d").drawImage(canvas, 0, 0);
          tile.append(copy);
        });
      }
    }, { root: $("assets"), rootMargin: "70px" });
    for (const asset of project.assets) {
      const button = document.createElement("button");
      button.id = "asset-" + asset.id;
      button.className = "asset";
      button.title = asset.name;
      const thumbnail = document.createElement("span");
      thumbnail.className = "asset-thumb";
      const name = document.createElement("span");
      name.className = "asset-name";
      name.textContent = asset.name;
      const size = document.createElement("span");
      size.className = "asset-size";
      size.textContent = `${asset.box[2]} × ${asset.box[3]}`;
      button.append(thumbnail, name, size);
      button.item = asset;
      button.tile = thumbnail;
      button.addEventListener("click", event => selectAsset(asset, event));
      button.addEventListener("dblclick", () => openPreview(asset));
      button.addEventListener("contextmenu", event => openContext(event, asset));
      $("assets").append(button);
      thumbnailObserver.observe(button);
    }
  }
  updateSelection();
}

function updateAsset(asset, change) {
  if (job || loading || gesture) return;
  commit(project.assets.map(item => item.id === asset.id ? { ...item, ...change, automatic: false } : item));
}

function updateSelection() {
  for (const button of all(".asset")) {
    const active = selected.has(button.item.id);
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", active);
  }
  const asset = current();
  const properties = $("properties");
  properties.replaceChildren();
  if (!asset) {
    const text = document.createElement("p");
    text.textContent = selected.size > 1 ? `已选择 ${selected.size} 个素材` : "选择素材以查看尺寸和蒙版属性。";
    properties.append(text);
  } else {
    properties.innerHTML = '<label>素材名称<input type="text" maxlength="90" id="asset-name"></label>' +
      '<dl class="geometry"></dl><label class="check"><input type="checkbox" id="decontaminate">清理白边</label>' +
      '<small id="edge-note"></small><button class="button" id="asset-preview-button" type="button">单独预览</button> ' +
      '<button class="button" id="expand-mask" type="button">扩展蒙版边界</button>';
    const name = $("asset-name");
    name.value = asset.name;
    name.addEventListener("change", () => {
      const value = name.value.trim();
      if (value && value !== asset.name) updateAsset(asset, { name: value });
      else name.value = asset.name;
    });
    name.addEventListener("keydown", event => { if (event.key === "Enter") name.blur(); });
    properties.querySelector("dl").innerHTML = asset.box.map((value, index) =>
      `<div><dt>${["X", "Y", "W", "H"][index]}</dt><dd>${value} px</dd></div>`).join("");
    $("decontaminate").checked = edgeCleanupEnabled(asset);
    $("decontaminate").disabled = !asset.background;
    $("decontaminate").onchange = event => updateAsset(asset, { edgeCleanup: event.target.checked });
    $("edge-note").textContent = asset.background ? "估算边缘覆盖和颜色，效果随素材保存。" : "此素材没有可用于残色估算的背景颜色。";
    $("asset-preview-button").onclick = () => openPreview(asset);
    $("expand-mask").onclick = () => expandMask(asset);
  }
  refreshToolbar();
  stage.invalidate();
}

function draw(ctx) {
  $("zoom-label").textContent = `${Math.round(stage.zoom * 100)}%`;
  const frame = stage.box([0, 0, image.width, image.height]);
  const editing = tool === "brush" || tool === "erase";
  ctx.imageSmoothingEnabled = stage.zoom < 4;
  ctx.fillStyle = stage.checker;
  ctx.fillRect(...frame);
  if (view === "source" || view === "outline" || view === "compare" || view === "mask" && editing) {
    ctx.drawImage(image, ...frame);
  }
  if (view === "mask" && editing) {
    ctx.fillStyle = "#141a20a0";
    ctx.fillRect(...frame);
  }
  if (["alpha", "compare", "mask"].includes(view)) {
    const assets = selected.size ? project.assets.filter(asset => selected.has(asset.id)) : project.assets;
    ctx.save();
    if (view === "compare") {
      const split = frame[0] + frame[2] * Number($("compare-position").value) / 100;
      ctx.beginPath();
      ctx.rect(split, frame[1], frame[0] + frame[2] - split, frame[3]);
      ctx.clip();
      ctx.fillStyle = stage.checker;
      ctx.fillRect(...frame);
    }
    for (const asset of assets) {
      const box = stage.box(asset.box);
      if (box[0] + box[2] < 0 || box[1] + box[3] < 0 || box[0] > viewport.clientWidth ||
          box[1] > viewport.clientHeight) continue;
      const painting = gesture?.asset === asset && gesture.mask;
      if (view === "mask") {
        const mask = painting || displayMask(asset);
        if (mask) {
          ctx.globalAlpha = editing ? .48 : 1;
          ctx.drawImage(mask, ...box);
          ctx.globalAlpha = 1;
        }
      } else {
        const preview = painting ? compose(image, asset, painting, 480) : stagePreview(asset);
        if (preview) ctx.drawImage(preview, ...box);
      }
    }
    ctx.restore();
    if (view === "compare") {
      const x = frame[0] + frame[2] * Number($("compare-position").value) / 100;
      ctx.strokeStyle = "#aaf0c8";
      ctx.beginPath();
      ctx.moveTo(x, frame[1]);
      ctx.lineTo(x, frame[1] + frame[3]);
      ctx.stroke();
    }
  }
  if (view === "outline" || selected.size && (view === "source" || view === "mask")) {
    for (const asset of project.assets) {
      const active = selected.has(asset.id);
      if (!active && view !== "outline") continue;
      const [x, y, w, h] = stage.box(asset.box);
      ctx.strokeStyle = active ? "#12684e" : "#316e648f";
      ctx.lineWidth = active ? 2 : 1;
      ctx.strokeRect(x, y, w, h);
      if (!active || editing) continue;
      ctx.fillStyle = "#174935";
      ctx.font = "11px Segoe UI, Microsoft YaHei UI, sans-serif";
      const label = asset.name.length > 18 ? asset.name.slice(0, 17) + "…" : asset.name;
      const labelWidth = ctx.measureText(label).width + 12;
      ctx.fillRect(x, y - 17, labelWidth, 17);
      ctx.fillStyle = "#dcfae8";
      ctx.fillText(label, x + 6, y - 5);
      for (const point of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
        ctx.fillStyle = "#b8f5d3";
        ctx.fillRect(point[0] - 2.5, point[1] - 2.5, 5, 5);
      }
    }
  }
  if (gesture?.type === "box" || gesture?.type === "segment" || gesture?.type === "lasso") {
    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = "#aaf0c8";
    ctx.fillStyle = "#4d9e724d";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (gesture.type === "lasso") {
      for (const [x, y] of gesture.points) ctx.lineTo(stage.x + x * stage.zoom, stage.y + y * stage.zoom);
      ctx.closePath();
    } else {
      ctx.rect(...stage.box(selectionBox([gesture.start, gesture.end])));
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  if (editing && hover && current() && !space && !job) {
    ctx.beginPath();
    ctx.arc(...hover, Number($("brush-size").value) * stage.zoom / 2, 0, Math.PI * 2);
    ctx.strokeStyle = "#131a18";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = "#cff8df";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

const maskViews = new WeakMap();
function displayMask(asset) {
  const maximum = selected.size === 1 ? 768 : 260;
  const saved = maskViews.get(asset);
  if (!(saved?.maximum >= maximum)) {
    const entry = { canvas: saved?.canvas, maximum };
    maskViews.set(asset, entry);
    loadMask(asset, maximum).then(canvas => {
      if (maskViews.get(asset) === entry) entry.canvas = canvas;
      stage.invalidate();
    }).catch(() => {});
  }
  return maskViews.get(asset).canvas;
}

function hit(point) {
  const [x, y] = point;
  return project?.assets.filter(asset => {
    const [left, top, w, h] = asset.box;
    return x >= left && x < left + w && y >= top && y < top + h;
  }).sort((a, b) => a.box[2] * a.box[3] - b.box[2] * b.box[3])[0];
}

function selectionBox(points) {
  let x0 = image.width, y0 = image.height, x1 = 0, y1 = 0;
  for (const [x, y] of points) {
    x0 = Math.min(x, x0);
    y0 = Math.min(y, y0);
    x1 = Math.max(x, x1);
    y1 = Math.max(y, y1);
  }
  return [Math.floor(x0), Math.floor(y0), Math.ceil(x1) - Math.floor(x0), Math.ceil(y1) - Math.floor(y0)];
}

function stroke(draft) {
  if (!draft.mask || draft.paintIndex >= draft.points.length) return;
  const ctx = draft.mask.getContext("2d");
  const [x, y] = draft.asset.box;
  const radius = draft.radius;
  ctx.globalCompositeOperation = draft.type === "erase" ? "destination-out" : "source-over";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = radius * 2;
  ctx.strokeStyle = ctx.fillStyle = "#fff";
  if (!draft.paintIndex) {
    const [px, py] = draft.points[0];
    ctx.beginPath();
    ctx.arc(px - x, py - y, radius, 0, 2 * Math.PI);
    ctx.fill();
    draft.paintIndex = 1;
  }
  ctx.beginPath();
  const previous = draft.points[draft.paintIndex - 1];
  ctx.moveTo(previous[0] - x, previous[1] - y);
  for (; draft.paintIndex < draft.points.length; draft.paintIndex++) {
    const point = draft.points[draft.paintIndex];
    ctx.lineTo(point[0] - x, point[1] - y);
  }
  ctx.stroke();
  stage.invalidate();
}

async function expandMask(asset) {
  if (job || gesture || loading) return;
  const original = project;
  try {
    const [x, y, w, h] = asset.box;
    const x0 = Math.max(0, x - 16), y0 = Math.max(0, y - 16);
    const box = [x0, y0, Math.min(image.width, x + w + 16) - x0, Math.min(image.height, y + h + 16) - y0];
    if (box.every((value, index) => value === asset.box[index])) return status("蒙版已到达原图边缘");
    const mask = await loadMask(asset);
    if (project !== original || !selected.has(asset.id)) return;
    const expanded = surface(box[2], box[3]);
    expanded.getContext("2d").drawImage(mask, x - x0, y - y0);
    updateAsset(asset, { box, mask: serializeMask(expanded) });
    status("已在边界增加最多 16 px 的可编辑空间");
  } catch { notify("无法扩展此蒙版。"); }
}

function pointerDown(event) {
  if (!image || gesture || (event.button !== 0 && event.button !== 1) || event.target !== $("canvas")) return;
  if (event.button === 1) event.preventDefault();
  viewport.focus({ preventScroll: true });
  const point = stage.point(event);
  const type = tool === "pan" || event.button === 1 || space ? "pan" : tool;
  if ((job || loading) && type !== "pan") return;
  if (type === "select") return selectAsset(hit(point), event, true);
  if (type === "pan") {
    gesture = { type, start: stage.screen(event), pan: [stage.x, stage.y] };
  } else if (type === "brush" || type === "erase") {
    const asset = current();
    if (!asset) return notify("请选择一个素材后编辑蒙版。");
    const draft = { type, asset, points: [point], radius: Number($("brush-size").value) / 2, paintIndex: 0 };
    gesture = draft;
    draft.loading = loadMask(asset).then(mask => {
      draft.mask = mask;
      if (gesture === draft) stroke(draft);
      return true;
    }).catch(() => {
      if (gesture === draft) notify("无法打开蒙版以进行编辑。");
      return false;
    });
  } else {
    const start = stage.clip(point);
    gesture = { type, start, end: start, points: [start] };
  }
  gesture.id = event.pointerId;
  viewport.setPointerCapture(event.pointerId);
  updateOptions();
  stage.invalidate();
}

function pointerMove(event) {
  hover = stage.screen(event);
  if (gesture?.id === event.pointerId && !gesture.finishing) {
    const draft = gesture;
    if (draft.type === "pan") {
      stage.fitMode = false;
      stage.x = draft.pan[0] + hover[0] - draft.start[0];
      stage.y = draft.pan[1] + hover[1] - draft.start[1];
    } else if (draft.asset) {
      const points = event.getCoalescedEvents?.();
      draft.points.push(...(points?.length ? points.map(item => stage.point(item)) : [stage.point(event)]));
      stroke(draft);
    } else {
      draft.end = stage.clip(stage.point(event));
      if (draft.type === "lasso") draft.points.push(draft.end);
    }
  }
  stage.invalidate();
}

async function finishPointer(event) {
  if (gesture?.id !== event.pointerId) return;
  pointerMove(event);
  const draft = gesture;
  if (draft.asset) {
    draft.finishing = true;
    const ok = await draft.loading;
    if (gesture !== draft) return;
    gesture = null;
    if (ok) {
      updateAsset(draft.asset, { mask: serializeMask(draft.mask) });
      status("蒙版已更新");
    }
  } else {
    gesture = null;
    if (draft.type === "lasso" && draft.points.length > 3) {
      const box = selectionBox(draft.points);
      if (box[2] >= 2 && box[3] >= 2) {
        const mask = surface(box[2], box[3]);
        const ctx = mask.getContext("2d");
        ctx.beginPath();
        for (const [x, y] of draft.points) ctx.lineTo(x - box[0], y - box[1]);
        ctx.closePath();
        ctx.fillStyle = "#fff";
        ctx.fill("evenodd");
        addAsset({ box, mask: serializeMask(mask), background: null });
        status("套索素材已添加");
      }
    } else if (draft.type === "box" || draft.type === "segment") {
      const box = selectionBox([draft.start, draft.end]);
      if (box[2] >= 2 && box[3] >= 2) extract(box, draft.type === "segment" ? $("segment-method").value : "box");
    }
  }
  updateOptions();
  stage.invalidate();
}

function discardGesture() {
  if (!gesture) return;
  const id = gesture.id;
  gesture = null;
  if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
  updateOptions();
  stage.invalidate();
}

function showExport(selectedOnly = false) {
  if (!project?.assets.length || job || loading || gesture) return;
  $("export-scope").querySelector('[value="selected"]').disabled = !selected.size;
  $("export-scope").value = selected.size ? "selected" : "all";
  if (selectedOnly && !selected.size) return;
  $("export-format").value = exportAssets().length === 1 ? "png" : "zip";
  updateExport();
  $("export-dialog").showModal();
}

function exportAssets() {
  return $("export-scope").value === "all" ? project.assets : project.assets.filter(asset => selected.has(asset.id));
}

function updateExport() {
  const count = exportAssets().length;
  $("export-format").querySelector('[value="png"]').disabled = count !== 1;
  if (count !== 1) $("export-format").value = "zip";
  $("export-confirm").disabled = !count;
  $("export-note").textContent = `${count} 个素材，保留原始像素尺寸。`;
}

async function exportCurrent() {
  const assets = exportAssets();
  const format = $("export-format").value;
  const name = safeName(format === "png" ? assets[0].name : project.name);
  await processJob("正在生成导出文件…", async (run, send) => {
    const response = await send("/export", exportBody(project, assets, format));
    const blob = await response.blob();
    if (job !== run) return;
    download(blob, name + "." + format);
    status(`已导出 ${assets.length} 个素材`);
  });
}

function openContext(event, asset) {
  if (!asset || gesture || job || loading) return;
  event.preventDefault();
  if (!selected.has(asset.id)) selectAsset(asset, {}, true);
  contextAsset = asset;
  const menu = $("context");
  menu.hidden = false;
  menu.style.left = Math.max(5, Math.min(event.clientX, innerWidth - menu.offsetWidth - 5)) + "px";
  menu.style.top = Math.max(5, Math.min(event.clientY, innerHeight - menu.offsetHeight - 5)) + "px";
  menu.querySelector("button").focus({ preventScroll: true });
}

function openPreview(asset) {
  if (!asset || job || loading || gesture) return;
  const dialog = $("asset-preview");
  $("preview-name").textContent = asset.name;
  $("preview-size").textContent = `${asset.box[2]} × ${asset.box[3]} px`;
  $("preview-zoom").value = "fit";
  $("preview-edge-label").hidden = !asset.background;
  $("preview-edge").checked = edgeCleanupEnabled(asset);
  dialog.showModal();
  loadPreview(asset);
}

function clearPreview() {
  preview?.controller.abort();
  if (preview?.url) URL.revokeObjectURL(preview.url);
  preview = null;
  $("preview-image").hidden = true;
  $("preview-image").removeAttribute("src");
}

function fitPreview() {
  if (!preview) return;
  const mode = $("preview-zoom").value;
  const [, , w, h] = preview.asset.box;
  const frame = $("preview-stage");
  const scale = mode === "fit" ? Math.min(8, (frame.clientWidth - 40) / w, (frame.clientHeight - 40) / h)
    : Number(mode);
  $("preview-image").style.width = Math.max(1, Math.round(w * scale)) + "px";
  frame.scrollLeft = (frame.scrollWidth - frame.clientWidth) / 2;
  frame.scrollTop = (frame.scrollHeight - frame.clientHeight) / 2;
}

async function loadPreview(asset) {
  clearPreview();
  const item = { asset, controller: new AbortController(), url: null, blob: null };
  preview = item;
  $("preview-status").hidden = false;
  $("preview-status").textContent = "正在生成透明预览…";
  $("preview-download").disabled = true;
  try {
    const response = await request("/export", exportBody(project, [asset], "png"), crypto.randomUUID(), item.controller.signal);
    const blob = await response.blob();
    if (preview !== item) return;
    item.blob = blob;
    item.url = URL.createObjectURL(blob);
    const picture = $("preview-image");
    picture.src = item.url;
    picture.alt = asset.name;
    await picture.decode();
    if (preview !== item) return;
    $("preview-status").hidden = true;
    picture.hidden = false;
    fitPreview();
    $("preview-download").disabled = false;
  } catch (error) {
    if (preview === item) $("preview-status").textContent = error.message || "无法生成预览。";
  }
}

function selectAll() {
  if (!project || job || gesture || loading) return;
  selected = new Set(project.assets.map(asset => asset.id));
  updateSelection();
}

async function refreshRecent() {
  const container = $("recent");
  try {
    await persist;
    const projects = await listProjects();
    container.replaceChildren();
    for (const record of projects.slice(0, 8)) {
      const button = document.createElement("button");
      button.textContent = record.name;
      button.title = record.name;
      button.disabled = record.id === project?.id;
      button.onclick = async () => {
        $("project-menu").open = false;
        try {
          const restored = await getProject(record.id);
          if (restored) await openProject(restored);
        } catch { notify("本机项目无法读取。"); }
      };
      container.append(button);
    }
    if (projects.length) return;
  } catch { /* portable project files still work */ }
  const note = document.createElement("div");
  note.className = "menu-section";
  note.textContent = "暂无本机项目";
  container.replaceChildren(note);
}

async function refreshEngine() {
  let samples = [];
  try {
    ({ model, samples = [] } = await engineStatus());
    ready = true;
  } catch {
    model = ready = false;
  }
  for (const button of all("[data-sample]")) {
    const filename = button.dataset.sample + ".jpg";
    button.hidden = !samples.includes(filename);
    if (!button.hidden) button.querySelector("img").src = "/samples/" + filename;
  }
  $("sample-section").hidden = !samples.length;
  $("engine-state").classList.toggle("online", ready);
  $("engine-state").classList.toggle("offline", !ready);
  $("engine-state").title = ready ? "本机处理服务在线" : "无法连接本机处理服务";
  $("engine-state").querySelector("span").textContent = ready ? "本地引擎在线" : "本地引擎离线";
  for (const id of ["method", "segment-method"]) {
    $(id).querySelector('[value="sam"]').disabled = !model;
    if (!model && $(id).value === "sam") $(id).selectedIndex = 0;
  }
  $("model-note").textContent = model ? "MobileSAM 已就绪，推理在本机运行。" : "尚未安装 MobileSAM，可使用颜色分割。";
}

for (const id of ["import", "empty-import", "new-project"]) {
  $(id).onclick = () => {
    $("project-menu").open = false;
    $("image-input").click();
  };
}
$("image-input").onchange = event => {
  openFile(event.target.files[0]);
  event.target.value = "";
};
$("project-open").onclick = () => {
  $("project-menu").open = false;
  $("project-input").click();
};
$("project-input").onchange = event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  openProject(() => readPortable(file), true);
};
$("project-save").onclick = async () => {
  if (!project) return;
  const snapshot = project;
  $("project-menu").open = false;
  try { download(await portable(snapshot), safeName(snapshot.name) + ".slice"); }
  catch { notify("项目文件生成失败。"); }
};
$("project-menu").addEventListener("toggle", () => { if ($("project-menu").open) refreshRecent(); });
$("analysis-menu").addEventListener("toggle", () => { if ($("analysis-menu").open) refreshEngine(); });
for (const button of all("[data-sample]")) {
  button.onclick = () => {
    const id = button.dataset.sample;
    openProject(async () => {
      const response = await fetch("/samples/" + id + ".jpg");
      if (!response.ok) throw new Error("示例图片暂时无法读取。");
      const name = button.querySelector("span").textContent;
      return { ...makeProject(await response.blob(), id + ".jpg"), name };
    });
  };
}
for (const button of all("[data-tool]")) button.onclick = () => setTool(button.dataset.tool);
for (const button of all("[data-view]")) button.onclick = () => setView(button.dataset.view);
$("analyze").onclick = analyze;
$("undo").onclick = () => undo();
$("redo").onclick = () => undo(true);
$("all-assets").onclick = selectAll;
$("delete").onclick = removeSelection;
$("export").onclick = () => showExport();
$("export-scope").onchange = updateExport;
$("export-dialog").addEventListener("close", () => {
  if ($("export-dialog").returnValue === "export") exportCurrent();
  $("export-dialog").returnValue = "";
});
$("cancel").onclick = cancel;
$("sensitivity").oninput = event => { $("sensitivity-value").textContent = event.target.value; };
$("brush-size").oninput = event => { $("brush-value").textContent = event.target.value + " px"; stage.invalidate(); };
$("compare-position").oninput = () => stage.invalidate();
$("zoom-out").onclick = () => stage.scaleBy(.8);
$("zoom-in").onclick = () => stage.scaleBy(1.25);
$("zoom-label").onclick = $("fit").onclick = () => stage.fit();
$("help-button").onclick = () => $("help-dialog").showModal();
$("notice-close").onclick = () => { $("notice").hidden = true; };
$("context-preview").onclick = () => { $("context").hidden = true; openPreview(contextAsset); };
$("context-focus").onclick = () => { $("context").hidden = true; stage.focus(contextAsset.box); };
$("context-export").onclick = () => { $("context").hidden = true; showExport(true); };
$("context-delete").onclick = () => { $("context").hidden = true; removeSelection(); };
$("preview-close").onclick = () => $("asset-preview").close();
$("asset-preview").addEventListener("close", clearPreview);
$("preview-background").onchange = event => { $("preview-stage").dataset.background = event.target.value; };
$("preview-zoom").onchange = fitPreview;
new ResizeObserver(fitPreview).observe($("preview-stage"));
$("preview-edge").onchange = event => {
  if (!preview) return;
  const asset = preview.asset;
  updateAsset(asset, { edgeCleanup: event.target.checked });
  loadPreview(project.assets.find(item => item.id === asset.id));
};
$("preview-download").onclick = () => {
  if (preview?.blob) download(preview.blob, safeName(preview.asset.name) + ".png");
};
document.querySelector(".panel-toggle").onclick = event => {
  const open = $("inspector").classList.toggle("open");
  event.currentTarget.setAttribute("aria-expanded", open);
};

viewport.addEventListener("pointerdown", pointerDown);
viewport.addEventListener("pointermove", pointerMove);
viewport.addEventListener("pointerup", finishPointer);
viewport.addEventListener("pointercancel", discardGesture);
viewport.addEventListener("pointerleave", () => { hover = null; stage.invalidate(); });
viewport.addEventListener("contextmenu", event => {
  if (image) { event.preventDefault(); openContext(event, hit(stage.point(event))); }
});
viewport.addEventListener("wheel", event => {
  if (!image || gesture) return;
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 150 : 1);
  stage.scaleBy(Math.exp(-Math.max(-250, Math.min(250, delta)) * .002), stage.screen(event));
}, { passive: false });
let dragDepth = 0;
viewport.addEventListener("dragenter", event => {
  if (!event.dataTransfer.types.includes("Files") || job || loading) return;
  event.preventDefault();
  dragDepth++;
  $("drop-hint").hidden = false;
});
viewport.addEventListener("dragover", event => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = job || loading ? "none" : "copy";
});
viewport.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop-hint").hidden = true;
});
viewport.addEventListener("drop", event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  dragDepth = 0;
  $("drop-hint").hidden = true;
  const file = event.dataTransfer.files[0];
  if (file.name.toLowerCase().endsWith(".slice")) {
    openProject(() => readPortable(file), true);
  } else openFile(file);
});

document.addEventListener("pointerdown", event => {
  for (const menu of all("details.menu[open]")) if (!menu.contains(event.target)) menu.open = false;
  if (!$("context").contains(event.target)) $("context").hidden = true;
});
const shortcuts = { v: "select", m: "box", w: "segment", l: "lasso", b: "brush", e: "erase", h: "pan" };
document.addEventListener("keydown", event => {
  if (document.querySelector("dialog[open]")) return;
  const key = event.key.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  if (key === "escape") {
    $("context").hidden = $("notice").hidden = true;
    for (const menu of all("details.menu[open]")) menu.open = false;
    if (job) cancel();
    else if (gesture) discardGesture();
    else if (project) selectAsset(null);
    return;
  }
  if (event.target.matches("input, select, textarea, [contenteditable]")) return;
  if (modifier && key === "o") { event.preventDefault(); if (!job && !loading) $("image-input").click(); return; }
  if (!image) return;
  if (modifier && ["z", "y", "a", "s"].includes(key)) {
    event.preventDefault();
    if (key === "z" || key === "y") undo(key === "y" || event.shiftKey);
    if (key === "a") selectAll();
    if (key === "s") $("project-save").click();
    return;
  }
  if (modifier || event.altKey) return;
  if (key === " " && !event.target.closest("button, summary, a")) {
    event.preventDefault();
    space = true;
    updateOptions();
  }
  if (key === "0") stage.fit();
  if (key === "delete" || key === "backspace") { event.preventDefault(); removeSelection(); }
  if (shortcuts[key] && !job) setTool(shortcuts[key]);
});
window.addEventListener("keyup", event => {
  if (event.key === " ") { space = false; updateOptions(); }
});
window.addEventListener("blur", () => {
  space = false;
  discardGesture();
  updateOptions();
});
window.addEventListener("online", refreshEngine);

render();
refreshEngine();
try {
  const active = localStorage.getItem("slice-studio-active");
  if (active) getProject(active).then(saved => {
    if (saved && !project) openProject(saved);
  }).catch(() => notify("本机项目恢复失败，可打开备份项目文件。"));
} catch { /* optional autoload */ }

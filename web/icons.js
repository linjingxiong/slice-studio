const paths = {
  logo: '<path d="M3 8V5a2 2 0 0 1 2-2h3m8 0h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3m3 1L17 6m-5 0h5v5"/>',
  folder: '<path d="M3 7V5h6l2 2h10v12H3z"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.35-1 1-1 1.7m0 3h.01"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  spark: '<path d="M11 3c.7 5.1 2.9 7.3 8 8-5.1.7-7.3 2.9-8 8-.7-5.1-2.9-7.3-8-8 5.1-.7 7.3-2.9 8-8Zm8 12v6m-3-3h6"/>',
  undo: '<path d="M8 5 3 10l5 5m-5-5h11a5 5 0 0 1 0 10h-2"/>',
  redo: '<path d="m16 5 5 5-5 5m5-5H10a5 5 0 0 0 0 10h2"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  cursor: '<path d="M5 3v15l4-4 3 6 3-1-3-6h6z"/>',
  frame: '<path d="M3 8V4h5m8 0h5v4m0 8v4h-5m-8 0H3v-4m0-5v2m18-2v2M11 4h2m-2 16h2"/>',
  wand: '<path d="m4 19 11-11 3 3L7 22zm9-9 3 3m3-10v4m-2-2h4M7 4v4M5 6h4m10 10v4m-2-2h4"/>',
  lasso: '<path d="M7 16c-3-1-4-3-4-6 0-4 4-6 9-6s9 3 9 6-4 6-8 6c-3 0-5-1-5-2 0-2 4-2 4 1 0 2-3 3-3 6"/>',
  brush: '<path d="M10 15s2-3 8-11c1-1 3 0 2 2-4 8-6 10-8 11m-2-2c-5-2-5 3-7 5 4 1 9 0 9-3z"/>',
  eraser: '<path d="m4 13 9-9a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3l-9 9H8l-4-4a2 2 0 0 1 0-3Zm4-4 8 8m-5 3h10"/>',
  hand: '<path d="M8 13V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v5c0 5-2 7-6 7-4 0-6-3-7-5l-3-4a1.5 1.5 0 0 1 2-2z"/>',
  plus: '<path d="M5 12h14m-7-7v14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M8 4H4v4m12-4h4v4m0 8v4h-4m-8 0H4v-4"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-4 3 2 4-5 6 6"/>',
  multi: '<rect x="7" y="7" width="13" height="13" rx="1"/><path d="M16 4H4v12m6-3 2 2 4-4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3m3 0-1 15H7L6 6m4 4v7m4-7v7"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};

export function icon(name) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + paths[name] + '</svg>';
}

for (const node of document.querySelectorAll("[data-icon]")) node.innerHTML = icon(node.dataset.icon);

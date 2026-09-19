import type { Doc, DocKind, InputInfo, Pt, Rgba, ToolId, ToolOptions } from './types';
import { BASIC_COLORS, css, fromHex, hex, same } from './color';
import { activeLayer, composite, compositeToCanvas, createDoc, createLayer, ctx2d, rasterizeLayer } from './document';
import { History } from './history';
import { Tools, type AppCtx } from './tools';
import { download, exportPng, exportPsd, exportSvg } from './exporters';
import { PROJECT_FILE, deserialize, serialize, type Manifest } from './project';
import { ConflictError, GitHubSync, type GhConfig } from './github';
import { ICONS } from './icons';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------- 状態 ----------------
let doc: Doc = createDoc('bitmap', 1024, 768);
let color: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const options: ToolOptions = { size: 6, fill: false, tolerance: 24, pressure: true, sampleAll: false };
let fingerDraws = true;
const history = new History();
let zoom = 1, panX = 0, panY = 0;
let docName = 'drawing';

const view = $<HTMLCanvasElement>('view');
const vctx = view.getContext('2d')!;
const viewport = $('viewport');

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; draw(); });
}

const app: AppCtx = {
  get doc() { return doc; },
  get color() { return color; },
  options,
  history,
  get zoom() { return zoom; },
  render: requestRender,
  dirty: markDirty,
  pickColor: setColor,
  compositeData: () => ctx2d(compositeToCanvas(doc)).getImageData(0, 0, doc.width, doc.height),
};
const tools = new Tools(app);

// ---------------- 描画 ----------------
const checker = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d')!;
  x.fillStyle = '#ccc'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#fff'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  return c;
})();
let cursorPos: Pt | null = null;

let lastViewportSize = { w: 0, h: 0 };
function resizeView() {
  const dpr = devicePixelRatio || 1;
  const r = viewport.getBoundingClientRect();
  view.width = Math.max(1, Math.round(r.width * dpr));
  view.height = Math.max(1, Math.round(r.height * dpr));
  // 起動直後など、極小サイズから通常サイズになったときは全体表示にし直す
  const wasTiny = lastViewportSize.w < 200 || lastViewportSize.h < 200;
  lastViewportSize = { w: r.width, h: r.height };
  if (wasTiny && r.width >= 200 && r.height >= 200) zoomFit();
  else requestRender();
}

function draw() {
  const dpr = devicePixelRatio || 1;
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.clearRect(0, 0, view.width, view.height);
  vctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, panX * dpr, panY * dpr);
  vctx.imageSmoothingEnabled = zoom < 2;
  vctx.save();
  vctx.beginPath();
  vctx.rect(0, 0, doc.width, doc.height);
  vctx.clip();
  vctx.fillStyle = vctx.createPattern(checker, 'repeat')!;
  vctx.save(); vctx.scale(1 / zoom, 1 / zoom); vctx.fillRect(0, 0, doc.width * zoom, doc.height * zoom); vctx.restore();
  composite(doc, vctx, tools.layerHook);
  vctx.restore();
  vctx.strokeStyle = '#000';
  vctx.lineWidth = 1 / zoom;
  vctx.strokeRect(0, 0, doc.width, doc.height);
  tools.drawOverlay(vctx, zoom);
  // ブラシカーソル: 描く線と同じ太さの円(ドキュメント座標なのでズームに追従)
  if (cursorPos && (tools.tool === 'pen' || tools.tool === 'eraser')) {
    vctx.beginPath();
    vctx.arc(cursorPos.x, cursorPos.y, options.size / 2, 0, Math.PI * 2);
    vctx.strokeStyle = 'rgba(0,0,0,.6)'; vctx.lineWidth = 1 / zoom; vctx.stroke();
    vctx.strokeStyle = 'rgba(255,255,255,.6)'; vctx.setLineDash([3 / zoom, 3 / zoom]); vctx.stroke();
    vctx.setLineDash([]);
  }
}

// ---------------- ビュー操作 ----------------
const clampZoom = (z: number) => Math.min(32, Math.max(0.05, z));
function updateZoomLabel() { $('zoom-label').textContent = `${Math.round(zoom * 100)}%`; }
function zoomAt(clientX: number, clientY: number, factor: number) {
  const r = view.getBoundingClientRect();
  const dx = (clientX - r.left - panX) / zoom, dy = (clientY - r.top - panY) / zoom;
  zoom = clampZoom(zoom * factor);
  panX = clientX - r.left - dx * zoom;
  panY = clientY - r.top - dy * zoom;
  updateZoomLabel();
  requestRender();
}
function zoomFit() {
  const r = viewport.getBoundingClientRect();
  zoom = clampZoom(Math.min((r.width - 40) / doc.width, (r.height - 40) / doc.height));
  panX = (r.width - doc.width * zoom) / 2;
  panY = (r.height - doc.height * zoom) / 2;
  updateZoomLabel();
  requestRender();
}
function toDoc(ev: { clientX: number; clientY: number }): Pt {
  const r = view.getBoundingClientRect();
  return { x: (ev.clientX - r.left - panX) / zoom, y: (ev.clientY - r.top - panY) / zoom };
}
const info = (ev: PointerEvent): InputInfo => ({ pressure: ev.pressure, pen: ev.pointerType === 'pen', shift: ev.shiftKey });

const pointers = new Map<number, Pt>();
let mode: 'none' | 'draw' | 'pan' | 'pinch' = 'none';
let panStart = { x: 0, y: 0, px: 0, py: 0 };
let pinchStart = { dist: 1, zoom: 1, docX: 0, docY: 0 };
let spaceDown = false;
let penSeen = false;

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}

view.addEventListener('pointerdown', ev => {
  view.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (ev.pointerType === 'pen' && !penSeen) {
    penSeen = true;
    fingerDraws = false;
    $<HTMLInputElement>('opt-finger').checked = false;
  }
  if (ev.pointerType === 'touch' && pointers.size === 2) {
    if (mode === 'draw') tools.cancel();
    const p = pinchInfo();
    const d = toDoc({ clientX: p.cx, clientY: p.cy });
    pinchStart = { dist: p.dist, zoom, docX: d.x, docY: d.y };
    mode = 'pinch';
    return;
  }
  if (pointers.size > 1) return;
  if (tools.tool === 'zoom' && ev.button === 0 && !spaceDown) {
    zoomAt(ev.clientX, ev.clientY, ev.altKey ? 0.8 : 1.25);
    return;
  }
  const wantPan = tools.tool === 'hand' || spaceDown || ev.button === 1 || (ev.pointerType === 'touch' && !fingerDraws);
  if (wantPan) {
    mode = 'pan';
    panStart = { x: ev.clientX, y: ev.clientY, px: panX, py: panY };
    return;
  }
  if (ev.button !== 0) return;
  mode = 'draw';
  tools.down(toDoc(ev), info(ev));
});

view.addEventListener('pointermove', ev => {
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  cursorPos = toDoc(ev);
  if (mode === 'pinch' && pointers.size >= 2) {
    const p = pinchInfo();
    const r = view.getBoundingClientRect();
    zoom = clampZoom(pinchStart.zoom * p.dist / pinchStart.dist);
    panX = p.cx - r.left - pinchStart.docX * zoom;
    panY = p.cy - r.top - pinchStart.docY * zoom;
    updateZoomLabel();
  } else if (mode === 'pan') {
    panX = panStart.px + (ev.clientX - panStart.x);
    panY = panStart.py + (ev.clientY - panStart.y);
  } else if (mode === 'draw' && pointers.has(ev.pointerId)) {
    const events = typeof ev.getCoalescedEvents === 'function' && ev.getCoalescedEvents().length ? ev.getCoalescedEvents() : [ev];
    for (const e of events) tools.move(toDoc(e), info(e));
  }
  requestRender();
});

function pointerEnd(ev: PointerEvent) {
  const had = pointers.delete(ev.pointerId);
  if (mode === 'pinch') { if (pointers.size < 2) mode = 'none'; return; }
  if (!had) return;
  if (mode === 'draw') tools.up(toDoc(ev), info(ev));
  mode = 'none';
  requestRender();
}
view.addEventListener('pointerup', pointerEnd);
view.addEventListener('pointercancel', pointerEnd);
view.addEventListener('pointerleave', () => { cursorPos = null; requestRender(); });
view.addEventListener('contextmenu', ev => ev.preventDefault());
view.addEventListener('wheel', ev => {
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * 0.002));
  else { panX -= ev.deltaX; panY -= ev.deltaY; requestRender(); }
}, { passive: false });

// ---------------- ツール ----------------
interface ToolDef { id: ToolId; label: string; key: string; }
/** 既定の並び(Photoshop のツールパネル順に近い) */
const TOOL_DEFS: ToolDef[] = [
  { id: 'move', label: '移動', key: 'V' },
  { id: 'select', label: '長方形選択', key: 'M' },
  { id: 'lasso', label: 'なげなわ', key: 'L' },
  { id: 'eyedropper', label: 'スポイト', key: 'I' },
  { id: 'pen', label: 'ブラシ', key: 'B' },
  { id: 'eraser', label: '消しゴム', key: 'E' },
  { id: 'bucket', label: '塗りつぶし', key: 'G' },
  { id: 'rect', label: '長方形', key: 'U で切替' },
  { id: 'ellipse', label: '楕円', key: 'U で切替' },
  { id: 'line', label: 'ライン', key: 'U で切替' },
  { id: 'scale', label: '自由変形(拡大・縮小)', key: 'Ctrl+T' },
  { id: 'rotate', label: '回転', key: 'R' },
  { id: 'hand', label: '手のひら', key: 'H / Space' },
  { id: 'zoom', label: 'ズーム(Alt+クリックで縮小)', key: 'Z' },
];
const TOOL_ORDER_KEY = 'oekaki.toolOrder';
function loadToolOrder(): ToolId[] {
  const all = TOOL_DEFS.map(d => d.id);
  try {
    const saved = JSON.parse(localStorage.getItem(TOOL_ORDER_KEY) || 'null');
    if (Array.isArray(saved)) {
      const valid = saved.filter((id: ToolId) => all.includes(id));
      return [...valid, ...all.filter(id => !valid.includes(id))];
    }
  } catch { /* ignore */ }
  return all;
}
let toolOrder = loadToolOrder();
let dragToolId: ToolId | null = null;

/** ツールバーを生成。ボタンはドラッグ&ドロップで並べ替えでき、順序は localStorage に保存 */
function renderToolbar() {
  const bar = $('toolbar');
  bar.innerHTML = '';
  const clearDropMarks = () => bar.querySelectorAll('button').forEach(x => x.classList.remove('drop-before', 'drop-after'));
  const isBefore = (b: HTMLElement, clientY: number) => clientY < b.getBoundingClientRect().top + b.offsetHeight / 2;
  for (const id of toolOrder) {
    const def = TOOL_DEFS.find(d => d.id === id)!;
    const b = document.createElement('button');
    b.dataset.tool = id;
    b.title = `${def.label} (${def.key})`;
    b.innerHTML = ICONS[id];
    b.draggable = true;
    b.classList.toggle('active', tools.tool === id);
    b.addEventListener('click', () => setTool(id));
    b.addEventListener('dragstart', ev => {
      dragToolId = id;
      b.classList.add('dragging');
      ev.dataTransfer?.setData('text/plain', id);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    });
    b.addEventListener('dragend', () => { dragToolId = null; b.classList.remove('dragging'); clearDropMarks(); });
    b.addEventListener('dragover', ev => {
      if (!dragToolId || dragToolId === id) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      const before = isBefore(b, ev.clientY);
      b.classList.toggle('drop-before', before);
      b.classList.toggle('drop-after', !before);
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop-before', 'drop-after'));
    b.addEventListener('drop', ev => {
      ev.preventDefault();
      const from = dragToolId;
      if (!from || from === id) return;
      const before = isBefore(b, ev.clientY);
      toolOrder = toolOrder.filter(t => t !== from);
      toolOrder.splice(toolOrder.indexOf(id) + (before ? 0 : 1), 0, from);
      localStorage.setItem(TOOL_ORDER_KEY, JSON.stringify(toolOrder));
      dragToolId = null;
      renderToolbar();
    });
    bar.appendChild(b);
  }
}

const CURSORS: Partial<Record<ToolId, string>> = {
  hand: 'grab', move: 'move', eyedropper: 'copy', bucket: 'cell', select: 'crosshair', lasso: 'crosshair',
  zoom: 'zoom-in', pen: 'none', eraser: 'none',
};
function setTool(t: ToolId) {
  tools.setTool(t);
  document.querySelectorAll<HTMLButtonElement>('#toolbar button').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  view.style.cursor = CURSORS[t] ?? 'crosshair';
}

// Photoshop 準拠のショートカット
const KEY_TOOLS: Record<string, ToolId> = { v: 'move', m: 'select', l: 'lasso', i: 'eyedropper', b: 'pen', e: 'eraser', g: 'bucket', r: 'rotate', h: 'hand', z: 'zoom' };
const SHAPE_CYCLE: ToolId[] = ['rect', 'ellipse', 'line'];
function setBrushSize(n: number) {
  options.size = Math.max(1, Math.min(100, Math.round(n)));
  $<HTMLInputElement>('opt-size').value = String(options.size);
  $('opt-size-label').textContent = String(options.size);
  requestRender();
}
const brushStep = (s: number) => (s < 10 ? 1 : s < 50 ? 5 : 10);
function selectAll() {
  tools.commitFloating();
  const layer = activeLayer(doc);
  if (layer.kind === 'vector') layer.shapes.forEach(s => tools.selectedShapes.add(s.id));
  else tools.selection = { kind: 'rect', points: [{ x: 0, y: 0 }, { x: doc.width, y: doc.height }] };
  requestRender();
}
function zoomCenter(factor: number) {
  const r = view.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}
window.addEventListener('keydown', ev => {
  const t = ev.target as HTMLElement;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.closest('dialog')) return;
  if (ev.code === 'Space') { spaceDown = true; ev.preventDefault(); return; }
  const k = ev.key.toLowerCase();
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod) {
    let handled = true;
    switch (k) {
      case 'z': ev.shiftKey ? redo() : undo(); break;           // Ctrl+Z / Ctrl+Shift+Z(Ctrl+Alt+Z も取り消し)
      case 'y': redo(); break;
      case 's': saveProject(); break;
      case 't': setTool('scale'); break;                         // 自由変形
      case 'd': tools.deselect(); afterEdit(); break;            // 選択解除
      case 'a': selectAll(); break;                              // すべてを選択
      case '0': zoomFit(); break;                                // 画面サイズに合わせる
      case '1': zoomCenter(1 / zoom); break;                     // 100%
      case '=': case '+': case ';': zoomCenter(1.25); break;     // ズームイン
      case '-': zoomCenter(0.8); break;                          // ズームアウト
      case 'n': if (ev.shiftKey) $('btn-layer-add').click(); else handled = false; break; // 新規レイヤー
      default: handled = false;
    }
    if (handled) ev.preventDefault();
    return;
  }
  if (KEY_TOOLS[k]) { setTool(KEY_TOOLS[k]); return; }
  if (k === 'u') {                                               // 図形ツールを切り替え
    const i = SHAPE_CYCLE.indexOf(tools.tool);
    setTool(i < 0 ? SHAPE_CYCLE[0] : SHAPE_CYCLE[(i + 1) % SHAPE_CYCLE.length]);
    return;
  }
  if (k === '[') { setBrushSize(options.size - brushStep(options.size)); return; }
  if (k === ']') { setBrushSize(options.size + brushStep(options.size)); return; }
  if (k === 'd') { setColor({ r: 0, g: 0, b: 0, a: 1 }); return; }   // 初期設定の色
  if (k === 'enter') { tools.commitFloating(); afterEdit(); }
  else if (k === 'escape') { tools.cancel(); tools.deselect(); afterEdit(); }
  else if (k === 'delete' || k === 'backspace') { tools.deleteSelection(); afterEdit(); }
});
window.addEventListener('keyup', ev => { if (ev.code === 'Space') spaceDown = false; });

function undo() { tools.cancel(); tools.commitFloating(); if (history.undo(doc)) { markDirty(); afterEdit(); } }
function redo() { tools.cancel(); tools.commitFloating(); if (history.redo(doc)) { markDirty(); afterEdit(); } }
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
$('btn-zoom-in').addEventListener('click', () => { const r = view.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25); });
$('btn-zoom-out').addEventListener('click', () => { const r = view.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8); });
$('btn-zoom-fit').addEventListener('click', zoomFit);

function afterEdit() {
  requestRender();
  scheduleLayerPanel();
  $<HTMLButtonElement>('btn-undo').disabled = !history.canUndo;
  $<HTMLButtonElement>('btn-redo').disabled = !history.canRedo;
}

// ---------------- 色 ----------------
function setColor(c: Rgba) {
  color = c;
  $('current-color').style.setProperty('--c', css(c));
  $<HTMLInputElement>('color-input').value = hex(c);
  $<HTMLInputElement>('alpha-input').value = String(Math.round(c.a * 100));
  $('alpha-label').textContent = String(Math.round(c.a * 100));
  document.querySelectorAll<HTMLElement>('.swatch').forEach(s => s.classList.toggle('selected', same(JSON.parse(s.dataset.c!), c)));
}
$<HTMLInputElement>('color-input').addEventListener('input', ev => setColor(fromHex((ev.target as HTMLInputElement).value, color.a)));
$<HTMLInputElement>('alpha-input').addEventListener('input', ev => setColor({ ...color, a: Number((ev.target as HTMLInputElement).value) / 100 }));
$('btn-add-color').addEventListener('click', () => {
  if (doc.palette.some(p => same(p, color))) return;
  doc.palette.push({ ...color });
  markDirty();
  renderPalette();
});
function renderPalette() {
  const el = $('palette');
  el.innerHTML = '';
  const make = (c: Rgba, custom: boolean) => {
    const s = document.createElement('div');
    s.className = 'swatch';
    s.dataset.c = JSON.stringify(c);
    s.style.setProperty('--c', css(c));
    s.title = `${hex(c)} / ${Math.round(c.a * 100)}%`;
    s.addEventListener('click', () => setColor({ ...c }));
    if (custom) {
      const d = document.createElement('span');
      d.className = 'del';
      d.textContent = '×';
      d.title = '登録色を削除';
      d.addEventListener('click', ev => { ev.stopPropagation(); doc.palette = doc.palette.filter(p => p !== c); markDirty(); renderPalette(); });
      s.appendChild(d);
    }
    el.appendChild(s);
  };
  BASIC_COLORS.forEach(c => make(c, false));
  doc.palette.forEach(c => make(c, true));
  setColor(color);
}

// ---------------- ツール設定 ----------------
const bindRange = (id: string, key: 'size' | 'tolerance') => {
  const input = $<HTMLInputElement>(id);
  input.value = String(options[key]);
  input.addEventListener('input', () => { options[key] = Number(input.value); $(`${id}-label`).textContent = input.value; requestRender(); });
};
bindRange('opt-size', 'size');
bindRange('opt-tolerance', 'tolerance');
$<HTMLInputElement>('opt-fill').addEventListener('change', ev => (options.fill = (ev.target as HTMLInputElement).checked));
$<HTMLInputElement>('opt-pressure').addEventListener('change', ev => (options.pressure = (ev.target as HTMLInputElement).checked));
$<HTMLInputElement>('opt-sample-all').addEventListener('change', ev => (options.sampleAll = (ev.target as HTMLInputElement).checked));
$<HTMLInputElement>('opt-finger').addEventListener('change', ev => (fingerDraws = (ev.target as HTMLInputElement).checked));

// ---------------- レイヤー ----------------
let layerPanelTimer = 0;
function scheduleLayerPanel() {
  clearTimeout(layerPanelTimer);
  layerPanelTimer = window.setTimeout(renderLayers, 250);
}
function setActiveLayer(id: string) {
  if (doc.activeLayerId === id) return;
  tools.cancel();
  tools.commitFloating();
  tools.selectedShapes.clear();
  doc.activeLayerId = id;
  renderLayers();
  requestRender();
}
function renderLayers() {
  const el = $('layers');
  el.innerHTML = '';
  for (const l of [...doc.layers].reverse()) {
    const row = document.createElement('div');
    row.className = 'layer' + (l.id === doc.activeLayerId ? ' active' : '');
    const eye = document.createElement('input');
    eye.type = 'checkbox';
    eye.checked = l.visible;
    eye.title = '表示';
    eye.addEventListener('change', () => { l.visible = eye.checked; markDirty(); requestRender(); });
    eye.addEventListener('click', ev => ev.stopPropagation());
    const thumb = document.createElement('canvas');
    thumb.className = 'thumb';
    thumb.width = 32; thumb.height = 24;
    const tc = thumb.getContext('2d')!;
    const src = l.kind === 'bitmap' ? l.canvas : rasterizeLayer(doc, l);
    const s = Math.min(32 / doc.width, 24 / doc.height);
    tc.drawImage(src, (32 - doc.width * s) / 2, (24 - doc.height * s) / 2, doc.width * s, doc.height * s);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = l.name;
    name.title = l.name;
    const op = document.createElement('input');
    op.type = 'range'; op.min = '0'; op.max = '100'; op.value = String(Math.round(l.opacity * 100));
    op.title = '不透明度';
    op.addEventListener('input', () => { l.opacity = Number(op.value) / 100; requestRender(); });
    op.addEventListener('change', markDirty);
    op.addEventListener('pointerdown', ev => ev.stopPropagation());
    row.append(eye, thumb, name, op);
    row.addEventListener('click', () => setActiveLayer(l.id));
    el.appendChild(row);
  }
  $('doc-info').textContent = `${doc.kind === 'bitmap' ? 'ビットマップ' : 'ベジェ'} ${doc.width}×${doc.height}`;
}
$('btn-layer-add').addEventListener('click', () => {
  tools.commitFloating();
  const idx = doc.layers.findIndex(l => l.id === doc.activeLayerId);
  const l = createLayer(doc.kind, doc.width, doc.height, `レイヤー ${doc.layers.length + 1}`);
  doc.layers.splice(idx + 1, 0, l);
  doc.activeLayerId = l.id;
  tools.selectedShapes.clear();
  markDirty(); renderLayers(); requestRender();
});
$('btn-layer-del').addEventListener('click', () => {
  if (doc.layers.length <= 1) return;
  tools.cancel(); tools.floating = null; tools.selectedShapes.clear();
  const idx = doc.layers.findIndex(l => l.id === doc.activeLayerId);
  doc.layers.splice(idx, 1);
  doc.activeLayerId = doc.layers[Math.min(idx, doc.layers.length - 1)].id;
  markDirty(); renderLayers(); requestRender();
});
const moveLayer = (dir: 1 | -1) => {
  tools.commitFloating();
  const idx = doc.layers.findIndex(l => l.id === doc.activeLayerId);
  const j = idx + dir;
  if (j < 0 || j >= doc.layers.length) return;
  [doc.layers[idx], doc.layers[j]] = [doc.layers[j], doc.layers[idx]];
  markDirty(); renderLayers(); requestRender();
};
$('btn-layer-up').addEventListener('click', () => moveLayer(1));
$('btn-layer-down').addEventListener('click', () => moveLayer(-1));
$('btn-layer-rename').addEventListener('click', () => {
  const l = activeLayer(doc);
  const n = prompt('レイヤー名', l.name);
  if (n && n.trim()) { l.name = n.trim(); markDirty(); renderLayers(); }
});

// ---------------- ドキュメント ----------------
function loadDoc(d: Doc, name?: string) {
  tools.reset();
  history.clear();
  doc = d;
  if (name) docName = name;
  renderPalette();
  renderLayers();
  zoomFit();
  afterEdit();
}
function newDoc(kind: DocKind, w: number, h: number) {
  loadDoc(createDoc(kind, w, h));
  sync.lastSha = null;
  sync.synced = false;
  sync.dirty = false;
  updateSyncStatus();
}

const dlgNew = $<HTMLDialogElement>('dlg-new');
$('btn-new').addEventListener('click', () => dlgNew.showModal());
$('new-cancel').addEventListener('click', () => dlgNew.close());
$('new-ok').addEventListener('click', () => {
  const w = Math.max(1, Math.min(8192, Number($<HTMLInputElement>('new-width').value) || 1024));
  const h = Math.max(1, Math.min(8192, Number($<HTMLInputElement>('new-height').value) || 768));
  if (sync.dirty && !confirm('未保存の変更があります。新規作成しますか?')) return;
  newDoc($<HTMLSelectElement>('new-kind').value as DocKind, w, h);
  dlgNew.close();
});

async function saveProject() {
  tools.commitFloating();
  const { manifest } = await serialize(doc, 'embed');
  download(new Blob([JSON.stringify(manifest)], { type: 'application/json' }), `${docName}.json`);
}
$('btn-save').addEventListener('click', saveProject);
$('btn-open').addEventListener('click', () => $<HTMLInputElement>('file-open').click());
$<HTMLInputElement>('file-open').addEventListener('change', async ev => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const m = JSON.parse(await f.text()) as Manifest;
    loadDoc(await deserialize(m, async () => null), f.name.replace(/\.json$/i, ''));
    sync.dirty = true;
  } catch (e) { alert('読み込みに失敗しました: ' + (e as Error).message); }
  (ev.target as HTMLInputElement).value = '';
});
$('btn-png').addEventListener('click', () => { tools.commitFloating(); exportPng(doc, docName); });
$('btn-psd').addEventListener('click', async () => {
  tools.commitFloating();
  try { await exportPsd(doc, docName); } catch (e) { alert('PSD 書き出しに失敗: ' + (e as Error).message); }
});
$('btn-svg').addEventListener('click', () => { tools.commitFloating(); exportSvg(doc, docName); });

// ---------------- ローカル自動保存 ----------------
const AUTOSAVE_KEY = 'oekaki.autosave';
let autosaveTimer = 0;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(async () => {
    try {
      const { manifest } = await serialize(doc, 'embed');
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ name: docName, manifest }));
    } catch { /* 容量超過などは無視 */ }
  }, 1500);
}
async function restoreAutosave(): Promise<boolean> {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const { name, manifest } = JSON.parse(raw);
    loadDoc(await deserialize(manifest, async () => null), name);
    return true;
  } catch { return false; }
}

function markDirty() {
  sync.dirty = true;
  sync.lastEdit = Date.now();
  scheduleLayerPanel();
  scheduleAutosave();
  updateSyncStatus();
}
window.addEventListener('beforeunload', ev => { if (sync.dirty && sync.gh) ev.preventDefault(); });

// ---------------- GitHub 同期 ----------------
const GH_KEY = 'oekaki.github';
const sync = {
  gh: null as GitHubSync | null,
  auto: true,
  lastSha: null as string | null,
  /** 一度でも pull/push に成功していれば true(自動プッシュの条件) */
  synced: false,
  dirty: false,
  lastEdit: 0,
  busy: false,
  conflict: false,
};
function setStatus(msg: string, cls: '' | 'ok' | 'err' = '') {
  const el = $('sync-status');
  el.textContent = msg;
  el.className = cls;
  $('gh-msg').textContent = msg;
}
function updateSyncStatus() {
  if (!sync.gh) { setStatus(''); $('btn-sync-now').hidden = true; return; }
  $('btn-sync-now').hidden = false;
  if (sync.busy || sync.conflict) return;
  if (!sync.synced) setStatus('GitHub: 未同期(プルかプッシュを実行)');
  else if (sync.dirty) setStatus('GitHub: 変更あり' + (sync.auto ? '(自動プッシュ待ち)' : ''));
  else setStatus('GitHub: 同期済み', 'ok');
}
function loadGhConfig(): (GhConfig & { auto: boolean }) | null {
  try { return JSON.parse(localStorage.getItem(GH_KEY) || 'null'); } catch { return null; }
}
function applyGhConfig(cfg: (GhConfig & { auto: boolean }) | null) {
  sync.gh = cfg && cfg.token && cfg.owner && cfg.repo ? new GitHubSync(cfg) : null;
  sync.auto = cfg?.auto ?? true;
  if (cfg?.dir) docName = cfg.dir;
  sync.lastSha = null;
  sync.synced = false;
  sync.conflict = false;
  updateSyncStatus();
}
async function push(force = false) {
  if (!sync.gh || sync.busy || tools.busy) return;
  sync.busy = true;
  tools.commitFloating();
  setStatus('GitHub: プッシュ中…');
  try {
    const { manifest, files } = await serialize(doc, 'files');
    const repoFiles = [
      { path: PROJECT_FILE, content: JSON.stringify(manifest) },
      ...(await Promise.all(files.map(async f => ({ path: f.path, content: new Uint8Array(await f.blob.arrayBuffer()) })))),
    ];
    sync.lastSha = await sync.gh.commitFiles(repoFiles, `update ${docName} ${new Date().toISOString()}`, { expectedHead: sync.lastSha, force });
    sync.dirty = false;
    sync.synced = true;
    sync.conflict = false;
    setStatus('GitHub: 同期済み', 'ok');
  } catch (e) {
    if (e instanceof ConflictError) {
      sync.conflict = true;
      setStatus('GitHub: 競合。プル(ローカル破棄)か強制プッシュを選んでください', 'err');
    } else setStatus('GitHub: エラー ' + (e as Error).message, 'err');
  } finally {
    sync.busy = false;
  }
}
async function pull() {
  if (!sync.gh || sync.busy || tools.busy) return;
  sync.busy = true;
  setStatus('GitHub: 取得中…');
  try {
    const { sha, files } = await sync.gh.pull();
    const pj = files.get(PROJECT_FILE);
    if (pj) {
      const manifest = JSON.parse(new TextDecoder().decode(pj)) as Manifest;
      const d = await deserialize(manifest, async p => {
        const u8 = files.get(p);
        return u8 ? new Blob([u8 as BlobPart], { type: 'image/png' }) : null;
      });
      loadDoc(d, sync.gh.cfg.dir);
      setStatus('GitHub: 取得しました', 'ok');
    } else {
      setStatus('GitHub: リモートにプロジェクトがありません(プッシュで作成)');
    }
    sync.lastSha = sha;
    sync.dirty = false;
    sync.synced = true;
    sync.conflict = false;
    scheduleAutosave();
  } catch (e) {
    setStatus('GitHub: エラー ' + (e as Error).message, 'err');
  } finally {
    sync.busy = false;
  }
}
async function autoSyncTick() {
  if (!sync.gh || !sync.auto || sync.busy || sync.conflict || tools.busy || !navigator.onLine) return;
  if (sync.dirty) {
    if (sync.synced && Date.now() - sync.lastEdit > 4000) await push();
    return;
  }
  if (!sync.synced) return;
  try {
    const head = await sync.gh.getHead();
    if (head !== sync.lastSha) await pull();
  } catch { /* 次回に再試行 */ }
}
setInterval(autoSyncTick, 10_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) autoSyncTick(); });

const dlgGh = $<HTMLDialogElement>('dlg-github');
$('btn-github').addEventListener('click', () => {
  const cfg = loadGhConfig();
  $<HTMLInputElement>('gh-token').value = cfg?.token ?? '';
  $<HTMLInputElement>('gh-owner').value = cfg?.owner ?? '';
  $<HTMLInputElement>('gh-repo').value = cfg?.repo ?? '';
  $<HTMLInputElement>('gh-branch').value = cfg?.branch ?? 'main';
  $<HTMLInputElement>('gh-dir').value = cfg?.dir ?? 'drawing1';
  $<HTMLInputElement>('gh-auto').checked = cfg?.auto ?? true;
  dlgGh.showModal();
});
function readGhForm(): GhConfig & { auto: boolean } {
  return {
    token: $<HTMLInputElement>('gh-token').value.trim(),
    owner: $<HTMLInputElement>('gh-owner').value.trim(),
    repo: $<HTMLInputElement>('gh-repo').value.trim(),
    branch: $<HTMLInputElement>('gh-branch').value.trim() || 'main',
    dir: $<HTMLInputElement>('gh-dir').value.trim().replace(/^\/+|\/+$/g, ''),
    auto: $<HTMLInputElement>('gh-auto').checked,
  };
}
function saveGhForm() {
  const cfg = readGhForm();
  localStorage.setItem(GH_KEY, JSON.stringify(cfg));
  applyGhConfig(cfg);
}
$('gh-save').addEventListener('click', () => { saveGhForm(); dlgGh.close(); });
$('gh-close').addEventListener('click', () => dlgGh.close());
$('gh-pull').addEventListener('click', async () => {
  saveGhForm();
  if (sync.dirty && !confirm('ローカルの変更を破棄してリモートを取得しますか?')) return;
  sync.conflict = false;
  await pull();
});
$('gh-push').addEventListener('click', async () => { saveGhForm(); await push(); });
$('gh-force-push').addEventListener('click', async () => {
  saveGhForm();
  if (!confirm('リモートの内容を上書きします。よろしいですか?')) return;
  await push(true);
});
$('btn-sync-now').addEventListener('click', () => (sync.dirty ? push() : pull()));

// ---------------- 起動 ----------------
async function boot() {
  new ResizeObserver(resizeView).observe(viewport);
  resizeView();
  renderToolbar();
  setTool('pen');
  renderPalette();
  applyGhConfig(loadGhConfig());
  const restored = await restoreAutosave();
  if (!restored) loadDoc(doc);
  if (sync.gh && sync.auto) {
    // 起動時はリモート優先。リモートが空ならローカルを保持
    await pull();
    if (restored && !sync.dirty && sync.synced) { /* pulled */ }
  }
  afterEdit();
}
boot();

import type { Doc, DocKind, InputInfo, Layer, Pt, Rgba, ToolId, ToolOptions } from './types';
import { BASIC_COLORS, css, fromHex, hex, same } from './color';
import { activeLayer, composite, compositeToCanvas, createDoc, createLayer, ctx2d, makeCanvas, rasterizeLayer, uid } from './document';
import { History, layersState, snap } from './history';
import { Tools, type AppCtx, type ToolState } from './tools';
import { download, exportPng, exportPsd, exportSvg } from './exporters';
import { PROJECT_FILE, deserialize, serialize, type Manifest } from './project';
import { ConflictError, GitHubSync, type GhConfig } from './github';
import { ICONS } from './icons';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------- 状態 ----------------
/** GitHub 同期の進行状態(タブごと) */
interface SyncState {
  lastSha: string | null;
  /** 一度でも pull/push に成功していれば true(自動プッシュの条件) */
  synced: boolean;
  dirty: boolean;
  lastEdit: number;
  busy: boolean;
  /** 両方(この端末と GitHub)に変更があり、どちらを残すか選ぶ必要がある */
  conflict: boolean;
  /** GitHub 側が自分の知らないコミットに進んでいる */
  remoteChanged: boolean;
  /** GitHub 側を最後に更新した端末と日時 */
  lastInfo: { device: string; date: string } | null;
  /** まだつながっていないタブについて、GitHub に同名の絵があるか最後に調べた時刻 */
  checkedAt: number;
  knownPaths: Set<string>;
}
const newSyncState = (): SyncState => ({ lastSha: null, synced: false, dirty: false, lastEdit: 0, busy: false, conflict: false, remoteChanged: false, lastInfo: null, checkedAt: 0, knownPaths: new Set() });
/** コミットメッセージに入れる端末名 */
const DEVICE = /iPad|iPhone/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
  : /Android/.test(navigator.userAgent) ? 'Android' : 'PC';

/** 開いているキャンバス 1 枚分の状態。名前は GitHub のフォルダ名を兼ねる */
interface Tab {
  id: string;
  name: string;
  doc: Doc;
  history: History;
  zoom: number;
  panX: number;
  panY: number;
  toolState: ToolState | null;
  selectedLayerIds: Set<string>;
  sync: SyncState;
}
let tabs: Tab[] = [];
let cur!: Tab;

// 以下はアクティブなタブの内容を映した変数(タブ切り替え時に入れ替える)
let doc: Doc = createDoc('bitmap', 1024, 768);
let history = new History();
let zoom = 1, panX = 0, panY = 0;
let selectedLayerIds = new Set<string>();

let color: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const options: ToolOptions = { size: 6, fill: false, tolerance: 24, pressure: true, sampleAll: false };
let fingerDraws = false;

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
  get history() { return history; },
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

/** 指(タッチ)のポインタだけを追跡。ペンとマウスは drawId / panId で管理する */
const touchPts = new Map<number, Pt>();
let mode: 'none' | 'draw' | 'pan' | 'pinch' = 'none';
let drawId: number | null = null;
let drawIsPen = false;
let panId: number | null = null;
let panStart = { x: 0, y: 0, px: 0, py: 0 };
let pinchStart = { dist: 1, zoom: 1, docX: 0, docY: 0 };
let spaceDown = false;

function pinchInfo() {
  const [a, b] = [...touchPts.values()];
  return { dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}
function startPan(ev: PointerEvent) {
  mode = 'pan';
  panId = ev.pointerId;
  panStart = { x: ev.clientX, y: ev.clientY, px: panX, py: panY };
}
function startPinch() {
  const p = pinchInfo();
  const d = toDoc({ clientX: p.cx, clientY: p.cy });
  pinchStart = { dist: p.dist, zoom, docX: d.x, docY: d.y };
  mode = 'pinch';
}
function endDraw(ev: PointerEvent | null) {
  if (mode !== 'draw') return;
  if (ev) tools.up(toDoc(ev), info(ev));
  else tools.cancel();
  mode = 'none';
  drawId = null;
}
/** ツールに応じて描画またはパンを開始する(ペン / マウス / 指すべて共通) */
function startPointer(ev: PointerEvent) {
  if (tools.tool === 'zoom' && ev.button === 0 && !spaceDown) {
    zoomAt(ev.clientX, ev.clientY, ev.altKey ? 0.8 : 1.25);
    return;
  }
  if (tools.tool === 'hand' || spaceDown || ev.button === 1) { startPan(ev); return; }
  if (ev.button !== 0) return;
  mode = 'draw';
  drawId = ev.pointerId;
  drawIsPen = ev.pointerType === 'pen';
  tools.down(toDoc(ev), info(ev));
}

view.addEventListener('pointerdown', ev => {
  try { view.setPointerCapture(ev.pointerId); } catch { /* 合成イベントなどでは失敗することがある */ }
  // スライダー等にフォーカスが残っていると iPad の Scribble が反応することがあるので外す
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
  cursorPos = toDoc(ev);

  if (ev.pointerType === 'pen') {
    // 手のひらが先に触れていても Pencil を優先する
    if (mode === 'pan' || mode === 'pinch') { mode = 'none'; panId = null; }
    if (mode === 'draw') return;
    startPointer(ev);
    return;
  }

  if (ev.pointerType === 'touch') {
    touchPts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    // Pencil で描いている最中の指(手のひら)は無視する
    if (mode === 'draw' && drawIsPen) return;
    if (touchPts.size === 2) {
      if (mode === 'draw') endDraw(null);
      if (mode === 'pan') { mode = 'none'; panId = null; }
      startPinch();
      return;
    }
    if (touchPts.size > 2 || mode !== 'none') return;
    if (!fingerDraws) { startPan(ev); return; }
    startPointer(ev);
    return;
  }

  // マウス
  if (mode !== 'none') return;
  startPointer(ev);
});

view.addEventListener('pointermove', ev => {
  if (touchPts.has(ev.pointerId)) touchPts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (ev.pointerType !== 'touch' || mode !== 'draw' || !drawIsPen) cursorPos = toDoc(ev);
  if (mode === 'pinch' && touchPts.size >= 2) {
    const p = pinchInfo();
    const r = view.getBoundingClientRect();
    zoom = clampZoom(pinchStart.zoom * p.dist / pinchStart.dist);
    panX = p.cx - r.left - pinchStart.docX * zoom;
    panY = p.cy - r.top - pinchStart.docY * zoom;
    updateZoomLabel();
  } else if (mode === 'pan' && ev.pointerId === panId) {
    panX = panStart.px + (ev.clientX - panStart.x);
    panY = panStart.py + (ev.clientY - panStart.y);
  } else if (mode === 'draw' && ev.pointerId === drawId) {
    const events = typeof ev.getCoalescedEvents === 'function' && ev.getCoalescedEvents().length ? ev.getCoalescedEvents() : [ev];
    for (const e of events) tools.move(toDoc(e), info(e));
  }
  requestRender();
});

function pointerEnd(ev: PointerEvent) {
  touchPts.delete(ev.pointerId);
  if (mode === 'pinch') {
    if (touchPts.size < 2) mode = 'none';
  } else if (mode === 'pan' && ev.pointerId === panId) {
    mode = 'none';
    panId = null;
  } else if (mode === 'draw' && ev.pointerId === drawId) {
    endDraw(ev);
  }
  requestRender();
}
view.addEventListener('pointerup', pointerEnd);
view.addEventListener('pointercancel', pointerEnd);
// iPad Safari のスクロール / ピンチ / Scribble などのジェスチャ認識を止める
view.addEventListener('touchstart', ev => ev.preventDefault(), { passive: false });
view.addEventListener('touchmove', ev => ev.preventDefault(), { passive: false });
document.addEventListener('gesturestart', ev => ev.preventDefault());
document.addEventListener('gesturechange', ev => ev.preventDefault());
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
// ---------------- 編集(カット / コピー / ペースト) ----------------
function doCopy() { if (!tools.copy()) setStatus('コピーするものがありません'); requestRender(); }
function doCut() { if (!tools.cut()) setStatus('カットするものがありません'); afterEdit(); }
function doPaste() {
  const clip = tools.clipboard;
  if (!clip) { setStatus('クリップボードが空です'); return; }
  tools.commitFloating();
  const layer = activeLayer(doc);
  if (clip.kind === 'bitmap' && doc.kind === 'bitmap') {
    // Photoshop と同じく新しいレイヤーに、元の位置へ貼り付ける
    tools.selection = null;
    withLayersHistory(() => {
      const l = addLayerAbove('ペースト');
      if (l.kind === 'bitmap') ctx2d(l.canvas).drawImage(clip.canvas, clip.x, clip.y);
    });
    tools.selection = { kind: 'rect', points: [{ x: clip.x, y: clip.y }, { x: clip.x + clip.canvas.width, y: clip.y + clip.canvas.height }] };
    setTool('move');
  } else if (clip.kind === 'vector' && layer.kind === 'vector') {
    // 同じレイヤーへ貼ると重なって見えないので少しずらす
    const off = clip.layerId === layer.id ? 16 : 0;
    const before = snap(layer);
    const clones = clip.shapes.map(s => ({
      ...structuredClone(s), id: uid(),
      anchors: s.anchors.map(a => ({ x: a.x + off, y: a.y + off, inX: a.inX + off, inY: a.inY + off, outX: a.outX + off, outY: a.outY + off })),
    }));
    layer.shapes.push(...clones);
    history.push(layer.id, before, snap(layer));
    tools.selectedShapes = new Set(clones.map(s => s.id));
    tools.clipboard = { kind: 'vector', shapes: structuredClone(clones), layerId: layer.id };
    markDirty();
    setTool('select');
    afterEdit();
  } else {
    setStatus('形式が違うため貼り付けできません(ビットマップ ⇄ ベジェ)', 'err');
  }
}
$('btn-cut').addEventListener('click', doCut);
$('btn-copy').addEventListener('click', doCopy);
$('btn-paste').addEventListener('click', doPaste);
$('btn-delete').addEventListener('click', () => { tools.deleteSelection(); afterEdit(); });
$('btn-select-all').addEventListener('click', () => selectAll());
$('btn-deselect').addEventListener('click', () => { tools.cancel(); tools.deselect(); afterEdit(); });
$('btn-commit').addEventListener('click', () => { tools.commitFloating(); afterEdit(); });

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
      case 'x': doCut(); break;
      case 'c': doCopy(); break;
      case 'v': doPaste(); break;
      case '0': zoomFit(); break;                                // 画面サイズに合わせる
      case '1': zoomCenter(1 / zoom); break;                     // 100%
      case '=': case '+': case ';': zoomCenter(1.25); break;     // ズームイン
      case '-': zoomCenter(0.8); break;                          // ズームアウト
      case 'n': if (ev.shiftKey) $('btn-layer-add').click(); else openNewDialog(); break; // 新規レイヤー / 新規キャンバス
      case 'pageup': case 'pagedown': cycleTab(k === 'pageup' ? -1 : 1); break;          // タブ切り替え
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
$('btn-zoom-in').addEventListener('click', () => zoomCenter(1.25));
$('btn-zoom-out').addEventListener('click', () => zoomCenter(0.8));
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
/** iPad 向け: ON のあいだはタップで選択の追加 / 解除になる */
let multiSelectMode = false;
/** レイヤー構成が変わった後に選択を整える(選択はアクティブレイヤーを必ず含む) */
function syncLayerSelection() {
  const ids = new Set(doc.layers.map(l => l.id));
  for (const id of [...selectedLayerIds]) if (!ids.has(id)) selectedLayerIds.delete(id);
  if (!ids.has(doc.activeLayerId)) doc.activeLayerId = doc.layers[doc.layers.length - 1].id;
  selectedLayerIds.add(doc.activeLayerId);
}
const selectedLayers = () => doc.layers.filter(l => selectedLayerIds.has(l.id));

function setActiveLayer(id: string, opts: { toggle?: boolean; range?: boolean } = {}) {
  tools.cancel();
  tools.commitFloating();
  tools.selectedShapes.clear();
  if (opts.toggle) {
    if (selectedLayerIds.has(id)) {
      if (selectedLayerIds.size > 1) {
        selectedLayerIds.delete(id);
        if (doc.activeLayerId === id) doc.activeLayerId = [...selectedLayerIds][0];
      }
    } else {
      selectedLayerIds.add(id);
      doc.activeLayerId = id;
    }
  } else if (opts.range) {
    const a = doc.layers.findIndex(l => l.id === doc.activeLayerId);
    const b = doc.layers.findIndex(l => l.id === id);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selectedLayerIds.add(doc.layers[i].id);
    doc.activeLayerId = id;
  } else {
    selectedLayerIds = new Set([id]);
    doc.activeLayerId = id;
  }
  renderLayers();
  requestRender();
}

/** レイヤー行の「≡」つまみをドラッグして並べ替える(ペン・指・マウス共通)。選択中の行はまとめて動く */
function attachLayerDrag(handle: HTMLElement, row: HTMLElement, layerId: string) {
  handle.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    try { handle.setPointerCapture(ev.pointerId); } catch { /* 合成イベントでは失敗する */ }
    const list = $('layers');
    const groupIds = selectedLayerIds.has(layerId) ? new Set(selectedLayerIds) : new Set([layerId]);
    const allRows = [...list.querySelectorAll<HTMLElement>('.layer')];
    const groupRows = allRows.filter(r => groupIds.has(r.dataset.id!));
    const others = allRows.filter(r => !groupIds.has(r.dataset.id!));
    let insertAt = -1; // 他の行(上から順)の何番目の前に入れるか。others.length なら末尾
    const clearMarks = () => others.forEach(r => r.classList.remove('drop-before', 'drop-after'));
    const onMove = (e: PointerEvent) => {
      groupRows.forEach(r => r.classList.add('dragging'));
      insertAt = others.length;
      for (let i = 0; i < others.length; i++) {
        const b = others[i].getBoundingClientRect();
        if (e.clientY < b.top + b.height / 2) { insertAt = i; break; }
      }
      clearMarks();
      if (insertAt < others.length) others[insertAt].classList.add('drop-before');
      else if (others.length) others[others.length - 1].classList.add('drop-after');
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      groupRows.forEach(r => r.classList.remove('dragging'));
      clearMarks();
      if (insertAt < 0) return;
      tools.commitFloating();
      withLayersHistory(() => {
        const group = doc.layers.filter(l => groupIds.has(l.id));
        const rest = doc.layers.filter(l => !groupIds.has(l.id));
        // パネルは上が最後尾。「行 X の上に入れる」= 配列で X の直後、末尾(一番下)なら 0
        const anchorId = insertAt < others.length ? others[insertAt].dataset.id : null;
        const at = anchorId ? rest.findIndex(l => l.id === anchorId) + 1 : 0;
        rest.splice(at, 0, ...group);
        doc.layers = rest;
      });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

/** 選択中のレイヤーを 1 枚に結合する(下にあるレイヤーが残る) */
function mergeSelectedLayers() {
  const members = selectedLayers();
  if (members.length < 2) { setStatus('結合するにはレイヤーを 2 枚以上選択してください'); return; }
  tools.cancel(); tools.commitFloating(); tools.selectedShapes.clear();
  withLayersHistory(() => {
    const target = members[0];
    let merged: Layer;
    if (target.kind === 'bitmap') {
      // 各レイヤーの不透明度を焼き込んで合成。非表示のレイヤーは捨てる(Photoshop と同じ)
      const c = makeCanvas(doc.width, doc.height);
      const cx = ctx2d(c);
      for (const m of members) {
        if (!m.visible) continue;
        cx.globalAlpha = m.opacity;
        cx.drawImage(m.kind === 'bitmap' ? m.canvas : rasterizeLayer(doc, m), 0, 0);
      }
      merged = { ...target, canvas: c, opacity: 1, visible: true };
    } else {
      merged = { ...target, shapes: members.flatMap(m => (m.kind === 'vector' && m.visible ? structuredClone(m.shapes) : [])) };
    }
    doc.layers = doc.layers.filter(l => l === target || !selectedLayerIds.has(l.id)).map(l => (l === target ? merged : l));
    doc.activeLayerId = merged.id;
    selectedLayerIds = new Set([merged.id]);
  });
}

function renderLayers() {
  syncLayerSelection();
  const el = $('layers');
  el.innerHTML = '';
  $('btn-layer-multi').classList.toggle('active', multiSelectMode);
  for (const l of [...doc.layers].reverse()) {
    const row = document.createElement('div');
    row.className = 'layer' + (l.id === doc.activeLayerId ? ' active' : '') + (selectedLayerIds.has(l.id) ? ' selected' : '');
    row.dataset.id = l.id;
    const handle = document.createElement('span');
    handle.className = 'grip';
    handle.textContent = '≡';
    handle.title = 'ドラッグで並べ替え';
    attachLayerDrag(handle, row, l.id);
    row.appendChild(handle);
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
    row.addEventListener('click', ev => setActiveLayer(l.id, { toggle: ev.ctrlKey || ev.metaKey || multiSelectMode, range: ev.shiftKey }));
    el.appendChild(row);
  }
  $('doc-info').textContent = `${doc.kind === 'bitmap' ? 'ビットマップ' : 'ベジェ'} ${doc.width}×${doc.height}`;
}
/** レイヤー構成を変える操作を取り消し可能にして実行する */
function withLayersHistory(fn: () => void) {
  const before = layersState(doc);
  fn();
  history.pushLayers(before, layersState(doc));
  markDirty(); renderLayers(); afterEdit();
}
/** アクティブレイヤーの上に新しいレイヤーを追加してアクティブにする */
function addLayerAbove(name: string) {
  const idx = doc.layers.findIndex(l => l.id === doc.activeLayerId);
  const l = createLayer(doc.kind, doc.width, doc.height, name);
  doc.layers.splice(idx + 1, 0, l);
  doc.activeLayerId = l.id;
  selectedLayerIds = new Set([l.id]);
  return l;
}
$('btn-layer-add').addEventListener('click', () => {
  tools.commitFloating();
  tools.selectedShapes.clear();
  withLayersHistory(() => addLayerAbove(`レイヤー ${doc.layers.length + 1}`));
});
$('btn-layer-del').addEventListener('click', () => {
  const ids = new Set(selectedLayerIds);
  if (doc.layers.length - ids.size < 1) { setStatus('すべてのレイヤーは削除できません(1 枚は残ります)'); return; }
  tools.cancel(); tools.commitFloating(); tools.selectedShapes.clear();
  withLayersHistory(() => {
    const idx = doc.layers.findIndex(l => ids.has(l.id));
    doc.layers = doc.layers.filter(l => !ids.has(l.id));
    doc.activeLayerId = doc.layers[Math.min(idx, doc.layers.length - 1)].id;
    selectedLayerIds = new Set([doc.activeLayerId]);
  });
});
/** 選択中のレイヤーをまとめて 1 段動かす(上 = 配列の後ろ) */
const moveLayer = (dir: 1 | -1) => {
  tools.commitFloating();
  const idxs = doc.layers.map((l, i) => (selectedLayerIds.has(l.id) ? i : -1)).filter(i => i >= 0);
  if (!idxs.length) return;
  if (dir === 1 && Math.max(...idxs) + 1 >= doc.layers.length) return;
  if (dir === -1 && Math.min(...idxs) - 1 < 0) return;
  withLayersHistory(() => {
    const order = dir === 1 ? [...idxs].reverse() : idxs;
    for (const i of order) [doc.layers[i], doc.layers[i + dir]] = [doc.layers[i + dir], doc.layers[i]];
  });
};
$('btn-layer-multi').addEventListener('click', () => { multiSelectMode = !multiSelectMode; renderLayers(); });
$('btn-layer-merge').addEventListener('click', mergeSelectedLayers);
$('btn-layer-up').addEventListener('click', () => moveLayer(1));
$('btn-layer-down').addEventListener('click', () => moveLayer(-1));
$('btn-layer-rename').addEventListener('click', () => {
  const l = activeLayer(doc);
  const n = prompt('レイヤー名', l.name);
  if (n && n.trim()) { l.name = n.trim(); markDirty(); renderLayers(); }
});

// ---------------- タブ(複数キャンバス) ----------------
/** 同名のタブがあれば末尾に番号を付ける(名前は GitHub のフォルダ名になるため一意にする) */
function uniqueTabName(base: string, except?: Tab): string {
  const clean = (base.trim() || 'drawing').replace(/[\\/:*?"<>|]/g, '_');
  const used = new Set(tabs.filter(t => t !== except).map(t => t.name));
  if (!used.has(clean)) return clean;
  const m = clean.match(/^(.*?)(\d+)$/);
  const stem = m ? m[1] : clean;
  let n = m ? Number(m[2]) + 1 : 2;
  while (used.has(stem + n)) n++;
  return stem + n;
}
function createTab(d: Doc, name: string, id = uid()): Tab {
  return { id, name: uniqueTabName(name), doc: d, history: new History(), zoom: 0, panX: 0, panY: 0, toolState: null, selectedLayerIds: new Set(), sync: newSyncState() };
}
/** 現在のタブに、表示状態を書き戻す */
function stashCurrentTab() {
  if (!cur) return;
  tools.commitFloating();
  flushAutosave();
  cur.zoom = zoom; cur.panX = panX; cur.panY = panY;
  cur.selectedLayerIds = selectedLayerIds;
  cur.toolState = tools.getState();
}
function activateTab(tab: Tab) {
  cur = tab;
  doc = tab.doc;
  history = tab.history;
  selectedLayerIds = tab.selectedLayerIds;
  tools.setState(tab.toolState);
  renderPalette();
  renderLayers();
  if (tab.zoom > 0) { zoom = tab.zoom; panX = tab.panX; panY = tab.panY; updateZoomLabel(); }
  else zoomFit();
  renderTabs();
  updateSyncStatus();
  afterEdit();
}
function addTab(d: Doc, name: string, opts: { activate?: boolean; id?: string } = {}): Tab {
  const tab = createTab(d, name, opts.id);
  tabs.push(tab);
  if (opts.activate ?? true) { stashCurrentTab(); activateTab(tab); }
  else renderTabs();
  return tab;
}
function switchTab(id: string) {
  const tab = tabs.find(t => t.id === id);
  if (!tab || tab === cur) return;
  stashCurrentTab();
  activateTab(tab);
  saveTabIndex();
}
function cycleTab(dir: 1 | -1) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(cur);
  switchTab(tabs[(i + dir + tabs.length) % tabs.length].id);
}
async function closeTab(id: string) {
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  if (tab.sync.dirty && sync.gh && !confirm(`「${tab.name}」には GitHub に送っていない変更があります。閉じますか?`)) return;
  if (!sync.gh && !confirm(`「${tab.name}」を閉じますか?(この端末の自動保存からも消えます。残したい場合は先に「保存」してください)`)) return;
  const idx = tabs.indexOf(tab);
  tabs = tabs.filter(t => t !== tab);
  await dbDelete(tabKey(tab.id)).catch(() => {});
  if (tabs.length === 0) {
    addTab(createDoc('bitmap', 1024, 768), 'drawing1');
  } else if (tab === cur) {
    cur = undefined as unknown as Tab; // stash させない
    activateTab(tabs[Math.min(idx, tabs.length - 1)]);
  } else renderTabs();
  saveTabIndex();
}
function renameTab(tab: Tab, name: string) {
  const n = uniqueTabName(name, tab);
  if (n === tab.name) return;
  tab.name = n;
  // フォルダ名が変わるのでリモートとの対応をやり直す
  tab.sync = { ...newSyncState(), dirty: tab.sync.dirty, lastEdit: tab.sync.lastEdit };
  renderTabs();
  updateSyncStatus();
  saveTabIndex();
  scheduleAutosave();
  autoSyncTick(); // 新しい名前の絵が GitHub にあればすぐ受け取る
}
/** 今のドキュメントを差し替える(GitHub からの取得など) */
function replaceTabDoc(tab: Tab, d: Doc) {
  tab.doc = d;
  tab.history.clear();
  tab.selectedLayerIds = new Set();
  tab.toolState = null;
  tab.zoom = 0;
  if (tab === cur) {
    tools.reset();
    activateTab(tab);
  }
}
function renderTabs() {
  const el = $('tabs');
  el.innerHTML = '';
  for (const t of tabs) {
    const b = document.createElement('div');
    b.className = 'tab' + (t === cur ? ' active' : '');
    b.dataset.id = t.id;
    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name;
    // 同期の印: ✓ 送信済み / ● 未送信 / ↓ 相手の更新あり
    const dirty = document.createElement('span');
    dirty.className = 'mark';
    let state = '';
    if (sync.gh) {
      const s = t.sync;
      if (s.conflict || (s.dirty && s.remoteChanged)) { dirty.textContent = '●↓'; dirty.classList.add('unsent'); state = '両方に変更あり'; }
      else if (s.remoteChanged) { dirty.textContent = '↓'; dirty.classList.add('remote'); state = '相手の更新あり'; }
      else if (s.dirty) { dirty.textContent = '●'; dirty.classList.add('unsent'); state = '未送信'; }
      else if (s.synced) { dirty.textContent = '✓'; dirty.classList.add('sent'); state = '送信済み'; }
    }
    b.title = `${t.name}${state ? `(${state})` : ''}\nダブルタップで名前を変更`;
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = '閉じる';
    close.addEventListener('click', ev => { ev.stopPropagation(); closeTab(t.id); });
    b.append(name, dirty, close);
    b.addEventListener('click', () => switchTab(t.id));
    b.addEventListener('dblclick', () => {
      const n = prompt('キャンバスの名前(GitHub のフォルダ名になります)', t.name);
      if (n && n.trim()) renameTab(t, n.trim());
    });
    el.appendChild(b);
  }
  el.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
$('btn-tab-new').addEventListener('click', () => openNewDialog());

// ---------------- ドキュメント ----------------
const dlgNew = $<HTMLDialogElement>('dlg-new');
function openNewDialog() {
  $<HTMLInputElement>('new-name').value = uniqueTabName(`drawing${tabs.length + 1}`);
  dlgNew.showModal();
}
$('btn-new').addEventListener('click', openNewDialog);
$('new-cancel').addEventListener('click', () => dlgNew.close());
$('new-ok').addEventListener('click', () => {
  const w = Math.max(1, Math.min(8192, Number($<HTMLInputElement>('new-width').value) || 1024));
  const h = Math.max(1, Math.min(8192, Number($<HTMLInputElement>('new-height').value) || 768));
  const kind = $<HTMLSelectElement>('new-kind').value as DocKind;
  addTab(createDoc(kind, w, h), $<HTMLInputElement>('new-name').value);
  dlgNew.close();
  saveTab(cur);
  saveTabIndex();
  autoSyncTick(); // 同じ名前の絵が GitHub にあればすぐ受け取る
});

async function saveProject() {
  tools.commitFloating();
  const { manifest } = await serialize(doc, 'embed');
  download(new Blob([JSON.stringify(manifest)], { type: 'application/json' }), `${cur.name}.json`);
}
$('btn-save').addEventListener('click', saveProject);
$('btn-open').addEventListener('click', () => $<HTMLInputElement>('file-open').click());
$<HTMLInputElement>('file-open').addEventListener('change', async ev => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const m = JSON.parse(await f.text()) as Manifest;
    const tab = addTab(await deserialize(m, async () => null), f.name.replace(/\.json$/i, ''));
    tab.sync.dirty = true;
    saveTab(tab);
    saveTabIndex();
  } catch (e) { alert('読み込みに失敗しました: ' + (e as Error).message); }
  (ev.target as HTMLInputElement).value = '';
});
$('btn-png').addEventListener('click', () => { tools.commitFloating(); exportPng(doc, cur.name); });
$('btn-psd').addEventListener('click', async () => {
  tools.commitFloating();
  try { await exportPsd(doc, cur.name); } catch (e) { alert('PSD 書き出しに失敗: ' + (e as Error).message); }
});
$('btn-svg').addEventListener('click', () => { tools.commitFloating(); exportSvg(doc, cur.name); });

// ---------------- ローカル自動保存 ----------------
// IndexedDB に保存する(localStorage は容量が小さく、大きな文字列化で描画が止まるため)
const LEGACY_AUTOSAVE_KEY = 'oekaki.autosave';
const TAB_INDEX_KEY = 'oekaki.tabs';
const tabKey = (id: string) => `oekaki.tab.${id}`;
function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open('oekaki', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function dbRun<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((res, rej) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      let result: T | undefined;
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => res(result);
      tx.onerror = () => rej(tx.error);
    });
  } finally { db.close(); }
}
const dbPut = (key: string, value: unknown) => dbRun('readwrite', s => { s.put(value, key); });
const dbGet = <T,>(key: string) => dbRun<T>('readonly', s => s.get(key) as IDBRequest<T>);
const dbDelete = (key: string) => dbRun('readwrite', s => { s.delete(key); });

interface TabIndexEntry { id: string; name: string; sync?: { lastSha: string | null; synced: boolean; dirty: boolean; lastEdit: number } }
function saveTabIndex() {
  const entries: TabIndexEntry[] = tabs.map(t => ({
    id: t.id, name: t.name,
    sync: { lastSha: t.sync.lastSha, synced: t.sync.synced, dirty: t.sync.dirty, lastEdit: t.sync.lastEdit },
  }));
  dbPut(TAB_INDEX_KEY, { activeId: cur?.id, tabs: entries }).catch(() => {});
}
async function saveTab(tab: Tab) {
  try {
    const { manifest } = await serialize(tab.doc, 'embed');
    await dbPut(tabKey(tab.id), { name: tab.name, manifest });
  } catch { /* プライベートブラウズなどで失敗しても無視 */ }
}
let autosaveTimer = 0;
/** 保存待ちのタブ。タブを切り替えると別のタブを保存してしまうので、対象を覚えておく */
let autosavePending: Tab | null = null;
function scheduleAutosave() {
  const tab = cur;
  if (autosavePending && autosavePending !== tab) saveTab(autosavePending);
  autosavePending = tab;
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => { autosavePending = null; saveTab(tab); saveTabIndex(); }, 1500);
}
/** 保存待ちがあれば今すぐ保存する(タブ切り替え・終了前) */
function flushAutosave() {
  if (!autosavePending) return;
  clearTimeout(autosaveTimer);
  const tab = autosavePending;
  autosavePending = null;
  saveTab(tab);
  saveTabIndex();
}
/** 前回開いていたタブを復元する。1 枚でも復元できたら true */
async function restoreTabs(): Promise<boolean> {
  try {
    const index = await dbGet<{ activeId?: string; tabs: TabIndexEntry[] }>(TAB_INDEX_KEY);
    let restoredAny = false;
    if (index?.tabs?.length) {
      for (const entry of index.tabs) {
        const saved = await dbGet<{ name: string; manifest: Manifest }>(tabKey(entry.id));
        if (!saved) continue;
        const tab = addTab(await deserialize(saved.manifest, async () => null), saved.name || entry.name, { activate: false, id: entry.id });
        // 未送信の変更があったかどうかを引き継ぐ(起動時に GitHub 側で上書きしないため)
        if (entry.sync) Object.assign(tab.sync, entry.sync);
        restoredAny = true;
      }
      const active = tabs.find(t => t.id === index.activeId) ?? tabs[0];
      if (active) activateTab(active);
    }
    // 旧バージョン(タブなし)の保存があれば引き継ぐ
    const legacy = await dbGet<{ name: string; manifest: Manifest }>(LEGACY_AUTOSAVE_KEY);
    if (legacy) {
      addTab(await deserialize(legacy.manifest, async () => null), legacy.name, { activate: !restoredAny });
      await dbDelete(LEGACY_AUTOSAVE_KEY);
      restoredAny = true;
      saveTab(cur);
      saveTabIndex();
    }
    return restoredAny;
  } catch { return false; }
}

function markDirty() {
  cur.sync.dirty = true;
  cur.sync.lastEdit = Date.now();
  scheduleLayerPanel();
  scheduleAutosave();
  updateSyncStatus();
  renderTabs();
}
window.addEventListener('beforeunload', ev => { flushAutosave(); if (sync.gh && tabs.some(t => t.sync.dirty)) ev.preventDefault(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flushAutosave(); });

// ---------------- GitHub 同期 ----------------
const GH_KEY = 'oekaki.github';
const sync = {
  cfg: null as (GhConfig & { auto: boolean }) | null,
  gh: null as GitHubSync | null,
  auto: true,
};
/** タブごとのフォルダを向いたクライアントを作る */
function ghFor(tab: Tab): GitHubSync | null {
  if (!sync.cfg || !sync.gh) return null;
  const g = new GitHubSync({ ...sync.cfg, dir: tab.name });
  g.knownPaths = tab.sync.knownPaths;
  return g;
}
let bannerTimer = 0;
function setStatus(msg: string, cls: '' | 'ok' | 'err' = '') {
  const el = $('sync-status');
  el.textContent = msg;
  el.className = cls;
  $('gh-msg').textContent = msg;
  // キャンバス上部のバナーにも出す(上部バーは狭くて読めないことがある)。成功は数秒で消し、エラーは残す
  const banner = $('sync-banner');
  clearTimeout(bannerTimer);
  if (!msg) { banner.hidden = true; return; }
  banner.textContent = msg;
  banner.className = cls;
  banner.hidden = false;
  if (cls !== 'err') bannerTimer = window.setTimeout(() => { banner.hidden = true; }, cls === 'ok' ? 5000 : 8000);
}
/** 送る / 受け取るボタンの表示を処理中に合わせる */
function setSyncButtons(state: 'idle' | 'sending' | 'receiving') {
  const send = $<HTMLButtonElement>('btn-send'), recv = $<HTMLButtonElement>('btn-receive');
  send.disabled = recv.disabled = state !== 'idle';
  send.textContent = state === 'sending' ? '送信中…' : 'この端末の絵を送る';
  recv.textContent = state === 'receiving' ? '受信中…' : 'GitHub の絵を受け取る';
}
function timeAgo(iso: string): string {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'たった今';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 時間前`;
  return `${Math.floor(sec / 86400)} 日前`;
}
function updateSyncStatus() {
  const buttons = $('sync-buttons');
  if (!sync.gh) {
    // 未設定であることを常時表示(バナーは出さない)
    const el = $('sync-status');
    el.textContent = 'GitHub: 未設定(右上の GitHub から設定)';
    el.className = '';
    buttons.hidden = true;
    return;
  }
  buttons.hidden = false;
  const s = cur.sync;
  const send = $('btn-send'), recv = $('btn-receive');
  const both = s.conflict || (s.dirty && s.remoteChanged);
  send.classList.toggle('attention', both);
  recv.classList.toggle('attention', both);
  const last = s.lastInfo ? ` · 最終更新 ${s.lastInfo.device} ${timeAgo(s.lastInfo.date)}` : '';
  if (s.busy) return;
  if (both) setStatus(`「${cur.name}」は ${DEVICE === 'iPad' ? 'PC' : 'iPad'} でも変更されています。どちらを残すかボタンで選んでください${last}`, 'err');
  else if (s.remoteChanged) setStatus(`「${cur.name}」に相手の更新があります(自動で受け取ります)${last}`);
  else if (s.dirty) setStatus(`「${cur.name}」: 未送信の変更あり` + (sync.auto ? '(まもなく自動で送ります)' : '') + last);
  else if (s.synced) setStatus(`「${cur.name}」: 送信済み${last}`, 'ok');
  else setStatus(`「${cur.name}」: GitHub とまだつながっていません(描くと自動で送ります)`);
}
function loadGhConfig(): (GhConfig & { auto: boolean }) | null {
  try { return JSON.parse(localStorage.getItem(GH_KEY) || 'null'); } catch { return null; }
}
/** 接続設定を反映する。resetTabs=true なら各タブの同期状態(どのコミットまで受け取ったか)を忘れる */
function applyGhConfig(cfg: (GhConfig & { auto: boolean }) | null, resetTabs = false) {
  sync.cfg = cfg;
  sync.gh = cfg && cfg.token && cfg.owner && cfg.repo ? new GitHubSync(cfg) : null;
  sync.auto = cfg?.auto ?? true;
  if (resetTabs) for (const t of tabs) t.sync = { ...newSyncState(), dirty: t.sync.dirty, lastEdit: t.sync.lastEdit };
  updateSyncStatus();
  renderTabs();
}
async function refreshLastInfo(tab: Tab) {
  try {
    const info = await ghFor(tab)?.lastCommitInfo();
    if (info) tab.sync.lastInfo = { device: /from (\S+)/.exec(info.message)?.[1] ?? '?', date: info.date };
  } catch { /* 表示用なので失敗しても無視 */ }
}
/**
 * この端末の絵で GitHub 側を上書きする。
 * force=false のときは、自分が知らないコミットがあれば ConflictError で止まる(自動送信用)。
 */
async function push(tab: Tab, force = false, manual = false) {
  const gh = ghFor(tab);
  const s = tab.sync;
  if (!gh) { if (manual) setStatus('GitHub の設定がありません。右上の「GitHub」から設定してください', 'err'); return; }
  if (s.busy) { if (manual) setStatus('同期の処理中です。少し待ってからもう一度押してください'); return; }
  if (tab === cur && tools.busy) { if (manual) tools.cancel(); else return; }
  s.busy = true;
  if (tab === cur) { tools.commitFloating(); setStatus(`「${tab.name}」を送信中…`); setSyncButtons('sending'); }
  try {
    const { manifest, files } = await serialize(tab.doc, 'files');
    const repoFiles = [
      { path: PROJECT_FILE, content: JSON.stringify(manifest) },
      ...(await Promise.all(files.map(async f => ({ path: f.path, content: new Uint8Array(await f.blob.arrayBuffer()) })))),
    ];
    s.lastSha = await gh.commitFiles(repoFiles, `update ${tab.name} from ${DEVICE} ${new Date().toISOString()}`, { expectedHead: force ? undefined : s.lastSha, force });
    s.knownPaths = gh.knownPaths;
    s.dirty = false;
    s.synced = true;
    s.conflict = false;
    s.remoteChanged = false;
    s.lastInfo = { device: DEVICE, date: new Date().toISOString() };
    saveTabIndex();
  } catch (e) {
    console.error('push failed', e);
    if (e instanceof ConflictError) { s.conflict = true; s.remoteChanged = true; await refreshLastInfo(tab); }
    else if (tab === cur) setStatus(`送信に失敗しました: ` + (e as Error).message, 'err');
  } finally {
    s.busy = false;
    if (tab === cur) { setSyncButtons('idle'); if (!s.conflict && !$('sync-banner').classList.contains('err')) setStatus(`「${tab.name}」を送りました`, 'ok'); updateSyncStatus(); }
    renderTabs();
  }
}
/** GitHub の絵でこのタブを上書きする */
async function pull(tab: Tab, manual = false) {
  const gh = ghFor(tab);
  const s = tab.sync;
  if (!gh) { if (manual) setStatus('GitHub の設定がありません。右上の「GitHub」から設定してください', 'err'); return; }
  if (s.busy) { if (manual) setStatus('同期の処理中です。少し待ってからもう一度押してください'); return; }
  if (tab === cur && tools.busy) { if (manual) tools.cancel(); else return; }
  s.busy = true;
  if (tab === cur) { setStatus(`「${tab.name}」を受信中…`); setSyncButtons('receiving'); }
  try {
    const { sha, files } = await gh.pull();
    s.knownPaths = gh.knownPaths;
    const pj = files.get(PROJECT_FILE);
    if (pj) {
      const manifest = JSON.parse(new TextDecoder().decode(pj)) as Manifest;
      const d = await deserialize(manifest, async p => {
        const u8 = files.get(p);
        return u8 ? new Blob([u8 as BlobPart], { type: 'image/png' }) : null;
      });
      replaceTabDoc(tab, d);
      saveTab(tab);
      s.synced = true;
    }
    s.lastSha = sha;
    s.dirty = false;
    s.conflict = false;
    s.remoteChanged = false;
    await refreshLastInfo(tab);
    saveTabIndex();
    if (tab === cur) setStatus(pj ? `「${tab.name}」を受け取りました` : `GitHub に「${tab.name}」という名前の絵はまだありません`, pj ? 'ok' : 'err');
  } catch (e) {
    console.error('pull failed', e);
    if (tab === cur) setStatus(`受信に失敗しました: ` + (e as Error).message, 'err');
  } finally {
    s.busy = false;
    if (tab === cur) { setSyncButtons('idle'); if (!$('sync-banner').classList.contains('err') && $('sync-banner').hidden) updateSyncStatus(); }
    renderTabs();
  }
}
/**
 * 自動同期。タブごとに:
 *  - 未送信の変更があり相手が進んでいなければ送る。相手も進んでいれば「両方に変更あり」にして止める
 *  - 変更がなく相手が進んでいれば受け取る
 *  - まだつながっていないタブは、GitHub に同名の絵がなければ送り、あれば「両方に変更あり」にする
 */
async function autoSyncTick() {
  if (!sync.gh || !sync.auto || !navigator.onLine) return;
  for (const tab of [...tabs]) {
    const s = tab.sync;
    if (s.busy || s.conflict || (tab === cur && tools.busy)) continue;
    if (s.dirty && Date.now() - s.lastEdit < 4000) continue;
    try {
      const gh = ghFor(tab)!;
      if (!s.synced) {
        if (!s.dirty) {
          // 空の新しいタブ: GitHub に同じ名前の絵があれば受け取る(1 分に 1 回だけ確認)
          if (Date.now() - s.checkedAt < 60_000) continue;
          s.checkedAt = Date.now();
          if (await gh.remoteHasProject()) await pull(tab);
          continue;
        }
        if (await gh.remoteHasProject()) { s.conflict = true; s.remoteChanged = true; await refreshLastInfo(tab); }
        else await push(tab, true);
      } else if (s.dirty) {
        await push(tab); // 相手が進んでいれば ConflictError → 両方に変更あり
      } else {
        const head = await gh.getHead();
        if (head !== s.lastSha) { s.remoteChanged = true; await pull(tab); }
      }
    } catch { /* 次回に再試行 */ }
    if (tab === cur) updateSyncStatus();
    renderTabs();
  }
}
setInterval(autoSyncTick, 10_000);
setInterval(() => { if (sync.gh) updateSyncStatus(); }, 60_000); // 「n 分前」の表示更新
document.addEventListener('visibilitychange', () => { if (!document.hidden) autoSyncTick(); });

$('btn-send').addEventListener('click', async () => {
  cur.sync.conflict = false;
  await push(cur, true, true);
});
$('btn-receive').addEventListener('click', async () => {
  if (cur.sync.dirty && !confirm(`「${cur.name}」でこの端末で描いた分は消え、GitHub の絵に置き換わります。よろしいですか?`)) return;
  cur.sync.conflict = false;
  await pull(cur, true);
});
$('gh-test').addEventListener('click', async () => {
  const cfg = readGhForm();
  const msg = $('gh-msg');
  if (!cfg.token || !cfg.owner || !cfg.repo) { msg.textContent = 'トークン・オーナー・リポジトリを入力してください'; return; }
  msg.textContent = '確認中…';
  const r = await new GitHubSync({ ...cfg, dir: '' }).checkAccess();
  if (r.ok) {
    msg.textContent = `接続 OK: ${cfg.owner}/${cfg.repo}(${r.isPrivate ? '非公開' : '公開'})、書き込み ${r.canPush ? '可' : '不可 → トークンの Contents 権限を Read and write にしてください'}`;
  } else {
    const hint = r.status === 401 ? 'トークンが間違っているか期限切れです'
      : r.status === 404 ? 'リポジトリ名かオーナー名が違うか、トークンにこのリポジトリの権限がありません'
      : r.status === 0 ? 'ネットワークに接続できません' : '';
    msg.textContent = `接続に失敗(${r.status}): ${hint || r.message}`;
  }
});

const dlgGh = $<HTMLDialogElement>('dlg-github');
$('btn-github').addEventListener('click', () => {
  const cfg = loadGhConfig();
  $<HTMLInputElement>('gh-token').value = cfg?.token ?? '';
  $<HTMLInputElement>('gh-owner').value = cfg?.owner ?? '';
  $<HTMLInputElement>('gh-repo').value = cfg?.repo ?? '';
  $<HTMLInputElement>('gh-branch').value = cfg?.branch ?? 'main';
  $<HTMLInputElement>('gh-auto').checked = cfg?.auto ?? true;
  updateSyncStatus();
  dlgGh.showModal();
});
function readGhForm(): GhConfig & { auto: boolean } {
  return {
    token: $<HTMLInputElement>('gh-token').value.trim(),
    owner: $<HTMLInputElement>('gh-owner').value.trim(),
    repo: $<HTMLInputElement>('gh-repo').value.trim(),
    branch: $<HTMLInputElement>('gh-branch').value.trim() || 'main',
    dir: '',
    auto: $<HTMLInputElement>('gh-auto').checked,
  };
}
/** 設定フォームを保存する。接続先が変わったときだけ同期状態をリセットする */
function saveGhForm() {
  const cfg = readGhForm();
  const prev = sync.cfg;
  const changed = !prev || prev.token !== cfg.token || prev.owner !== cfg.owner || prev.repo !== cfg.repo || prev.branch !== cfg.branch;
  localStorage.setItem(GH_KEY, JSON.stringify(cfg));
  if (changed) { applyGhConfig(cfg, true); bootSync(); }
  else { sync.cfg = cfg; sync.auto = cfg.auto; }
  updateSyncStatus();
}
$('gh-save').addEventListener('click', () => { saveGhForm(); dlgGh.close(); });
$('gh-close').addEventListener('click', () => dlgGh.close());

/** 起動時・接続先変更時: 未送信の変更がないタブは GitHub の絵を受け取る */
async function bootSync() {
  if (!sync.gh) return;
  for (const t of [...tabs]) {
    if (t.sync.dirty) continue; // 未送信の変更は消さない(自動同期が「両方に変更あり」を判定する)
    try {
      if (await ghFor(t)!.remoteHasProject()) await pull(t);
    } catch { /* 次回の自動同期で再試行 */ }
  }
  updateSyncStatus();
  renderTabs();
}

// ---------------- 起動 ----------------
async function boot() {
  new ResizeObserver(resizeView).observe(viewport);
  resizeView();
  renderToolbar();
  setTool('pen');
  renderPalette();
  const restored = await restoreTabs();
  if (!restored) addTab(createDoc('bitmap', 1024, 768), 'drawing1');
  applyGhConfig(loadGhConfig());
  afterEdit();
  await bootSync();
}
boot();

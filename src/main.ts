import type { Doc, DocKind, InputInfo, Layer, Pt, Rgba, ToolId, ToolOptions } from './types';
import { BASIC_COLORS, css, fromHex, hex, same } from './color';
import { activeLayer, composite, compositeToCanvas, createDoc, createLayer, ctx2d, makeCanvas, rasterizeLayer, uid } from './document';
import { History, layersState, snap } from './history';
import { Tools, type AppCtx, type ToolState } from './tools';
import { download, exportPng, exportPsd, exportSvg } from './exporters';
import { PROJECT_FILE, blobToDataUrl, canvasToBlob, deserialize, serialize, type Manifest } from './project';
import { ConflictError, GitHubSync, type GhConfig } from './github';
import { ICONS } from './icons';
import { IMAGE_EXT, PSD_EXT, importImage, importPsd } from './importers';
import { DEFAULT_NOTEBOOK, DEFAULT_SECTION, KEEP_FILE, THUMB_FILE, canvasDir, cleanName, colorFor, makeThumb, parseTree, type RemoteCanvas, type RemoteScan } from './library';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------- 状態 ----------------
/** GitHub 同期の進行状態(画像ごと) */
interface SyncState {
  lastSha: string | null;
  /** 一度でも pull/push に成功していれば true */
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
  /** まだつながっていない画像について、GitHub に同名の絵があるか最後に調べた時刻 */
  checkedAt: number;
  knownPaths: Set<string>;
}
const newSyncState = (): SyncState => ({ lastSha: null, synced: false, dirty: false, lastEdit: 0, busy: false, conflict: false, remoteChanged: false, lastInfo: null, checkedAt: 0, knownPaths: new Set() });
/** コミットメッセージに入れる端末名 */
const DEVICE = /iPad|iPhone/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
  : /Android/.test(navigator.userAgent) ? 'Android' : 'PC';

/**
 * ライブラリ内の画像 1 枚。開いているものがタブになる(open=true)。
 * 閉じている画像は doc を持たず、開くときに端末内の保存から読み込む。
 * ノートブック / セクション / 名前 がそのまま GitHub のフォルダになる。
 */
interface Tab {
  id: string;
  name: string;
  notebook: string;
  section: string;
  open: boolean;
  doc: Doc | null;
  /** 一覧用サムネイル(data URL) */
  thumb: string | null;
  /** 旧形式(トップ直下)から開いた画像の、GitHub 上の現在のフォルダ。送ると新しい場所に移る */
  remoteDir?: string;
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
const openTabs = () => tabs.filter(t => t.open);
/** 開いている画像がないときのダミー(ライブラリには含めない)。cur === EMPTY で「空」を判定する */
const EMPTY: Tab = {
  id: '__empty__', name: '', notebook: '', section: '', open: false, doc: createDoc('bitmap', 1, 1), thumb: null,
  history: new History(), zoom: 1, panX: 0, panY: 0, toolState: null, selectedLayerIds: new Set(), sync: newSyncState(),
};
const isEmpty = () => cur === EMPTY;
const tabDir = (t: Tab) => canvasDir(t.notebook, t.section, t.name);

/** 画像のない(空の)ノートブック / セクションを覚えておく */
interface Structure { notebooks: string[]; sections: { notebook: string; name: string }[] }
let structure: Structure = { notebooks: [DEFAULT_NOTEBOOK], sections: [{ notebook: DEFAULT_NOTEBOOK, name: DEFAULT_SECTION }] };
/** GitHub 上の一覧(最後に取得したもの) */
let remoteScan: RemoteScan | null = null;

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
  notify: msg => setStatus(msg),
  setTool: t => setTool(t),
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
  $('empty-state').hidden = !isEmpty();
  if (isEmpty()) return;
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
const info = (ev: PointerEvent): InputInfo => ({ pressure: ev.pressure, pen: ev.pointerType === 'pen', shift: ev.shiftKey, alt: ev.altKey });

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
  if (isEmpty()) return;
  try { view.setPointerCapture(ev.pointerId); } catch { /* 合成イベントなどでは失敗することがある */ }
  // スライダー等にフォーカスが残っていると iPad の Scribble が反応することがあるので外す
  // キー受け取り先に焦点を移す(iPad ではページに焦点がないと外付けキー / 左手デバイスのキーが届かない)
  focusKeys();
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
  } else if (mode === 'none' && tools.tool === 'move' && ev.pointerType !== 'touch') {
    view.style.cursor = tools.hoverCursor(toDoc(ev));
  }
  requestRender();
});
// 枠内ダブルクリックで変形を確定(Photoshop と同じ)
view.addEventListener('dblclick', () => { if (tools.tool === 'move') { tools.commitTransform(); afterEdit(); } });

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
  { id: 'move', label: '移動(バウンディングボックス: 角で拡大縮小 / 枠の外で回転 / 中で移動。他のツールに切り替えると確定)', key: 'V / Ctrl+T' },
  { id: 'select', label: '長方形選択', key: 'M' },
  { id: 'lasso', label: 'なげなわ', key: 'L' },
  { id: 'eyedropper', label: 'スポイト(押している間だけ。離すと前のツールに戻る。ブラシ中は Alt+クリック)', key: 'I' },
  { id: 'pen', label: 'ブラシ', key: 'B' },
  { id: 'eraser', label: '消しゴム', key: 'E' },
  { id: 'bucket', label: '塗りつぶし', key: 'G' },
  { id: 'rect', label: '長方形', key: 'U で切替' },
  { id: 'ellipse', label: '楕円', key: 'U で切替' },
  { id: 'line', label: 'ライン', key: 'U で切替' },
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
      const valid = (saved as string[]).filter((id): id is ToolId => (all as string[]).includes(id));
      return [...valid, ...all.filter(id => !valid.includes(id))];
    }
  } catch { /* ignore */ }
  return all;
}
let toolOrder = loadToolOrder();
let dragToolId: ToolId | null = null;

/** ツールバーを生成。ボタンはドラッグ&ドロップで並べ替えでき、順序は localStorage に保存 */
function renderToolbar() {
  const bar = $('tools');
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

// ---------------- ツールバーの幅 / 上の余白 ----------------
const TOOLBAR_W_KEY = 'oekaki.toolbarWidth';
const TOP_GAP_KEY = 'oekaki.topGap';
function applyToolbarWidth(w: number) {
  w = Math.round(Math.max(36, Math.min(160, w)));
  document.documentElement.style.setProperty('--toolbar-w', `${w}px`);
  // 1 列に収まる最大のボタン幅(最大 42px)。広いときは複数列に並ぶ
  const inner = w - 8;
  const cols = Math.max(1, Math.floor((inner + 2) / 44));
  const btn = Math.min(42, Math.floor((inner - (cols - 1) * 2) / cols));
  document.documentElement.style.setProperty('--tool-btn', `${Math.max(28, btn)}px`);
  return w;
}
{
  const saved = Number(localStorage.getItem(TOOLBAR_W_KEY));
  applyToolbarWidth(saved > 0 ? saved : 52);
  const resizer = $('toolbar-resizer');
  resizer.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    try { resizer.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    resizer.classList.add('active');
    const left = $('toolbar').getBoundingClientRect().left;
    let w = 52;
    const onMove = (e: PointerEvent) => { w = applyToolbarWidth(e.clientX - left); resizeView(); };
    const onUp = () => {
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onUp);
      resizer.removeEventListener('pointercancel', onUp);
      resizer.classList.remove('active');
      localStorage.setItem(TOOLBAR_W_KEY, String(w));
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp);
    resizer.addEventListener('pointercancel', onUp);
  });
  // 右パネルの幅(左端をドラッグ)
  const SIDEBAR_W_KEY = 'oekaki.sidebarWidth';
  const applySidebarWidth = (w: number) => {
    w = Math.round(Math.max(160, Math.min(420, w)));
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
    return w;
  };
  const savedSide = Number(localStorage.getItem(SIDEBAR_W_KEY));
  applySidebarWidth(savedSide > 0 ? savedSide : 240);
  const sres = $('sidebar-resizer');
  sres.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    try { sres.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    sres.classList.add('active');
    const right = $('sidebar').getBoundingClientRect().right;
    let w = 240;
    const onMove = (e: PointerEvent) => { w = applySidebarWidth(right - e.clientX); resizeView(); };
    const onUp = () => {
      sres.removeEventListener('pointermove', onMove);
      sres.removeEventListener('pointerup', onUp);
      sres.removeEventListener('pointercancel', onUp);
      sres.classList.remove('active');
      localStorage.setItem(SIDEBAR_W_KEY, String(w));
    };
    sres.addEventListener('pointermove', onMove);
    sres.addEventListener('pointerup', onUp);
    sres.addEventListener('pointercancel', onUp);
  });
  // たたむ / 開く(状態は保存)
  const PANELS_KEY = 'oekaki.panels';
  const panels = { toolbar: false, sidebar: false, ...(JSON.parse(localStorage.getItem(PANELS_KEY) || '{}') as Partial<{ toolbar: boolean; sidebar: boolean }>) };
  const applyPanels = () => {
    document.body.classList.toggle('toolbar-hidden', panels.toolbar);
    document.body.classList.toggle('sidebar-hidden', panels.sidebar);
    $('btn-toolbar-toggle').textContent = panels.toolbar ? '›' : '‹';
    $('btn-sidebar-toggle').textContent = panels.sidebar ? '‹' : '›';
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
    resizeView();
  };
  applyPanels();
  $('btn-toolbar-toggle').addEventListener('click', () => { panels.toolbar = !panels.toolbar; applyPanels(); });
  $('btn-sidebar-toggle').addEventListener('click', () => { panels.sidebar = !panels.sidebar; applyPanels(); });

  const gap = $<HTMLInputElement>('opt-top-gap');
  const applyGap = (on: boolean) => {
    document.documentElement.style.setProperty('--top-gap', on ? '22px' : '0px');
    document.documentElement.style.setProperty('--left-gap', on ? '96px' : '0px'); // 左上のウィンドウ操作ボタンを避ける
    resizeView();
  };
  gap.checked = localStorage.getItem(TOP_GAP_KEY) === '1';
  applyGap(gap.checked);
  gap.addEventListener('change', () => { localStorage.setItem(TOP_GAP_KEY, gap.checked ? '1' : '0'); applyGap(gap.checked); });
}

const CURSORS: Partial<Record<ToolId, string>> = {
  hand: 'grab', move: 'move', eyedropper: 'copy', bucket: 'cell', select: 'crosshair', lasso: 'crosshair',
  zoom: 'zoom-in', pen: 'none', eraser: 'none',
};
function setTool(t: ToolId) {
  tools.setTool(t);
  document.querySelectorAll<HTMLButtonElement>('#tools button').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
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
  tools.commitTransform();
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
  tools.commitTransform();
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
$('btn-deselect').addEventListener('click', () => { tools.escape(); afterEdit(); });
$('btn-commit').addEventListener('click', () => { tools.commitTransform(); afterEdit(); });

function zoomCenter(factor: number) {
  const r = view.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}
/**
 * 押されたキーを小文字で返す。Option(Alt)を押すと ev.key が「ß」「‘」などの別の文字になるため、
 * Alt 併用時や不明なキーのときは物理キー(ev.code)から求める
 */
function keyOf(ev: KeyboardEvent): string {
  const byCode = (c: string): string | null => {
    let m = /^Key([A-Z])$/.exec(c); if (m) return m[1].toLowerCase();
    m = /^Digit(\d)$/.exec(c); if (m) return m[1];
    const map: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Slash: '/', Minus: '-', Equal: '=', Semicolon: ';', Enter: 'enter', Escape: 'escape', Delete: 'delete', Backspace: 'backspace', PageUp: 'pageup', PageDown: 'pagedown' };
    return map[c] ?? null;
  };
  if (ev.altKey || !ev.key || ev.key === 'Unidentified') return byCode(ev.code) ?? (ev.key || '').toLowerCase();
  return ev.key.toLowerCase();
}
/**
 * キーの受け取り先。iPad の Safari は文字入力欄に焦点があるときしかハードウェアキーをページに渡さないため、
 * iPad では見えない入力欄(inputmode=none: ソフトキーボードなし)に焦点を当てておく。PC はキャンバスでよい
 */
const keySink = $<HTMLTextAreaElement>('key-sink');
const USE_KEY_SINK = /iPad|iPhone/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function focusKeys() {
  const a = document.activeElement;
  // 設定欄などで入力中は奪わない
  const typing = (a instanceof HTMLInputElement && /^(text|password|number|email|search|url|tel)$/.test(a.type)) || a instanceof HTMLSelectElement || (a instanceof HTMLTextAreaElement && a !== keySink);
  if (typing) return;
  if (document.querySelector('dialog[open]') || !$('library').hidden) return;
  if (USE_KEY_SINK) keySink.focus({ preventScroll: true });
  else view.focus({ preventScroll: true });
}
keySink.addEventListener('input', () => { keySink.value = ''; });
// ボタンなどを押したあとも受け取り先に戻す(入力欄・ダイアログ以外)
document.addEventListener('pointerup', ev => {
  const t = ev.target as HTMLElement;
  if (t.closest('select, textarea, dialog, #library') || (t instanceof HTMLInputElement && /^(text|password|number|email|search|url|tel)$/.test(t.type))) return;
  setTimeout(focusKeys, 0);
}, true);
// キー確認モード: 届いたキーをすべて画面に表示する(左手デバイスの設定確認用)
let keyMonitor = false;
window.addEventListener('keydown', ev => {
  if (!keyMonitor) return;
  const mods = [ev.ctrlKey && 'Ctrl', ev.metaKey && 'Cmd', ev.altKey && 'Option/Alt', ev.shiftKey && 'Shift'].filter(Boolean).join('+');
  setStatus(`キー受信: ${mods ? mods + '+' : ''}${keyOf(ev)}  (key="${ev.key}" code="${ev.code}")`, 'ok');
}, true);
window.addEventListener('keydown', ev => {
  const t = ev.target as HTMLElement;
  if (t !== keySink && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.closest('dialog') || !$('library').hidden)) return;
  if (t === keySink && !ev.ctrlKey && !ev.metaKey && ev.key.length === 1) ev.preventDefault(); // 入力欄に文字を溜めない
  if (ev.code === 'Space') { spaceDown = true; ev.preventDefault(); return; }
  const k = keyOf(ev);
  const mod = ev.ctrlKey || ev.metaKey;
  if (isEmpty()) {
    // 画像がないときは、新規 / ライブラリ / タブ切替だけ受け付ける
    if (mod && k === 'n' && !ev.shiftKey) { openNewDialog(); ev.preventDefault(); }
    else if (mod && ev.shiftKey && k === 'l') { openLibrary(); ev.preventDefault(); }
    return;
  }
  if (mod) {
    let handled = true;
    switch (k) {
      case 'z': ev.shiftKey ? redo() : undo(); break;           // Ctrl+Z / Ctrl+Shift+Z(Ctrl+Alt+Z も取り消し)
      case 'y': redo(); break;
      case 't': setTool('move'); break;                          // 自由変形 = 移動ツールの枠
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
      case 'j': duplicateLayer(); break;                                                   // レイヤーを複製(Photoshop: Ctrl+J)
      case 'e': mergeDown(); break;                                                        // 下のレイヤーと結合(Photoshop: Ctrl+E)
      case '/': toggleLockActive(); break;                                                 // ロック切替(Photoshop: Ctrl+/)
      case 'l': if (ev.shiftKey) openLibrary(); else handled = false; break;               // ライブラリ(Ctrl+Shift+L)
      // 左手デバイス(TourBox など)向け: Ctrl+Alt+S 送る / Ctrl+Alt+R 受け取る / Ctrl+Alt+B ボス
      case 's': if (ev.altKey) $('btn-send').click(); else saveProject(); break;
      case 'r': if (ev.altKey) $('btn-receive').click(); else handled = false; break;
      case 'b': if (ev.altKey) toggleBoss(); else handled = false; break;
      default: handled = false;
    }
    if (handled) ev.preventDefault();
    return;
  }
  if (ev.altKey && (k === '[' || k === ']')) {                   // 上下のレイヤーを選ぶ(Photoshop: Alt+[ / Alt+])
    const i = doc.layers.findIndex(l => l.id === doc.activeLayerId);
    const j = i + (k === ']' ? 1 : -1);
    if (j >= 0 && j < doc.layers.length) setActiveLayer(doc.layers[j].id);
    ev.preventDefault();
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
  if (k === 'enter') { tools.commitTransform(); afterEdit(); }
  else if (k === 'escape') { tools.escape(); afterEdit(); }
  else if (k === 'delete' || k === 'backspace') { tools.deleteSelection(); afterEdit(); }
});
window.addEventListener('keyup', ev => { if (ev.code === 'Space') spaceDown = false; });

function undo() { tools.cancel(); tools.commitTransform(); if (history.undo(doc)) { markDirty(); afterEdit(); } }
function redo() { tools.cancel(); tools.commitTransform(); if (history.redo(doc)) { markDirty(); afterEdit(); } }
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
  tools.commitTransform();
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
      tools.commitTransform();
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
  tools.cancel(); tools.commitTransform(); tools.selectedShapes.clear();
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
  const el = $('layers');
  el.innerHTML = '';
  if (isEmpty()) { $('doc-info').textContent = ''; return; }
  syncLayerSelection();
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
    const lock = document.createElement('button');
    lock.className = 'lock' + (l.locked ? ' on' : '');
    lock.textContent = l.locked ? '🔒' : '🔓';
    lock.title = l.locked ? 'ロック中(押して解除)' : '書き込み禁止にする';
    lock.addEventListener('click', ev => { ev.stopPropagation(); l.locked = !l.locked; if (l.locked) { tools.cancel(); tools.commitTransform(); } markDirty(); renderLayers(); });
    row.classList.toggle('locked', !!l.locked);
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
    row.append(eye, lock, thumb, name, op);
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
  tools.commitTransform();
  tools.selectedShapes.clear();
  withLayersHistory(() => addLayerAbove(`レイヤー ${doc.layers.length + 1}`));
});
$('btn-layer-del').addEventListener('click', () => {
  const ids = new Set(selectedLayerIds);
  if (doc.layers.length - ids.size < 1) { setStatus('すべてのレイヤーは削除できません(1 枚は残ります)'); return; }
  tools.cancel(); tools.commitTransform(); tools.selectedShapes.clear();
  withLayersHistory(() => {
    const idx = doc.layers.findIndex(l => ids.has(l.id));
    doc.layers = doc.layers.filter(l => !ids.has(l.id));
    doc.activeLayerId = doc.layers[Math.min(idx, doc.layers.length - 1)].id;
    selectedLayerIds = new Set([doc.activeLayerId]);
  });
});
/** 選択中のレイヤーをまとめて 1 段動かす(上 = 配列の後ろ) */
const moveLayer = (dir: 1 | -1) => {
  tools.commitTransform();
  const idxs = doc.layers.map((l, i) => (selectedLayerIds.has(l.id) ? i : -1)).filter(i => i >= 0);
  if (!idxs.length) return;
  if (dir === 1 && Math.max(...idxs) + 1 >= doc.layers.length) return;
  if (dir === -1 && Math.min(...idxs) - 1 < 0) return;
  withLayersHistory(() => {
    const order = dir === 1 ? [...idxs].reverse() : idxs;
    for (const i of order) [doc.layers[i], doc.layers[i + dir]] = [doc.layers[i + dir], doc.layers[i]];
  });
};
/** アクティブレイヤーを複製して上に置く(Photoshop: Ctrl+J) */
function duplicateLayer() {
  tools.commitTransform();
  const src = activeLayer(doc);
  withLayersHistory(() => {
    const l = addLayerAbove(`${src.name} のコピー`);
    l.visible = src.visible; l.opacity = src.opacity;
    if (l.kind === 'bitmap' && src.kind === 'bitmap') ctx2d(l.canvas).drawImage(src.canvas, 0, 0);
    else if (l.kind === 'vector' && src.kind === 'vector') l.shapes = structuredClone(src.shapes).map(s => ({ ...s, id: uid() }));
  });
}
/** アクティブレイヤーを下のレイヤーと結合(Photoshop: Ctrl+E) */
function mergeDown() {
  const i = doc.layers.findIndex(l => l.id === doc.activeLayerId);
  if (i <= 0) { setStatus('下にレイヤーがありません'); return; }
  selectedLayerIds = new Set([doc.layers[i - 1].id, doc.layers[i].id]);
  mergeSelectedLayers();
}
function toggleLockActive() {
  const l = activeLayer(doc);
  l.locked = !l.locked;
  if (l.locked) { tools.cancel(); tools.commitTransform(); }
  setStatus(`レイヤー「${l.name}」を${l.locked ? 'ロックしました' : 'ロック解除しました'}`);
  markDirty(); renderLayers();
}
$('btn-layer-multi').addEventListener('click', () => { multiSelectMode = !multiSelectMode; renderLayers(); });
$('btn-layer-merge').addEventListener('click', mergeSelectedLayers);
$('btn-layer-up').addEventListener('click', () => moveLayer(1));
$('btn-layer-down').addEventListener('click', () => moveLayer(-1));
$('btn-layer-rename').addEventListener('click', () => {
  const l = activeLayer(doc);
  const n = prompt('レイヤー名', l.name);
  if (n && n.trim()) { l.name = n.trim(); markDirty(); renderLayers(); }
});

// ---------------- タブ(開いている画像) ----------------
/** 同じセクション内で同名があれば末尾に番号を付ける(名前は GitHub のフォルダ名になるため一意にする) */
function uniqueName(base: string, notebook: string, section: string, except?: Tab): string {
  const clean = cleanName(base, 'drawing');
  const used = new Set(tabs.filter(t => t !== except && t.notebook === notebook && t.section === section).map(t => t.name));
  for (const r of remoteScan?.canvases ?? []) if (r.notebook === notebook && r.section === section && !tabs.some(t => t.notebook === notebook && t.section === section && t.name === r.name)) used.add(r.name);
  if (!used.has(clean)) return clean;
  const m = clean.match(/^(.*?)(\d+)$/);
  const stem = m ? m[1] : clean;
  let n = m ? Number(m[2]) + 1 : 2;
  while (used.has(stem + n)) n++;
  return stem + n;
}
function createTab(d: Doc | null, name: string, notebook: string, section: string, id = uid()): Tab {
  return {
    id, name, notebook, section, open: false, doc: d, thumb: null,
    history: new History(), zoom: 0, panX: 0, panY: 0, toolState: null, selectedLayerIds: new Set(), sync: newSyncState(),
  };
}
/** 現在のタブに、表示状態を書き戻す */
function stashCurrentTab() {
  if (!cur || isEmpty()) return;
  tools.commitTransform();
  flushAutosave();
  cur.zoom = zoom; cur.panX = panX; cur.panY = panY;
  cur.selectedLayerIds = selectedLayerIds;
  cur.toolState = tools.getState();
}
/** 開いている画像がない状態にする */
function activateEmpty() {
  tools.reset();
  cur = EMPTY;
  doc = EMPTY.doc!;
  history = EMPTY.history;
  selectedLayerIds = new Set();
  renderPalette();
  renderLayers();
  renderTabs();
  updateSyncStatus();
  afterEdit();
}
function activateTab(tab: Tab) {
  if (!tab.doc) return;
  cur = tab;
  tab.open = tab !== EMPTY;
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
/** 新しい画像をライブラリに加えて開く */
function addTab(d: Doc, name: string, notebook: string, section: string, opts: { activate?: boolean; id?: string } = {}): Tab {
  notebook = cleanName(notebook, DEFAULT_NOTEBOOK);
  section = cleanName(section, DEFAULT_SECTION);
  const tab = createTab(d, uniqueName(name, notebook, section), notebook, section, opts.id);
  tabs.push(tab);
  ensureStructure(notebook, section);
  if (opts.activate ?? true) { stashCurrentTab(); activateTab(tab); }
  else renderTabs();
  return tab;
}
/** ライブラリの画像を開く(閉じていれば端末内の保存から読み込み、なければ GitHub から受け取る) */
async function openTab(tab: Tab): Promise<boolean> {
  if (!tab.doc) {
    const saved = await dbGet<{ manifest: Manifest }>(tabKey(tab.id));
    if (saved) tab.doc = await deserialize(saved.manifest, async () => null);
  }
  if (!tab.doc && sync.gh) {
    await pull(tab, true);
  }
  if (!tab.doc) { setStatus(`「${tab.name}」を開けませんでした(端末内にも GitHub にもデータがありません)`, 'err'); return false; }
  if (tab === cur) return true;
  stashCurrentTab();
  activateTab(tab);
  saveTabIndex();
  return true;
}
function switchTab(id: string) {
  const tab = tabs.find(t => t.id === id);
  if (tab) openTab(tab);
}
function cycleTab(dir: 1 | -1) {
  const list = openTabs();
  if (list.length < 2) return;
  const i = list.indexOf(cur);
  switchTab(list[(i + dir + list.length) % list.length].id);
}
/** タブを閉じる(画像はライブラリに残る)。最後の 1 枚を閉じると「画像なし」の状態になる */
function closeTab(id: string) {
  const tab = tabs.find(t => t.id === id);
  if (!tab || !tab.open) return;
  const list = openTabs();
  if (tab === cur) stashCurrentTab();
  tab.open = false;
  tab.doc = null; // メモリを解放。端末内の保存から再読み込みできる
  tab.history.clear();
  if (tab === cur) {
    const rest = list.filter(t => t !== tab);
    const idx = list.indexOf(tab);
    cur = undefined as unknown as Tab;
    if (rest.length) activateTab(rest[Math.min(idx, rest.length - 1)]);
    else activateEmpty();
  } else renderTabs();
  saveTabIndex();
}
/** 画像をライブラリから完全に削除する(端末内と GitHub の両方) */
async function deleteCanvas(tab: Tab) {
  if (!confirm(`「${tab.name}」を削除します。端末内と GitHub の両方から消えます。よろしいですか?`)) return;
  if (tab.open) closeTab(tab.id);
  tabs = tabs.filter(t => t !== tab);
  await dbDelete(tabKey(tab.id)).catch(() => {});
  saveTabIndex();
  if (sync.gh && (tab.sync.synced || tab.remoteDir)) {
    const dir = tab.remoteDir ?? tabDir(tab);
    await libraryRemote(g => g.movePaths(p => (p.startsWith(dir + '/') ? null : undefined), `delete ${dir} from ${DEVICE}`), `「${tab.name}」を GitHub からも削除しました`);
  }
  renderLibrary();
}
/** 名前・場所を変える。GitHub 上のフォルダも移す */
async function relocateCanvas(tab: Tab, name: string, notebook: string, section: string) {
  notebook = cleanName(notebook, DEFAULT_NOTEBOOK);
  section = cleanName(section, DEFAULT_SECTION);
  const n = uniqueName(name, notebook, section, tab);
  if (n === tab.name && notebook === tab.notebook && section === tab.section) return;
  const oldDir = tab.remoteDir ?? tabDir(tab);
  tab.name = n; tab.notebook = notebook; tab.section = section;
  ensureStructure(notebook, section);
  const newDir = tabDir(tab);
  if (sync.gh && (tab.sync.synced || tab.remoteDir)) {
    const sha = await libraryRemote(g => g.movePaths(p => (p.startsWith(oldDir + '/') ? newDir + p.slice(oldDir.length) : undefined), `move ${oldDir} -> ${newDir} from ${DEVICE}`), `GitHub 上でも「${newDir}」へ移しました`);
    if (sha) { tab.sync.lastSha = sha; tab.remoteDir = undefined; tab.sync.knownPaths = new Set([...tab.sync.knownPaths].map(p => (p.startsWith(oldDir + '/') ? newDir + p.slice(oldDir.length) : p))); }
  }
  renderTabs(); updateSyncStatus(); saveTabIndex(); renderLibrary();
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
  for (const t of openTabs()) {
    const b = document.createElement('div');
    b.className = 'tab' + (t === cur ? ' active' : '');
    b.dataset.id = t.id;
    const dot = document.createElement('span');
    dot.className = 'sdot';
    dot.style.background = colorFor(t.section);
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
    b.title = `${t.notebook} › ${t.section} › ${t.name}${state ? `(${state})` : ''}\nダブルタップで名前を変更`;
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = '閉じる(ライブラリには残ります)';
    close.addEventListener('click', ev => { ev.stopPropagation(); closeTab(t.id); });
    b.append(dot, name, dirty, close);
    b.addEventListener('click', () => switchTab(t.id));
    b.addEventListener('dblclick', () => {
      const n = prompt('画像の名前(GitHub のフォルダ名になります)', t.name);
      if (n && n.trim()) relocateCanvas(t, n.trim(), t.notebook, t.section);
    });
    el.appendChild(b);
  }
  el.querySelector('.tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
$('btn-tab-new').addEventListener('click', () => openNewDialog());
$<HTMLInputElement>('opt-key-monitor').addEventListener('change', ev => {
  keyMonitor = (ev.target as HTMLInputElement).checked;
  setTimeout(focusKeys, 0);
  setStatus(keyMonitor ? 'キー確認: キャンバスをタップしてから左手デバイスのボタンを押してください' : 'キー確認を終了しました');
});
// 画像がないときは、編集・書き出し・同期などのボタンを受け付けない(先に捕まえて止める)
const EMPTY_BLOCKED = new Set(['btn-save', 'btn-png', 'btn-psd', 'btn-svg', 'btn-yohaku', 'btn-undo', 'btn-redo', 'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit',
  'btn-send', 'btn-receive', 'btn-cut', 'btn-copy', 'btn-paste', 'btn-delete', 'btn-select-all', 'btn-deselect', 'btn-commit', 'btn-add-color',
  'btn-layer-add', 'btn-layer-del', 'btn-layer-up', 'btn-layer-down', 'btn-layer-rename', 'btn-layer-multi', 'btn-layer-merge']);
document.addEventListener('click', ev => {
  const b = (ev.target as HTMLElement).closest?.('button');
  if (b && isEmpty() && EMPTY_BLOCKED.has(b.id)) {
    ev.stopImmediatePropagation();
    ev.preventDefault();
    setStatus('画像を開いていません。「新規」で作るか、「ライブラリ」から開いてください');
  }
}, true);
$('empty-new').addEventListener('click', () => openNewDialog());
$('empty-library').addEventListener('click', openLibrary);

// ---------------- ボスが来た(緊急で画面を隠す) ----------------
let bossHidden = false;
const ORIGINAL_TITLE = document.title;
function toggleBoss() {
  bossHidden = !bossHidden;
  if (bossHidden) { tools.cancel(); flushAutosave(); }
  $('boss-screen').hidden = !bossHidden;
  document.title = bossHidden ? 'Untitled' : ORIGINAL_TITLE;
  if (!bossHidden) requestRender();
}
$('btn-boss').addEventListener('click', toggleBoss);
$('btn-boss-restore').addEventListener('click', toggleBoss);

// ---------------- ライブラリ(ノートブック › セクション › 画像) ----------------
const STRUCTURE_KEY = 'oekaki.structure';
const REMOTE_SCAN_KEY = 'oekaki.remoteScan';
let libNotebook = DEFAULT_NOTEBOOK;
let libSection = DEFAULT_SECTION;

function ensureStructure(notebook: string, section: string) {
  let changed = false;
  if (!structure.notebooks.includes(notebook)) { structure.notebooks.push(notebook); changed = true; }
  if (!structure.sections.some(s => s.notebook === notebook && s.name === section)) { structure.sections.push({ notebook, name: section }); changed = true; }
  if (changed) dbPut(STRUCTURE_KEY, structure).catch(() => {});
}
/** 端末内 + GitHub の一覧を合わせた全ノートブック */
function allNotebooks(): string[] {
  const set = new Set<string>([...structure.notebooks, ...tabs.map(t => t.notebook), ...(remoteScan?.notebooks ?? [])]);
  return [...set].sort((a, b) => (a === DEFAULT_NOTEBOOK ? -1 : b === DEFAULT_NOTEBOOK ? 1 : a.localeCompare(b, 'ja')));
}
function allSections(notebook: string): string[] {
  const set = new Set<string>([
    ...structure.sections.filter(s => s.notebook === notebook).map(s => s.name),
    ...tabs.filter(t => t.notebook === notebook).map(t => t.section),
    ...(remoteScan?.sections ?? []).filter(s => s.notebook === notebook).map(s => s.name),
  ]);
  return [...set].sort((a, b) => (a === DEFAULT_SECTION ? -1 : b === DEFAULT_SECTION ? 1 : a.localeCompare(b, 'ja')));
}
interface LibEntry { key: string; name: string; local: Tab | null; remote: RemoteCanvas | null; }
function canvasesIn(notebook: string, section: string): LibEntry[] {
  const map = new Map<string, LibEntry>();
  for (const t of tabs) if (t.notebook === notebook && t.section === section) map.set(t.name, { key: t.name, name: t.name, local: t, remote: null });
  for (const r of remoteScan?.canvases ?? []) {
    if (r.notebook !== notebook || r.section !== section) continue;
    const e = map.get(r.name);
    if (e) e.remote = r;
    else map.set(r.name, { key: r.name, name: r.name, local: null, remote: r });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}
const countIn = (notebook: string, section?: string) =>
  (section === undefined ? allSections(notebook).reduce((n, s) => n + canvasesIn(notebook, s).length, 0) : canvasesIn(notebook, section).length);

function openLibrary() {
  stashCurrentTab();
  libNotebook = cur?.notebook || DEFAULT_NOTEBOOK;
  libSection = cur?.section || DEFAULT_SECTION;
  $('library').hidden = false;
  renderLibrary();
  if (sync.gh) scanRemote();
}
function closeLibrary() { $('library').hidden = true; requestRender(); }
$('btn-library').addEventListener('click', openLibrary);
$('lib-close').addEventListener('click', closeLibrary);
$('lib-refresh').addEventListener('click', () => { if (sync.gh) scanRemote(true); else $('lib-status').textContent = 'GitHub が未設定です'; });

/** 「⋯」メニュー(prompt / confirm ベースの簡易版) */
function moreButton(actions: { label: string; run: () => void }[]): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'more';
  b.textContent = '⋯';
  b.title = 'メニュー';
  b.addEventListener('click', ev => {
    ev.stopPropagation();
    const choice = prompt(actions.map((a, i) => `${i + 1}: ${a.label}`).join('\n') + '\n番号を入力', '');
    const i = Number(choice) - 1;
    if (actions[i]) actions[i].run();
  });
  return b;
}

function renderLibrary() {
  if ($('library').hidden) return;
  const nbs = allNotebooks();
  if (!nbs.includes(libNotebook)) libNotebook = nbs[0] ?? DEFAULT_NOTEBOOK;
  const secs = allSections(libNotebook);
  if (!secs.includes(libSection)) libSection = secs[0] ?? DEFAULT_SECTION;

  const nbList = $('lib-nb-list');
  nbList.innerHTML = '';
  for (const nb of nbs) {
    const row = document.createElement('div');
    row.className = 'lib-item' + (nb === libNotebook ? ' active' : '');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = colorFor(nb);
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = nb;
    const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = String(countIn(nb));
    row.append(dot, nm, cnt, moreButton([
      { label: '名前を変更', run: () => { const n = prompt('ノートブック名', nb); if (n && n.trim()) renameNotebook(nb, n.trim()); } },
      { label: '削除', run: () => deleteNotebook(nb) },
    ]));
    row.addEventListener('click', () => { libNotebook = nb; libSection = allSections(nb)[0] ?? DEFAULT_SECTION; renderLibrary(); });
    nbList.appendChild(row);
  }

  const secList = $('lib-sec-list');
  secList.innerHTML = '';
  for (const sec of secs) {
    const row = document.createElement('div');
    row.className = 'lib-item' + (sec === libSection ? ' active' : '');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = colorFor(sec);
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = sec;
    const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = String(countIn(libNotebook, sec));
    row.append(dot, nm, cnt, moreButton([
      { label: '名前を変更', run: () => { const n = prompt('セクション名', sec); if (n && n.trim()) renameSection(libNotebook, sec, n.trim()); } },
      { label: '削除', run: () => deleteSection(libNotebook, sec) },
    ]));
    row.addEventListener('click', () => { libSection = sec; renderLibrary(); });
    secList.appendChild(row);
  }

  $('lib-crumb').textContent = `${libNotebook} › ${libSection}`;
  const grid = $('lib-grid');
  grid.innerHTML = '';
  const entries = canvasesIn(libNotebook, libSection);
  if (!entries.length) {
    const e = document.createElement('div');
    e.className = 'lib-empty';
    e.textContent = 'このセクションにはまだ画像がありません。「＋ 新規画像」で作るか、画像ファイルをキャンバスにドロップしてください。';
    grid.appendChild(e);
  }
  for (const en of entries) {
    const card = document.createElement('div');
    card.className = 'lib-card' + (en.local?.open ? ' open' : '');
    const th = document.createElement('div');
    th.className = 'thumb';
    const img = document.createElement('img');
    const local = en.local;
    if (local?.thumb) img.src = local.thumb;
    else if (local?.doc) { thumbDataUrl(local).then(u => { img.src = u; }); }
    else if (en.remote?.thumbSha) { remoteThumb(en.remote.thumbSha).then(u => { if (u) img.src = u; }); }
    if (local?.thumb || local?.doc || en.remote?.thumbSha) th.appendChild(img);
    else { const ph = document.createElement('span'); ph.className = 'ph'; ph.textContent = 'サムネイルなし'; th.appendChild(ph); }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = en.name; nm.title = en.name;
    const badge = document.createElement('span');
    badge.className = 'badge' + (!local ? ' cloud' : '');
    badge.textContent = !local ? '☁ GitHub' : local.open ? '開いています' : (local.sync.dirty && sync.gh ? '● 未送信' : '');
    const actions: { label: string; run: () => void }[] = [];
    if (local) {
      actions.push({ label: '名前を変更', run: () => { const n = prompt('画像の名前', local.name); if (n && n.trim()) relocateCanvas(local, n.trim(), local.notebook, local.section); } });
      actions.push({ label: '別のセクションへ移動', run: () => openMoveDialog(local) });
      actions.push({ label: '削除', run: () => deleteCanvas(local) });
    } else if (en.remote) {
      actions.push({ label: 'GitHub から削除', run: () => deleteRemoteOnly(en.remote!) });
    }
    meta.append(nm, badge, moreButton(actions));
    card.append(th, meta);
    card.addEventListener('click', () => openFromLibrary(en));
    grid.appendChild(card);
  }
}
async function openFromLibrary(en: LibEntry) {
  let tab = en.local;
  if (!tab) {
    const r = en.remote!;
    tab = createTab(null, r.name, r.notebook, r.section);
    if (r.legacy) tab.remoteDir = r.dir;
    tabs.push(tab);
  }
  closeLibrary();
  const ok = await openTab(tab);
  if (!ok && !en.local) tabs = tabs.filter(t => t !== tab);
  renderTabs();
}
$('lib-nb-add').addEventListener('click', async () => {
  const n = prompt('新しいノートブックの名前');
  if (!n || !n.trim()) return;
  const nb = cleanName(n, DEFAULT_NOTEBOOK);
  ensureStructure(nb, DEFAULT_SECTION);
  libNotebook = nb; libSection = DEFAULT_SECTION;
  renderLibrary();
  await keepRemote(nb, DEFAULT_SECTION);
});
$('lib-sec-add').addEventListener('click', async () => {
  const n = prompt(`「${libNotebook}」に追加するセクションの名前`);
  if (!n || !n.trim()) return;
  const sec = cleanName(n, DEFAULT_SECTION);
  ensureStructure(libNotebook, sec);
  libSection = sec;
  renderLibrary();
  await keepRemote(libNotebook, sec);
});
$('lib-img-add').addEventListener('click', () => { closeLibrary(); openNewDialog(libNotebook, libSection); });

/** GitHub に空のセクションを見えるようにする(.keep を置く) */
async function keepRemote(notebook: string, section: string) {
  if (!sync.gh) return;
  await libraryRemote(g => g.commitChanges([{ path: `${notebook}/${section}/${KEEP_FILE}`, content: '' }], `add section ${notebook}/${section} from ${DEVICE}`), `GitHub にも「${notebook} › ${section}」を作りました`);
}
async function renameNotebook(from: string, to: string) {
  to = cleanName(to, DEFAULT_NOTEBOOK);
  if (to === from) return;
  if (allNotebooks().includes(to)) { alert('同じ名前のノートブックがあります'); return; }
  for (const t of tabs) if (t.notebook === from) t.notebook = to;
  structure.notebooks = structure.notebooks.map(n => (n === from ? to : n));
  structure.sections.forEach(s => { if (s.notebook === from) s.notebook = to; });
  dbPut(STRUCTURE_KEY, structure).catch(() => {});
  if (remoteScan) { remoteScan.notebooks = remoteScan.notebooks.map(n => (n === from ? to : n)); remoteScan.sections.forEach(s => { if (s.notebook === from) s.notebook = to; }); remoteScan.canvases.forEach(c => { if (c.notebook === from && !c.legacy) { c.notebook = to; c.dir = canvasDir(to, c.section, c.name); } }); }
  libNotebook = to;
  renderTabs(); renderLibrary(); saveTabIndex();
  if (sync.gh) await libraryRemote(g => g.movePaths(p => (p.startsWith(from + '/') ? to + p.slice(from.length) : undefined), `rename notebook ${from} -> ${to} from ${DEVICE}`), `GitHub 上でも「${to}」に変更しました`, true);
}
async function renameSection(notebook: string, from: string, to: string) {
  to = cleanName(to, DEFAULT_SECTION);
  if (to === from) return;
  if (allSections(notebook).includes(to)) { alert('同じ名前のセクションがあります'); return; }
  for (const t of tabs) if (t.notebook === notebook && t.section === from) t.section = to;
  structure.sections.forEach(s => { if (s.notebook === notebook && s.name === from) s.name = to; });
  dbPut(STRUCTURE_KEY, structure).catch(() => {});
  if (remoteScan) { remoteScan.sections.forEach(s => { if (s.notebook === notebook && s.name === from) s.name = to; }); remoteScan.canvases.forEach(c => { if (c.notebook === notebook && c.section === from && !c.legacy) { c.section = to; c.dir = canvasDir(notebook, to, c.name); } }); }
  libSection = to;
  renderTabs(); renderLibrary(); saveTabIndex();
  const oldP = `${notebook}/${from}/`, newP = `${notebook}/${to}/`;
  if (sync.gh) await libraryRemote(g => g.movePaths(p => (p.startsWith(oldP) ? newP + p.slice(oldP.length) : undefined), `rename section ${oldP} -> ${newP} from ${DEVICE}`), `GitHub 上でも「${to}」に変更しました`, true);
}
async function deleteNotebook(nb: string) {
  const n = countIn(nb);
  if (allNotebooks().length <= 1) { alert('最後のノートブックは削除できません'); return; }
  if (!confirm(`ノートブック「${nb}」を削除します${n ? `(中の画像 ${n} 枚も端末と GitHub から消えます)` : ''}。よろしいですか?`)) return;
  await removeCanvases(t => t.notebook === nb);
  structure.notebooks = structure.notebooks.filter(x => x !== nb);
  structure.sections = structure.sections.filter(s => s.notebook !== nb);
  dbPut(STRUCTURE_KEY, structure).catch(() => {});
  if (remoteScan) { remoteScan.notebooks = remoteScan.notebooks.filter(x => x !== nb); remoteScan.sections = remoteScan.sections.filter(s => s.notebook !== nb); remoteScan.canvases = remoteScan.canvases.filter(c => c.notebook !== nb); }
  renderLibrary();
  if (sync.gh) await libraryRemote(g => g.movePaths(p => (p.startsWith(nb + '/') ? null : undefined), `delete notebook ${nb} from ${DEVICE}`), `GitHub からも「${nb}」を削除しました`, true);
}
async function deleteSection(nb: string, sec: string) {
  const n = countIn(nb, sec);
  if (!confirm(`セクション「${sec}」を削除します${n ? `(中の画像 ${n} 枚も端末と GitHub から消えます)` : ''}。よろしいですか?`)) return;
  await removeCanvases(t => t.notebook === nb && t.section === sec);
  structure.sections = structure.sections.filter(s => !(s.notebook === nb && s.name === sec));
  dbPut(STRUCTURE_KEY, structure).catch(() => {});
  if (remoteScan) { remoteScan.sections = remoteScan.sections.filter(s => !(s.notebook === nb && s.name === sec)); remoteScan.canvases = remoteScan.canvases.filter(c => !(c.notebook === nb && c.section === sec)); }
  renderLibrary();
  const p0 = `${nb}/${sec}/`;
  if (sync.gh) await libraryRemote(g => g.movePaths(p => (p.startsWith(p0) ? null : undefined), `delete section ${p0} from ${DEVICE}`), `GitHub からも「${sec}」を削除しました`, true);
}
/** 条件に合う端末内の画像を消す(開いているものは閉じる) */
async function removeCanvases(pred: (t: Tab) => boolean) {
  const victims = tabs.filter(pred);
  if (!victims.length) return;
  for (const t of victims) if (t.open) closeTab(t.id);
  tabs = tabs.filter(t => !pred(t));
  for (const t of victims) await dbDelete(tabKey(t.id)).catch(() => {});
  saveTabIndex();
  renderTabs();
}
async function deleteRemoteOnly(r: RemoteCanvas) {
  if (!confirm(`GitHub 上の「${r.name}」を削除します。よろしいですか?`)) return;
  if (remoteScan) remoteScan.canvases = remoteScan.canvases.filter(c => c !== r);
  renderLibrary();
  await libraryRemote(g => g.movePaths(p => (p.startsWith(r.dir + '/') ? null : undefined), `delete ${r.dir} from ${DEVICE}`), `GitHub から「${r.name}」を削除しました`);
}
/** ライブラリ操作を GitHub に反映する共通処理(進行表示とエラー表示) */
async function libraryRemote(fn: (g: GitHubSync) => Promise<string | null>, okMsg: string, rescan = false): Promise<string | null> {
  if (!sync.gh || !sync.cfg) return null;
  const st = $('lib-status');
  st.textContent = 'GitHub に反映中…';
  try {
    const sha = await fn(new GitHubSync({ ...sync.cfg, dir: '' }));
    st.textContent = okMsg;
    setStatus(okMsg, 'ok');
    if (rescan) await scanRemote(true);
    return sha;
  } catch (e) {
    console.error(e);
    st.textContent = 'GitHub への反映に失敗: ' + (e as Error).message;
    setStatus('GitHub への反映に失敗: ' + (e as Error).message, 'err');
    return null;
  }
}
let scanning = false;
/** GitHub の一覧を取り直す */
async function scanRemote(force = false) {
  if (!sync.gh || !sync.cfg || scanning) return;
  if (!force && remoteScan && Date.now() - (remoteScanAt || 0) < 20_000) return;
  scanning = true;
  const st = $('lib-status');
  st.textContent = 'GitHub の一覧を取得中…';
  try {
    const g = new GitHubSync({ ...sync.cfg, dir: '' });
    const { sha, files } = await g.listTree();
    remoteScan = { headSha: sha, ...parseTree(files) };
    remoteScanAt = Date.now();
    dbPut(REMOTE_SCAN_KEY, { at: remoteScanAt, scan: remoteScan }).catch(() => {});
    st.textContent = `GitHub の一覧を更新しました(画像 ${remoteScan.canvases.length} 枚)`;
  } catch (e) {
    st.textContent = 'GitHub の一覧を取得できません: ' + (e as Error).message;
  } finally {
    scanning = false;
    renderLibrary();
  }
}
let remoteScanAt = 0;
const thumbCache = new Map<string, string>();
async function remoteThumb(sha: string): Promise<string | null> {
  if (thumbCache.has(sha)) return thumbCache.get(sha)!;
  const cached = await dbGet<string>(`oekaki.thumb.${sha}`).catch(() => undefined);
  if (cached) { thumbCache.set(sha, cached); return cached; }
  if (!sync.cfg) return null;
  try {
    const bytes = await new GitHubSync({ ...sync.cfg, dir: '' }).getBlobBytes(sha);
    const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = () => rej(r.error); r.readAsDataURL(new Blob([bytes as BlobPart], { type: 'image/png' })); });
    thumbCache.set(sha, url);
    dbPut(`oekaki.thumb.${sha}`, url).catch(() => {});
    return url;
  } catch { return null; }
}
async function thumbDataUrl(tab: Tab): Promise<string> {
  if (!tab.doc) return tab.thumb ?? '';
  const blob = await makeThumb(compositeToCanvas(tab.doc));
  const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  tab.thumb = url;
  return url;
}

const dlgMove = $<HTMLDialogElement>('dlg-move');
let moveTarget: Tab | null = null;
function fillDatalists() {
  $('nb-list').innerHTML = allNotebooks().map(n => `<option value="${n.replace(/"/g, '&quot;')}">`).join('');
  const nb = $<HTMLInputElement>('new-notebook').value || $<HTMLInputElement>('move-notebook').value || libNotebook;
  $('sec-list').innerHTML = allSections(nb).map(n => `<option value="${n.replace(/"/g, '&quot;')}">`).join('');
}
$<HTMLInputElement>('new-notebook').addEventListener('input', fillDatalists);
$<HTMLInputElement>('move-notebook').addEventListener('input', fillDatalists);
function openMoveDialog(tab: Tab) {
  moveTarget = tab;
  $<HTMLInputElement>('move-notebook').value = tab.notebook;
  $<HTMLInputElement>('move-section').value = tab.section;
  fillDatalists();
  dlgMove.showModal();
}
$('move-cancel').addEventListener('click', () => dlgMove.close());
$('move-ok').addEventListener('click', () => {
  if (!moveTarget) return;
  relocateCanvas(moveTarget, moveTarget.name, $<HTMLInputElement>('move-notebook').value, $<HTMLInputElement>('move-section').value);
  dlgMove.close();
});

// ---------------- ドキュメント ----------------
const dlgNew = $<HTMLDialogElement>('dlg-new');
function openNewDialog(notebook?: string, section?: string) {
  const nb = notebook ?? (cur?.notebook || DEFAULT_NOTEBOOK);
  const sec = section ?? (cur?.section || DEFAULT_SECTION);
  $<HTMLInputElement>('new-notebook').value = nb;
  $<HTMLInputElement>('new-section').value = sec;
  fillDatalists();
  $<HTMLInputElement>('new-name').value = uniqueName(`drawing${tabs.length + 1}`, nb, sec);
  dlgNew.showModal();
}
$('btn-new').addEventListener('click', () => openNewDialog());
$('new-cancel').addEventListener('click', () => dlgNew.close());
$('new-ok').addEventListener('click', async () => {
  const w = Math.max(1, Math.min(8192, Number($<HTMLInputElement>('new-width').value) || 1024));
  const h = Math.max(1, Math.min(8192, Number($<HTMLInputElement>('new-height').value) || 768));
  const kind = $<HTMLSelectElement>('new-kind').value as DocKind;
  const nb = $<HTMLInputElement>('new-notebook').value, sec = $<HTMLInputElement>('new-section').value;
  const isNewSection = !allSections(cleanName(nb, DEFAULT_NOTEBOOK)).includes(cleanName(sec, DEFAULT_SECTION));
  const tab = addTab(createDoc(kind, w, h), $<HTMLInputElement>('new-name').value, nb, sec);
  dlgNew.close();
  saveTab(tab);
  saveTabIndex();
  if (isNewSection) await keepRemote(tab.notebook, tab.section);
  autoSyncTick(); // 同じ名前の絵が GitHub にあればすぐ受け取る
});

async function saveProject() {
  tools.commitTransform();
  const { manifest } = await serialize(doc, 'embed');
  download(new Blob([JSON.stringify(manifest)], { type: 'application/json' }), `${cur.name}.json`);
}
$('btn-save').addEventListener('click', saveProject);
$('btn-open').addEventListener('click', () => $<HTMLInputElement>('file-open').click());
/** プロジェクト JSON / 画像 / PSD を新しいタブとして開く */
async function openFile(f: File) {
  const name = f.name.replace(/\.[^.]+$/, '') || 'image';
  try {
    let d: Doc;
    if (/\.json$/i.test(f.name)) d = await deserialize(JSON.parse(await f.text()) as Manifest, async () => null);
    else if (PSD_EXT.test(f.name)) d = await importPsd(f);
    else if (IMAGE_EXT.test(f.name) || f.type.startsWith('image/')) d = await importImage(f);
    else throw new Error('対応していないファイル形式です(JSON / PNG / JPEG / WebP / GIF / BMP / SVG / PSD)');
    const tab = addTab(d, name, cur?.notebook || DEFAULT_NOTEBOOK, cur?.section || DEFAULT_SECTION);
    tab.sync.dirty = true;
    saveTab(tab);
    saveTabIndex();
    setStatus(`「${f.name}」を開きました(${tab.notebook} › ${tab.section})`, 'ok');
  } catch (e) { alert(`「${f.name}」を読み込めませんでした: ` + (e as Error).message); }
}
$<HTMLInputElement>('file-open').addEventListener('change', async ev => {
  const input = ev.target as HTMLInputElement;
  for (const f of [...(input.files ?? [])]) await openFile(f);
  input.value = '';
});
// キャンバスへのドラッグ&ドロップでも開ける
viewport.addEventListener('dragover', ev => { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'; });
viewport.addEventListener('drop', async ev => {
  ev.preventDefault();
  for (const f of [...(ev.dataTransfer?.files ?? [])]) await openFile(f);
});
$('btn-png').addEventListener('click', () => { tools.commitTransform(); exportPng(doc, cur.name); });

// ---------------- 余白ノートへ送る ----------------
// 同じ kusimaru.github.io 上の余白ノートと IndexedDB('oekaki-share' / 'inbox')を共有し、
// 合成した PNG を置いてから余白ノートを開く。余白ノート側が起動時 / 画面に戻ったときに取り出して今のページに貼る。
function openShareInbox(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('oekaki-share', 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('inbox')) r.result.createObjectStore('inbox', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function sendToYohaku() {
  tools.commitTransform();
  const blob = await canvasToBlob(compositeToCanvas(doc));
  const isIosApp = /iPad|iPhone/.test(navigator.userAgent) && (navigator as any).standalone === true;
  // iPad のホーム画面アプリは保存領域が別なので、共有シートで渡す(「ファイルに保存」→ 余白ノートの「画像を追加」)
  if (isIosApp && navigator.canShare?.({ files: [new File([blob], `${cur.name}.png`, { type: 'image/png' })] })) {
    try { await navigator.share({ files: [new File([blob], `${cur.name}.png`, { type: 'image/png' })], title: cur.name }); } catch { /* キャンセル */ }
    return;
  }
  try {
    const src = await blobToDataUrl(blob);
    const idb = await openShareInbox();
    await new Promise<void>((res, rej) => {
      const tx = idb.transaction('inbox', 'readwrite');
      tx.objectStore('inbox').put({ id: uid(), name: cur.name, src, width: doc.width, height: doc.height, createdAt: Date.now() });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    // 書けたか読み返して件数を出す(診断用)
    const n = await new Promise<number>((res, rej) => { const q = idb.transaction('inbox').objectStore('inbox').count(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    idb.close();
    const ua = /Edg\//.test(navigator.userAgent) ? 'Edge' : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : /Safari\//.test(navigator.userAgent) ? 'Safari' : 'その他';
    // ブラウザが違う(保存領域を共有できない)場合の保険として、クリップボードにも画像を入れる。
    // 余白ノートで貼り付け(Ctrl+V)すると、text/plain の印を見て「データ受け取り › お絵かきツール」に入る
    let copied = false;
    try {
      if (navigator.clipboard && 'write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob, 'text/plain': new Blob([`oekaki-tool:${cur.name}`], { type: 'text/plain' }) })]);
        copied = true;
      }
    } catch { /* 権限なしなどは無視 */ }
    // GitHub 経由(iPad のホーム画面アプリなど、保存領域を共有できない相手にも届く)。
    // oekaki-data の `_yohaku-inbox/` に置き、余白ノート側が取りに来て削除する
    let viaGithub = false;
    if (sync.gh && sync.cfg) {
      try {
        await new GitHubSync({ ...sync.cfg, dir: '' }).commitChanges(
          [{ path: `_yohaku-inbox/${Date.now()}-${cur.name}.png`, content: new Uint8Array(await blob.arrayBuffer()) }],
          `send ${cur.name} to yohaku-note from ${DEVICE}`,
        );
        viaGithub = true;
      } catch (e) { console.warn('yohaku via github', e); }
    }
    // タブは開かない。アプリ化した余白ノートを開く(前面にする)と、その時点で受け取って貼り付ける
    const how = viaGithub ? 'GitHub 経由でも送りました。余白ノートの「お絵かきツールから受け取る」を設定していれば、開いたときに自動で届きます' : 'GitHub 未設定のため、同じブラウザの余白ノートにだけ届きます';
    setStatus(`「${cur.name}」を余白ノートに送りました(${ua} の受け渡し箱: ${n} 枚${copied ? '、クリップボードにもコピー済み' : ''})。${how}`, 'ok');
  } catch (e) {
    setStatus('余白ノートへ送れませんでした: ' + (e as Error).message, 'err');
  }
}
$('btn-yohaku').addEventListener('click', sendToYohaku);
$('btn-psd').addEventListener('click', async () => {
  tools.commitTransform();
  try { await exportPsd(doc, cur.name); } catch (e) { alert('PSD 書き出しに失敗: ' + (e as Error).message); }
});
$('btn-svg').addEventListener('click', () => { tools.commitTransform(); exportSvg(doc, cur.name); });

// ---------------- ローカル保存(IndexedDB) ----------------
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

interface TabIndexEntry {
  id: string; name: string; notebook?: string; section?: string; open?: boolean; thumb?: string | null; remoteDir?: string;
  sync?: { lastSha: string | null; synced: boolean; dirty: boolean; lastEdit: number };
}
function saveTabIndex() {
  const entries: TabIndexEntry[] = tabs.map(t => ({
    id: t.id, name: t.name, notebook: t.notebook, section: t.section, open: t.open, thumb: t.thumb, remoteDir: t.remoteDir,
    sync: { lastSha: t.sync.lastSha, synced: t.sync.synced, dirty: t.sync.dirty, lastEdit: t.sync.lastEdit },
  }));
  dbPut(TAB_INDEX_KEY, { activeId: cur?.id, tabs: entries }).catch(() => {});
}
async function saveTab(tab: Tab) {
  if (!tab.doc || tab === EMPTY) return;
  try {
    const { manifest } = await serialize(tab === cur ? tools.docForSave() : tab.doc, 'embed');
    await dbPut(tabKey(tab.id), { name: tab.name, manifest });
    await thumbDataUrl(tab);
    saveTabIndex();
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
  autosaveTimer = window.setTimeout(() => { autosavePending = null; saveTab(tab); }, 1500);
}
/** 保存待ちがあれば今すぐ保存する(タブ切り替え・終了前) */
function flushAutosave() {
  if (!autosavePending) return;
  clearTimeout(autosaveTimer);
  const tab = autosavePending;
  autosavePending = null;
  saveTab(tab);
}
/** 前回の状態(ライブラリ全体と開いていたタブ)を復元する。1 枚でも開けたら true */
async function restoreTabs(): Promise<boolean> {
  try {
    structure = (await dbGet<Structure>(STRUCTURE_KEY)) ?? structure;
    const cachedScan = await dbGet<{ at: number; scan: RemoteScan }>(REMOTE_SCAN_KEY);
    if (cachedScan) { remoteScan = cachedScan.scan; remoteScanAt = 0; }
    const index = await dbGet<{ activeId?: string; tabs: TabIndexEntry[] }>(TAB_INDEX_KEY);
    let opened = false;
    if (index?.tabs?.length) {
      for (const entry of index.tabs) {
        const tab = createTab(null, entry.name, entry.notebook ?? DEFAULT_NOTEBOOK, entry.section ?? DEFAULT_SECTION, entry.id);
        tab.thumb = entry.thumb ?? null;
        tab.remoteDir = entry.remoteDir;
        if (entry.sync) Object.assign(tab.sync, entry.sync);
        tabs.push(tab);
        ensureStructure(tab.notebook, tab.section);
      }
      // 前回開いていたタブだけ内容を読み込む
      for (const entry of index.tabs) {
        if (!entry.open && entry.id !== index.activeId) continue;
        const tab = tabs.find(t => t.id === entry.id)!;
        const saved = await dbGet<{ manifest: Manifest }>(tabKey(tab.id));
        if (!saved) continue;
        tab.doc = await deserialize(saved.manifest, async () => null);
        tab.open = true;
        opened = true;
      }
      const active = tabs.find(t => t.id === index.activeId && t.doc) ?? tabs.find(t => t.doc);
      if (active) activateTab(active);
    }
    // 旧バージョン(タブなし)の保存があれば引き継ぐ
    const legacy = await dbGet<{ name: string; manifest: Manifest }>(LEGACY_AUTOSAVE_KEY);
    if (legacy) {
      addTab(await deserialize(legacy.manifest, async () => null), legacy.name, DEFAULT_NOTEBOOK, DEFAULT_SECTION, { activate: !opened });
      await dbDelete(LEGACY_AUTOSAVE_KEY);
      opened = true;
      saveTab(cur);
    }
    return opened;
  } catch (e) { console.error(e); return false; }
}

function markDirty() {
  cur.sync.dirty = true;
  cur.sync.lastEdit = Date.now();
  $<HTMLButtonElement>('btn-undo').disabled = !history.canUndo;
  $<HTMLButtonElement>('btn-redo').disabled = !history.canRedo;
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
  cfg: null as (GhConfig & { auto: boolean; auto2?: boolean }) | null,
  gh: null as GitHubSync | null,
  /** 自動同期(既定はオフ = ボタンを押したときだけ同期) */
  auto: false,
};
/** 画像ごとのフォルダを向いたクライアントを作る */
function ghFor(tab: Tab): GitHubSync | null {
  if (!sync.cfg || !sync.gh) return null;
  const g = new GitHubSync({ ...sync.cfg, dir: tab.remoteDir ?? tabDir(tab) });
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
  send.querySelector('.lbl')!.textContent = state === 'sending' ? '送信中' : '送る';
  recv.querySelector('.lbl')!.textContent = state === 'receiving' ? '受信中' : '受け取る';
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
  if (!cur) return;
  if (isEmpty()) { const el = $('sync-status'); el.textContent = '画像を開いていません'; el.className = ''; return; }
  const s = cur.sync;
  const send = $('btn-send'), recv = $('btn-receive');
  const both = s.conflict || (s.dirty && s.remoteChanged);
  send.classList.toggle('attention', both);
  recv.classList.toggle('attention', both);
  const last = s.lastInfo ? ` · 最終更新 ${s.lastInfo.device} ${timeAgo(s.lastInfo.date)}` : '';
  if (s.busy) return;
  const el = $('sync-status');
  const show = (msg: string, cls: '' | 'ok' | 'err' = '') => { el.textContent = msg; el.className = cls; $('gh-msg').textContent = msg; };
  // 手動モードでは状態を右上に出すだけ(バナーはボタン操作の結果にだけ使う)
  const out = sync.auto ? setStatus : show;
  if (both) out(`「${cur.name}」は ${DEVICE === 'iPad' ? 'PC' : 'iPad'} でも変更されています。どちらを残すかボタンで選んでください${last}`, 'err');
  else if (s.remoteChanged) out(`「${cur.name}」: 相手の更新あり(「受け取る」で取り込み)${last}`);
  else if (s.dirty) out(`「${cur.name}」: 未送信の変更あり` + (sync.auto ? '(まもなく自動で送ります)' : '(「送る」で送信)') + last);
  else if (s.synced) out(`「${cur.name}」: 送信済み${last}`, 'ok');
  else out(`「${cur.name}」: GitHub にまだ送っていません` + (sync.auto ? '(描くと自動で送ります)' : '(「送る」で送信)'));
}
function loadGhConfig(): (GhConfig & { auto: boolean; auto2?: boolean }) | null {
  try { return JSON.parse(localStorage.getItem(GH_KEY) || 'null'); } catch { return null; }
}
/** 接続設定を反映する。resetTabs=true なら各タブの同期状態(どのコミットまで受け取ったか)を忘れる */
function applyGhConfig(cfg: (GhConfig & { auto: boolean; auto2?: boolean }) | null, resetTabs = false) {
  sync.cfg = cfg;
  sync.gh = cfg && cfg.token && cfg.owner && cfg.repo ? new GitHubSync(cfg) : null;
  sync.auto = cfg?.auto2 ?? false; // 既定は手動(ボタンを押したときだけ同期)
  if (resetTabs) { for (const t of tabs) t.sync = { ...newSyncState(), dirty: t.sync.dirty, lastEdit: t.sync.lastEdit }; remoteScan = null; }
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
  if (!tab.doc) return;
  if (s.busy) { if (manual) setStatus('同期の処理中です。少し待ってからもう一度押してください'); return; }
  if (tab === cur && tools.busy) { if (manual) tools.cancel(); else return; }
  s.busy = true;
  if (tab === cur) { tools.commitTransform(); setStatus(`「${tab.name}」を送信中…`); setSyncButtons('sending'); }
  try {
    const editStamp = s.lastEdit; // 送信中に描いた分は「未送信」のまま残す
    const { manifest, files } = await serialize(tab.doc, 'files');
    const thumb = await makeThumb(compositeToCanvas(tab.doc));
    const repoFiles = [
      { path: PROJECT_FILE, content: JSON.stringify(manifest) },
      { path: THUMB_FILE, content: new Uint8Array(await thumb.arrayBuffer()) },
      ...(await Promise.all(files.map(async f => ({ path: f.path, content: new Uint8Array(await f.blob.arrayBuffer()) })))),
    ];
    // 旧形式の場所から開いた画像は、新しい場所へ送りつつ古いフォルダを消す
    const dest = new GitHubSync({ ...sync.cfg!, dir: tabDir(tab) });
    dest.knownPaths = s.knownPaths;
    s.lastSha = await dest.commitFiles(repoFiles, `update ${tabDir(tab)} from ${DEVICE} ${new Date().toISOString()}`, { expectedHead: force ? undefined : s.lastSha, force });
    s.knownPaths = dest.knownPaths;
    tab.remoteDir = undefined;
    if (s.lastEdit === editStamp) s.dirty = false;
    s.synced = true;
    s.conflict = false;
    s.remoteChanged = false;
    s.lastInfo = { device: DEVICE, date: new Date().toISOString() };
    if (remoteScan && !remoteScan.canvases.some(c => c.dir === tabDir(tab))) remoteScan.canvases.push({ notebook: tab.notebook, section: tab.section, name: tab.name, dir: tabDir(tab), thumbSha: null, legacy: false });
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
    if (tab === cur || manual) setStatus(pj ? `「${tab.name}」を受け取りました` : `GitHub に「${tab.name}」という名前の絵はまだありません`, pj ? 'ok' : 'err');
  } catch (e) {
    console.error('pull failed', e);
    if (tab === cur || manual) setStatus(`受信に失敗しました: ` + (e as Error).message, 'err');
  } finally {
    s.busy = false;
    if (tab === cur) { setSyncButtons('idle'); if (!$('sync-banner').classList.contains('err') && $('sync-banner').hidden) updateSyncStatus(); }
    renderTabs();
  }
}
/**
 * 自動同期(開いているタブが対象)。タブごとに:
 *  - 未送信の変更があり相手が進んでいなければ送る。相手も進んでいれば「両方に変更あり」にして止める
 *  - 変更がなく相手が進んでいれば受け取る
 *  - まだつながっていないタブは、GitHub に同名の絵がなければ送り、あれば「両方に変更あり」にする
 */
async function autoSyncTick() {
  if (!sync.gh || !navigator.onLine) return;
  if (!sync.auto) { await checkRemoteTick(); return; }
  for (const tab of openTabs()) {
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
/**
 * 手動モード: 絵は動かさず、相手の更新があるかだけを 30 秒ごとに確認して印を出す。
 * 例外として、まだ何も描いていない新しいタブは、GitHub に同名の絵があれば受け取る(何も失われないため)。
 */
async function checkRemoteTick() {
  for (const tab of openTabs()) {
    const s = tab.sync;
    if (s.busy || Date.now() - s.checkedAt < 30_000) continue;
    s.checkedAt = Date.now();
    try {
      const gh = ghFor(tab)!;
      if (!s.synced) {
        if (!s.dirty && await gh.remoteHasProject()) await pull(tab);
        continue;
      }
      const head = await gh.getHead();
      const changed = head !== s.lastSha;
      if (changed && !s.remoteChanged) await refreshLastInfo(tab);
      s.remoteChanged = changed;
    } catch { /* 次回に再試行 */ }
  }
  updateSyncStatus();
  renderTabs();
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
  $<HTMLInputElement>('gh-auto').checked = cfg?.auto2 ?? false;
  updateSyncStatus();
  dlgGh.showModal();
});
function readGhForm(): GhConfig & { auto: boolean; auto2: boolean } {
  const auto = $<HTMLInputElement>('gh-auto').checked;
  return {
    token: $<HTMLInputElement>('gh-token').value.trim(),
    owner: $<HTMLInputElement>('gh-owner').value.trim(),
    repo: $<HTMLInputElement>('gh-repo').value.trim(),
    branch: $<HTMLInputElement>('gh-branch').value.trim() || 'main',
    dir: '',
    auto,
    auto2: auto,
  };
}
/** 設定フォームを保存する。接続先が変わったときだけ同期状態をリセットする */
function saveGhForm() {
  const cfg = readGhForm();
  const prev = sync.cfg;
  const changed = !prev || prev.token !== cfg.token || prev.owner !== cfg.owner || prev.repo !== cfg.repo || prev.branch !== cfg.branch;
  localStorage.setItem(GH_KEY, JSON.stringify(cfg));
  if (changed) { applyGhConfig(cfg, true); bootSync(); }
  else { sync.cfg = cfg; sync.auto = cfg.auto2; }
  updateSyncStatus();
}
$('gh-save').addEventListener('click', () => { saveGhForm(); dlgGh.close(); });
$('gh-close').addEventListener('click', () => dlgGh.close());

/**
 * 起動時・接続先変更時。
 * 自動同期オン: 未送信の変更がないタブは GitHub の絵を受け取る。
 * 手動: 相手の更新があるかを確認して印を出すだけ(空の新しいタブだけは受け取る)。
 */
async function bootSync() {
  if (!sync.gh) return;
  scanRemote(true);
  if (!sync.auto) { for (const t of tabs) t.sync.checkedAt = 0; await checkRemoteTick(); return; }
  for (const t of openTabs()) {
    if (t.sync.dirty) continue; // 未送信の変更は消さない(自動同期が「両方に変更あり」を判定する)
    try {
      if (await ghFor(t)!.remoteHasProject()) await pull(t);
    } catch { /* 次回の自動同期で再試行 */ }
  }
  updateSyncStatus();
  renderTabs();
}

// ---------------- 新しい版の確認 ----------------
/** 公開先の version.json と自分のビルド識別子を比べ、違えば更新を促す(iPad のホーム画面アプリは古い版を持ち続けるため) */
async function checkForUpdate() {
  try {
    const r = await fetch(`./version.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { build } = await r.json();
    if (build && build !== __BUILD_ID__) $('update-banner').hidden = false;
  } catch { /* オフラインなどは無視 */ }
}
$('btn-update').addEventListener('click', () => {
  flushAutosave();
  // キャッシュされた古い index.html を避けるため、URL を変えて読み直す
  location.href = location.pathname + '?u=' + Date.now();
});
setInterval(checkForUpdate, 10 * 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
// PC でも「アプリとしてインストール」できるようにサービスワーカーを登録する(公開版のみ)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(e => console.warn('service worker', e));
}

// ---------------- 起動 ----------------
async function boot() {
  new ResizeObserver(resizeView).observe(viewport);
  resizeView();
  renderToolbar();
  setTool('pen');
  renderPalette();
  const restored = await restoreTabs();
  if (!restored) activateEmpty(); // 画像が 1 枚もない状態も許可する(自動では作らない)
  applyGhConfig(loadGhConfig());
  afterEdit();
  focusKeys();
  setTimeout(checkForUpdate, 3000);
  await bootSync();
}
boot();

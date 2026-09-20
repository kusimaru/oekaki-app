import type { BitmapLayer, Doc, InputInfo, Layer, Pt, Rgba, Selection, Shape, ToolId, ToolOptions, VectorLayer } from './types';
import { css } from './color';
import { activeLayer, ctx2d, makeCanvas, renderShape, uid } from './document';
import { History, snap, restore, type Snap } from './history';
import { floodFill, normalizeRect, selectionBounds, selectionMask, selectionPath } from './raster';
import {
  anchor, ellipseAnchors, hitShape, pointInPolygon, pointInRect, rectAnchors,
  shapeBounds, simplify, smoothAnchors, transformShape, unionRect, type Rect,
} from './vector';

export interface AppCtx {
  readonly doc: Doc;
  readonly color: Rgba;
  readonly options: ToolOptions;
  readonly history: History;
  readonly zoom: number;
  render(): void;
  dirty(): void;
  pickColor(c: Rgba): void;
  compositeData(): ImageData;
  /** 操作できない理由などをユーザーに知らせる */
  notify(msg: string): void;
}

/** レイヤーの中身を変えるツール(ロック中は使えない) */
const EDIT_TOOLS = new Set<ToolId>(['move', 'rotate', 'pen', 'eraser', 'bucket', 'line', 'rect', 'ellipse']);

/** ビットマップレイヤーの描かれている範囲(透明でないピクセルの外接矩形)。何もなければ null */
function contentBounds(layer: BitmapLayer): Rect | null {
  const w = layer.canvas.width, h = layer.canvas.height;
  const d = ctx2d(layer.canvas).getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * 変形パラメータ。元の位置 (cx, cy) を基準に、拡大縮小 → 回転 → 平行移動 の順に適用する。
 * 行列にすると translate(cx+tx, cy+ty) · rotate(angle) · scale(sx, sy) · translate(-cx, -cy)
 */
export interface XParams { cx: number; cy: number; tx: number; ty: number; angle: number; sx: number; sy: number; }
const xfPoint = (x: XParams, p: Pt): Pt => {
  const dx = (p.x - x.cx) * x.sx, dy = (p.y - x.cy) * x.sy;
  const cos = Math.cos(x.angle), sin = Math.sin(x.angle);
  return { x: dx * cos - dy * sin + x.cx + x.tx, y: dx * sin + dy * cos + x.cy + x.ty };
};
const xfInverse = (x: XParams, p: Pt): Pt => {
  const wx = p.x - x.cx - x.tx, wy = p.y - x.cy - x.ty;
  const cos = Math.cos(x.angle), sin = Math.sin(x.angle);
  const lx = wx * cos + wy * sin, ly = -wx * sin + wy * cos;
  return { x: lx / (x.sx || 1e-6) + x.cx, y: ly / (x.sy || 1e-6) + x.cy };
};
const xfApply = (ctx: CanvasRenderingContext2D, x: XParams) => {
  ctx.translate(x.cx + x.tx, x.cy + x.ty);
  ctx.rotate(x.angle);
  ctx.scale(x.sx, x.sy);
  ctx.translate(-x.cx, -x.cy);
};

/** ビットマップの浮動選択(移動・回転・変形中のピクセル) */
export interface Floating extends XParams {
  canvas: HTMLCanvasElement;
  /** 変形前の範囲(ドキュメント座標)。バウンディングボックスの元 */
  bounds: Rect;
  before: Snap;
  layerId: string;
  /** 選択なしでレイヤー全体を対象にした場合 true(確定後に選択を消す) */
  implicit: boolean;
}
/** ベジェの変形セッション(選択図形を元の形から変形し続ける) */
interface VectorXf extends XParams {
  layerId: string;
  base: Map<string, Shape>;
  bounds: Rect;
  before: Snap;
}

export interface ToolState { selection: Selection | null; selectedShapes: Set<string>; }

export type Clip =
  | { kind: 'bitmap'; canvas: HTMLCanvasElement; x: number; y: number }
  | { kind: 'vector'; shapes: Shape[]; layerId: string };

type XformMode = 'move' | 'rotate';
type ShapeKind = 'line' | 'rect' | 'ellipse';
const isXform = (t: ToolId) => t === 'move' || t === 'rotate';
/** バウンディングボックスのハンドル。hx, hy は -1 / 0 / 1(0,0 は使わない) */
interface Handle { hx: number; hy: number; }
const HANDLES: Handle[] = [
  { hx: -1, hy: -1 }, { hx: 0, hy: -1 }, { hx: 1, hy: -1 },
  { hx: -1, hy: 0 }, { hx: 1, hy: 0 },
  { hx: -1, hy: 1 }, { hx: 0, hy: 1 }, { hx: 1, hy: 1 },
];
const handleLocal = (b: Rect, h: Handle): Pt => ({ x: b.x + ((h.hx + 1) / 2) * b.w, y: b.y + ((h.hy + 1) / 2) * b.h });

type Op =
  | { t: 'marquee'; start: Pt; cur: Pt; shift: boolean; /** 自由変形の範囲指定として使う */ forTransform?: boolean }
  | { t: 'lasso'; pts: Pt[]; shift: boolean }
  | { t: 'stroke'; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; last: Pt; lastW: number; carry: number; before: Snap }
  | { t: 'erase'; last: Pt; lastW: number; carry: number; before: Snap }
  | { t: 'vpen'; pts: Pt[] }
  | { t: 'verase'; before: Snap; changed: boolean }
  | { t: 'shape'; kind: ShapeKind; start: Pt; cur: Pt; shift: boolean }
  | { t: 'xform'; mode: XformMode; start: Pt; base: XParams }
  | { t: 'vxform'; mode: XformMode; start: Pt; base: Map<string, Shape>; center: Pt; before: Snap; moved: boolean }
  | { t: 'box'; mode: 'move' | 'rotate' | 'scale'; handle: Handle; anchor: Pt; start: Pt; base: XParams };

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

export class Tools {
  tool: ToolId = 'pen';
  selection: Selection | null = null;
  selectedShapes = new Set<string>();
  floating: Floating | null = null;
  private vxf: VectorXf | null = null;
  private op: Op | null = null;

  constructor(private app: AppCtx) {}

  get doc() { return this.app.doc; }
  get active(): Layer { return activeLayer(this.doc); }
  get busy() { return this.op !== null; }
  /** 自由変形の枠が出ているか */
  get transforming() { return this.floating !== null || this.vxf !== null; }

  setTool(t: ToolId) {
    if (this.op) this.cancel();
    if (!isXform(t)) this.commitTransform();
    this.tool = t;
    if (t === 'move') this.beginTransform();
    this.app.render();
  }

  /** ドキュメント差し替え時 */
  reset() {
    this.op = null;
    this.selection = null;
    this.selectedShapes.clear();
    this.floating = null;
    this.vxf = null;
  }

  /** タブ切り替え用: 選択状態を取り出す(浮動選択は先に確定しておくこと) */
  getState(): ToolState {
    return { selection: this.selection, selectedShapes: new Set(this.selectedShapes) };
  }
  setState(s: ToolState | null) {
    this.op = null;
    this.floating = null;
    this.vxf = null;
    this.selection = s?.selection ?? null;
    this.selectedShapes = s ? new Set(s.selectedShapes) : new Set();
  }

  deselect() {
    this.commitTransform();
    this.selection = null;
    this.selectedShapes.clear();
    this.app.render();
  }

  /** Esc: 操作中なら中止、変形中なら元に戻す、それ以外は選択解除 */
  escape() {
    if (this.op) { this.cancel(); return; }
    if (this.transforming) { this.cancelTransform(); return; }
    this.deselect();
  }

  /** 進行中の操作を破棄 */
  cancel() {
    const op = this.op;
    this.op = null;
    if (!op) return;
    const layer = this.active;
    if (op.t === 'erase' || op.t === 'verase' || op.t === 'vxform') restore(layer, op.before);
    if (op.t === 'xform' && this.floating) Object.assign(this.floating, op.base);
    if (op.t === 'box') { this.setParams(op.base); }
    this.app.render();
  }

  /** ロック中のレイヤーなら知らせて true */
  private lockedNotice(layer: Layer): boolean {
    if (!layer.locked) return false;
    this.app.notify(`レイヤー「${layer.name}」はロックされています(レイヤーパネルの 🔒 で解除)`);
    return true;
  }

  /** アプリ内クリップボード */
  clipboard: Clip | null = null;

  /** 選択範囲(なければレイヤー全体)をクリップボードへ。コピーできたら true */
  copy(): boolean {
    this.commitTransform();
    const layer = this.active;
    const { width: w, height: h } = this.doc;
    if (layer.kind === 'vector') {
      const shapes = layer.shapes.filter(s => this.selectedShapes.has(s.id));
      if (!shapes.length) return false;
      this.clipboard = { kind: 'vector', shapes: structuredClone(shapes), layerId: layer.id };
      return true;
    }
    const sel: Selection = this.selection ?? { kind: 'rect', points: [{ x: 0, y: 0 }, { x: w, y: h }] };
    const b = selectionBounds(sel);
    const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(w, Math.ceil(b.x + b.w)), y1 = Math.min(h, Math.ceil(b.y + b.h));
    if (x1 - x0 < 1 || y1 - y0 < 1) return false;
    const c = makeCanvas(x1 - x0, y1 - y0);
    const cx = ctx2d(c);
    cx.translate(-x0, -y0);
    cx.clip(selectionPath(sel));
    cx.drawImage(layer.canvas, 0, 0);
    this.clipboard = { kind: 'bitmap', canvas: c, x: x0, y: y0 };
    return true;
  }

  /** コピーして選択範囲を消す。選択がなければレイヤー全体 */
  cut(): boolean {
    if (this.lockedNotice(this.active)) return false;
    if (!this.copy()) return false;
    const layer = this.active;
    if (layer.kind === 'bitmap' && !this.selection) {
      this.selection = { kind: 'rect', points: [{ x: 0, y: 0 }, { x: this.doc.width, y: this.doc.height }] };
      this.deleteSelection();
      this.selection = null;
      this.app.render();
    } else {
      this.deleteSelection();
    }
    return true;
  }

  deleteSelection() {
    const layer = this.active;
    const { width: w, height: h } = this.doc;
    if (this.lockedNotice(layer)) return;
    if (layer.kind === 'vector') {
      if (this.vxf) this.cancelTransform();
      if (!this.selectedShapes.size) return;
      const before = snap(layer);
      layer.shapes = layer.shapes.filter(s => !this.selectedShapes.has(s.id));
      this.selectedShapes.clear();
      this.app.history.push(layer.id, before, snap(layer));
    } else if (this.floating) {
      const f = this.floating;
      this.floating = null;
      this.app.history.push(layer.id, f.before, snap(layer));
      if (f.implicit) this.selection = null;
    } else if (this.selection) {
      const before = snap(layer);
      const c = ctx2d(layer.canvas);
      c.save();
      c.clip(selectionPath(this.selection));
      c.clearRect(0, 0, w, h);
      c.restore();
      this.app.history.push(layer.id, before, snap(layer));
    } else return;
    this.app.dirty();
    this.app.render();
  }

  // ---------- 変形(浮動選択 / ベジェの変形セッション) ----------

  /**
   * 浮動選択を作る。選択範囲があればそれを、なければ fallback(描かれている範囲など)を、
   * それもなければレイヤー全体を対象にする。選択範囲がなかった場合は確定後に選択を消す(implicit)
   */
  private ensureFloating(fallback?: Selection) {
    if (this.floating) return;
    const layer = this.active;
    if (layer.kind !== 'bitmap') return;
    const { width: w, height: h } = this.doc;
    const implicit = !this.selection;
    const sel: Selection = this.selection ?? fallback ?? { kind: 'rect', points: [{ x: 0, y: 0 }, { x: w, y: h }] };
    const path = selectionPath(sel);
    const b = selectionBounds(sel);
    const before = snap(layer);
    const fc = makeCanvas(w, h);
    const fx = ctx2d(fc);
    fx.save(); fx.clip(path); fx.drawImage(layer.canvas, 0, 0); fx.restore();
    const lc = ctx2d(layer.canvas);
    lc.save(); lc.clip(path); lc.clearRect(0, 0, w, h); lc.restore();
    this.selection = sel;
    this.floating = { canvas: fc, bounds: b, cx: b.x + b.w / 2, cy: b.y + b.h / 2, tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, before, layerId: layer.id, implicit };
  }

  /** ベジェ: 選択図形の変形セッションを始める */
  private ensureVectorXf(): boolean {
    if (this.vxf) return true;
    const layer = this.active;
    if (layer.kind !== 'vector' || !this.selectedShapes.size) return false;
    const base = new Map<string, Shape>();
    const rects: Rect[] = [];
    for (const s of layer.shapes) if (this.selectedShapes.has(s.id)) { base.set(s.id, structuredClone(s)); rects.push(shapeBounds(s)); }
    const b = unionRect(rects);
    this.vxf = { layerId: layer.id, base, bounds: b, cx: b.x + b.w / 2, cy: b.y + b.h / 2, tx: 0, ty: 0, angle: 0, sx: 1, sy: 1, before: snap(layer) };
    return true;
  }

  /**
   * 移動ツール選択時(Photoshop の「バウンディングボックスを表示」と同じ):
   * 選択範囲があればその範囲、なければ描かれている範囲に枠を出す。何も描かれていなければ、ドラッグで囲んだ範囲(downTransform)
   */
  private beginTransform() {
    const layer = this.active;
    if (this.lockedNotice(layer)) return;
    if (layer.kind === 'bitmap') {
      if (this.selection) { this.ensureFloating(); return; }
      const b = contentBounds(layer);
      if (b) this.ensureFloating({ kind: 'rect', points: [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }] });
      else this.app.notify('このレイヤーには何も描かれていません。変形する範囲をドラッグで囲んでください');
    } else if (!this.ensureVectorXf()) {
      this.app.notify('変形する図形をクリックするか、ドラッグで囲んでください');
    }
  }

  /** 現在の枠(変形パラメータと元の範囲) */
  private box(): (XParams & { bounds: Rect }) | null {
    return this.floating ?? this.vxf;
  }
  private setParams(p: XParams) {
    const b = this.box();
    if (!b) return;
    b.tx = p.tx; b.ty = p.ty; b.angle = p.angle; b.sx = p.sx; b.sy = p.sy;
    if (this.vxf) this.applyVectorXf();
  }
  private applyVectorXf() {
    const v = this.vxf;
    const layer = this.active;
    if (!v || layer.kind !== 'vector') return;
    layer.shapes = layer.shapes.map(s => (v.base.has(s.id) ? transformShape(v.base.get(s.id)!, pt => xfPoint(v, pt)) : s));
  }

  /**
   * 保存用のドキュメント。変形途中(浮動選択あり)なら、浮動部分を描き込んだコピーを返す。
   * 途中で再読み込みされても、切り抜かれた穴だけが保存されないようにするため。
   */
  docForSave(): Doc {
    const f = this.floating;
    if (!f) return this.doc;
    const layers = this.doc.layers.map(l => {
      if (l.id !== f.layerId || l.kind !== 'bitmap') return l;
      const c = makeCanvas(l.canvas.width, l.canvas.height);
      const cx = ctx2d(c);
      cx.drawImage(l.canvas, 0, 0);
      cx.save(); xfApply(cx, f); cx.drawImage(f.canvas, 0, 0); cx.restore();
      return { ...l, canvas: c };
    });
    return { ...this.doc, layers };
  }

  /** 変形を確定する(ビットマップの浮動選択とベジェの両方) */
  commitTransform() {
    this.commitFloating();
    const v = this.vxf;
    if (v) {
      this.vxf = null;
      const layer = this.doc.layers.find(l => l.id === v.layerId);
      if (layer) {
        const changed = v.tx || v.ty || v.angle || v.sx !== 1 || v.sy !== 1;
        if (changed) { this.app.history.push(layer.id, v.before, snap(layer)); this.app.dirty(); }
      }
      this.app.render();
    }
  }
  /** 変形をやめて元に戻す */
  cancelTransform() {
    const f = this.floating;
    if (f) {
      this.floating = null;
      const layer = this.doc.layers.find(l => l.id === f.layerId);
      if (layer) restore(layer, f.before);
      if (f.implicit) this.selection = null;
    }
    const v = this.vxf;
    if (v) {
      this.vxf = null;
      const layer = this.doc.layers.find(l => l.id === v.layerId);
      if (layer) restore(layer, v.before);
    }
    this.app.render();
  }

  commitFloating() {
    const f = this.floating;
    if (!f) return;
    this.floating = null;
    const layer = this.doc.layers.find(l => l.id === f.layerId);
    if (layer?.kind === 'bitmap') {
      const c = ctx2d(layer.canvas);
      c.save();
      xfApply(c, f);
      c.drawImage(f.canvas, 0, 0);
      c.restore();
      this.app.history.push(layer.id, f.before, snap(layer));
    }
    if (f.implicit) this.selection = null;
    else if (this.selection) {
      const sel = this.selection;
      let pts: Pt[];
      if (sel.kind === 'rect') {
        const b = selectionBounds(sel);
        pts = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
      } else pts = sel.points;
      this.selection = { kind: 'lasso', points: pts.map(p => xfPoint(f, p)) };
    }
    this.app.dirty();
    this.app.render();
  }

  /** 枠のどこを押したか判定する */
  private hitBox(p: Pt): { mode: 'move' | 'rotate' | 'scale'; handle: Handle } | null {
    const b = this.box();
    if (!b) return null;
    const tol = 12 / this.app.zoom;
    let best: Handle | null = null, bestD = tol;
    for (const h of HANDLES) {
      const d = dist(xfPoint(b, handleLocal(b.bounds, h)), p);
      if (d < bestD) { bestD = d; best = h; }
    }
    if (best) return { mode: 'scale', handle: best };
    const lp = xfInverse(b, p);
    const inside = lp.x >= b.bounds.x && lp.x <= b.bounds.x + b.bounds.w && lp.y >= b.bounds.y && lp.y <= b.bounds.y + b.bounds.h;
    return { mode: inside ? 'move' : 'rotate', handle: { hx: 0, hy: 0 } };
  }

  /** 移動ツールでポインタが乗っている場所に応じたカーソル */
  hoverCursor(p: Pt): string {
    if (this.tool !== 'move' || !this.box()) return 'move';
    const h = this.hitBox(p);
    if (!h) return 'default';
    if (h.mode === 'move') return 'move';
    if (h.mode === 'rotate') return 'grab';
    const { hx, hy } = h.handle;
    if (hx === 0) return 'ns-resize';
    if (hy === 0) return 'ew-resize';
    return hx * hy > 0 ? 'nwse-resize' : 'nesw-resize';
  }

  // ---------- 入力 ----------

  down(p: Pt, info: InputInfo) {
    const layer = this.active;
    if (this.tool === 'eyedropper') {
      const c = this.sample(p);
      if (c) this.app.pickColor(c);
      return;
    }
    if (EDIT_TOOLS.has(this.tool) && this.lockedNotice(layer)) return;
    if (this.tool === 'move') { this.downTransform(layer, p, info); this.app.render(); return; }
    if (this.transforming && !isXform(this.tool)) this.commitTransform();
    if (layer.kind === 'bitmap') this.downBitmap(layer, p, info);
    else this.downVector(layer, p, info);
    this.app.render();
  }

  private downTransform(layer: Layer, p: Pt, info: InputInfo) {
    if (!this.box()) {
      if (layer.kind === 'bitmap') {
        if (this.selection) this.ensureFloating();
        else { this.op = { t: 'marquee', start: p, cur: p, shift: false, forTransform: true }; return; } // 範囲をドラッグで指定
      } else {
        // 未選択なら押した図形を選んで枠を出す。図形がなければドラッグで囲む
        const hit = this.hitAt(layer, p);
        if (hit) {
          if (!info.shift) this.selectedShapes.clear();
          this.selectedShapes.add(hit.id);
          this.ensureVectorXf();
        } else {
          this.op = { t: 'marquee', start: p, cur: p, shift: info.shift, forTransform: true };
          return;
        }
      }
      if (!this.box()) return;
    }
    const b = this.box()!;
    const hit = this.hitBox(p)!;
    const base: XParams = { cx: b.cx, cy: b.cy, tx: b.tx, ty: b.ty, angle: b.angle, sx: b.sx, sy: b.sy };
    let anchorPt: Pt = { x: b.cx, y: b.cy };
    if (hit.mode === 'scale') {
      anchorPt = info.alt ? { x: b.cx, y: b.cy } : handleLocal(b.bounds, { hx: -hit.handle.hx, hy: -hit.handle.hy });
    }
    this.op = { t: 'box', mode: hit.mode, handle: hit.handle, anchor: anchorPt, start: p, base };
  }

  private downBitmap(layer: BitmapLayer, p: Pt, info: InputInfo) {
    const { width: w, height: h } = this.doc;
    switch (this.tool) {
      case 'select': this.op = { t: 'marquee', start: p, cur: p, shift: info.shift }; break;
      case 'lasso': this.op = { t: 'lasso', pts: [p], shift: info.shift }; break;
      case 'rotate': {
        this.ensureFloating();
        const f = this.floating!;
        this.op = { t: 'xform', mode: this.tool, start: p, base: { cx: f.cx, cy: f.cy, tx: f.tx, ty: f.ty, angle: f.angle, sx: f.sx, sy: f.sy } };
        break;
      }
      case 'pen': {
        const canvas = makeCanvas(w, h);
        const ctx = ctx2d(canvas);
        this.smoothP = -1;
        const wd = this.strokeWidth(info);
        ctx.fillStyle = this.opaqueColor();
        const carry = this.stamp(ctx, p, p, wd, wd, 0);
        this.op = { t: 'stroke', canvas, ctx, last: p, lastW: wd, carry, before: snap(layer) };
        break;
      }
      case 'eraser': {
        this.smoothP = -1;
        const wd = this.strokeWidth(info);
        const carry = this.eraseStamp(layer, p, p, wd, wd, 0);
        this.op = { t: 'erase', last: p, lastW: wd, carry, before: snap(layer) };
        break;
      }
      case 'bucket': this.bucketBitmap(layer, p); break;
      case 'line': case 'rect': case 'ellipse':
        this.op = { t: 'shape', kind: this.tool, start: p, cur: p, shift: info.shift };
        break;
    }
  }

  private downVector(layer: VectorLayer, p: Pt, info: InputInfo) {
    switch (this.tool) {
      case 'select': {
        const hit = this.hitAt(layer, p);
        if (hit) {
          if (info.shift) {
            if (this.selectedShapes.has(hit.id)) this.selectedShapes.delete(hit.id);
            else this.selectedShapes.add(hit.id);
          } else if (!this.selectedShapes.has(hit.id)) {
            this.selectedShapes.clear();
            this.selectedShapes.add(hit.id);
          }
          if (this.selectedShapes.size) this.startVxform(layer, 'move', p);
        } else {
          this.op = { t: 'marquee', start: p, cur: p, shift: info.shift };
        }
        break;
      }
      case 'lasso': this.op = { t: 'lasso', pts: [p], shift: info.shift }; break;
      case 'rotate': {
        if (!this.selectedShapes.size) {
          const hit = this.hitAt(layer, p);
          if (!hit) break;
          this.selectedShapes.add(hit.id);
        }
        this.startVxform(layer, this.tool, p);
        break;
      }
      case 'pen': this.op = { t: 'vpen', pts: [p] }; break;
      case 'eraser': {
        this.op = { t: 'verase', before: snap(layer), changed: false };
        this.eraseShapesAt(layer, p);
        break;
      }
      case 'bucket': {
        const hit = this.hitAt(layer, p);
        if (!hit) break;
        const before = snap(layer);
        hit.fill = { ...this.app.color };
        this.app.history.push(layer.id, before, snap(layer));
        this.app.dirty();
        break;
      }
      case 'line': case 'rect': case 'ellipse':
        this.op = { t: 'shape', kind: this.tool, start: p, cur: p, shift: info.shift };
        break;
    }
  }

  private startVxform(layer: VectorLayer, mode: XformMode, p: Pt) {
    const base = new Map<string, Shape>();
    const rects = [];
    for (const s of layer.shapes) {
      if (!this.selectedShapes.has(s.id)) continue;
      base.set(s.id, structuredClone(s));
      rects.push(shapeBounds(s));
    }
    const u = unionRect(rects);
    this.op = { t: 'vxform', mode, start: p, base, center: { x: u.x + u.w / 2, y: u.y + u.h / 2 }, before: snap(layer), moved: false };
  }

  move(p: Pt, info: InputInfo) {
    const op = this.op;
    if (!op) return;
    const layer = this.active;
    switch (op.t) {
      case 'marquee': op.cur = p; break;
      case 'lasso': op.pts.push(p); break;
      case 'stroke': {
        const wd = this.strokeWidth(info);
        op.ctx.fillStyle = this.opaqueColor();
        op.carry = this.stamp(op.ctx, op.last, p, op.lastW, wd, op.carry);
        op.last = p;
        op.lastW = wd;
        break;
      }
      case 'erase': {
        const wd = this.strokeWidth(info);
        if (layer.kind === 'bitmap') op.carry = this.eraseStamp(layer, op.last, p, op.lastW, wd, op.carry);
        op.last = p;
        op.lastW = wd;
        break;
      }
      case 'vpen': op.pts.push(p); break;
      case 'verase': if (layer.kind === 'vector') this.eraseShapesAt(layer, p); break;
      case 'shape': op.cur = p; op.shift = info.shift; break;
      case 'xform': {
        const f = this.floating;
        if (!f) break;
        const c = { x: f.cx + op.base.tx, y: f.cy + op.base.ty };
        if (op.mode === 'move') {
          f.tx = op.base.tx + (p.x - op.start.x);
          f.ty = op.base.ty + (p.y - op.start.y);
        } else {
          f.angle = op.base.angle + Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(op.start.y - c.y, op.start.x - c.x);
        }
        break;
      }
      case 'vxform': {
        if (layer.kind !== 'vector') break;
        const fn = this.xformFn(op.mode, op.start, p, op.center);
        layer.shapes = layer.shapes.map(s => (op.base.has(s.id) ? transformShape(op.base.get(s.id)!, fn) : s));
        op.moved = true;
        break;
      }
      case 'box': this.moveBox(op, p, info); break;
    }
    this.app.render();
  }

  /** バウンディングボックスのドラッグ(移動 / 回転 / 拡大縮小) */
  private moveBox(op: Extract<Op, { t: 'box' }>, p: Pt, info: InputInfo) {
    const b = this.box();
    if (!b) return;
    const base = op.base;
    const next: XParams = { ...base };
    if (op.mode === 'move') {
      next.tx = base.tx + (p.x - op.start.x);
      next.ty = base.ty + (p.y - op.start.y);
    } else if (op.mode === 'rotate') {
      const c = { x: base.cx + base.tx, y: base.cy + base.ty };
      let a = base.angle + Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(op.start.y - c.y, op.start.x - c.x);
      if (info.shift) { const step = Math.PI / 12; a = Math.round(a / step) * step; } // 15° 刻み
      next.angle = a;
    } else {
      // 拡大縮小: 元の座標系(回転・拡大前)で、アンカーからの距離の比で倍率を決める
      const hl = handleLocal(b.bounds, op.handle);
      const a = op.anchor;
      const lp = xfInverse(base, p);
      const { hx, hy } = op.handle;
      const corner = hx !== 0 && hy !== 0;
      const proportional = corner && !info.shift; // Photoshop と同じく角は既定で縦横比を保つ
      const clamp = (v: number) => (Math.abs(v) < 0.01 ? (v < 0 ? -0.01 : 0.01) : v);
      if (proportional) {
        const dx = hl.x - a.x, dy = hl.y - a.y;
        const t = ((lp.x - a.x) * dx + (lp.y - a.y) * dy) / (dx * dx + dy * dy || 1);
        next.sx = clamp(base.sx * t);
        next.sy = clamp(base.sy * t);
      } else {
        if (hx !== 0) next.sx = clamp(base.sx * (lp.x - a.x) / (hl.x - a.x || 1e-6));
        if (hy !== 0) next.sy = clamp(base.sy * (lp.y - a.y) / (hl.y - a.y || 1e-6));
      }
      // アンカー(反対側の角 / 辺 / 中心)が動かないように平行移動を補正する
      const before = xfPoint(base, a);
      const after = xfPoint({ ...next, tx: base.tx, ty: base.ty }, a);
      next.tx = base.tx + before.x - after.x;
      next.ty = base.ty + before.y - after.y;
    }
    this.setParams(next);
  }

  up(p: Pt, info: InputInfo) {
    const op = this.op;
    if (!op) return;
    this.op = null;
    const layer = this.active;
    switch (op.t) {
      case 'marquee': {
        const r = normalizeRect(op.start, p);
        const tiny = r.w < 2 && r.h < 2;
        if (layer.kind === 'bitmap') {
          this.selection = tiny ? null : { kind: 'rect', points: [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }] };
          if (op.forTransform && this.selection) this.ensureFloating();
        } else {
          if (!op.shift) this.selectedShapes.clear();
          if (!tiny) for (const s of layer.shapes) if (s.anchors.some(a => pointInRect(a, r))) this.selectedShapes.add(s.id);
          if (op.forTransform && this.selectedShapes.size) this.ensureVectorXf();
        }
        break;
      }
      case 'lasso': {
        if (layer.kind === 'bitmap') {
          this.selection = op.pts.length < 3 ? null : { kind: 'lasso', points: op.pts };
        } else {
          if (!op.shift) this.selectedShapes.clear();
          if (op.pts.length >= 3) for (const s of layer.shapes) if (s.anchors.some(a => pointInPolygon(a, op.pts))) this.selectedShapes.add(s.id);
        }
        break;
      }
      case 'stroke': {
        if (layer.kind !== 'bitmap') break;
        const c = ctx2d(layer.canvas);
        c.save();
        if (this.selection) c.clip(selectionPath(this.selection));
        c.globalAlpha = this.app.color.a;
        c.drawImage(op.canvas, 0, 0);
        c.restore();
        this.app.history.push(layer.id, op.before, snap(layer));
        this.app.dirty();
        break;
      }
      case 'erase':
        this.app.history.push(layer.id, op.before, snap(layer));
        this.app.dirty();
        break;
      case 'vpen': {
        if (layer.kind !== 'vector') break;
        const pts = simplify(op.pts, 1.2);
        if (pts.length === 1) pts.push({ x: pts[0].x + 0.01, y: pts[0].y });
        const before = snap(layer);
        layer.shapes.push({
          id: uid(), anchors: smoothAnchors(pts), closed: false,
          stroke: { ...this.app.color }, strokeWidth: this.app.options.size, fill: null,
        });
        this.app.history.push(layer.id, before, snap(layer));
        this.app.dirty();
        break;
      }
      case 'verase':
        if (op.changed) {
          this.app.history.push(layer.id, op.before, snap(layer));
          this.app.dirty();
        }
        break;
      case 'shape': {
        op.cur = p;
        const shape = this.buildShape(op);
        if (!shape) break;
        const before = snap(layer);
        if (layer.kind === 'bitmap') {
          const c = ctx2d(layer.canvas);
          c.save();
          if (this.selection) c.clip(selectionPath(this.selection));
          renderShape(c, shape);
          c.restore();
        } else {
          layer.shapes.push(shape);
        }
        this.app.history.push(layer.id, before, snap(layer));
        this.app.dirty();
        break;
      }
      case 'xform': break;   // 浮動選択は Enter / ツール変更で確定
      case 'box': break;     // 同上
      case 'vxform':
        if (op.moved) {
          this.app.history.push(layer.id, op.before, snap(layer));
          this.app.dirty();
        }
        break;
    }
    void info;
    this.app.render();
  }

  // ---------- 内部処理 ----------

  /** ストローク中の平滑化済み筆圧(-1 = 未開始) */
  private smoothP = -1;

  private strokeWidth(info: InputInfo): number {
    const s = this.app.options.size;
    if (!(this.app.options.pressure && info.pen)) return s;
    // Apple Pencil は触れた直後と抜く瞬間に筆圧 0 を送るので、0 はそのまま最小の太さとして扱う
    // (0 を中間値に置き換えると抜きの最後に太い点=ダマができる)
    const raw = Math.min(1, Math.max(0, info.pressure));
    if (this.smoothP < 0) this.smoothP = raw;
    else this.smoothP += (raw - this.smoothP) * (raw < this.smoothP ? 0.7 : 0.4); // 抜き(減少)は速く追従
    return Math.max(0.5, s * Math.min(1.5, 0.05 + this.smoothP * 1.45));
  }

  private opaqueColor(): string {
    return css({ ...this.app.color, a: 1 });
  }

  /**
   * a→b に沿って円を等間隔にスタンプする(太さは wa→wb に補間)。
   * 線分をつなぐ方式と違い、太さが変わっても端が飛び出さず、抜きが滑らかになる。
   * 戻り値は次の区間に持ち越す距離。
   */
  private stamp(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, wa: number, wb: number, carry: number): number {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      if (carry === 0) {
        ctx.beginPath();
        ctx.arc(a.x, a.y, wa / 2, 0, Math.PI * 2);
        ctx.fill();
        return Math.max(0.75, wa * 0.18);
      }
      return carry;
    }
    let d = carry;
    while (d <= len) {
      const t = d / len;
      const w = wa + (wb - wa) * t;
      ctx.beginPath();
      ctx.arc(a.x + dx * t, a.y + dy * t, w / 2, 0, Math.PI * 2);
      ctx.fill();
      d += Math.max(0.75, w * 0.18);
    }
    return d - len;
  }

  private eraseStamp(layer: BitmapLayer, a: Pt, b: Pt, wa: number, wb: number, carry: number): number {
    const c = ctx2d(layer.canvas);
    c.save();
    if (this.selection) c.clip(selectionPath(this.selection));
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = '#000';
    const r = this.stamp(c, a, b, wa, wb, carry);
    c.restore();
    return r;
  }

  private bucketBitmap(layer: BitmapLayer, p: Pt) {
    const { width: w, height: h } = this.doc;
    const c = ctx2d(layer.canvas);
    // Photoshop と同じく既定では現在のレイヤーだけを参照する(上のレイヤーの線に塞がれない)
    const ref = this.app.options.sampleAll ? this.app.compositeData() : c.getImageData(0, 0, w, h);
    const target = c.getImageData(0, 0, w, h);
    const before: Snap = { kind: 'bitmap', data: new ImageData(new Uint8ClampedArray(target.data), w, h) };
    const mask = this.selection ? selectionMask(this.selection, w, h) : null;
    floodFill(target, ref, p.x, p.y, this.app.color, this.app.options.tolerance, mask);
    c.putImageData(target, 0, 0);
    this.app.history.push(layer.id, before, snap(layer));
    this.app.dirty();
  }

  private sample(p: Pt): Rgba | null {
    const d = this.app.compositeData();
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return null;
    const i = (y * d.width + x) * 4;
    if (d.data[i + 3] === 0) return null;
    return { r: d.data[i], g: d.data[i + 1], b: d.data[i + 2], a: Math.round((d.data[i + 3] / 255) * 100) / 100 };
  }

  private hitAt(layer: VectorLayer, p: Pt): Shape | null {
    const slop = 8 / this.app.zoom;
    for (let i = layer.shapes.length - 1; i >= 0; i--) if (hitShape(layer.shapes[i], p, slop)) return layer.shapes[i];
    return null;
  }

  private eraseShapesAt(layer: VectorLayer, p: Pt) {
    const op = this.op;
    const slop = Math.max(this.app.options.size, 8 / this.app.zoom);
    const n = layer.shapes.length;
    layer.shapes = layer.shapes.filter(s => !hitShape(s, p, slop));
    if (layer.shapes.length !== n) {
      if (op?.t === 'verase') op.changed = true;
      for (const id of [...this.selectedShapes]) if (!layer.shapes.some(s => s.id === id)) this.selectedShapes.delete(id);
    }
  }

  private xformFn(mode: XformMode, start: Pt, cur: Pt, c: Pt): (p: Pt) => Pt {
    if (mode === 'move') {
      const dx = cur.x - start.x, dy = cur.y - start.y;
      return p => ({ x: p.x + dx, y: p.y + dy });
    }
    const a = Math.atan2(cur.y - c.y, cur.x - c.x) - Math.atan2(start.y - c.y, start.x - c.x);
    const cos = Math.cos(a), sin = Math.sin(a);
    return p => ({ x: (p.x - c.x) * cos - (p.y - c.y) * sin + c.x, y: (p.x - c.x) * sin + (p.y - c.y) * cos + c.y });
  }

  private buildShape(op: Extract<Op, { t: 'shape' }>): Shape | null {
    const a = op.start;
    let b = op.cur;
    if (op.shift) {
      const dx = b.x - a.x, dy = b.y - a.y;
      if (op.kind === 'line') {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        b = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        b = { x: a.x + Math.sign(dx || 1) * m, y: a.y + Math.sign(dy || 1) * m };
      }
    }
    if (dist(a, b) < 1) return null;
    const color = { ...this.app.color };
    const size = this.app.options.size;
    if (op.kind === 'line') {
      return { id: uid(), anchors: [anchor(a.x, a.y), anchor(b.x, b.y)], closed: false, stroke: color, strokeWidth: size, fill: null };
    }
    const fill = this.app.options.fill;
    const anchors = op.kind === 'rect' ? rectAnchors(a, b) : ellipseAnchors(a, b);
    return { id: uid(), anchors, closed: true, stroke: fill ? null : color, strokeWidth: size, fill: fill ? color : null };
  }

  // ---------- 描画 ----------

  /** composite() の hook。アクティブレイヤーの直後に浮動選択・描画中ストロークを重ねる */
  layerHook = (layer: Layer, ctx: CanvasRenderingContext2D) => {
    if (layer.id !== this.doc.activeLayerId) return;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    if (this.floating) {
      ctx.save();
      xfApply(ctx, this.floating);
      ctx.drawImage(this.floating.canvas, 0, 0);
      ctx.restore();
    }
    const op = this.op;
    if (op?.t === 'stroke') {
      ctx.globalAlpha = layer.opacity * this.app.color.a;
      if (this.selection) ctx.clip(selectionPath(this.selection));
      ctx.drawImage(op.canvas, 0, 0);
    }
    ctx.restore();
  };

  /** ドキュメント座標系で選択枠やプレビューを描く */
  drawOverlay(ctx: CanvasRenderingContext2D, zoom: number) {
    const lw = 1 / zoom;
    const op = this.op;
    const layer = this.active;
    ctx.save();
    ctx.lineWidth = lw;

    if (op?.t === 'shape') {
      const s = this.buildShape(op);
      if (s) {
        ctx.save();
        if (layer.kind === 'bitmap' && this.selection) ctx.clip(selectionPath(this.selection));
        renderShape(ctx, s);
        ctx.restore();
      }
    }
    if (op?.t === 'vpen' && op.pts.length) {
      ctx.strokeStyle = css(this.app.color);
      ctx.lineWidth = this.app.options.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      op.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.lineWidth = lw;
    }
    if (op?.t === 'marquee') {
      const r = normalizeRect(op.start, op.cur);
      const p = new Path2D();
      p.rect(r.x, r.y, r.w, r.h);
      this.ants(ctx, p, lw);
    }
    if (op?.t === 'lasso' && op.pts.length > 1) {
      const p = new Path2D();
      op.pts.forEach((pt, i) => (i ? p.lineTo(pt.x, pt.y) : p.moveTo(pt.x, pt.y)));
      this.ants(ctx, p, lw);
    }
    if (this.selection) {
      const path = selectionPath(this.selection);
      if (this.floating) {
        ctx.save();
        xfApply(ctx, this.floating);
        this.ants(ctx, path, lw / Math.max(0.01, Math.min(Math.abs(this.floating.sx), Math.abs(this.floating.sy))));
        ctx.restore();
      } else this.ants(ctx, path, lw);
    }
    if (layer.kind === 'vector' && this.selectedShapes.size && !this.vxf) {
      ctx.strokeStyle = '#f5c542';
      ctx.setLineDash([4 * lw, 3 * lw]);
      for (const s of layer.shapes) {
        if (!this.selectedShapes.has(s.id)) continue;
        const b = shapeBounds(s);
        ctx.strokeRect(b.x - 2 * lw, b.y - 2 * lw, b.w + 4 * lw, b.h + 4 * lw);
      }
      ctx.setLineDash([]);
    }
    // 移動ツールのバウンディングボックス
    const box = this.tool === 'move' || this.vxf ? this.box() : null;
    if (box) {
      const b = box.bounds;
      const corners = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }].map(p => xfPoint(box, p));
      ctx.beginPath();
      corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
      ctx.closePath();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3 * lw; ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = lw; ctx.stroke();
      const hs = 8 / zoom;
      for (const h of HANDLES) {
        const w = xfPoint(box, handleLocal(b, h));
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = lw;
        ctx.fillRect(w.x - hs / 2, w.y - hs / 2, hs, hs);
        ctx.strokeRect(w.x - hs / 2, w.y - hs / 2, hs, hs);
      }
      const c = { x: box.cx + box.tx, y: box.cy + box.ty };
      ctx.beginPath();
      ctx.arc(c.x, c.y, 4 / zoom, 0, Math.PI * 2);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2 * lw; ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = lw; ctx.stroke();
    }
    ctx.restore();
  }

  private ants(ctx: CanvasRenderingContext2D, path: Path2D, lw: number) {
    ctx.save();
    ctx.lineWidth = lw;
    ctx.setLineDash([]);
    ctx.strokeStyle = '#fff';
    ctx.stroke(path);
    ctx.setLineDash([4 * lw, 4 * lw]);
    ctx.strokeStyle = '#000';
    ctx.stroke(path);
    ctx.restore();
  }
}

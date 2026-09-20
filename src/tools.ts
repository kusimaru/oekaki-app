import type { BitmapLayer, Doc, InputInfo, Layer, Pt, Rgba, Selection, Shape, ToolId, ToolOptions, VectorLayer } from './types';
import { css } from './color';
import { activeLayer, ctx2d, makeCanvas, renderShape, uid } from './document';
import { History, snap, restore, type Snap } from './history';
import { floodFill, normalizeRect, selectionBounds, selectionMask, selectionPath } from './raster';
import {
  anchor, ellipseAnchors, hitShape, pointInPolygon, pointInRect, rectAnchors,
  shapeBounds, simplify, smoothAnchors, transformShape, unionRect,
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
}

/** ビットマップの浮動選択(移動・回転・拡縮中のピクセル) */
export interface Floating {
  canvas: HTMLCanvasElement;
  tx: number; ty: number; angle: number; scale: number;
  cx: number; cy: number;
  before: Snap;
  layerId: string;
  /** 選択なしでレイヤー全体を対象にした場合 true(確定後に選択を消す) */
  implicit: boolean;
}

export type Clip =
  | { kind: 'bitmap'; canvas: HTMLCanvasElement; x: number; y: number }
  | { kind: 'vector'; shapes: Shape[]; layerId: string };

type XformMode = 'move' | 'rotate' | 'scale';
type ShapeKind = 'line' | 'rect' | 'ellipse';
const isXform = (t: ToolId): t is XformMode => t === 'move' || t === 'rotate' || t === 'scale';

type Op =
  | { t: 'marquee'; start: Pt; cur: Pt; shift: boolean }
  | { t: 'lasso'; pts: Pt[]; shift: boolean }
  | { t: 'stroke'; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; last: Pt; lastW: number; carry: number; before: Snap }
  | { t: 'erase'; last: Pt; lastW: number; carry: number; before: Snap }
  | { t: 'vpen'; pts: Pt[] }
  | { t: 'verase'; before: Snap; changed: boolean }
  | { t: 'shape'; kind: ShapeKind; start: Pt; cur: Pt; shift: boolean }
  | { t: 'xform'; mode: XformMode; start: Pt; base: { tx: number; ty: number; angle: number; scale: number } }
  | { t: 'vxform'; mode: XformMode; start: Pt; base: Map<string, Shape>; center: Pt; before: Snap; moved: boolean };

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

export class Tools {
  tool: ToolId = 'pen';
  selection: Selection | null = null;
  selectedShapes = new Set<string>();
  floating: Floating | null = null;
  private op: Op | null = null;

  constructor(private app: AppCtx) {}

  get doc() { return this.app.doc; }
  get active(): Layer { return activeLayer(this.doc); }
  get busy() { return this.op !== null; }

  setTool(t: ToolId) {
    if (this.op) this.cancel();
    if (this.floating && !isXform(t)) this.commitFloating();
    this.tool = t;
    this.app.render();
  }

  /** ドキュメント差し替え時 */
  reset() {
    this.op = null;
    this.selection = null;
    this.selectedShapes.clear();
    this.floating = null;
  }

  deselect() {
    this.commitFloating();
    this.selection = null;
    this.selectedShapes.clear();
    this.app.render();
  }

  /** 進行中の操作を破棄 */
  cancel() {
    const op = this.op;
    this.op = null;
    if (!op) return;
    const layer = this.active;
    if (op.t === 'erase' || op.t === 'verase' || op.t === 'vxform') restore(layer, op.before);
    if (op.t === 'xform' && this.floating) Object.assign(this.floating, op.base);
    this.app.render();
  }

  /** アプリ内クリップボード */
  clipboard: Clip | null = null;

  /** 選択範囲(なければレイヤー全体)をクリップボードへ。コピーできたら true */
  copy(): boolean {
    this.commitFloating();
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
    if (layer.kind === 'vector') {
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

  // ---------- 浮動選択(ビットマップの変形) ----------

  private ensureFloating() {
    if (this.floating) return;
    const layer = this.active;
    if (layer.kind !== 'bitmap') return;
    const { width: w, height: h } = this.doc;
    const implicit = !this.selection;
    const sel: Selection = this.selection ?? { kind: 'rect', points: [{ x: 0, y: 0 }, { x: w, y: h }] };
    const path = selectionPath(sel);
    const b = selectionBounds(sel);
    const before = snap(layer);
    const fc = makeCanvas(w, h);
    const fx = ctx2d(fc);
    fx.save(); fx.clip(path); fx.drawImage(layer.canvas, 0, 0); fx.restore();
    const lc = ctx2d(layer.canvas);
    lc.save(); lc.clip(path); lc.clearRect(0, 0, w, h); lc.restore();
    this.selection = sel;
    this.floating = { canvas: fc, tx: 0, ty: 0, angle: 0, scale: 1, cx: b.x + b.w / 2, cy: b.y + b.h / 2, before, layerId: layer.id, implicit };
  }

  private applyFloating(f: Floating, p: Pt): Pt {
    const dx = (p.x - f.cx) * f.scale, dy = (p.y - f.cy) * f.scale;
    const cos = Math.cos(f.angle), sin = Math.sin(f.angle);
    return { x: dx * cos - dy * sin + f.cx + f.tx, y: dx * sin + dy * cos + f.cy + f.ty };
  }

  private floatingTransform(ctx: CanvasRenderingContext2D, f: Floating) {
    ctx.translate(f.cx + f.tx, f.cy + f.ty);
    ctx.rotate(f.angle);
    ctx.scale(f.scale, f.scale);
    ctx.translate(-f.cx, -f.cy);
  }

  commitFloating() {
    const f = this.floating;
    if (!f) return;
    this.floating = null;
    const layer = this.doc.layers.find(l => l.id === f.layerId);
    if (layer?.kind === 'bitmap') {
      const c = ctx2d(layer.canvas);
      c.save();
      this.floatingTransform(c, f);
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
      this.selection = { kind: 'lasso', points: pts.map(p => this.applyFloating(f, p)) };
    }
    this.app.dirty();
    this.app.render();
  }

  // ---------- 入力 ----------

  down(p: Pt, info: InputInfo) {
    const layer = this.active;
    if (this.tool === 'eyedropper') {
      const c = this.sample(p);
      if (c) this.app.pickColor(c);
      return;
    }
    if (this.floating && !isXform(this.tool)) this.commitFloating();
    if (layer.kind === 'bitmap') this.downBitmap(layer, p, info);
    else this.downVector(layer, p, info);
    this.app.render();
  }

  private downBitmap(layer: BitmapLayer, p: Pt, info: InputInfo) {
    const { width: w, height: h } = this.doc;
    switch (this.tool) {
      case 'select': this.op = { t: 'marquee', start: p, cur: p, shift: info.shift }; break;
      case 'lasso': this.op = { t: 'lasso', pts: [p], shift: info.shift }; break;
      case 'move': case 'rotate': case 'scale': {
        this.ensureFloating();
        const f = this.floating!;
        this.op = { t: 'xform', mode: this.tool, start: p, base: { tx: f.tx, ty: f.ty, angle: f.angle, scale: f.scale } };
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
      case 'move': case 'rotate': case 'scale': {
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
        } else if (op.mode === 'rotate') {
          f.angle = op.base.angle + Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(op.start.y - c.y, op.start.x - c.x);
        } else {
          f.scale = Math.max(0.01, op.base.scale * dist(p, c) / Math.max(1, dist(op.start, c)));
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
    }
    this.app.render();
  }

  up(p: Pt, info: InputInfo) {
    const op = this.op;
    if (!op) return;
    this.op = null;
    const layer = this.active;
    const { width: w, height: h } = this.doc;
    switch (op.t) {
      case 'marquee': {
        const r = normalizeRect(op.start, p);
        const tiny = r.w < 2 && r.h < 2;
        if (layer.kind === 'bitmap') {
          this.selection = tiny ? null : { kind: 'rect', points: [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }] };
        } else {
          if (!op.shift) this.selectedShapes.clear();
          if (!tiny) for (const s of layer.shapes) if (s.anchors.some(a => pointInRect(a, r))) this.selectedShapes.add(s.id);
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
      case 'xform': break; // 浮動選択は Enter / ツール変更で確定
      case 'vxform':
        if (op.moved) {
          this.app.history.push(layer.id, op.before, snap(layer));
          this.app.dirty();
        }
        break;
    }
    void w; void h;
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
    if (mode === 'rotate') {
      const a = Math.atan2(cur.y - c.y, cur.x - c.x) - Math.atan2(start.y - c.y, start.x - c.x);
      const cos = Math.cos(a), sin = Math.sin(a);
      return p => ({ x: (p.x - c.x) * cos - (p.y - c.y) * sin + c.x, y: (p.x - c.x) * sin + (p.y - c.y) * cos + c.y });
    }
    const s = Math.max(0.01, dist(cur, c) / Math.max(1, dist(start, c)));
    return p => ({ x: c.x + (p.x - c.x) * s, y: c.y + (p.y - c.y) * s });
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
      this.floatingTransform(ctx, this.floating);
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
        this.floatingTransform(ctx, this.floating);
        this.ants(ctx, path, lw / this.floating.scale);
        ctx.restore();
      } else this.ants(ctx, path, lw);
    }
    if (layer.kind === 'vector' && this.selectedShapes.size) {
      ctx.strokeStyle = '#f5c542';
      ctx.setLineDash([4 * lw, 3 * lw]);
      for (const s of layer.shapes) {
        if (!this.selectedShapes.has(s.id)) continue;
        const b = shapeBounds(s);
        ctx.strokeRect(b.x - 2 * lw, b.y - 2 * lw, b.w + 4 * lw, b.h + 4 * lw);
      }
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

import type { Doc, DocKind, Layer, Shape } from './types';
import { css } from './color';
import { shapePath } from './vector';

let seq = 0;
export const uid = () => Date.now().toString(36) + '-' + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
export const ctx2d = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;

export function createLayer(kind: DocKind, w: number, h: number, name: string): Layer {
  const base = { id: uid(), name, visible: true, opacity: 1 };
  return kind === 'bitmap'
    ? { ...base, kind: 'bitmap', canvas: makeCanvas(w, h) }
    : { ...base, kind: 'vector', shapes: [] };
}

export function createDoc(kind: DocKind, w: number, h: number): Doc {
  const l = createLayer(kind, w, h, 'レイヤー 1');
  return { kind, width: w, height: h, layers: [l], activeLayerId: l.id, palette: [] };
}

export const activeLayer = (doc: Doc): Layer => doc.layers.find(l => l.id === doc.activeLayerId) ?? doc.layers[0];

export function renderShape(ctx: CanvasRenderingContext2D, s: Shape) {
  const p = shapePath(s);
  if (s.fill) {
    ctx.fillStyle = css(s.fill);
    ctx.fill(p);
  }
  if (s.stroke && s.strokeWidth > 0) {
    ctx.strokeStyle = css(s.stroke);
    ctx.lineWidth = s.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(p);
  }
}

export function renderLayerContent(ctx: CanvasRenderingContext2D, layer: Layer) {
  if (layer.kind === 'bitmap') ctx.drawImage(layer.canvas, 0, 0);
  else for (const s of layer.shapes) renderShape(ctx, s);
}

export function rasterizeLayer(doc: Doc, layer: Layer): HTMLCanvasElement {
  const c = makeCanvas(doc.width, doc.height);
  renderLayerContent(ctx2d(c), layer);
  return c;
}

/** 全レイヤーを合成。hook は各レイヤー描画後に呼ばれる(浮動選択やストロークのプレビュー用) */
export function composite(doc: Doc, ctx: CanvasRenderingContext2D, hook?: (layer: Layer, ctx: CanvasRenderingContext2D) => void) {
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    if (layer.kind === 'vector' && layer.opacity < 1) ctx.drawImage(rasterizeLayer(doc, layer), 0, 0);
    else renderLayerContent(ctx, layer);
    ctx.restore();
    hook?.(layer, ctx);
  }
}

export function compositeToCanvas(doc: Doc): HTMLCanvasElement {
  const c = makeCanvas(doc.width, doc.height);
  composite(doc, ctx2d(c));
  return c;
}

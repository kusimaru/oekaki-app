import type { Pt, Rgba, Selection } from './types';
import type { Rect } from './vector';

export function selectionPath(sel: Selection): Path2D {
  const p = new Path2D();
  if (sel.kind === 'rect') {
    const b = selectionBounds(sel);
    p.rect(b.x, b.y, b.w, b.h);
  } else {
    sel.points.forEach((pt, i) => (i === 0 ? p.moveTo(pt.x, pt.y) : p.lineTo(pt.x, pt.y)));
    p.closePath();
  }
  return p;
}

export function selectionBounds(sel: Selection): Rect {
  const xs = sel.points.map(p => p.x), ys = sel.points.map(p => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

export function normalizeRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** 選択範囲内=1 のマスク */
export function selectionMask(sel: Selection, w: number, h: number): Uint8Array {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fill(selectionPath(sel));
  const d = ctx.getImageData(0, 0, w, h).data;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  return m;
}

/**
 * ref(合成画像)で領域を判定し、target(アクティブレイヤー)に塗る。
 * 4近傍のスタック探索。
 */
export function floodFill(target: ImageData, ref: ImageData, sx: number, sy: number, color: Rgba, tolerance: number, mask: Uint8Array | null): void {
  const w = ref.width, h = ref.height;
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  if (mask && !mask[sy * w + sx]) return;
  const rd = ref.data, td = target.data;
  const si = (sy * w + sx) * 4;
  const r0 = rd[si], g0 = rd[si + 1], b0 = rd[si + 2], a0 = rd[si + 3];
  const visited = new Uint8Array(w * h);
  const stack: number[] = [sy * w + sx];
  const cr = color.r, cg = color.g, cb = color.b, ca = Math.round(color.a * 255);
  const match = (i: number) => {
    const j = i * 4;
    return Math.abs(rd[j] - r0) <= tolerance && Math.abs(rd[j + 1] - g0) <= tolerance
      && Math.abs(rd[j + 2] - b0) <= tolerance && Math.abs(rd[j + 3] - a0) <= tolerance;
  };
  while (stack.length) {
    const i = stack.pop()!;
    if (visited[i]) continue;
    visited[i] = 1;
    if (mask && !mask[i]) continue;
    if (!match(i)) continue;
    const j = i * 4;
    td[j] = cr;
    td[j + 1] = cg;
    td[j + 2] = cb;
    td[j + 3] = ca;
    const x = i % w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (i >= w) stack.push(i - w);
    if (i + w < w * h) stack.push(i + w);
  }
}

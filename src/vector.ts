import type { Anchor, Pt, Shape } from './types';

export const anchor = (x: number, y: number): Anchor => ({ x, y, inX: x, inY: y, outX: x, outY: y });

export function shapePath(s: Shape): Path2D {
  const p = new Path2D();
  const a = s.anchors;
  if (a.length === 0) return p;
  p.moveTo(a[0].x, a[0].y);
  for (let i = 1; i < a.length; i++) {
    p.bezierCurveTo(a[i - 1].outX, a[i - 1].outY, a[i].inX, a[i].inY, a[i].x, a[i].y);
  }
  if (s.closed && a.length > 1) {
    const l = a[a.length - 1];
    p.bezierCurveTo(l.outX, l.outY, a[0].inX, a[0].inY, a[0].x, a[0].y);
    p.closePath();
  }
  return p;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

export function shapeSvgD(s: Shape): string {
  const a = s.anchors;
  if (a.length === 0) return '';
  let d = `M${f(a[0].x)} ${f(a[0].y)}`;
  for (let i = 1; i < a.length; i++) {
    d += ` C${f(a[i - 1].outX)} ${f(a[i - 1].outY)} ${f(a[i].inX)} ${f(a[i].inY)} ${f(a[i].x)} ${f(a[i].y)}`;
  }
  if (s.closed && a.length > 1) {
    const l = a[a.length - 1];
    d += ` C${f(l.outX)} ${f(l.outY)} ${f(a[0].inX)} ${f(a[0].inY)} ${f(a[0].x)} ${f(a[0].y)} Z`;
  }
  return d;
}

export interface Rect { x: number; y: number; w: number; h: number; }

export function shapeBounds(s: Shape): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const a of s.anchors) {
    for (const [x, y] of [[a.x, a.y], [a.inX, a.inY], [a.outX, a.outY]]) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRect(rs: Rect[]): Rect {
  if (rs.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y));
  const x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function transformShape(s: Shape, fn: (p: Pt) => Pt): Shape {
  return {
    ...s,
    anchors: s.anchors.map(a => {
      const p = fn({ x: a.x, y: a.y }), i = fn({ x: a.inX, y: a.inY }), o = fn({ x: a.outX, y: a.outY });
      return { x: p.x, y: p.y, inX: i.x, inY: i.y, outX: o.x, outY: o.y };
    }),
  };
}

/** Ramer-Douglas-Peucker で点列を間引く */
export function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = pts[s], b = pts[e];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1e-9;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      const d = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Catmull-Rom 由来のハンドルで滑らかなベジェにする */
export function smoothAnchors(pts: Pt[], tension = 1 / 6): Anchor[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
    const tx = (next.x - prev.x) * tension, ty = (next.y - prev.y) * tension;
    return { x: p.x, y: p.y, inX: p.x - tx, inY: p.y - ty, outX: p.x + tx, outY: p.y + ty };
  });
}

const KAPPA = 0.5522847498;

export function ellipseAnchors(a: Pt, b: Pt): Anchor[] {
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    { x: cx + rx, y: cy, inX: cx + rx, inY: cy - ky, outX: cx + rx, outY: cy + ky },
    { x: cx, y: cy + ry, inX: cx + kx, inY: cy + ry, outX: cx - kx, outY: cy + ry },
    { x: cx - rx, y: cy, inX: cx - rx, inY: cy + ky, outX: cx - rx, outY: cy - ky },
    { x: cx, y: cy - ry, inX: cx - kx, inY: cy - ry, outX: cx + kx, outY: cy - ry },
  ];
}

export function rectAnchors(a: Pt, b: Pt): Anchor[] {
  return [anchor(a.x, a.y), anchor(b.x, a.y), anchor(b.x, b.y), anchor(a.x, b.y)];
}

const hitCtx = document.createElement('canvas').getContext('2d')!;

/** slop はヒット判定を広げる幅(ドキュメント座標) */
export function hitShape(s: Shape, p: Pt, slop: number): boolean {
  const path = shapePath(s);
  if (s.fill && hitCtx.isPointInPath(path, p.x, p.y)) return true;
  hitCtx.lineWidth = Math.max(s.strokeWidth, slop);
  return hitCtx.isPointInStroke(path, p.x, p.y);
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export const pointInRect = (p: Pt, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

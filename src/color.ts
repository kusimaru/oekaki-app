import type { Rgba } from './types';

export const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
export const css = (c: Rgba) => `rgba(${c.r},${c.g},${c.b},${c.a})`;
export const hex = (c: Rgba) => '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
export function fromHex(h: string, a = 1): Rgba {
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
}
export const same = (a: Rgba, b: Rgba) => a.r === b.r && a.g === b.g && a.b === b.b && Math.abs(a.a - b.a) < 0.005;

export const BASIC_COLORS: Rgba[] = [
  rgba(0, 0, 0), rgba(255, 255, 255), rgba(128, 128, 128),
  rgba(230, 0, 18), rgba(0, 104, 183), rgba(0, 153, 68),
  rgba(255, 241, 0), rgba(243, 152, 0), rgba(228, 0, 127),
  rgba(0, 160, 233), rgba(146, 7, 131), rgba(139, 69, 19),
];

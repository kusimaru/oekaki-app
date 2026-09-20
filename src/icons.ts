import type { ToolId } from './types';

/**
 * ツールアイコン(Photoshop 風の白線アイコン)。
 * 形は Lucide Icons(ISC License)をベースに調整。
 */
const wrap = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const ICONS: Record<ToolId, string> = {
  move: wrap('<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>'),
  select: wrap('<rect x="3.5" y="3.5" width="17" height="17" stroke-dasharray="3.2 2.2"/>'),
  lasso: wrap('<path d="M4 9.5c0-2.8 3.6-5 8-5s8 2.2 8 5-3.6 5-8 5c-1.7 0-3.2-.3-4.5-.9"/><path d="M7.5 13.6c-1.4 1.2-1.7 3-1 4.1.8 1.3 2.4 1 2.4 2.3 0 .8-.6 1.3-.6 1.3"/>'),
  eyedropper: wrap('<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>'),
  pen: wrap('<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>'),
  eraser: wrap('<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'),
  bucket: wrap('<path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/>'),
  line: wrap('<line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="1.3" fill="currentColor"/><circle cx="20" cy="4" r="1.3" fill="currentColor"/>'),
  rect: wrap('<rect x="3" y="5" width="18" height="14" rx="1"/>'),
  ellipse: wrap('<ellipse cx="12" cy="12" rx="9" ry="7.5"/>'),
  rotate: wrap('<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>'),
  hand: wrap('<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
  zoom: wrap('<circle cx="11" cy="11" r="7.5"/><line x1="21" y1="21" x2="16.5" y2="16.5"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>'),
};

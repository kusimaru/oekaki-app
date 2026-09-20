import type { Doc, Layer } from './types';
import { createLayer, ctx2d, makeCanvas, uid } from './document';

/** ブラウザで開ける画像(JPEG / PNG / WebP / GIF / BMP / SVG など)を読み込む */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('画像として読み込めませんでした')); };
    img.src = url;
  });
}

/** 画像 1 枚を同じサイズのビットマップキャンバスにする */
export async function importImage(file: File): Promise<Doc> {
  const img = await loadImage(file);
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('画像のサイズが取得できません');
  const layer = createLayer('bitmap', w, h, file.name.replace(/\.[^.]+$/, '') || '画像');
  if (layer.kind === 'bitmap') ctx2d(layer.canvas).drawImage(img, 0, 0);
  return { kind: 'bitmap', width: w, height: h, layers: [layer], activeLayerId: layer.id, palette: [] };
}

/** PSD をレイヤー構成ごと読み込む(フォルダは中身を展開、ベクター / テキストは見た目のピクセルで取り込む) */
export async function importPsd(file: File): Promise<Doc> {
  const { readPsd } = await import('ag-psd');
  const psd = readPsd(await file.arrayBuffer(), { skipThumbnail: true, skipLinkedFilesData: true });
  const w = psd.width, h = psd.height;
  const layers: Layer[] = [];
  const walk = (items: any[] | undefined, prefix: string) => {
    for (const it of items ?? []) {
      if (it.children) { walk(it.children, prefix + (it.name ? it.name + ' / ' : '')); continue; }
      const canvas = makeCanvas(w, h);
      if (it.canvas) ctx2d(canvas).drawImage(it.canvas, it.left ?? 0, it.top ?? 0);
      layers.push({ id: uid(), kind: 'bitmap', name: prefix + (it.name || 'レイヤー'), visible: !it.hidden, opacity: it.opacity ?? 1, canvas });
    }
  };
  walk(psd.children, '');
  if (layers.length === 0) {
    // レイヤー情報のない(統合済みの)PSD は合成画像を 1 枚にする
    const canvas = makeCanvas(w, h);
    if (psd.canvas) ctx2d(canvas).drawImage(psd.canvas, 0, 0);
    layers.push({ id: uid(), kind: 'bitmap', name: '背景', visible: true, opacity: 1, canvas });
  }
  return { kind: 'bitmap', width: w, height: h, layers, activeLayerId: layers[layers.length - 1].id, palette: [] };
}

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i;
export const PSD_EXT = /\.psd$/i;

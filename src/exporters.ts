import type { Doc, Rgba } from './types';
import { hex } from './color';
import { compositeToCanvas, rasterizeLayer } from './document';
import { canvasToBlob, blobToDataUrl } from './project';
import { shapeSvgD } from './vector';

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function exportPng(doc: Doc, name: string) {
  download(await canvasToBlob(compositeToCanvas(doc)), `${name}.png`);
}

/** PSD 書き出し。ベジェレイヤーはラスタ化される(レイヤー構成は保持) */
export async function exportPsd(doc: Doc, name: string) {
  const { writePsd } = await import('ag-psd');
  const psd = {
    width: doc.width,
    height: doc.height,
    canvas: compositeToCanvas(doc),
    children: doc.layers.map(l => ({
      name: l.name,
      opacity: l.opacity,
      hidden: !l.visible,
      canvas: l.kind === 'bitmap' ? l.canvas : rasterizeLayer(doc, l),
    })),
  };
  const buf = writePsd(psd, { generateThumbnail: true });
  download(new Blob([buf], { type: 'image/vnd.adobe.photoshop' }), `${name}.psd`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const idOf = (s: string) => s.replace(/[^\p{L}\p{N}_-]/gu, '_');
const paint = (attr: string, c: Rgba | null) =>
  c ? ` ${attr}="${hex(c)}"${c.a < 1 ? ` ${attr}-opacity="${c.a}"` : ''}` : ` ${attr}="none"`;

/**
 * SVG 書き出し。レイヤーは <g id="レイヤー名"> になる。
 * Illustrator で開くとグループとして読み込まれる(名前・不透明度は保持)。
 * ビットマップレイヤーは <image> として埋め込む。
 */
export async function exportSvg(doc: Doc, name: string) {
  const parts: string[] = [];
  const usedIds = new Set<string>();
  for (const l of doc.layers) {
    let id = idOf(l.name) || 'layer';
    while (usedIds.has(id)) id += '_';
    usedIds.add(id);
    const attrs = ` id="${esc(id)}" data-name="${esc(l.name)}"${l.opacity < 1 ? ` opacity="${l.opacity}"` : ''}${l.visible ? '' : ' display="none"'}`;
    if (l.kind === 'vector') {
      const paths = l.shapes.map(s =>
        `    <path d="${shapeSvgD(s)}"${paint('fill', s.fill)}${paint('stroke', s.stroke)}${s.stroke ? ` stroke-width="${s.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"` : ''}/>`,
      );
      parts.push(`  <g${attrs}>\n${paths.join('\n')}\n  </g>`);
    } else {
      const url = await blobToDataUrl(await canvasToBlob(l.canvas));
      parts.push(`  <g${attrs}>\n    <image width="${doc.width}" height="${doc.height}" href="${url}"/>\n  </g>`);
    }
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">\n${parts.join('\n')}\n</svg>\n`;
  download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
}

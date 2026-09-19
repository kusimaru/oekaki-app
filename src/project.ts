import type { Doc, DocKind, Layer, Rgba, Shape } from './types';
import { makeCanvas, ctx2d, uid } from './document';

/** プロジェクト保存形式(project.json) */
export interface Manifest {
  version: 1;
  kind: DocKind;
  width: number;
  height: number;
  activeLayerId: string;
  palette: Rgba[];
  layers: LayerManifest[];
}
export interface LayerManifest {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  kind: DocKind;
  shapes?: Shape[];
  /** ファイル分割保存時: PNG の相対パス */
  file?: string;
  /** 単一ファイル保存時: data URL */
  data?: string;
}

export const PROJECT_FILE = 'project.json';

export function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
}

export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
}

export async function blobToCanvas(b: Blob, w: number, h: number): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(b);
  const c = makeCanvas(w, h);
  ctx2d(c).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

/**
 * mode 'embed': 単一 JSON に PNG を data URL で埋め込む(ローカル保存用)
 * mode 'files': レイヤー PNG を別ファイルにする(GitHub 用)
 */
export async function serialize(doc: Doc, mode: 'embed' | 'files'): Promise<{ manifest: Manifest; files: { path: string; blob: Blob }[] }> {
  const files: { path: string; blob: Blob }[] = [];
  const layers: LayerManifest[] = [];
  for (const l of doc.layers) {
    const m: LayerManifest = { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, kind: l.kind };
    if (l.kind === 'vector') {
      m.shapes = l.shapes;
    } else {
      const blob = await canvasToBlob(l.canvas);
      if (mode === 'embed') m.data = await blobToDataUrl(blob);
      else {
        m.file = `layers/${l.id}.png`;
        files.push({ path: m.file, blob });
      }
    }
    layers.push(m);
  }
  const manifest: Manifest = {
    version: 1, kind: doc.kind, width: doc.width, height: doc.height,
    activeLayerId: doc.activeLayerId, palette: doc.palette, layers,
  };
  return { manifest, files };
}

export async function deserialize(manifest: Manifest, loadFile: (path: string) => Promise<Blob | null>): Promise<Doc> {
  const layers: Layer[] = [];
  for (const m of manifest.layers) {
    const base = { id: m.id || uid(), name: m.name, visible: m.visible ?? true, opacity: m.opacity ?? 1 };
    if (m.kind === 'vector') {
      layers.push({ ...base, kind: 'vector', shapes: m.shapes ?? [] });
    } else {
      let blob: Blob | null = null;
      if (m.data) blob = await (await fetch(m.data)).blob();
      else if (m.file) blob = await loadFile(m.file);
      const canvas = blob ? await blobToCanvas(blob, manifest.width, manifest.height) : makeCanvas(manifest.width, manifest.height);
      layers.push({ ...base, kind: 'bitmap', canvas });
    }
  }
  if (layers.length === 0) throw new Error('レイヤーがありません');
  const activeLayerId = layers.some(l => l.id === manifest.activeLayerId) ? manifest.activeLayerId : layers[layers.length - 1].id;
  return { kind: manifest.kind, width: manifest.width, height: manifest.height, layers, activeLayerId, palette: manifest.palette ?? [] };
}

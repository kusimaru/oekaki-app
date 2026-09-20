import type { Doc, Layer, Shape } from './types';

export type Snap = { kind: 'bitmap'; data: ImageData } | { kind: 'vector'; shapes: Shape[] };

export function snap(layer: Layer): Snap {
  if (layer.kind === 'bitmap') {
    const ctx = layer.canvas.getContext('2d', { willReadFrequently: true })!;
    return { kind: 'bitmap', data: ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height) };
  }
  return { kind: 'vector', shapes: structuredClone(layer.shapes) };
}

export function restore(layer: Layer, s: Snap): void {
  if (layer.kind === 'bitmap' && s.kind === 'bitmap') {
    layer.canvas.getContext('2d')!.putImageData(s.data, 0, 0);
  } else if (layer.kind === 'vector' && s.kind === 'vector') {
    layer.shapes = structuredClone(s.shapes);
  }
}

/** レイヤー構成(追加・削除・並べ替え)のスナップショット。Layer オブジェクト自体は共有する */
export interface LayersState { layers: Layer[]; activeLayerId: string; }
export const layersState = (doc: Doc): LayersState => ({ layers: [...doc.layers], activeLayerId: doc.activeLayerId });

type Entry =
  | { kind: 'layer'; layerId: string; before: Snap; after: Snap }
  | { kind: 'layers'; before: LayersState; after: LayersState };

export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  limit = 40;

  push(layerId: string, before: Snap, after: Snap) {
    this.add({ kind: 'layer', layerId, before, after });
  }
  pushLayers(before: LayersState, after: LayersState) {
    this.add({ kind: 'layers', before, after });
  }
  private add(e: Entry) {
    this.undoStack.push(e);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  private apply(doc: Doc, e: Entry, dir: 'before' | 'after') {
    if (e.kind === 'layers') {
      const s = e[dir];
      doc.layers = [...s.layers];
      doc.activeLayerId = s.activeLayerId;
    } else {
      const l = doc.layers.find(l => l.id === e.layerId);
      if (l) restore(l, e[dir]);
    }
  }
  undo(doc: Doc): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    this.apply(doc, e, 'before');
    this.redoStack.push(e);
    return true;
  }
  redo(doc: Doc): boolean {
    const e = this.redoStack.pop();
    if (!e) return false;
    this.apply(doc, e, 'after');
    this.undoStack.push(e);
    return true;
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}

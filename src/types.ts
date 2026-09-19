export type DocKind = 'bitmap' | 'vector';

export interface Pt { x: number; y: number; }

/** r,g,b は 0-255、a は 0-1 */
export interface Rgba { r: number; g: number; b: number; a: number; }

/** ベジェのアンカー点。in/out はハンドル座標(絶対座標) */
export interface Anchor { x: number; y: number; inX: number; inY: number; outX: number; outY: number; }

export interface Shape {
  id: string;
  anchors: Anchor[];
  closed: boolean;
  stroke: Rgba | null;
  strokeWidth: number;
  fill: Rgba | null;
}

interface LayerBase { id: string; name: string; visible: boolean; opacity: number; }
export interface BitmapLayer extends LayerBase { kind: 'bitmap'; canvas: HTMLCanvasElement; }
export interface VectorLayer extends LayerBase { kind: 'vector'; shapes: Shape[]; }
export type Layer = BitmapLayer | VectorLayer;

export interface Doc {
  kind: DocKind;
  width: number;
  height: number;
  /** index 0 が最下層 */
  layers: Layer[];
  activeLayerId: string;
  /** ユーザー登録色 */
  palette: Rgba[];
}

export interface Selection {
  kind: 'rect' | 'lasso';
  /** rect: 対角2点 / lasso: 多角形 */
  points: Pt[];
}

export type ToolId =
  | 'select' | 'lasso' | 'move' | 'rotate' | 'scale'
  | 'pen' | 'eraser' | 'bucket' | 'eyedropper'
  | 'line' | 'rect' | 'ellipse' | 'hand' | 'zoom';

export interface ToolOptions {
  size: number;
  fill: boolean;
  tolerance: number;
  pressure: boolean;
  /** バケツ: 全レイヤーを参照して領域判定する(false = 現在のレイヤーのみ) */
  sampleAll: boolean;
}

export interface InputInfo { pressure: number; pen: boolean; shift: boolean; }

/**
 * ライブラリ(ノートブック › セクション › 画像)の共通処理。
 * GitHub 上では `ノートブック/セクション/画像/project.json` というフォルダ構造そのものが一覧の元データ。
 */
export const DEFAULT_NOTEBOOK = 'わたしのノート';
export const DEFAULT_SECTION = '未分類';
export const THUMB_FILE = 'thumb.png';
export const KEEP_FILE = '.keep';

/** 余白ノートと同じセクション色 */
export const SECTION_COLORS = ['#c2185b', '#1e5bb8', '#2e9e5b', '#d94a3d', '#7b3fb0', '#e08a00', '#0f9c8a', '#5c6bc0', '#8d6e63', '#546e7a'];

/** 名前から決まる色(端末間で同じ色になる) */
export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return SECTION_COLORS[h % SECTION_COLORS.length];
}

/** フォルダ名に使えない文字を除く */
export const cleanName = (s: string, fallback: string) => {
  const c = s.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').slice(0, 60);
  return c || fallback;
};

export const canvasDir = (notebook: string, section: string, name: string) => `${notebook}/${section}/${name}`;

export interface RemoteCanvas {
  notebook: string;
  section: string;
  name: string;
  /** リポジトリ内のフォルダ(旧形式はトップ直下) */
  dir: string;
  thumbSha: string | null;
  legacy: boolean;
}
export interface RemoteScan {
  headSha: string | null;
  notebooks: string[];
  sections: { notebook: string; name: string }[];
  canvases: RemoteCanvas[];
}

/** リポジトリのファイル一覧からライブラリ構造を組み立てる */
export function parseTree(files: { path: string; sha: string }[]): Omit<RemoteScan, 'headSha'> {
  const notebooks = new Set<string>();
  const sections = new Map<string, { notebook: string; name: string }>();
  const canvases = new Map<string, RemoteCanvas>();
  const addSection = (nb: string, sec: string) => { notebooks.add(nb); sections.set(`${nb}/${sec}`, { notebook: nb, name: sec }); };
  for (const f of files) {
    const parts = f.path.split('/');
    const file = parts[parts.length - 1];
    if (parts.length === 4 && (file === 'project.json' || file === THUMB_FILE)) {
      const [nb, sec, name] = parts;
      addSection(nb, sec);
      const dir = canvasDir(nb, sec, name);
      const c = canvases.get(dir) ?? { notebook: nb, section: sec, name, dir, thumbSha: null, legacy: false };
      if (file === THUMB_FILE) c.thumbSha = f.sha;
      canvases.set(dir, c);
    } else if (parts.length === 3 && file === KEEP_FILE) {
      addSection(parts[0], parts[1]);
    } else if (parts.length === 2 && (file === 'project.json' || file === THUMB_FILE)) {
      // 旧形式: トップ直下の `画像名/project.json`
      const name = parts[0];
      addSection(DEFAULT_NOTEBOOK, DEFAULT_SECTION);
      const c = canvases.get(name) ?? { notebook: DEFAULT_NOTEBOOK, section: DEFAULT_SECTION, name, dir: name, thumbSha: null, legacy: true };
      if (file === THUMB_FILE) c.thumbSha = f.sha;
      canvases.set(name, c);
    }
  }
  return { notebooks: [...notebooks], sections: [...sections.values()], canvases: [...canvases.values()] };
}

/** サムネイル用に縮小した PNG の Blob を作る */
export function makeThumb(src: HTMLCanvasElement, max = 240): Promise<Blob> {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * s));
  c.height = Math.max(1, Math.round(src.height * s));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('thumb'))), 'image/png'));
}

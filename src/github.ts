/**
 * GitHub REST API(Git Data API)でプロジェクトフォルダをコミット / 取得する。
 * サーバー不要。Fine-grained PAT(対象リポジトリの Contents: Read and write)を使う。
 */
export interface GhConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** リポジトリ内のプロジェクトフォルダ(例: "my-drawing") */
  dir: string;
}

export interface RepoFile { path: string; content: Uint8Array | string; }

export class ConflictError extends Error {
  constructor() { super('リモートに新しいコミットがあります(競合)'); }
}

const API = 'https://api.github.com';

function toBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(b64.replace(/\n/g, ''));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export class GitHubSync {
  /** 直近の push/pull 時点でリポジトリに存在したパス(削除検出用) */
  knownPaths = new Set<string>();

  constructor(public cfg: GhConfig) {}

  private async api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    // GitHub API は Cache-Control: max-age=60 を返すので、ブラウザが 60 秒間古い応答を使ってしまう。
    // 常に最新を見るため、キャッシュ無効化と GET へのダミー引数の両方で防ぐ
    const method = (init.method ?? 'GET').toUpperCase();
    const url = API + path + (method === 'GET' ? (path.includes('?') ? '&' : '?') + '_=' + Date.now() : '');
    const res = await fetch(url, {
      ...init,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? (undefined as T) : res.json();
  }

  private get base() { return `/repos/${this.cfg.owner}/${this.cfg.repo}`; }
  private get prefix() { return this.cfg.dir ? this.cfg.dir.replace(/\/+$/, '') + '/' : ''; }

  /** ブランチ先頭のコミット SHA。ブランチが無い(空リポジトリ)場合は null */
  async getHead(): Promise<string | null> {
    try {
      const r = await this.api(`${this.base}/git/ref/heads/${encodeURIComponent(this.cfg.branch)}`);
      return r.object.sha as string;
    } catch (e: any) {
      if (e.status === 404 || e.status === 409) return null;
      throw e;
    }
  }

  /** 空リポジトリなら Contents API で最初のコミットを作ってブランチを生やす */
  private async ensureBranch(): Promise<string> {
    const head = await this.getHead();
    if (head) return head;
    await this.api(`${this.base}/contents/${this.prefix}.gitkeep`, {
      method: 'PUT',
      body: JSON.stringify({ message: 'init', content: '', branch: this.cfg.branch }),
    });
    const sha = await this.getHead();
    if (!sha) throw new Error('ブランチを作成できませんでした');
    return sha;
  }

  /**
   * 複数ファイルを 1 コミットで書き込む。
   * expectedHead が指定され、リモート先頭が異なる場合は ConflictError。
   */
  async commitFiles(files: RepoFile[], message: string, opts: { expectedHead?: string | null; force?: boolean } = {}): Promise<string> {
    const head = await this.ensureBranch();
    if (!opts.force && opts.expectedHead !== undefined && opts.expectedHead !== null && head !== opts.expectedHead) throw new ConflictError();
    const headCommit = await this.api(`${this.base}/git/commits/${head}`);
    const enc = new TextEncoder();
    const tree: any[] = [];
    const newPaths = new Set<string>();
    for (const f of files) {
      const u8 = typeof f.content === 'string' ? enc.encode(f.content) : f.content;
      const blob = await this.api(`${this.base}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: toBase64(u8), encoding: 'base64' }),
      });
      const path = this.prefix + f.path;
      newPaths.add(path);
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    for (const p of this.knownPaths) if (!newPaths.has(p)) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
    const newTree = await this.api(`${this.base}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }),
    });
    const commit = await this.api(`${this.base}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: newTree.sha, parents: [head] }),
    });
    try {
      await this.api(`${this.base}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: !!opts.force }),
      });
    } catch (e: any) {
      if (e.status === 422) throw new ConflictError();
      throw e;
    }
    this.knownPaths = newPaths;
    return commit.sha as string;
  }

  /** 接続テスト: トークンでリポジトリが見えるか、書き込みできるか */
  async checkAccess(): Promise<{ ok: true; canPush: boolean; isPrivate: boolean } | { ok: false; status: number; message: string }> {
    try {
      const r = await this.api(this.base);
      return { ok: true, canPush: !!r.permissions?.push, isPrivate: !!r.private };
    } catch (e: any) {
      return { ok: false, status: e.status ?? 0, message: e.message ?? String(e) };
    }
  }

  /** リモートのフォルダに project.json があるか */
  async remoteHasProject(): Promise<boolean> {
    const head = await this.getHead();
    if (!head) return false;
    const commit = await this.api(`${this.base}/git/commits/${head}`);
    const tree = await this.api(`${this.base}/git/trees/${commit.tree.sha}?recursive=1`);
    return (tree.tree as any[]).some(item => item.type === 'blob' && item.path === this.prefix + 'project.json');
  }

  /** このフォルダを最後に更新したコミットのメッセージと日時 */
  async lastCommitInfo(): Promise<{ message: string; date: string } | null> {
    const dir = this.prefix.replace(/\/$/, '');
    const list = await this.api(`${this.base}/commits?path=${encodeURIComponent(dir)}&sha=${encodeURIComponent(this.cfg.branch)}&per_page=1`);
    const c = list?.[0]?.commit;
    return c ? { message: c.message as string, date: c.committer?.date ?? c.author?.date } : null;
  }

  /** プロジェクトフォルダ配下の全ファイルを取得 */
  async pull(): Promise<{ sha: string | null; files: Map<string, Uint8Array> }> {
    const files = new Map<string, Uint8Array>();
    const head = await this.getHead();
    if (!head) return { sha: null, files };
    const commit = await this.api(`${this.base}/git/commits/${head}`);
    const tree = await this.api(`${this.base}/git/trees/${commit.tree.sha}?recursive=1`);
    const known = new Set<string>();
    for (const item of tree.tree as any[]) {
      if (item.type !== 'blob' || !item.path.startsWith(this.prefix)) continue;
      known.add(item.path);
      const rel = item.path.slice(this.prefix.length);
      if (rel === '.gitkeep') continue;
      const blob = await this.api(`${this.base}/git/blobs/${item.sha}`);
      files.set(rel, fromBase64(blob.content));
    }
    this.knownPaths = known;
    return { sha: head, files };
  }
}

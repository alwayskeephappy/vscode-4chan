import type { Board, CatalogPage, Post } from './types';

const API = 'https://a.4cdn.org';
const IMG = 'https://i.4cdn.org';

const TTL = 60_000; // 缓存 60 秒
const cache = new Map<string, { t: number; data: unknown }>();
const pending = new Map<string, Promise<unknown>>();

async function getJSON<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < TTL) return hit.data as T;

  // 并发去重：同一 path 同时只发一次
  const inflight = pending.get(path);
  if (inflight) return inflight as Promise<T>;

  const p = (async () => {
    const res = await fetch(`${API}${path}`, {
      headers: { 'User-Agent': 'vscode-4chan/0.1 (+developer tool)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    const json = (await res.json()) as T;
    cache.set(path, { t: Date.now(), data: json });
    return json;
  })().finally(() => pending.delete(path));

  pending.set(path, p);
  return p as Promise<T>;
}

export function imageUrl(
  board: string,
  tim: number | undefined,
  ext: string | undefined,
  thumb = false,
): string | undefined {
  if (!tim || !ext) return undefined;
  return thumb ? `${IMG}/${board}/${tim}s.jpg` : `${IMG}/${board}/${tim}${ext}`;
}

export async function getBoards(): Promise<Board[]> {
  const data = await getJSON<{ boards: Board[] }>('/boards.json');
  return data.boards ?? [];
}

export async function getCatalog(board: string): Promise<CatalogPage[]> {
  return getJSON<CatalogPage[]>(`/${board}/catalog.json`);
}

export async function getThread(board: string, no: number): Promise<Post[]> {
  const data = await getJSON<{ posts: Post[] }>(`/${board}/thread/${no}.json`);
  return data.posts ?? [];
}

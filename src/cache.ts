// Memoization for public upstream data: a memory map, in-flight de-duplication, and optionally a shared
// Cache API cache (Cloudflare Workers' `caches.default`), so other isolates reuse a result.
// Values must be JSON-serialisable and public. Never cache per-user secrets with this.

type Entry = { at: number; value: unknown };

/** The subset of the Cache API this module uses. `caches.default` in Workers satisfies it. */
export type EdgeCache = {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
};

export type CacheOptions = {
  /** Most entries kept in memory; the oldest is dropped first. */
  maxEntries?: number;
  /** Optional shared cache. Failures are ignored and fall back to memory only. */
  edge?: EdgeCache;
  /** URL prefix for edge keys. The host does not need to exist; it only names the entry. */
  edgePrefix?: string;
  /** Clock, injectable for tests. */
  now?: () => number;
};

export type Cached<T> = { value: T; at: number; hit: boolean };

export type Memo = {
  cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<Cached<T>>;
  clear(): void;
  readonly size: number;
};

export function createCache(opts: CacheOptions = {}): Memo {
  const max = opts.maxEntries ?? 500;
  const now = opts.now ?? Date.now;
  const prefix = opts.edgePrefix ?? "https://cache.venue-adapters.invalid/";
  const mem = new Map<string, Entry>();
  const inflight = new Map<string, Promise<Entry>>();

  const fromEdge = async (key: string, ttlMs: number): Promise<Entry | null> => {
    if (!opts.edge) return null;
    try {
      const r = await opts.edge.match(prefix + encodeURIComponent(key));
      if (!r) return null;
      const e = (await r.json()) as Entry;
      return now() - e.at < ttlMs ? e : null;
    } catch {
      return null;
    }
  };

  const toEdge = async (key: string, e: Entry, ttlMs: number) => {
    if (!opts.edge) return;
    try {
      await opts.edge.put(
        prefix + encodeURIComponent(key),
        new Response(JSON.stringify(e), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${Math.ceil(ttlMs / 1000)}` },
        }),
      );
    } catch {
      /* no usable Cache API here: memory only */
    }
  };

  return {
    async cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<Cached<T>> {
      const m = mem.get(key);
      if (m && now() - m.at < ttlMs) return { value: m.value as T, at: m.at, hit: true };
      let p = inflight.get(key);
      let hit = true;
      if (!p) {
        hit = false;
        p = (async () => {
          const edge = await fromEdge(key, ttlMs);
          if (edge) return edge;
          const e: Entry = { at: now(), value: await fn() };
          await toEdge(key, e, ttlMs);
          return e;
        })().finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      const e = await p;
      if (!mem.has(key) && mem.size >= max) mem.delete(mem.keys().next().value!);
      mem.set(key, e);
      return { value: e.value as T, at: e.at, hit };
    },
    clear() {
      mem.clear();
    },
    get size() {
      return mem.size;
    },
  };
}

/** Runs `fn` over `items` with at most `limit` calls in flight. Results keep the input order. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
  if (!(limit >= 1)) throw new RangeError("limit must be at least 1");
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

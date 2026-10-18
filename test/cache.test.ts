import { describe, expect, it } from "vitest";
import { createCache, pool, type EdgeCache } from "../src/index";

describe("createCache", () => {
  it("reuses a value within its TTL and refreshes after it", async () => {
    let t = 0;
    let calls = 0;
    const c = createCache({ now: () => t });
    const fn = async () => ++calls;
    expect(await c.cached("k", 1000, fn)).toEqual({ value: 1, at: 0, hit: false });
    t = 999;
    expect((await c.cached("k", 1000, fn)).hit).toBe(true);
    t = 1000;
    expect(await c.cached("k", 1000, fn)).toEqual({ value: 2, at: 1000, hit: false });
  });

  it("shares one in-flight call", async () => {
    let calls = 0;
    const c = createCache();
    const fn = () => new Promise<number>((r) => setTimeout(() => r(++calls), 5));
    const [a, b] = await Promise.all([c.cached("k", 1000, fn), c.cached("k", 1000, fn)]);
    expect(calls).toBe(1);
    expect(a.value).toBe(1);
    expect(b).toMatchObject({ value: 1, hit: true });
  });

  it("does not cache failures", async () => {
    const c = createCache();
    await expect(c.cached("k", 1000, async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect((await c.cached("k", 1000, async () => 5)).value).toBe(5);
  });

  it("drops the oldest entry past maxEntries", async () => {
    const c = createCache({ maxEntries: 2 });
    for (const k of ["a", "b", "c"]) await c.cached(k, 1000, async () => k);
    expect(c.size).toBe(2);
    expect((await c.cached("a", 1000, async () => "again")).value).toBe("again");
  });

  it("reads and writes a shared edge cache, and survives its failures", async () => {
    const store = new Map<string, string>();
    const edge: EdgeCache = {
      async match(k) {
        const v = store.get(k);
        return v ? new Response(v) : undefined;
      },
      async put(k, r) {
        store.set(k, await r.text());
      },
    };
    const a = createCache({ edge });
    await a.cached("k", 60_000, async () => "from upstream");
    const b = createCache({ edge });
    expect((await b.cached("k", 60_000, async () => "not used")).value).toBe("from upstream");

    const broken: EdgeCache = {
      match: () => Promise.reject(new Error("no cache")),
      put: () => Promise.reject(new Error("no cache")),
    };
    expect((await createCache({ edge: broken }).cached("k", 1000, async () => 1)).value).toBe(1);
  });
});

describe("pool", () => {
  it("keeps order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await pool([5, 1, 4, 2, 3], 2, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, x));
      active--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("rejects a limit below one", async () => {
    await expect(pool([1], 0, async (x) => x)).rejects.toThrow(RangeError);
  });
});

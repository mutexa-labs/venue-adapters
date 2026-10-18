import { describe, expect, it } from "vitest";
import { createHyperliquidProxy } from "../src/hono";
import { hlFetch } from "./helpers/fixtures";

const post = (app: ReturnType<typeof createHyperliquidProxy>, body: string) =>
  app.request("/info", { method: "POST", headers: { "content-type": "application/json" }, body });

describe("hyperliquid proxy route", () => {
  it("passes allowlisted reads through and caches them", async () => {
    const f = hlFetch();
    const app = createHyperliquidProxy({ fetch: f });
    const a = await post(app, JSON.stringify({ type: "allMids" }));
    expect(a.status).toBe(200);
    expect(a.headers.get("x-cache")).toBe("miss");
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys((await a.json()) as object)).toContain("BTC");
    const b = await post(app, JSON.stringify({ type: "allMids" }));
    expect(b.headers.get("x-cache")).toBe("hit");
    expect(f.calls).toHaveLength(1);
  });

  it("answers 400 for bad JSON and requests outside the allowlist", async () => {
    const app = createHyperliquidProxy({ fetch: hlFetch() });
    expect((await post(app, "{nope")).status).toBe(400);
    const r = await post(app, JSON.stringify({ type: "exchange", action: {} }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/type must be one of/);
  });

  it("answers 502 when the upstream fails", async () => {
    const app = createHyperliquidProxy({ fetch: () => Promise.reject(new TypeError("fetch failed")) });
    expect((await post(app, JSON.stringify({ type: "allMids" }))).status).toBe(502);
  });
});

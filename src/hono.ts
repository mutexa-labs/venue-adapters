// Optional: a mountable, read-only proxy for the Hyperliquid info API (requires `hono`).
//
//   app.route("/api/hl", createHyperliquidProxy());   // POST /api/hl/info
//
// Only allowlisted request types pass, bodies are validated and normalised, and identical requests within a
// type's TTL share one upstream call.

import { Hono } from "hono";
import {
  createHyperliquidClient,
  HyperliquidError,
  type HyperliquidClient,
  type HyperliquidClientOptions,
} from "./hyperliquid/client";

export type HyperliquidProxyOptions = HyperliquidClientOptions & {
  client?: HyperliquidClient;
  /** Path of the POST route inside the returned app. */
  path?: string;
};

export function createHyperliquidProxy(opts: HyperliquidProxyOptions = {}) {
  const client = opts.client ?? createHyperliquidClient(opts);
  const app = new Hono();
  app.post(opts.path ?? "/info", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    try {
      const r = await client.infoRaw(body);
      return c.body(r.body, 200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-cache": r.cache,
      });
    } catch (e) {
      if (e instanceof HyperliquidError && e.status === 400) return c.json({ error: e.message }, 400);
      return c.json({ error: e instanceof Error ? e.message : "Upstream error" }, 502);
    }
  });
  return app;
}

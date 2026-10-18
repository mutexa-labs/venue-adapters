// Read-only client for the Hyperliquid public info API: an allowlist of request types, request validation,
// per-type cache TTLs and in-flight de-duplication.

import { createCache, type Memo } from "../cache";
import type { FetchLike } from "../types";
import type { HlAllMids, HlCandle, HlClearinghouseState, HlMetaAndCtxs, HlSpotState, HlTrade } from "./types";

export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

/** The only request types the client (and the proxy route) will send. All are public reads. */
export const HL_ALLOWED = [
  "allMids",
  "metaAndAssetCtxs",
  "clearinghouseState",
  "spotClearinghouseState",
  "candleSnapshot",
  "recentTrades",
] as const;
export type HlRequestType = (typeof HL_ALLOWED)[number];

/** Seconds a response may be reused, per request type. */
export const HL_CACHE_TTL: Record<HlRequestType, number> = {
  allMids: 2,
  metaAndAssetCtxs: 5,
  clearinghouseState: 3,
  spotClearinghouseState: 10,
  candleSnapshot: 30,
  recentTrades: 2,
};

export const CANDLE_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const COIN_RE = /^[A-Za-z0-9:_-]{1,32}$/;

export type HlRequest = { type: HlRequestType } & Record<string, unknown>;

export type ValidationResult = { ok: true; req: HlRequest } | { ok: false; error: string };

/**
 * Validates a request body and returns a normalised copy (lowercased addresses, candle times rounded to the
 * minute so nearby requests share a cache entry), or an error message. Unknown fields are dropped.
 */
export function validateHlRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const type = b.type;
  if (typeof type !== "string" || !(HL_ALLOWED as readonly string[]).includes(type))
    return { ok: false, error: `type must be one of ${HL_ALLOWED.join(", ")}` };
  switch (type as HlRequestType) {
    case "allMids":
    case "metaAndAssetCtxs":
      return { ok: true, req: { type: type as HlRequestType } };
    case "clearinghouseState":
    case "spotClearinghouseState": {
      if (typeof b.user !== "string" || !ADDRESS_RE.test(b.user))
        return { ok: false, error: "user must be a 0x address" };
      return { ok: true, req: { type: type as HlRequestType, user: b.user.toLowerCase() } };
    }
    case "recentTrades": {
      if (typeof b.coin !== "string" || !COIN_RE.test(b.coin)) return { ok: false, error: "coin is invalid" };
      return { ok: true, req: { type: "recentTrades", coin: b.coin } };
    }
    case "candleSnapshot": {
      const r = b.req as Record<string, unknown> | undefined;
      if (!r || typeof r !== "object") return { ok: false, error: "req is required" };
      const { coin, interval, startTime, endTime } = r;
      if (typeof coin !== "string" || !COIN_RE.test(coin)) return { ok: false, error: "req.coin is invalid" };
      if (typeof interval !== "string" || !(CANDLE_INTERVALS as readonly string[]).includes(interval))
        return { ok: false, error: "req.interval is invalid" };
      if (typeof startTime !== "number" || !Number.isFinite(startTime))
        return { ok: false, error: "req.startTime is invalid" };
      const end = typeof endTime === "number" && Number.isFinite(endTime) ? endTime : undefined;
      const round = (t: number) => Math.floor(t / 60_000) * 60_000;
      return {
        ok: true,
        req: {
          type: "candleSnapshot",
          req: { coin, interval, startTime: round(startTime), ...(end !== undefined ? { endTime: round(end) } : {}) },
        },
      };
    }
  }
}

/** An upstream or validation failure, with a message that is safe to show as-is. */
export class HyperliquidError extends Error {
  override name = "HyperliquidError";
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export type HyperliquidClientOptions = {
  /** Info endpoint. Defaults to Hyperliquid mainnet. */
  url?: string;
  fetch?: FetchLike;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Cache to use; `false` disables caching. A private in-memory cache is created when omitted. */
  cache?: Memo | false;
  /** Override TTLs (seconds) per request type. */
  ttl?: Partial<Record<HlRequestType, number>>;
};

export type RawInfo = { status: number; body: string; cache: "hit" | "miss" | "off" };

export type HyperliquidClient = {
  readonly url: string;
  /** Validates, de-duplicates and caches one request; returns the upstream body as text. */
  infoRaw(body: unknown): Promise<RawInfo>;
  /** Same as `infoRaw`, parsed. Throws `HyperliquidError` on validation or upstream failure. */
  info<T>(body: unknown): Promise<T>;
  allMids(): Promise<HlAllMids>;
  metaAndAssetCtxs(): Promise<HlMetaAndCtxs>;
  clearinghouseState(user: string): Promise<HlClearinghouseState>;
  spotClearinghouseState(user: string): Promise<HlSpotState>;
  candleSnapshot(coin: string, interval: CandleInterval, startTime: number, endTime?: number): Promise<HlCandle[]>;
  recentTrades(coin: string): Promise<HlTrade[]>;
};

export function createHyperliquidClient(opts: HyperliquidClientOptions = {}): HyperliquidClient {
  const url = opts.url ?? HL_INFO_URL;
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 8000;
  const memo = opts.cache === false ? null : (opts.cache ?? createCache());
  const ttl = { ...HL_CACHE_TTL, ...opts.ttl };

  const upstream = async (key: string): Promise<{ status: number; body: string }> => {
    let r: Response;
    try {
      r = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: key,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError")
        throw new HyperliquidError(`Hyperliquid did not answer within ${timeoutMs} ms`);
      throw new HyperliquidError(`Could not reach Hyperliquid: ${e instanceof Error ? e.message : String(e)}`);
    }
    const body = await r.text();
    if (r.status !== 200) throw new HyperliquidError(`Hyperliquid responded ${r.status}`, r.status);
    return { status: r.status, body };
  };

  const infoRaw = async (body: unknown): Promise<RawInfo> => {
    const v = validateHlRequest(body);
    if (!v.ok) throw new HyperliquidError(v.error, 400);
    const key = JSON.stringify(v.req);
    if (!memo) return { ...(await upstream(key)), cache: "off" };
    const r = await memo.cached(`hl:${url}:${key}`, ttl[v.req.type] * 1000, () => upstream(key));
    return { ...r.value, cache: r.hit ? "hit" : "miss" };
  };

  const info = async <T>(body: unknown): Promise<T> => {
    const r = await infoRaw(body);
    try {
      return JSON.parse(r.body) as T;
    } catch {
      throw new HyperliquidError("Hyperliquid returned a body that is not JSON", r.status);
    }
  };

  return {
    url,
    infoRaw,
    info,
    allMids: () => info<HlAllMids>({ type: "allMids" }),
    metaAndAssetCtxs: () => info<HlMetaAndCtxs>({ type: "metaAndAssetCtxs" }),
    clearinghouseState: (user) => info<HlClearinghouseState>({ type: "clearinghouseState", user }),
    spotClearinghouseState: (user) => info<HlSpotState>({ type: "spotClearinghouseState", user }),
    candleSnapshot: (coin, interval, startTime, endTime) =>
      info<HlCandle[]>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }),
    recentTrades: (coin) => info<HlTrade[]>({ type: "recentTrades", coin }),
  };
}

import { liqPrice } from "@mutexa/liq-math";
import { describe, expect, it } from "vitest";
import {
  createHyperliquidAdapter,
  createHyperliquidClient,
  fundingApr,
  fundingPerDay,
  HyperliquidError,
  toMarkets,
  type HlClearinghouseState,
  type HlMetaAndCtxs,
} from "../src/index";
import { fixtureFetch } from "../src/conformance/index";
import { hl, hlFetch, hlResponse, HL_TOLERANCE } from "./helpers/fixtures";

const [A1, A2, A3, A4] = hl.accounts as [string, string, string, string];
const meta = hlResponse<HlMetaAndCtxs>("metaAndAssetCtxs");

describe("hyperliquid client", () => {
  it("caches per request type and de-duplicates concurrent reads", async () => {
    const f = hlFetch();
    const c = createHyperliquidClient({ fetch: f });
    const [a, b] = await Promise.all([c.metaAndAssetCtxs(), c.metaAndAssetCtxs()]);
    expect(a).toEqual(b);
    await c.metaAndAssetCtxs();
    expect(f.calls).toHaveLength(1);
    expect((await c.infoRaw({ type: "metaAndAssetCtxs" })).cache).toBe("hit");
  });

  it("sends the normalised request, so different spellings share a cache entry", async () => {
    const f = hlFetch();
    const c = createHyperliquidClient({ fetch: f });
    await c.clearinghouseState(A1.toUpperCase().replace("0X", "0x"));
    await c.clearinghouseState(A1);
    expect(f.calls).toEqual([{ type: "clearinghouseState", user: A1 }]);
  });

  it("can run without a cache", async () => {
    const f = hlFetch();
    const c = createHyperliquidClient({ fetch: f, cache: false });
    await c.allMids();
    expect((await c.infoRaw({ type: "allMids" })).cache).toBe("off");
    expect(f.calls).toHaveLength(2);
  });

  it("rejects invalid requests before any network call", async () => {
    const f = hlFetch();
    const c = createHyperliquidClient({ fetch: f });
    await expect(c.info({ type: "userFills", user: A1 })).rejects.toMatchObject({
      name: "HyperliquidError",
      status: 400,
    });
    await expect(c.clearinghouseState("0xnope")).rejects.toThrow("user must be a 0x address");
    expect(f.calls).toHaveLength(0);
  });

  it("maps upstream failures to HyperliquidError", async () => {
    const c = createHyperliquidClient({ fetch: fixtureFetch([]) });
    await expect(c.allMids()).rejects.toEqual(new HyperliquidError("Hyperliquid responded 404", 404));
    const down = createHyperliquidClient({ fetch: () => Promise.reject(new TypeError("fetch failed")) });
    await expect(down.allMids()).rejects.toThrow("Could not reach Hyperliquid: fetch failed");
  });
});

describe("markets", () => {
  const markets = toMarkets(meta);

  it("parses every recorded market, sorted by 24h volume", () => {
    expect(markets).toHaveLength(meta[0].universe.length);
    for (let i = 1; i < markets.length; i++)
      expect(markets[i - 1]!.dayVolume).toBeGreaterThanOrEqual(markets[i]!.dayVolume);
  });

  it("resolves margin tables into tiers with a continuous maintenance deduction", () => {
    const btc = markets.find((m) => m.name === "BTC")!;
    const table = meta[0].marginTables!.find(([id]) => id === btc.asset.marginTableId)![1];
    expect(btc.tiers.map((t) => t.maxLeverage)).toEqual(table.marginTiers.map((t) => t.maxLeverage));
    const [t0, t1] = btc.tiers as [(typeof btc.tiers)[0], (typeof btc.tiers)[0]];
    // maintenance margin is the same on both sides of the tier boundary
    expect(t1.lowerBound * t0.l - t0.deduction).toBeCloseTo(t1.lowerBound * t1.l - t1.deduction, 6);
    const lit = markets.find((m) => m.name === "LIT")!;
    expect(lit.tiers).toHaveLength(1);
    expect(lit.tiers[0]!.maxLeverage).toBe(lit.maxLeverage);
  });

  it("drops delisted markets and markets without a mark", () => {
    const [m, ctxs] = structuredClone(meta);
    m.universe[0]!.isDelisted = true;
    ctxs[1]!.markPx = "0";
    expect(toMarkets([m, ctxs])).toHaveLength(m.universe.length - 2);
  });

  it("estimates funding from the hourly rate", () => {
    expect(fundingPerDay(1, 10_000, 0.0000125)).toBeCloseTo(3, 10);
    expect(fundingPerDay(-1, 10_000, 0.0000125)).toBeCloseTo(-3, 10);
    expect(fundingApr(0.0000125)).toBeCloseTo(0.1095, 10);
  });
});

describe("hyperliquid adapter", () => {
  const adapter = () => createHyperliquidAdapter({ fetch: hlFetch() });

  it("reports isolated positions with a computed liquidation price that matches the venue", async () => {
    let checked = 0;
    for (const a of [A1, A2, A3]) {
      const st = await adapter().account(a);
      const iso = st.positions.filter((p) => p.marginMode === "isolated");
      expect(iso.length).toBeGreaterThan(0);
      for (const p of iso) {
        expect(p.reportedLiq).not.toBeNull();
        expect(Math.abs(p.computedLiq! - p.reportedLiq!) / p.reportedLiq!).toBeLessThan(HL_TOLERANCE);
        checked++;
      }
    }
    expect(checked).toBe(3);
  });

  it("keeps the venue value for cross positions and null where there is none", async () => {
    const st = await adapter().account(A4);
    expect(st.venue).toBe("hyperliquid");
    expect(st.address).toBe(A4);
    expect(st.block).toBeNull();
    const raw = hlResponse<HlClearinghouseState>("clearinghouseState", A4);
    expect(st.positions).toHaveLength(raw.assetPositions.length);
    for (const p of st.positions) {
      expect(p.marginMode).toBe("cross");
      expect(p.computedLiq).toBeNull();
    }
    expect(st.positions.filter((p) => p.reportedLiq === null).length).toBe(
      raw.assetPositions.filter((p) => p.position.liquidationPx === null).length,
    );
  });

  it("maps signs, sizes and mark from the raw state", async () => {
    const st = await adapter().account(A1);
    const raw = hlResponse<HlClearinghouseState>("clearinghouseState", A1).assetPositions[0]!.position;
    const p = st.positions.find((x) => x.market === raw.coin)!;
    expect(p.side).toBe(Number(raw.szi) > 0 ? 1 : -1);
    expect(p.size).toBe(Math.abs(Number(raw.szi)));
    expect(p.markPx * p.size).toBeCloseTo(Number(raw.positionValue), 6);
    expect(p.margin).toBe(Number(raw.marginUsed));
  });

  it("returns markets and risk params", async () => {
    const a = adapter();
    const ms = await a.markets();
    expect(ms[0]).toMatchObject({ kind: "perp" });
    const rp = await a.riskParams("BTC");
    expect(rp).toMatchObject({ kind: "perp", market: "BTC" });
    await expect(a.riskParams("NOPE")).rejects.toThrow("Unknown market NOPE");
  });

  it("computes a fresh liquidation price with liq-math", async () => {
    const a = adapter();
    const rp = await a.riskParams("ETH");
    if (rp.kind !== "perp") throw new Error("expected perp");
    const input = { kind: "perp" as const, side: 1 as const, entry: 2000, size: 5, margin: 1000, tiers: rp.tiers };
    expect(a.liquidationPrice(input)).toBe(liqPrice(1, 2000, 5, 1000, rp.tiers));
    expect(() =>
      a.liquidationPrice({ kind: "loan", collateral: 1, debtUsd: 1, price: 1, liqThreshold: 0.8 }),
    ).toThrow();
  });

  it("reads spot balances and candles", async () => {
    const a = adapter();
    const spot = await a.spot(A1);
    expect(spot.length).toBeGreaterThan(0);
    expect(typeof spot[0]!.total).toBe("number");
    const cs = await a.candles(hl.candles.coin, hl.candles.interval, hl.candles.startTime, hl.candles.endTime);
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) expect(c.h).toBeGreaterThanOrEqual(c.l);
  });

  it("refuses a malformed address", async () => {
    await expect(adapter().account("0x123")).rejects.toThrow("address must be a 0x address");
  });
});

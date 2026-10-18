import { tiersFor, type Tier } from "@mutexa/liq-math";
import type { HlAssetCtx, HlMetaAndCtxs, HlUniverseAsset, MarginTable } from "./types";

/** One live perp market from `metaAndAssetCtxs`, with numbers parsed and margin tiers resolved. */
export type HlMarket = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  mark: number;
  oracle: number;
  mid: number | null;
  prevDay: number;
  /** Fractional change against the previous day's price. */
  change: number;
  dayVolume: number;
  /** Open interest in coins. */
  openInterest: number;
  openInterestUsd: number;
  /** Current hourly funding rate (Hyperliquid pays funding every hour). */
  fundingHourly: number;
  tiers: Tier[];
  asset: HlUniverseAsset;
  ctx: HlAssetCtx;
};

/** Margin tiers of one asset, from its margin table when it has one, otherwise one tier at max leverage. */
export function tiersOf(asset: HlUniverseAsset, tables: Map<number, MarginTable>): Tier[] {
  const table = asset.marginTableId !== undefined ? tables.get(asset.marginTableId) : undefined;
  return tiersFor(asset.maxLeverage, table?.marginTiers?.length ? table.marginTiers : undefined);
}

/** Live perp markets: delisted assets and assets without a mark price removed, sorted by 24h volume. */
export function toMarkets(data: HlMetaAndCtxs): HlMarket[] {
  const [meta, ctxs] = data;
  const tables = new Map<number, MarginTable>(meta.marginTables ?? []);
  const out: HlMarket[] = [];
  meta.universe.forEach((asset, i) => {
    const ctx = ctxs[i];
    if (!ctx || asset.isDelisted) return;
    const mark = Number(ctx.markPx);
    if (!(mark > 0)) return;
    const prevDay = Number(ctx.prevDayPx);
    const openInterest = Number(ctx.openInterest);
    out.push({
      name: asset.name,
      szDecimals: asset.szDecimals,
      maxLeverage: asset.maxLeverage,
      onlyIsolated: asset.onlyIsolated === true,
      mark,
      oracle: Number(ctx.oraclePx),
      mid: ctx.midPx === null ? null : Number(ctx.midPx),
      prevDay,
      change: prevDay > 0 ? mark / prevDay - 1 : 0,
      dayVolume: Number(ctx.dayNtlVlm),
      openInterest,
      openInterestUsd: openInterest * mark,
      fundingHourly: Number(ctx.funding),
      tiers: tiersOf(asset, tables),
      asset,
      ctx,
    });
  });
  out.sort((a, b) => b.dayVolume - a.dayVolume);
  return out;
}

/**
 * Estimated USD per day at the current hourly rate. Positive means the position pays, negative means it
 * receives (longs pay shorts when the rate is positive).
 */
export function fundingPerDay(side: 1 | -1, notional: number, hourlyRate: number): number {
  return side * hourlyRate * 24 * notional;
}

/** Hourly rate annualised without compounding. */
export function fundingApr(hourlyRate: number): number {
  return hourlyRate * 24 * 365;
}

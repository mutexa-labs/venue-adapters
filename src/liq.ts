import { liqPrice, loanStats } from "@mutexa/liq-math";
import type { PositionInput } from "./types";

/** Liquidation price for a fresh perp position or a single-collateral loan. NaN when inputs cannot produce one. */
export function computeLiquidationPrice(p: PositionInput): number {
  if (p.kind === "perp") return liqPrice(p.side, p.entry, p.size, p.margin, p.tiers);
  return loanStats(p.collateral, p.debtUsd, p.price, p.liqThreshold).liq;
}

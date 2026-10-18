import type { Side, Tier } from "@mutexa/liq-math";

export type { Side, Tier };

/** Any `fetch`-compatible function. Injected so tests, Workers and Node can each supply their own. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What a venue supports. Read by callers before they ask for something the venue cannot do. */
export type Capabilities = {
  isolated: boolean;
  cross: boolean;
  lending: boolean;
  orderBook: boolean;
  postOnly: boolean;
};

/** A tradable perp market or a lending reserve, in one shape. */
export type Market = {
  /** Venue-unique id: the coin name on Hyperliquid, the reserve symbol on Aave. */
  id: string;
  kind: "perp" | "lending";
  /** Mark price (perps) or oracle price (lending), in USD. */
  price: number;
  /** Venue-specific detail the generic shape does not cover. */
  raw: unknown;
};

/** Risk parameters that decide where a position or loan is liquidated. */
export type RiskParams =
  | { kind: "perp"; market: string; maxLeverage: number; tiers: Tier[]; szDecimals: number; onlyIsolated: boolean }
  | { kind: "lending"; market: string; ltv: number; liqThreshold: number; liqBonus: number };

/** One open position as the venue reports it, next to the value computed with `@mutexa/liq-math`. */
export type PerpPositionState = {
  kind: "perp";
  market: string;
  side: Side;
  /** Absolute size in coins. */
  size: number;
  entryPx: number;
  markPx: number;
  /** Position value in USD at mark. */
  value: number;
  leverage: number;
  marginMode: "isolated" | "cross";
  /** Margin allocated to the position (isolated margin for isolated positions). */
  margin: number;
  unrealizedPnl: number;
  /** Liquidation price the venue reports, or null when the venue reports none. */
  reportedLiq: number | null;
  /**
   * Liquidation price computed from the position's own state. Null where the computation does not apply
   * (cross margin depends on the whole account, so only the venue's value is shown).
   */
  computedLiq: number | null;
};

/** Account-level lending state: the venue's health factor next to the one recomputed from reserve data. */
export type LendingAccountState = {
  kind: "lending";
  collateralUsd: number;
  debtUsd: number;
  reportedHealthFactor: number | null;
  computedHealthFactor: number | null;
  reserves: {
    market: string;
    collateral: number;
    collateralUsd: number;
    debt: number;
    debtUsd: number;
    usedAsCollateral: boolean;
  }[];
};

export type AccountState = {
  venue: string;
  address: string;
  /** Venue timestamp or block time of the read, in ms. */
  time: number;
  /** Block number for on-chain venues, null for off-chain ones. */
  block: number | null;
  positions: PerpPositionState[];
  lending: LendingAccountState | null;
};

/** Inputs for a fresh liquidation price, computed without any I/O. */
export type PositionInput =
  | { kind: "perp"; side: Side; entry: number; size: number; margin: number; tiers: Tier[] }
  | { kind: "loan"; collateral: number; debtUsd: number; price: number; liqThreshold: number };

/**
 * The interface every venue implements. All methods are reads. Write methods (`placeOrder`, `addMargin`, …)
 * are reserved names and are not part of this release.
 */
export interface VenueAdapter {
  /** Stable id, for example "hyperliquid" or "aave-v3-ethereum". */
  readonly id: string;
  readonly capabilities: Capabilities;
  markets(): Promise<Market[]>;
  /** Tiers for perps, LTV and liquidation threshold for lending. */
  riskParams(market: string): Promise<RiskParams>;
  /** Positions with the venue-reported liquidation price next to the computed one. */
  account(address: string): Promise<AccountState>;
  /** Liquidation price for a fresh position or loan, computed with `@mutexa/liq-math`. */
  liquidationPrice(p: PositionInput): number;
}

import { liqPriceFromState } from "@mutexa/liq-math";
import { computeLiquidationPrice } from "../liq";
import type {
  AccountState,
  Capabilities,
  Market,
  PerpPositionState,
  PositionInput,
  RiskParams,
  VenueAdapter,
} from "../types";
import {
  ADDRESS_RE,
  createHyperliquidClient,
  HyperliquidError,
  type CandleInterval,
  type HyperliquidClient,
  type HyperliquidClientOptions,
} from "./client";
import { toMarkets, type HlMarket } from "./markets";
import type { HlAllMids, HlAssetPosition, HlClearinghouseState } from "./types";

export const HYPERLIQUID_CAPABILITIES: Capabilities = {
  isolated: true,
  cross: true,
  lending: false,
  orderBook: true,
  postOnly: true,
};

export type SpotBalance = { coin: string; token: number; total: number; hold: number; entryNtl: number };
export type Candle = { t: number; T: number; o: number; h: number; l: number; c: number; v: number; n: number };

export type HyperliquidAdapter = VenueAdapter & {
  readonly client: HyperliquidClient;
  /** Perp markets with tiers, funding and open interest. */
  perpMarkets(): Promise<HlMarket[]>;
  mids(): Promise<HlAllMids>;
  /** Raw public account state, as Hyperliquid returns it. */
  state(address: string): Promise<HlClearinghouseState>;
  spot(address: string): Promise<SpotBalance[]>;
  candles(coin: string, interval: CandleInterval, startTime: number, endTime?: number): Promise<Candle[]>;
};

/**
 * Maps one Hyperliquid position. The computed liquidation price uses the position's own state:
 * mark = positionValue / |szi| and isolated margin = marginUsed, in Hyperliquid's documented formula.
 * Cross positions share the account's margin, so only the venue's value is reported for them.
 */
export function toPositionState(p: HlAssetPosition["position"], market: HlMarket | undefined): PerpPositionState {
  const szi = Number(p.szi);
  const side = szi > 0 ? 1 : -1;
  const size = Math.abs(szi);
  const value = Number(p.positionValue);
  const markPx = size > 0 ? value / size : NaN;
  const margin = Number(p.marginUsed);
  const reported = p.liquidationPx === null ? null : Number(p.liquidationPx);
  const marginMode = p.leverage.type === "isolated" ? "isolated" : "cross";
  let computedLiq: number | null = null;
  if (marginMode === "isolated" && market && size > 0) {
    const c = liqPriceFromState(side, markPx, size, margin, market.tiers);
    computedLiq = Number.isFinite(c) && c > 0 ? c : null;
  }
  return {
    kind: "perp",
    market: p.coin,
    side,
    size,
    entryPx: Number(p.entryPx),
    markPx,
    value,
    leverage: p.leverage.value,
    marginMode,
    margin,
    unrealizedPnl: Number(p.unrealizedPnl),
    reportedLiq: reported !== null && Number.isFinite(reported) && reported > 0 ? reported : null,
    computedLiq,
  };
}

export type HyperliquidAdapterOptions = HyperliquidClientOptions & { client?: HyperliquidClient };

export function createHyperliquidAdapter(opts: HyperliquidAdapterOptions = {}): HyperliquidAdapter {
  const client = opts.client ?? createHyperliquidClient(opts);
  const checkAddress = (address: string) => {
    if (!ADDRESS_RE.test(address)) throw new HyperliquidError("address must be a 0x address", 400);
    return address.toLowerCase();
  };
  const perpMarkets = async () => toMarkets(await client.metaAndAssetCtxs());

  return {
    id: "hyperliquid",
    capabilities: HYPERLIQUID_CAPABILITIES,
    client,
    perpMarkets,
    async markets(): Promise<Market[]> {
      return (await perpMarkets()).map((m) => ({ id: m.name, kind: "perp", price: m.mark, raw: m }));
    },
    async riskParams(coin: string): Promise<RiskParams> {
      const m = (await perpMarkets()).find((x) => x.name === coin);
      if (!m) throw new HyperliquidError(`Unknown market ${coin}`, 404);
      return {
        kind: "perp",
        market: m.name,
        maxLeverage: m.maxLeverage,
        tiers: m.tiers,
        szDecimals: m.szDecimals,
        onlyIsolated: m.onlyIsolated,
      };
    },
    async account(address: string): Promise<AccountState> {
      const user = checkAddress(address);
      const [st, markets] = await Promise.all([client.clearinghouseState(user), perpMarkets()]);
      const byName = new Map(markets.map((m) => [m.name, m]));
      const positions = st.assetPositions
        .filter((p) => Number(p.position.szi) !== 0)
        .map((p) => toPositionState(p.position, byName.get(p.position.coin)));
      return { venue: "hyperliquid", address: user, time: st.time, block: null, positions, lending: null };
    },
    liquidationPrice(p: PositionInput): number {
      if (p.kind !== "perp") throw new HyperliquidError("Hyperliquid positions are perps", 400);
      return computeLiquidationPrice(p);
    },
    mids: () => client.allMids(),
    state: (address) => client.clearinghouseState(checkAddress(address)),
    async spot(address: string): Promise<SpotBalance[]> {
      const st = await client.spotClearinghouseState(checkAddress(address));
      return st.balances.map((b) => ({
        coin: b.coin,
        token: b.token,
        total: Number(b.total),
        hold: Number(b.hold),
        entryNtl: Number(b.entryNtl),
      }));
    },
    async candles(coin, interval, startTime, endTime) {
      const cs = await client.candleSnapshot(coin, interval, startTime, endTime);
      return cs.map((c) => ({
        t: c.t,
        T: c.T,
        o: Number(c.o),
        h: Number(c.h),
        l: Number(c.l),
        c: Number(c.c),
        v: Number(c.v),
        n: c.n,
      }));
    },
  };
}

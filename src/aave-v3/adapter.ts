import { createPublicClient, fallback, getAddress, http, type Address } from "viem";
import { createCache, type Memo } from "../cache";
import { computeLiquidationPrice } from "../liq";
import type { AccountState, Capabilities, Market, PositionInput, RiskParams, VenueAdapter } from "../types";
import { AAVE_V3_ETHEREUM, type AaveMarket, type AaveSnapshot } from "./markets";
import {
  AaveError,
  aaveSnapshot,
  aaveUserAccount,
  healthFactorOf,
  type AaveClient,
  type UserAccount,
} from "./snapshot";

export const AAVE_V3_CAPABILITIES: Capabilities = {
  isolated: false,
  cross: false,
  lending: true,
  orderBook: false,
  postOnly: false,
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export type AaveV3AdapterOptions = {
  /** A viem client for the market's chain. Give this or `rpcUrls`. */
  client?: AaveClient;
  /** RPC endpoints, tried in order. There is no built-in default: pick the endpoints you trust. */
  rpcUrls?: string[];
  market?: AaveMarket;
  /** How long a reserve snapshot is reused, in ms. */
  ttlMs?: number;
  /** Pin every read to this block (tests, audits). */
  blockNumber?: bigint;
  cache?: Memo | false;
  batchSize?: number;
};

export type AaveV3Adapter = VenueAdapter & {
  readonly market: AaveMarket;
  /** All reserves at one block, cached for `ttlMs`. */
  snapshot(): Promise<AaveSnapshot>;
  /** The Pool's own account totals and every reserve position, at the snapshot's block. */
  userAccount(address: string): Promise<UserAccount>;
};

export function createAaveV3Adapter(opts: AaveV3AdapterOptions): AaveV3Adapter {
  const market = opts.market ?? AAVE_V3_ETHEREUM;
  let client = opts.client;
  if (!client) {
    if (!opts.rpcUrls?.length) throw new AaveError("Pass a viem client or at least one RPC URL");
    client = createPublicClient({
      transport: fallback(opts.rpcUrls.map((u) => http(u, { timeout: 8000, retryCount: 0 }))),
    });
  }
  const c = client;
  const ttlMs = opts.ttlMs ?? 60_000;
  const memo = opts.cache === false ? null : (opts.cache ?? createCache());
  const read = () => aaveSnapshot(c, market, { blockNumber: opts.blockNumber, batchSize: opts.batchSize });
  const snapshot = async () =>
    memo ? (await memo.cached(`aave:${market.id}:${opts.blockNumber ?? "latest"}`, ttlMs, read)).value : read();

  const userAccount = async (address: string) => {
    if (!ADDRESS_RE.test(address)) throw new AaveError("address must be a 0x address");
    return aaveUserAccount(c, market, await snapshot(), getAddress(address) as Address, { batchSize: opts.batchSize });
  };

  return {
    id: market.id,
    capabilities: AAVE_V3_CAPABILITIES,
    market,
    snapshot,
    userAccount,
    async markets(): Promise<Market[]> {
      const s = await snapshot();
      return s.reserves.map((r) => ({ id: r.symbol, kind: "lending", price: r.priceUsd, raw: r }));
    },
    async riskParams(symbol: string): Promise<RiskParams> {
      const r = (await snapshot()).reserves.find((x) => x.symbol === symbol);
      if (!r) throw new AaveError(`Unknown reserve ${symbol}`);
      return { kind: "lending", market: r.symbol, ltv: r.ltv, liqThreshold: r.liqThreshold, liqBonus: r.liqBonus };
    },
    async account(address: string): Promise<AccountState> {
      const u = await userAccount(address);
      const s = await snapshot();
      return {
        venue: market.id,
        address: address.toLowerCase(),
        time: s.blockTime,
        block: u.block,
        positions: [],
        lending: {
          kind: "lending",
          collateralUsd: u.totalCollateralUsd,
          debtUsd: u.totalDebtUsd,
          reportedHealthFactor: u.healthFactor,
          // E-Mode changes thresholds per category; only standard mode is recomputed here
          computedHealthFactor: u.eMode === 0 ? healthFactorOf(u.reserves) : null,
          reserves: u.reserves.map((r) => ({
            market: r.symbol,
            collateral: r.collateral,
            collateralUsd: r.collateralUsd,
            debt: r.debt,
            debtUsd: r.debtUsd,
            usedAsCollateral: r.usedAsCollateral,
          })),
        },
      };
    },
    liquidationPrice(p: PositionInput): number {
      if (p.kind !== "loan") throw new AaveError("Aave positions are loans");
      return computeLiquidationPrice(p);
    },
  };
}

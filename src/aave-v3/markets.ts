// Aave V3 market addresses and the reserve shape this package reports.
//
// Ethereum mainnet addresses, checked on-chain on 2026-10-18:
//   Pool                  0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
//   PoolAddressesProvider 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e  (Pool.ADDRESSES_PROVIDER(); getPool() returns
//                                                                     the Pool above)
// The data provider and the oracle are not listed here on purpose: they are resolved from the
// PoolAddressesProvider on every snapshot, at the snapshot's block.

export type AaveMarket = {
  /** Stable id used as the adapter id, for example "aave-v3-ethereum". */
  id: string;
  chainId: number;
  /** The Pool the snapshot must find behind the provider, or it refuses to report. */
  pool: `0x${string}`;
  addressesProvider: `0x${string}`;
  /** Multicall3 on that chain, used to read everything at one block. */
  multicall3: `0x${string}`;
};

export const AAVE_V3_ETHEREUM: AaveMarket = {
  id: "aave-v3-ethereum",
  chainId: 1,
  pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  addressesProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

export type AaveReserve = {
  symbol: string;
  address: string;
  decimals: number;
  /** 0..1, max loan-to-value for new borrows. */
  ltv: number;
  /** 0..1. */
  liqThreshold: number;
  /** For example 0.05 for a 5% bonus. */
  liqBonus: number;
  usageAsCollateral: boolean;
  borrowingEnabled: boolean;
  active: boolean;
  frozen: boolean;
  paused: boolean;
  /** AaveOracle price in the market's base currency (USD on Ethereum). */
  priceUsd: number;
};

export type AaveSnapshot = {
  market: string;
  chainId: number;
  pool: string;
  addressesProvider: string;
  dataProvider: string;
  oracle: string;
  marketId: string;
  block: number;
  /** Block timestamp in ms. */
  blockTime: number;
  /** Oracle BASE_CURRENCY_UNIT (1e8 for USD on Ethereum): prices and Pool totals are divided by it. */
  baseCurrencyUnit: number;
  reserves: AaveReserve[];
};

/** Can back a new loan: LTV above zero, collateral enabled, active, not frozen or paused, priced. */
export const isCollateral = (r: AaveReserve) =>
  r.ltv > 0 && r.usageAsCollateral && r.active && !r.frozen && !r.paused && r.priceUsd > 0;

/** Can be borrowed now. */
export const isBorrowable = (r: AaveReserve) =>
  r.borrowingEnabled && r.active && !r.frozen && !r.paused && r.priceUsd > 0;

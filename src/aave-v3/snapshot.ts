import { getAddress, type Address, type PublicClient } from "viem";
import { dataProviderAbi, oracleAbi, poolAbi, providerAbi } from "./abi";
import type { AaveMarket, AaveReserve, AaveSnapshot } from "./markets";

/** The viem client methods this module uses. Any `PublicClient` satisfies it. */
export type AaveClient = Pick<PublicClient, "getBlockNumber" | "getBlock" | "multicall">;

/** Thrown when the market cannot be read safely; the message is safe to show as-is. */
export class AaveError extends Error {
  override name = "AaveError";
}

export type SnapshotOptions = {
  /** Pin the read to this block. The latest block is used when omitted. */
  blockNumber?: bigint;
  /** Largest multicall calldata chunk in bytes. */
  batchSize?: number;
};

const MAX_RESERVES = 200;

/**
 * Reads every reserve's risk parameters and oracle price at one block. The data provider and oracle are
 * resolved from the PoolAddressesProvider at that block, and nothing is reported if the provider's `getPool()`
 * no longer returns the market's pinned Pool.
 */
export async function aaveSnapshot(
  client: AaveClient,
  market: AaveMarket,
  opts: SnapshotOptions = {},
): Promise<AaveSnapshot> {
  const blockNumber = opts.blockNumber ?? (await client.getBlockNumber());
  const mc = {
    blockNumber,
    allowFailure: false as const,
    multicallAddress: market.multicall3,
    batchSize: opts.batchSize ?? 16_384,
  };
  const provider = market.addressesProvider;

  const [pool, oracle, dataProvider, marketId] = await client.multicall({
    ...mc,
    contracts: [
      { address: provider, abi: providerAbi, functionName: "getPool" },
      { address: provider, abi: providerAbi, functionName: "getPriceOracle" },
      { address: provider, abi: providerAbi, functionName: "getPoolDataProvider" },
      { address: provider, abi: providerAbi, functionName: "getMarketId" },
    ],
  });
  if (getAddress(pool) !== getAddress(market.pool))
    throw new AaveError(`PoolAddressesProvider returned an unexpected pool ${pool}; refusing to report`);

  const [tokens, unit, block] = await Promise.all([
    client
      .multicall({
        ...mc,
        contracts: [{ address: dataProvider, abi: dataProviderAbi, functionName: "getAllReservesTokens" }],
      })
      .then(([t]) => t),
    client
      .multicall({ ...mc, contracts: [{ address: oracle, abi: oracleAbi, functionName: "BASE_CURRENCY_UNIT" }] })
      .then(([u]) => u),
    client.getBlock({ blockNumber }),
  ]);
  if (!tokens.length || tokens.length > MAX_RESERVES) throw new AaveError("Unexpected reserve list");
  const assets = tokens.map((t) => t.tokenAddress as Address);

  const configs = await client.multicall({
    ...mc,
    contracts: assets.map(
      (a) =>
        ({
          address: dataProvider,
          abi: dataProviderAbi,
          functionName: "getReserveConfigurationData",
          args: [a],
        }) as const,
    ),
  });
  const paused = await client.multicall({
    ...mc,
    contracts: assets.map(
      (a) => ({ address: dataProvider, abi: dataProviderAbi, functionName: "getPaused", args: [a] }) as const,
    ),
  });
  const [prices] = await client.multicall({
    ...mc,
    contracts: [{ address: oracle, abi: oracleAbi, functionName: "getAssetsPrices", args: [assets] }],
  });
  if (prices.length !== assets.length) throw new AaveError("Oracle returned the wrong number of prices");

  const reserves: AaveReserve[] = tokens.map((t, i) => {
    const c = configs[i]!;
    return {
      symbol: t.symbol,
      address: getAddress(t.tokenAddress),
      decimals: Number(c[0]),
      ltv: Number(c[1]) / 1e4,
      liqThreshold: Number(c[2]) / 1e4,
      liqBonus: Number(c[3]) > 0 ? Number(c[3]) / 1e4 - 1 : 0,
      usageAsCollateral: c[5],
      borrowingEnabled: c[6],
      active: c[8],
      frozen: c[9],
      paused: paused[i]!,
      priceUsd: Number(prices[i]!) / Number(unit),
    };
  });

  return {
    market: market.id,
    chainId: market.chainId,
    pool: getAddress(pool),
    addressesProvider: getAddress(provider),
    dataProvider: getAddress(dataProvider),
    oracle: getAddress(oracle),
    marketId,
    block: Number(blockNumber),
    blockTime: Number(block.timestamp) * 1000,
    baseCurrencyUnit: Number(unit),
    reserves,
  };
}

export type UserReserve = {
  symbol: string;
  address: string;
  collateral: number;
  collateralUsd: number;
  debt: number;
  debtUsd: number;
  usedAsCollateral: boolean;
  liqThreshold: number;
};

export type UserAccount = {
  block: number;
  /** Pool.getUserAccountData, in the base currency (USD). */
  totalCollateralUsd: number;
  totalDebtUsd: number;
  /** Weighted average liquidation threshold, 0..1. */
  liqThreshold: number;
  /** Null when the account has no debt (the Pool reports the max uint). */
  healthFactor: number | null;
  /** E-Mode category; 0 means standard mode. */
  eMode: number;
  reserves: UserReserve[];
};

const WAD = 1e18;

/** Reads one account at the snapshot's block: the Pool's own totals and every non-empty reserve position. */
export async function aaveUserAccount(
  client: AaveClient,
  market: AaveMarket,
  snap: AaveSnapshot,
  user: Address,
  opts: Pick<SnapshotOptions, "batchSize"> = {},
): Promise<UserAccount> {
  const mc = {
    blockNumber: BigInt(snap.block),
    allowFailure: false as const,
    multicallAddress: market.multicall3,
    batchSize: opts.batchSize ?? 16_384,
  };
  const [data, eMode] = await client.multicall({
    ...mc,
    contracts: [
      { address: snap.pool as Address, abi: poolAbi, functionName: "getUserAccountData", args: [user] },
      { address: snap.pool as Address, abi: poolAbi, functionName: "getUserEMode", args: [user] },
    ],
  });
  const rows = await client.multicall({
    ...mc,
    contracts: snap.reserves.map(
      (r) =>
        ({
          address: snap.dataProvider as Address,
          abi: dataProviderAbi,
          functionName: "getUserReserveData",
          args: [r.address as Address, user],
        }) as const,
    ),
  });
  const reserves: UserReserve[] = [];
  snap.reserves.forEach((r, i) => {
    const u = rows[i]!;
    const scale = 10 ** r.decimals;
    const collateral = Number(u[0]) / scale;
    const debt = (Number(u[1]) + Number(u[2])) / scale;
    if (collateral === 0 && debt === 0) return;
    reserves.push({
      symbol: r.symbol,
      address: r.address,
      collateral,
      collateralUsd: collateral * r.priceUsd,
      debt,
      debtUsd: debt * r.priceUsd,
      usedAsCollateral: u[8],
      liqThreshold: r.liqThreshold,
    });
  });
  const debtBase = Number(data[1]);
  return {
    block: snap.block,
    totalCollateralUsd: Number(data[0]) / snap.baseCurrencyUnit,
    totalDebtUsd: debtBase / snap.baseCurrencyUnit,
    liqThreshold: Number(data[3]) / 1e4,
    healthFactor: debtBase > 0 ? Number(data[5]) / WAD : null,
    eMode: Number(eMode),
    reserves,
  };
}

/**
 * Standard-mode health factor from reserve positions: Σ collateral_usd · liquidationThreshold / Σ debt_usd.
 * Null when there is no debt.
 */
export function healthFactorOf(
  reserves: Pick<UserReserve, "collateralUsd" | "debtUsd" | "usedAsCollateral" | "liqThreshold">[],
): number | null {
  let weighted = 0;
  let debt = 0;
  for (const r of reserves) {
    if (r.usedAsCollateral) weighted += r.collateralUsd * r.liqThreshold;
    debt += r.debtUsd;
  }
  return debt > 0 ? weighted / debt : null;
}

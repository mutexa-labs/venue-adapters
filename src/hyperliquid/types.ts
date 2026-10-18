// Response shapes of the Hyperliquid public info API, limited to the fields this package reads.

export type MarginTier = { lowerBound: string; maxLeverage: number };
export type MarginTable = { description: string; marginTiers: MarginTier[] };

export type HlUniverseAsset = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  marginTableId?: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
  marginMode?: string;
};

export type HlAssetCtx = {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  markPx: string;
  midPx: string | null;
  oraclePx: string;
};

export type HlMetaAndCtxs = [{ universe: HlUniverseAsset[]; marginTables?: [number, MarginTable][] }, HlAssetCtx[]];

export type HlAllMids = Record<string, string>;

export type HlAssetPosition = {
  type: string;
  position: {
    coin: string;
    szi: string;
    leverage: { type: "isolated" | "cross"; value: number; rawUsd?: string };
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    returnOnEquity: string;
    liquidationPx: string | null;
    marginUsed: string;
    maxLeverage: number;
    cumFunding?: { allTime: string; sinceOpen: string; sinceChange: string };
  };
};

export type HlMarginSummary = {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
};

export type HlClearinghouseState = {
  marginSummary: HlMarginSummary;
  crossMarginSummary: HlMarginSummary;
  crossMaintenanceMarginUsed: string;
  withdrawable: string;
  assetPositions: HlAssetPosition[];
  time: number;
};

export type HlSpotBalance = { coin: string; token: number; total: string; hold: string; entryNtl: string };
export type HlSpotState = { balances: HlSpotBalance[] };

export type HlCandle = { t: number; T: number; o: string; c: string; h: string; l: string; v: string; n: number };

export type HlTrade = {
  coin: string;
  side: string;
  px: string;
  sz: string;
  time: number;
  hash: string;
  tid: number;
  users: [string, string];
};

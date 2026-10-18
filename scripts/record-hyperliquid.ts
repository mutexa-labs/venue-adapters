// Records Hyperliquid fixtures from the live public info API.
//
//   pnpm exec tsx scripts/record-hyperliquid.ts <address> [<address> ...]
//
// Addresses are given at run time and never written to disk: every account is stored under an obviously fake
// address (0x…a1, 0x…a2, …), positions are trimmed to MAX_POSITIONS per account (isolated first), and the market
// list is trimmed to the coins the recorded positions use plus a few reference markets.

import { mkdirSync, writeFileSync } from "node:fs";
import { HL_INFO_URL, validateHlRequest } from "../src/hyperliquid/client";
import type { HlAllMids, HlClearinghouseState, HlMetaAndCtxs, HlSpotState } from "../src/hyperliquid/types";

const addresses = (
  process.argv.slice(2).length ? process.argv.slice(2) : (process.env.RECORD_ADDRESSES ?? "").split(",")
)
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);
if (!addresses.length) {
  console.error("usage: tsx scripts/record-hyperliquid.ts <address> [<address> ...]");
  process.exit(1);
}
const MAX_POSITIONS = Number(process.env.MAX_POSITIONS ?? 6);
const fake = (i: number) => `0x${(0xa1 + i).toString(16).padStart(40, "0")}`;

async function info<T>(body: unknown): Promise<{ request: unknown; response: T }> {
  const v = validateHlRequest(body);
  if (!v.ok) throw new Error(v.error);
  const r = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(v.req),
  });
  if (!r.ok) throw new Error(`${JSON.stringify(body)} -> ${r.status}`);
  return { request: v.req, response: (await r.json()) as T };
}

const recordedAt = new Date().toISOString();
const meta = await info<HlMetaAndCtxs>({ type: "metaAndAssetCtxs" });
const mids = await info<HlAllMids>({ type: "allMids" });

const rank = (p: HlClearinghouseState["assetPositions"][number]) =>
  p.position.leverage.type === "isolated" ? 0 : p.position.liquidationPx ? 1 : 2;

const accounts: { request: unknown; response: HlClearinghouseState }[] = [];
for (const [i, a] of addresses.entries()) {
  const st = await info<HlClearinghouseState>({ type: "clearinghouseState", user: a });
  const kept = [...st.response.assetPositions].sort((x, y) => rank(x) - rank(y)).slice(0, MAX_POSITIONS);
  accounts.push({
    request: { type: "clearinghouseState", user: fake(i) },
    response: { ...st.response, assetPositions: kept },
  });
}
const spot = await info<HlSpotState>({ type: "spotClearinghouseState", user: addresses[0] });
const spotTrimmed = {
  ...spot.response,
  balances: spot.response.balances.filter((b) => Number(b.total) !== 0).slice(0, 6),
};

const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const candleReq = { coin: "BTC", interval: "1h" as const, startTime: now - 24 * 3_600_000, endTime: now };
const candles = await info<unknown[]>({ type: "candleSnapshot", req: candleReq });

// trim the market list, keeping universe and contexts aligned
const [m, ctxs] = meta.response;
const coins = new Set([
  "BTC",
  "ETH",
  ...accounts.flatMap((x) => x.response.assetPositions.map((p) => p.position.coin)),
]);
const tiered = m.universe.find(
  (u) =>
    u.marginTableId !== undefined &&
    (m.marginTables ?? []).some(([id, t]) => id === u.marginTableId && t.marginTiers.length > 1),
);
if (tiered) coins.add(tiered.name);
const keep = m.universe.map((u, i) => (coins.has(u.name) ? i : -1)).filter((i) => i >= 0);
const universe = keep.map((i) => m.universe[i]!);
const tableIds = new Set(universe.map((u) => u.marginTableId).filter((x) => x !== undefined));
const trimmedMeta: HlMetaAndCtxs = [
  { universe, marginTables: (m.marginTables ?? []).filter(([id]) => tableIds.has(id)) },
  keep.map((i) => ctxs[i]!),
];
const trimmedMids = Object.fromEntries(Object.entries(mids.response).filter(([k]) => coins.has(k)));

let out = JSON.stringify(
  {
    recordedAt,
    recordedWith: "scripts/record-hyperliquid.ts",
    note: "Public Hyperliquid responses, trimmed. Account addresses are fake; positions are real values read at recordedAt.",
    accounts: accounts.map((_, i) => fake(i)),
    candles: candleReq,
    exchanges: [
      { request: meta.request, response: trimmedMeta },
      { request: mids.request, response: trimmedMids },
      ...accounts,
      { request: { type: "spotClearinghouseState", user: fake(0) }, response: spotTrimmed },
      { request: { type: "candleSnapshot", req: candleReq }, response: candles.response },
    ],
  },
  null,
  1,
);
for (const [i, a] of addresses.entries()) out = out.split(a.slice(2)).join(fake(i).slice(2));
mkdirSync("fixtures/hyperliquid", { recursive: true });
writeFileSync("fixtures/hyperliquid/recorded.json", out + "\n");
console.error(`wrote fixtures/hyperliquid/recorded.json (${accounts.length} accounts, ${universe.length} markets)`);

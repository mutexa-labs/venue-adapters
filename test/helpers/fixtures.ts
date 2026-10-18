import { readFileSync } from "node:fs";
import { createPublicClient, custom } from "viem";
import { fixtureFetch, fixtureRpc, type HttpExchange, type RpcExchange } from "../../src/conformance/index";

const read = <T>(p: string) => JSON.parse(readFileSync(new URL(`../../fixtures/${p}`, import.meta.url), "utf8")) as T;

export type HlRecording = {
  recordedAt: string;
  accounts: string[];
  candles: { coin: string; interval: "1h"; startTime: number; endTime: number };
  exchanges: HttpExchange[];
};
export type AaveRecording = { recordedAt: string; block: number; accounts: string[]; exchanges: RpcExchange[] };

export const hl = read<HlRecording>("hyperliquid/recorded.json");
export const aave = read<AaveRecording>("aave-v3/recorded.json");

export const hlFetch = () => fixtureFetch(hl.exchanges);

export function aaveClient() {
  const rpc = fixtureRpc(aave.exchanges);
  return { client: createPublicClient({ transport: custom(rpc) }), rpc };
}

/** Recorded response for one request type (and user, when given). */
export function hlResponse<T>(type: string, user?: string): T {
  const x = hl.exchanges.find(
    (e) => (e.request as { type: string }).type === type && (!user || (e.request as { user?: string }).user === user),
  );
  if (!x) throw new Error(`no recorded ${type}`);
  return x.response as T;
}

/**
 * Largest relative difference the venue's own rounding allows. Hyperliquid reports liquidationPx with about ten
 * significant digits, so a correct formula lands within 1e-9 of it; 1e-8 leaves a margin for float error.
 */
export const HL_TOLERANCE = 1e-8;

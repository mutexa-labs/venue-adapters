// Live smoke test against the public APIs. Skipped unless LIVE=1; never part of CI.
//   LIVE=1 ETH_RPC=<url> pnpm test:live
import { describe, expect, it } from "vitest";
import { createHyperliquidAdapter } from "../src/index";
import { createAaveV3Adapter } from "../src/aave-v3/index";

const live = process.env.LIVE === "1";

describe.skipIf(!live)("live", () => {
  it("reads Hyperliquid markets", async () => {
    const ms = await createHyperliquidAdapter().perpMarkets();
    expect(ms.find((m) => m.name === "BTC")?.mark).toBeGreaterThan(0);
  });

  it.skipIf(!process.env.ETH_RPC)("reads an Aave V3 snapshot", async () => {
    const s = await createAaveV3Adapter({ rpcUrls: [process.env.ETH_RPC!] }).snapshot();
    expect(s.reserves.length).toBeGreaterThan(0);
  });
});

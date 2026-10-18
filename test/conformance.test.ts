import { describe, expect, it } from "vitest";
import { createHyperliquidAdapter, type VenueAdapter } from "../src/index";
import { createAaveV3Adapter } from "../src/aave-v3/index";
import { assertConformance, runConformance } from "../src/conformance/index";
import { aave, aaveClient, hl, hlFetch, HL_TOLERANCE } from "./helpers/fixtures";

describe("conformance kit", () => {
  it("passes for the Hyperliquid adapter on recorded accounts", async () => {
    const r = await runConformance(createHyperliquidAdapter({ fetch: hlFetch() }), {
      addresses: hl.accounts,
      tolerance: { relative: HL_TOLERANCE },
      minChecks: 3,
    });
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.checks).toHaveLength(3);
    expect(r.skipped.some((s) => s.reason.includes("cross"))).toBe(true);
    expect(r.skipped.some((s) => s.reason.includes("no liquidation price"))).toBe(true);
    assertConformance(r);
  });

  it("passes for the Aave V3 adapter on recorded accounts", async () => {
    const r = await runConformance(
      createAaveV3Adapter({ client: aaveClient().client, blockNumber: BigInt(aave.block) }),
      {
        addresses: aave.accounts,
        tolerance: { relative: 1e-9 },
        minChecks: aave.accounts.length,
      },
    );
    expect(r.failures).toEqual([]);
    expect(r.checks.every((c) => c.kind === "healthFactor")).toBe(true);
  });

  it("fails an adapter whose liquidation prices disagree with its venue", async () => {
    const good = createHyperliquidAdapter({ fetch: hlFetch() });
    const bad: VenueAdapter = {
      ...good,
      async account(a) {
        const st = await good.account(a);
        return {
          ...st,
          positions: st.positions.map((p) => ({ ...p, computedLiq: p.computedLiq && p.computedLiq * 1.01 })),
        };
      },
    };
    const r = await runConformance(bad, { addresses: hl.accounts, tolerance: { relative: HL_TOLERANCE } });
    expect(r.passed).toBe(false);
    expect(r.failures).toHaveLength(3);
    expect(() => assertConformance(r)).toThrow(/failed conformance/);
  });

  it("fails an adapter that breaks the interface or reads nothing", async () => {
    const empty: VenueAdapter = {
      id: "",
      capabilities: { isolated: true, cross: false, lending: false, orderBook: false } as never,
      markets: async () => [],
      riskParams: async () => Promise.reject(new Error("none")),
      account: async () => Promise.reject(new Error("down")),
      liquidationPrice: () => NaN,
    };
    const r = await runConformance(empty, {
      addresses: ["0x00000000000000000000000000000000000000a1"],
      tolerance: { relative: 0 },
    });
    expect(r.failures).toEqual([
      "id must be a non-empty string",
      "capabilities.postOnly must be a boolean",
      "markets() returned no markets",
      "account(0x00000000000000000000000000000000000000a1) threw: down",
      "only 0 value checks ran, expected at least 1",
    ]);
  });
});

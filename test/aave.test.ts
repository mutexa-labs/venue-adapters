import { loanStats } from "@mutexa/liq-math";
import { describe, expect, it } from "vitest";
import {
  AAVE_V3_ETHEREUM,
  aaveSnapshot,
  createAaveV3Adapter,
  healthFactorOf,
  isBorrowable,
  isCollateral,
} from "../src/aave-v3/index";
import { aave, aaveClient } from "./helpers/fixtures";

const block = BigInt(aave.block);
const adapter = () => createAaveV3Adapter({ client: aaveClient().client, blockNumber: block });

/**
 * The Pool computes the health factor in fixed point (wad and percentage math) from scaled balances; this package
 * recomputes it in float64 from the data provider's balances. On the recorded accounts they agree to within
 * about 1e-11 relative; 1e-9 leaves a margin for other balances.
 */
const HF_TOLERANCE = 1e-9;

describe("aave v3 snapshot", () => {
  it("reads every reserve at one block, with provider-resolved data provider and oracle", async () => {
    const s = await aaveSnapshot(aaveClient().client, AAVE_V3_ETHEREUM, { blockNumber: block });
    expect(s.block).toBe(aave.block);
    expect(s.pool).toBe(AAVE_V3_ETHEREUM.pool);
    expect(s.marketId).toBe("Aave Ethereum Market");
    expect(s.dataProvider).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(s.oracle).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(s.reserves.length).toBeGreaterThan(10);
    for (const r of s.reserves) {
      expect(r.liqThreshold).toBeGreaterThanOrEqual(r.ltv);
      expect(r.liqThreshold).toBeLessThan(1);
    }
    expect(s.reserves.some(isCollateral)).toBe(true);
    expect(s.reserves.some(isBorrowable)).toBe(true);
  });

  it("refuses to report when the provider no longer returns the pinned pool", async () => {
    const wrong = { ...AAVE_V3_ETHEREUM, pool: "0x000000000000000000000000000000000000dEaD" as const };
    await expect(aaveSnapshot(aaveClient().client, wrong, { blockNumber: block })).rejects.toThrow(/unexpected pool/);
  });

  it("never calls the RPC beyond the recorded calls", async () => {
    const { client, rpc } = aaveClient();
    await createAaveV3Adapter({ client, blockNumber: block }).snapshot();
    expect(rpc.calls.every((m) => m === "eth_call" || m === "eth_getBlockByNumber")).toBe(true);
  });

  it("needs a client or an RPC URL", () => {
    expect(() => createAaveV3Adapter({})).toThrow(/RPC URL/);
  });
});

describe("aave v3 adapter", () => {
  it("recomputes each account's health factor within tolerance of the Pool's", async () => {
    for (const a of aave.accounts) {
      const st = await adapter().account(a);
      const l = st.lending!;
      expect(st.block).toBe(aave.block);
      expect(l.reportedHealthFactor).not.toBeNull();
      expect(Math.abs(l.computedHealthFactor! - l.reportedHealthFactor!) / l.reportedHealthFactor!).toBeLessThan(
        HF_TOLERANCE,
      );
      expect(l.collateralUsd).toBeGreaterThan(l.debtUsd);
    }
  });

  it("gives the liquidation price of a single-collateral, single-debt loan", async () => {
    const a = adapter();
    const u = await a.userAccount(aave.accounts[0]!);
    const coll = u.reserves.filter((r) => r.collateral > 0 && r.usedAsCollateral);
    const debt = u.reserves.filter((r) => r.debt > 0);
    expect(coll).toHaveLength(1);
    expect(debt).toHaveLength(1);
    const c = coll[0]!;
    const price = c.collateralUsd / c.collateral;
    const liq = a.liquidationPrice({
      kind: "loan",
      collateral: c.collateral,
      debtUsd: debt[0]!.debtUsd,
      price,
      liqThreshold: c.liqThreshold,
    });
    expect(liq).toBe(loanStats(c.collateral, debt[0]!.debtUsd, price, c.liqThreshold).liq);
    // at the liquidation price the health factor is exactly 1
    expect(
      healthFactorOf([
        { ...c, collateralUsd: c.collateral * liq },
        { ...debt[0]!, usedAsCollateral: false, collateralUsd: 0 },
      ]),
    ).toBeCloseTo(1, 9);
  });

  it("returns reserves as markets and their risk params", async () => {
    const a = adapter();
    const ms = await a.markets();
    expect(ms.every((m) => m.kind === "lending")).toBe(true);
    const weth = await a.riskParams("WETH");
    expect(weth).toMatchObject({ kind: "lending", market: "WETH" });
    await expect(a.riskParams("NOPE")).rejects.toThrow("Unknown reserve NOPE");
  });

  it("validates addresses and position kinds", async () => {
    const a = adapter();
    await expect(a.account("0x12")).rejects.toThrow("address must be a 0x address");
    expect(() => a.liquidationPrice({ kind: "perp", side: 1, entry: 1, size: 1, margin: 1, tiers: [] })).toThrow();
  });
});

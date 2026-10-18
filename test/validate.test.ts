import { describe, expect, it } from "vitest";
import { HL_ALLOWED, HL_CACHE_TTL, validateHlRequest } from "../src/index";

const A = "0x00000000000000000000000000000000000000A1";

describe("validateHlRequest", () => {
  const cases: [string, unknown, string | Record<string, unknown>][] = [
    ["null body", null, "Body must be a JSON object"],
    ["array body", [], "Body must be a JSON object"],
    ["missing type", {}, "type must be one of"],
    ["type not allowed", { type: "userFills" }, "type must be one of"],
    ["allMids drops extra fields", { type: "allMids", dex: "x" }, { type: "allMids" }],
    ["metaAndAssetCtxs", { type: "metaAndAssetCtxs" }, { type: "metaAndAssetCtxs" }],
    [
      "clearinghouseState lowercases",
      { type: "clearinghouseState", user: A },
      { type: "clearinghouseState", user: A.toLowerCase() },
    ],
    ["clearinghouseState short address", { type: "clearinghouseState", user: "0x1234" }, "user must be a 0x address"],
    ["spot without user", { type: "spotClearinghouseState" }, "user must be a 0x address"],
    ["recentTrades", { type: "recentTrades", coin: "BTC" }, { type: "recentTrades", coin: "BTC" }],
    ["recentTrades bad coin", { type: "recentTrades", coin: "BTC; drop" }, "coin is invalid"],
    ["candle without req", { type: "candleSnapshot" }, "req is required"],
    [
      "candle bad interval",
      { type: "candleSnapshot", req: { coin: "BTC", interval: "2m", startTime: 1 } },
      "req.interval is invalid",
    ],
    [
      "candle bad start",
      { type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: "1" } },
      "req.startTime is invalid",
    ],
    [
      "candle rounds to the minute",
      { type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: 120_001, endTime: 179_999 } },
      { type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: 120_000, endTime: 120_000 } },
    ],
  ];
  for (const [name, body, expected] of cases)
    it(name, () => {
      const r = validateHlRequest(body);
      if (typeof expected === "string") {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain(expected);
      } else expect(r).toEqual({ ok: true, req: expected });
    });

  it("has a TTL for every allowed type", () => {
    for (const t of HL_ALLOWED) expect(HL_CACHE_TTL[t]).toBeGreaterThan(0);
  });
});

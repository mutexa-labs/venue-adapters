// Conformance kit: any adapter, built over recorded fixtures, must agree with its own venue.
//
// For perp positions the computed liquidation price is compared with the venue-reported one; for lending
// accounts the recomputed health factor is compared with the venue's. Structural checks make sure the adapter
// answers the interface the way callers expect.

import type { FetchLike, VenueAdapter } from "../types";

export type ConformanceOptions = {
  /** Accounts to read through the adapter (from recorded fixtures in tests). */
  addresses: string[];
  /** Largest accepted |computed − reported| / reported. Set per venue model from the recorded data. */
  tolerance: { relative: number };
  /** Fail when fewer value checks than this ran. */
  minChecks?: number;
};

export type ConformanceCheck = {
  address: string;
  market: string;
  kind: "liquidationPrice" | "healthFactor";
  reported: number;
  computed: number;
  relError: number;
  pass: boolean;
};

export type ConformanceReport = {
  adapter: string;
  checks: ConformanceCheck[];
  /** Positions that could not be checked (cross margin, no reported value, E-Mode), with the reason. */
  skipped: { address: string; market: string; reason: string }[];
  /** Interface problems, value mismatches and thrown errors, as readable lines. */
  failures: string[];
  passed: boolean;
};

const rel = (computed: number, reported: number) => Math.abs(computed - reported) / Math.abs(reported);

export async function runConformance(adapter: VenueAdapter, opts: ConformanceOptions): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const skipped: ConformanceReport["skipped"] = [];
  const failures: string[] = [];
  const tol = opts.tolerance.relative;
  if (!(tol >= 0)) throw new RangeError("tolerance.relative must be a non-negative number");

  if (typeof adapter.id !== "string" || !adapter.id) failures.push("id must be a non-empty string");
  for (const k of ["isolated", "cross", "lending", "orderBook", "postOnly"] as const)
    if (typeof adapter.capabilities?.[k] !== "boolean") failures.push(`capabilities.${k} must be a boolean`);

  try {
    const markets = await adapter.markets();
    if (!markets.length) failures.push("markets() returned no markets");
    const first = markets[0];
    if (first) {
      const rp = await adapter.riskParams(first.id);
      if (rp.market !== first.id) failures.push(`riskParams(${first.id}).market is ${rp.market}`);
      if (rp.kind === "perp" && first.kind !== "perp")
        failures.push(`riskParams(${first.id}) is perp for a ${first.kind} market`);
      if (rp.kind === "lending" && first.kind !== "lending")
        failures.push(`riskParams(${first.id}) is lending for a ${first.kind} market`);
      if (rp.kind === "perp" && !rp.tiers.length) failures.push(`riskParams(${first.id}) has no tiers`);
    }
  } catch (e) {
    failures.push(`markets/riskParams threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const address of opts.addresses) {
    try {
      const st = await adapter.account(address);
      if (st.venue !== adapter.id) failures.push(`account(${address}).venue is ${st.venue}, expected ${adapter.id}`);
      for (const p of st.positions) {
        if (p.reportedLiq === null) {
          skipped.push({ address, market: p.market, reason: "venue reports no liquidation price" });
          continue;
        }
        if (p.computedLiq === null) {
          skipped.push({ address, market: p.market, reason: `${p.marginMode} margin is not computed per position` });
          continue;
        }
        const e = rel(p.computedLiq, p.reportedLiq);
        const pass = e <= tol;
        checks.push({
          address,
          market: p.market,
          kind: "liquidationPrice",
          reported: p.reportedLiq,
          computed: p.computedLiq,
          relError: e,
          pass,
        });
        if (!pass)
          failures.push(
            `${address} ${p.market}: computed liquidation ${p.computedLiq} vs reported ${p.reportedLiq} (rel ${e})`,
          );
      }
      const l = st.lending;
      if (l) {
        if (l.reportedHealthFactor === null) skipped.push({ address, market: "account", reason: "no debt" });
        else if (l.computedHealthFactor === null)
          skipped.push({ address, market: "account", reason: "health factor not recomputed (E-Mode)" });
        else {
          const e = rel(l.computedHealthFactor, l.reportedHealthFactor);
          const pass = e <= tol;
          checks.push({
            address,
            market: "account",
            kind: "healthFactor",
            reported: l.reportedHealthFactor,
            computed: l.computedHealthFactor,
            relError: e,
            pass,
          });
          if (!pass)
            failures.push(
              `${address}: computed health factor ${l.computedHealthFactor} vs reported ${l.reportedHealthFactor} (rel ${e})`,
            );
        }
      }
    } catch (e) {
      failures.push(`account(${address}) threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const min = opts.minChecks ?? 1;
  if (checks.length < min) failures.push(`only ${checks.length} value checks ran, expected at least ${min}`);
  return { adapter: adapter.id, checks, skipped, failures, passed: failures.length === 0 };
}

/** Throws with every failure listed when the report did not pass. */
export function assertConformance(report: ConformanceReport): void {
  if (!report.passed) throw new Error(`${report.adapter} failed conformance:\n- ${report.failures.join("\n- ")}`);
}

// ---- fixture replay helpers

/** A recorded HTTP POST: the JSON request body and the response body the venue returned. */
export type HttpExchange = { request: unknown; status?: number; response: unknown };

/**
 * A `fetch` that answers from recorded exchanges, matched on the JSON request body (key order ignored).
 * Unknown requests answer 404, so a test never reaches the network.
 */
export function fixtureFetch(exchanges: HttpExchange[]): FetchLike & { calls: unknown[] } {
  const table = new Map(exchanges.map((x) => [canonical(x.request), x]));
  const calls: unknown[] = [];
  const f = async (_input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push(body);
    const hit = table.get(canonical(body));
    if (!hit) return new Response(JSON.stringify({ error: "no fixture for request" }), { status: 404 });
    return new Response(JSON.stringify(hit.response), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return Object.assign(f, { calls });
}

/** A recorded JSON-RPC call. */
export type RpcExchange = { method: string; params: unknown; result: unknown };

/**
 * An EIP-1193 `request` function that answers from recorded JSON-RPC calls, for viem's `custom()` transport.
 * Unknown calls throw, so a test never reaches the network.
 */
export function fixtureRpc(exchanges: RpcExchange[]): {
  request: (a: { method: string; params?: unknown }) => Promise<unknown>;
  calls: string[];
} {
  const table = new Map(exchanges.map((x) => [canonical({ method: x.method, params: x.params ?? [] }), x.result]));
  const calls: string[] = [];
  return {
    calls,
    async request({ method, params }) {
      const key = canonical({ method, params: params ?? [] });
      calls.push(method);
      if (!table.has(key)) throw new Error(`no fixture for ${method} ${JSON.stringify(params).slice(0, 200)}`);
      return table.get(key);
    },
  };
}

function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  return typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : v;
}

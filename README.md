# @mutexa/venue-adapters

One read-only TypeScript interface for perps and lending venues, with adapters for **Hyperliquid** and
**Aave V3**, and a **conformance kit** that proves an adapter agrees with its own venue on recorded data.

Every position comes back with two liquidation numbers side by side: the one the venue reports, and the one
computed from the position's own state with [`@mutexa/liq-math`](https://github.com/mutexa-labs/liq-math). If
they disagree, you find out in a test, not in production.

- **Hyperliquid:** info API client with an allowlist of public request types, request validation and
  normalisation, per-type cache TTLs, in-flight de-duplication; markets with margin tiers, account positions,
  spot balances, candles and funding helpers.
- **Aave V3:** reserve snapshot pinned to one block, with the data provider and oracle resolved from the
  PoolAddressesProvider at that block, and a refusal to report if `getPool()` no longer returns the expected
  Pool. The RPC endpoint is always your input.
- **Optional Hono route:** a mountable read-only proxy for the Hyperliquid info API (Cloudflare Workers, Node,
  Bun).
- **Conformance kit:** `runConformance(adapter, …)` plus fixture replay helpers for `fetch` and JSON-RPC.

Runs anywhere with `fetch` and Web Streams: Node 22+, Cloudflare Workers, browsers. Read-only: nothing here
signs, sends or funds anything.

## Install

```sh
pnpm add @mutexa/venue-adapters
# optional, only for the proxy route
pnpm add hono
```

## 30-second example

From [`examples/account.ts`](examples/account.ts):

```ts
import { createHyperliquidAdapter } from "@mutexa/venue-adapters";

const hl = createHyperliquidAdapter();
const account = await hl.account(process.argv[2]!);

for (const p of account.positions) {
  console.log(
    p.market,
    p.side === 1 ? "long" : "short",
    p.marginMode,
    "venue liq:",
    p.reportedLiq,
    "computed:",
    p.computedLiq, // null for cross margin: it depends on the whole account
  );
}
```

```sh
pnpm exec tsx examples/account.ts 0xYourAddress
```

Aave V3, from [`examples/aave.ts`](examples/aave.ts):

```ts
import { createAaveV3Adapter, isCollateral } from "@mutexa/venue-adapters/aave-v3";

const aave = createAaveV3Adapter({ rpcUrls: [process.env.ETH_RPC!] });
const snap = await aave.snapshot(); // every reserve at one block; refuses to report if getPool() changed

console.log(`block ${snap.block}, ${snap.reserves.length} reserves`);
for (const r of snap.reserves.filter(isCollateral).slice(0, 5)) {
  console.log(r.symbol, "LTV", r.ltv, "LT", r.liqThreshold, "price", r.priceUsd);
}
```

There is no default RPC. Public Ethereum endpoints such as `https://ethereum-rpc.publicnode.com` work for
trying it out; use the endpoints you trust in production.

## The interface

```ts
interface VenueAdapter {
  readonly id: string; // "hyperliquid", "aave-v3-ethereum"
  readonly capabilities: Capabilities; // isolated / cross / lending / orderBook / postOnly
  markets(): Promise<Market[]>;
  riskParams(market: string): Promise<RiskParams>; // tiers for perps, LTV/LT for lending
  account(address: string): Promise<AccountState>; // venue-reported and computed values side by side
  liquidationPrice(p: PositionInput): number; // fresh position or loan, via @mutexa/liq-math
}
```

Write methods (`placeOrder`, `addMargin`, …) are reserved names and are not part of this release.

## API

### `@mutexa/venue-adapters`

| Export | What it does |
|---|---|
| `createHyperliquidAdapter(opts?)` | `VenueAdapter` for Hyperliquid, plus `perpMarkets()`, `mids()`, `state(address)`, `spot(address)`, `candles(coin, interval, start, end?)` |
| `createHyperliquidClient(opts?)` | Info API client: `info`, `infoRaw`, `allMids`, `metaAndAssetCtxs`, `clearinghouseState`, `spotClearinghouseState`, `candleSnapshot`, `recentTrades`. Options: `url`, `fetch`, `timeoutMs`, `cache`, `ttl` |
| `validateHlRequest(body)` | Allowlist check and normalisation (lowercased addresses, candle times rounded to the minute) |
| `HL_ALLOWED`, `HL_CACHE_TTL`, `HL_INFO_URL`, `CANDLE_INTERVALS`, `ADDRESS_RE`, `COIN_RE` | The allowlist, TTLs in seconds per request type, endpoint, and validation patterns |
| `toMarkets(metaAndAssetCtxs)` | Live perp markets with parsed numbers and resolved margin tiers, sorted by 24h volume |
| `tiersOf(asset, tables)` | Margin tiers of one asset (falls back to one tier at max leverage) |
| `toPositionState(position, market)` | One Hyperliquid position mapped to `PerpPositionState` |
| `fundingPerDay(side, notional, hourlyRate)`, `fundingApr(hourlyRate)` | Funding estimates at the current hourly rate |
| `computeLiquidationPrice(input)` | Fresh perp or loan liquidation price |
| `createCache(opts?)`, `pool(items, limit, fn)` | Memo with TTL, in-flight de-duplication and optional Workers Cache API; bounded concurrency |
| `HyperliquidError` | Validation and upstream errors with a safe message and `status` |
| Types | `VenueAdapter`, `Capabilities`, `Market`, `RiskParams`, `AccountState`, `PerpPositionState`, `LendingAccountState`, `PositionInput`, `HlMarket`, raw `Hl*` response types |

### `@mutexa/venue-adapters/aave-v3`

| Export | What it does |
|---|---|
| `createAaveV3Adapter({ client \| rpcUrls, market?, ttlMs?, blockNumber?, cache? })` | `VenueAdapter` for an Aave V3 market, plus `snapshot()` and `userAccount(address)` |
| `aaveSnapshot(client, market, { blockNumber? })` | All reserves (LTV, liquidation threshold, bonus, flags, oracle price) at one block |
| `aaveUserAccount(client, market, snapshot, user)` | `getUserAccountData` totals and every non-empty reserve position at the snapshot's block |
| `healthFactorOf(reserves)` | Standard-mode health factor from reserve positions |
| `AAVE_V3_ETHEREUM` | Pool, PoolAddressesProvider and Multicall3 on Ethereum mainnet (checked on-chain 2026-10-18) |
| `isCollateral(r)`, `isBorrowable(r)` | Reserve usability checks |

### `@mutexa/venue-adapters/hono`

| Export | What it does |
|---|---|
| `createHyperliquidProxy(opts?)` | Hono app with `POST /info`: validated, allowlisted, cached; `x-cache: hit \| miss` header |

```ts
app.route("/api/hl", createHyperliquidProxy()); // POST /api/hl/info
```

### `@mutexa/venue-adapters/conformance`

| Export | What it does |
|---|---|
| `runConformance(adapter, { addresses, tolerance, minChecks? })` | Structural checks, then computed vs venue-reported liquidation prices (perps) and health factors (lending) |
| `assertConformance(report)` | Throws with every failure listed |
| `fixtureFetch(exchanges)` | `fetch` that answers recorded HTTP exchanges, matched on the JSON body |
| `fixtureRpc(exchanges)` | EIP-1193 `request` for viem's `custom()` transport that answers recorded JSON-RPC calls |

## Writing a new adapter

1. Implement `VenueAdapter`. Return the venue's own liquidation price (or health factor) in `reportedLiq` /
   `reportedHealthFactor`, and your computed one next to it.
2. Write a recorder like [`scripts/record-hyperliquid.ts`](scripts/record-hyperliquid.ts): addresses come in
   at run time, are replaced with obviously fake ones, and only the fields your tests read are kept.
3. Run the kit against the recorded fixtures in a test:

```ts
const report = await runConformance(myAdapter, { addresses, tolerance: { relative: 1e-8 }, minChecks: 3 });
assertConformance(report);
```

Pick the tolerance from your venue's rounding, and write the reason next to it.

## Fixtures and tolerances

| Fixture | Recorded with | Contents |
|---|---|---|
| `fixtures/hyperliquid/recorded.json` | `pnpm record <address...>` | `metaAndAssetCtxs` and `allMids` (trimmed to the recorded coins plus reference markets), four accounts' `clearinghouseState` (positions trimmed, isolated first), one `spotClearinghouseState`, one `candleSnapshot` |
| `fixtures/aave-v3/recorded.json` | `ETH_RPC=… pnpm record:aave <address...>` | Every JSON-RPC call for one snapshot and three accounts, at one pinned block |

Account addresses in fixtures are fake (`0x…a1`, `0x…b1`); the values are real reads at the recorded time.
The RPC URL and the real addresses are never written to disk.

- **Hyperliquid isolated:** 1e-8 relative. Hyperliquid reports `liquidationPx` with about ten significant
  digits; on the recorded positions the computed price is within 7e-10 of it.
- **Aave V3 health factor:** 1e-9 relative. The Pool computes in fixed point from scaled balances, this package
  in float64; on the recorded accounts they agree within about 1e-11.

CI runs only against these files. `LIVE=1 pnpm test:live` (optionally with `ETH_RPC`) is a by-hand smoke test.

## How Mutexa uses it

This code is extracted from the Mutexa app: its Hyperliquid info proxy (allowlist, validation, TTLs, in-flight
de-duplication), its market mapping and funding estimates, and its Aave V3 reserve snapshot. The app's worker
proxy and Aave route become thin wrappers over these adapters, and the planner, tracker and lending pages read
markets, tiers and reserves through them.

## Limitations

- **Read-only.** No orders, no margin changes, no funding through privacy rails.
- **Cross margin is not computed per position.** A cross position's liquidation price depends on the whole
  account, so `computedLiq` is `null` and only the venue's value is reported.
- **Aave E-Mode and isolation mode are not recomputed.** `computedHealthFactor` is `null` for E-Mode accounts.
- **Funding drift.** Funding changes isolated margin, so a liquidation price planned at open drifts over time;
  `account()` always reads the current state.
- **Not in this release:** Solana venues, Morpho and other lending markets, order placement.

Mutexa's privacy limits apply to anything built on these reads: positions are hidden from public trackers, not
from the venues themselves; clustering by timing is still possible; very large positions still move markets;
splitting and privacy rails cost extra fees; fills that carry an integrator fee are marked as such. Follow each
venue's terms in your region.

## Stability

`0.x`: the interface may change between minor versions, always with a changelog entry. A change in a fixture's
expected value or in a public type is a minor bump.

## License

MIT © 2026 Mutexa

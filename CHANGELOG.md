# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow semver (`0.x`: minor bumps may
change the API).

## [0.1.1] - 2026-10-19

### Fixed

- `createHyperliquidProxy` declares its `Hono` return type, so the declaration build succeeds when the package
  is installed from git.

## [0.1.0] - 2026-10-18

### Added

- `VenueAdapter` interface with `Capabilities`, `Market`, `RiskParams`, `AccountState` and `PositionInput`.
- Hyperliquid info client: allowlist, request validation and normalisation, per-type cache TTLs, in-flight
  de-duplication, typed reads.
- Hyperliquid adapter: markets with margin tiers, positions with venue-reported and computed liquidation prices,
  spot balances, candles, funding helpers.
- Aave V3 adapter: reserve snapshot pinned to one block, provider-resolved data provider and oracle, `getPool()`
  safety check, account health factor reported and recomputed.
- `createCache` and `pool` helpers, with optional Cache API support for Cloudflare Workers.
- Optional Hono proxy route (`@mutexa/venue-adapters/hono`).
- Conformance kit with fixture replay helpers (`@mutexa/venue-adapters/conformance`).
- Recorded Hyperliquid and Aave V3 fixtures with fake account addresses, and their recorder scripts.

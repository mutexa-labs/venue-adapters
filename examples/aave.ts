// ETH_RPC=<your endpoint> pnpm exec tsx examples/aave.ts
import { createAaveV3Adapter, isCollateral } from "@mutexa/venue-adapters/aave-v3";

const aave = createAaveV3Adapter({ rpcUrls: [process.env.ETH_RPC!] });
const snap = await aave.snapshot(); // every reserve at one block; refuses to report if getPool() changed

console.log(`block ${snap.block}, ${snap.reserves.length} reserves`);
for (const r of snap.reserves.filter(isCollateral).slice(0, 5)) {
  console.log(r.symbol, "LTV", r.ltv, "LT", r.liqThreshold, "price", r.priceUsd);
}

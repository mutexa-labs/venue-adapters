// pnpm exec tsx examples/account.ts <hyperliquid address>
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

// Records Aave V3 fixtures: every JSON-RPC call the adapter makes for one snapshot and the given accounts, at a
// pinned block.
//
//   ETH_RPC=<your endpoint> pnpm exec tsx scripts/record-aave.ts <address> [<address> ...]
//
// The RPC URL is read from the environment and never written to disk. Account addresses are replaced with
// obviously fake ones (0x…b1, 0x…b2, …) everywhere in the recorded calldata.

import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, custom, getAddress, type Address } from "viem";
import { AAVE_V3_ETHEREUM, aaveSnapshot, aaveUserAccount } from "../src/aave-v3/index";

const rpc = process.env.ETH_RPC;
const addresses = process.argv.slice(2).map((a) => a.toLowerCase());
if (!rpc || !addresses.length) {
  console.error("usage: ETH_RPC=<url> tsx scripts/record-aave.ts <address> [<address> ...]");
  process.exit(1);
}
const fake = (i: number) => `0x${(0xb1 + i).toString(16).padStart(40, "0")}`;

const exchanges: { method: string; params: unknown; result: unknown }[] = [];
let id = 0;
const client = createPublicClient({
  transport: custom({
    async request({ method, params }) {
      const r = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const j = (await r.json()) as { result?: unknown; error?: { message: string } };
      if (j.error) throw new Error(j.error.message);
      // a block is only read for its timestamp: keep the fields viem needs, drop transaction hashes
      const result =
        method === "eth_getBlockByNumber" && j.result && typeof j.result === "object"
          ? {
              number: (j.result as { number: string }).number,
              timestamp: (j.result as { timestamp: string }).timestamp,
              transactions: [],
            }
          : j.result;
      exchanges.push({ method, params, result });
      return j.result;
    },
  }),
});

const latest = await client.getBlockNumber();
const blockNumber = latest - 5n; // a few blocks back, so every node behind a load balancer has it
exchanges.length = 0;
const snap = await aaveSnapshot(client, AAVE_V3_ETHEREUM, { blockNumber });
const summary = [];
for (const a of addresses) {
  const u = await aaveUserAccount(client, AAVE_V3_ETHEREUM, snap, getAddress(a) as Address);
  summary.push({ reserves: u.reserves.length, eMode: u.eMode, hf: u.healthFactor });
}

let out = JSON.stringify(
  {
    recordedAt: new Date().toISOString(),
    recordedWith: "scripts/record-aave.ts",
    note: "Ethereum mainnet JSON-RPC responses at one block. Account addresses are fake.",
    block: Number(blockNumber),
    accounts: addresses.map((_, i) => fake(i)),
    exchanges,
  },
  null,
  1,
);
for (const [i, a] of addresses.entries()) out = out.split(a.slice(2)).join(fake(i).slice(2));
mkdirSync("fixtures/aave-v3", { recursive: true });
writeFileSync("fixtures/aave-v3/recorded.json", out + "\n");
console.error(`wrote fixtures/aave-v3/recorded.json at block ${blockNumber}`, summary);

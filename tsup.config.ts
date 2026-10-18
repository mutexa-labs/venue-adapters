import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "aave-v3/index": "src/aave-v3/index.ts",
    "conformance/index": "src/conformance/index.ts",
    hono: "src/hono.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: ["hono", "viem", "@mutexa/liq-math"],
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Test against core's source so `pnpm test` doesn't depend on a fresh `tsc -b` build.
  resolve: {
    alias: { "@als/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
  },
  test: {
    name: "cli",
    include: ["src/**/*.test.ts"],
  },
});

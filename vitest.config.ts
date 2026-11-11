import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        "packages/core/src/**": { lines: 80, functions: 80, branches: 80, statements: 80 },
      },
    },
  },
});

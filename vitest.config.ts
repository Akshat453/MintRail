import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const conditions = ["development", ...defaultServerConditions];
const SERVICES = ["packages/shared", "ledger", "conductor", "junction", "signal", "api", "depot", "sdk-node"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    clearMocks: true,
    env: { MINTRAIL_LOG_LEVEL: "silent" },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: SERVICES.map((s) => `${s}/test/**/*.test.ts`),
          exclude: ["**/*.int.test.ts", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: [...SERVICES.map((s) => `${s}/test/**/*.int.test.ts`), "tests/e2e/**/*.int.test.ts"],
          globalSetup: ["./tests/support/global-setup.ts"],
          // One shared database, truncated between tests.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: [
        "packages/shared/src/**",
        "ledger/src/**",
        "conductor/src/**",
        "junction/src/**",
        "signal/src/**",
        "api/src/**",
        "depot/src/**",
        "sdk-node/src/**",
      ],
      exclude: ["**/main*.ts", "**/*.d.ts"],
      reporter: ["text-summary", "text"],
      thresholds: {
        "api/src/**": { lines: 85, branches: 85, functions: 85, statements: 85 },
        "ledger/src/**": { lines: 85, branches: 85, functions: 85, statements: 85 },
      },
    },
  },
});

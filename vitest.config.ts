// Root Vitest config. Picks up tests from any package under packages/* and
// any future engine integration tests. Each package can override locally.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests from any workspace package + project-level tests.
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    // 30 s default — engine e2e tests can be slow.
    testTimeout: 30_000,
    // Show full output even when many tests run.
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
    },
  },
});

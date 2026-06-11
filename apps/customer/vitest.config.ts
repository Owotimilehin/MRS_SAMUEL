import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Pure-logic tests only (node env, no DOM). React components are verified via
// typecheck + a Playwright smoke, matching the rest of this monorepo where the
// customer app has no component tests.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

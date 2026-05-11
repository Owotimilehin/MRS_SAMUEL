import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Playwright owns ./e2e — vitest stays out of it.
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
  },
});

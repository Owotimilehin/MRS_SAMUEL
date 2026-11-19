import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@admin": fileURLToPath(new URL("../admin/src", import.meta.url)) } },
  test: { exclude: ["**/node_modules/**", "**/dist/**"] },
});

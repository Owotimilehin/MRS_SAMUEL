// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Self-hosted on the DO droplet (Docker / Cloudflare Tunnel), not Vercel.
// node-server emits a standalone Node bundle at .output/server/index.mjs.
// compressPublicAssets: ship .gz/.br copies of JS, CSS and other static files so the
// Node server sends them compressed (SEO F8, mobile speed). It is a real nitro option
// that the Lovable wrapper forwards but doesn't list in its types, hence the variable.
const nitroOptions = { preset: "node-server", compressPublicAssets: true };

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  nitro: nitroOptions,
});

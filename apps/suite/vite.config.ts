import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * The business suite: a web app of its own at suite.<domain>.
 *
 * It shares the shop's API (reached through /v1, same as the admin app) and,
 * for now, reuses the inbox screens and building blocks straight from the
 * admin app's source through the "@admin" alias. See
 * docs/handoffs/2026-11-19-suite-blueprint.md for what moves where, and when.
 */
export default defineConfig({
  resolve: {
    alias: { "@admin": fileURLToPath(new URL("../admin/src", import.meta.url)) },
    // One copy of each, even though files come from two apps.
    dedupe: ["react", "react-dom", "@tanstack/react-query", "@tanstack/react-router", "zustand"],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Registered by hand in main.tsx, with a periodic update check.
      injectRegister: false,
      includeAssets: ["brand-logo.png"],
      manifest: {
        name: "Mrs. Samuel Business Suite",
        short_name: "MS Suite",
        description: "Customer messages, calls and contacts for Mrs. Samuel Fruit Juice.",
        theme_color: "#0e3f1f",
        background_color: "#fbf7ef",
        display: "standalone",
        start_url: "/inbox",
        icons: [{ src: "/brand-logo.png", sizes: "any", type: "image/png" }],
      },
      workbox: {
        navigateFallback: "/index.html",
        // Never answer an API call from the cache: messages must be live.
        navigateFallbackDenylist: [/^\/v1\//],
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 3003,
    host: true,
    proxy: { "/v1": "http://localhost:3001" },
  },
});

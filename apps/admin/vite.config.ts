import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // We register the worker ourselves in main.tsx (with a periodic update
      // check), so don't also auto-inject registerSW.js.
      injectRegister: false,
      // Don't precache imagery the user might not visit; keep cache lean.
      includeAssets: ["favicon.ico"],
      manifest: {
        name: "Mrs. Samuel Admin",
        short_name: "MS Admin",
        description: "Branch POS, factory dispatch, and admin tools for Mrs. Samuel Fruit Juice.",
        theme_color: "#4ea83a",
        background_color: "#fbf7ef",
        display: "standalone",
        start_url: "/branch",
        icons: [],
      },
      workbox: {
        navigateFallback: "/index.html",
        // Take control immediately on a new deploy so the next normal reload
        // serves the fresh build — no hard-refresh / tab-close needed.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /\/v1\/sync\/pull/,
            handler: "NetworkFirst",
            options: {
              cacheName: "sync-pull",
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 5 },
            },
          },
          {
            urlPattern: /\/v1\/products(\/[^/]+)?$/,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "products" },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 3000,
    host: true,
    allowedHosts: [".ngrok-free.app", ".ngrok.app", ".ngrok.io", ".ngrok.dev", ".ngrok-free.dev"],
    proxy: { "/v1": "http://localhost:3001" },
  },
});

import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const here = dirname(fileURLToPath(import.meta.url));

// In production, admin nginx proxies /media/ to the customer app, which serves
// product imagery from its public/media folder. The admin dev server has no
// such proxy, so /media/* falls through to the SPA fallback (HTML) and product
// bottle images break. Serve those assets straight off disk in dev so the admin
// renders the same imagery locally as in prod.
function serveCustomerMedia(): Plugin {
  const root = join(here, "../customer/public/media");
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
  };
  return {
    name: "serve-customer-media",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/media", (req, res, next) => {
        const rel = normalize(decodeURIComponent((req.url ?? "").split("?")[0]!)).replace(/^[/\\]+/, "");
        const file = join(root, rel);
        // Block path traversal outside the media root.
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader("Content-Type", types[extname(file).toLowerCase()] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [
    serveCustomerMedia(),
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

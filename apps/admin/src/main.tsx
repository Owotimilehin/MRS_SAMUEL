import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "./router.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ToastHost } from "./components/ToastHost.js";
import { installTelemetry } from "./lib/telemetry.js";
import { browserReloadEnv, reloadOnceForStaleChunk } from "./lib/chunk-reload.js";
import "./index.css";

installTelemetry("admin");

// A lazy route's dynamic import can 404 after a deploy replaces hashed chunks
// while this tab still references the previous build's filenames. Vite fires
// `vite:preloadError` for these — reload once to pull the fresh build.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault(); // suppress Vite's default rethrow; we recover instead
  reloadOnceForStaleChunk(browserReloadEnv());
});

// Keep the installed app current without a hard refresh. The generated sw.js
// uses skipWaiting + clientsClaim, so a new build activates and takes control
// immediately; we reload the page the moment that happens (but only on an
// UPDATE, never the first install). We also poll for a new build every 60s so a
// long-open POS/admin session upgrades itself shortly after a deploy.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        setInterval(() => void registration.update(), 60_000);
        registration.addEventListener("updatefound", () => {
          const incoming = registration.installing;
          if (!incoming) return;
          incoming.addEventListener("statechange", () => {
            // controller present => a worker already ran => this is an update,
            // not the first install, so it's safe to reload to the new bundle.
            if (incoming.state === "activated" && navigator.serviceWorker.controller) {
              window.location.reload();
            }
          });
        });
      })
      .catch(() => {
        /* SW registration is best-effort; the app works without it */
      });
  });
}

const queryClient = new QueryClient();
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root");
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <ToastHost />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

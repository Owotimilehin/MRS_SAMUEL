import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "@admin/components/ErrorBoundary.js";
import { ToastHost } from "@admin/components/ToastHost.js";
import { HostAppProvider } from "@admin/lib/app-frame.js";
import { browserReloadEnv, reloadOnceForStaleChunk } from "@admin/lib/chunk-reload.js";
import { installTelemetry } from "@admin/lib/telemetry.js";
import { router } from "./router.js";
import { suiteHost } from "./suite-host.js";
// The admin app's stylesheet first (colours, type, buttons, the page frame),
// then the suite's own rules on top.
import "@admin/index.css";
import "./suite.css";

installTelemetry("suite");

// After a deploy, a page chunk this tab still points at may be gone. Reload once.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadOnceForStaleChunk(browserReloadEnv());
});

// Keep an open tab on the newest build, and let installed copies of the suite
// (phone home screen, desktop app window) update themselves.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        setInterval(() => void registration.update(), 60_000);
        registration.addEventListener("updatefound", () => {
          const incoming = registration.installing;
          if (!incoming) return;
          incoming.addEventListener("statechange", () => {
            if (incoming.state === "activated" && navigator.serviceWorker.controller) {
              window.location.reload();
            }
          });
        });
      })
      .catch(() => {
        /* best-effort; the suite works without it */
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
        <HostAppProvider value={suiteHost}>
          <RouterProvider router={router} />
        </HostAppProvider>
        <ToastHost />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

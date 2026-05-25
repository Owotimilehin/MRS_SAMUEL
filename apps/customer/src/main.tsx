import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { installTelemetry } from "./lib/telemetry.js";
import { cart } from "./store/cart.js";
import "./index.css";

installTelemetry("customer");
// Prime the in-memory mirror from the server cookie so the badge / pages
// render the correct cart on first paint. Errors are swallowed — an empty
// snapshot is the safe default.
void cart.refresh().catch(() => {
  /* server cart unavailable — start empty */
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root");
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  </StrictMode>,
);

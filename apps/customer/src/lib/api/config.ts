// apps/customer/src/lib/api/config.ts
/**
 * Base URL for the Mrs. Samuel API. Used only inside server functions
 * (they run on the customer's Node server and proxy the API), so the value
 * never reaches the browser. Vite statically replaces import.meta.env at
 * build time for both the client and SSR bundles.
 */
export const API_BASE: string =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ??
  "http://localhost:8787";

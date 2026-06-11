// apps/customer/src/lib/api/config.ts
/**
 * Base URL for the Mrs. Samuel API. Used only inside server functions
 * (they run on the customer's Node server and proxy the API), so the value
 * never reaches the browser.
 *
 * Resolution order:
 *   1. `process.env.PUBLIC_API_URL` — runtime env on the SSR Node server.
 *      Preferred so one built image is portable across environments (in the
 *      compose network this is `http://api:3001`; locally `http://localhost:3001`).
 *   2. `import.meta.env.VITE_API_URL` — build-time fallback (Vite statically
 *      replaces this for the client/SSR bundles).
 *   3. Local dev default.
 *
 * Because these server functions only run on Node, `process.env` is always
 * available there; the `typeof` guard keeps it safe if the module is ever
 * pulled into a client bundle.
 */
const runtimeApiUrl =
  typeof process !== "undefined" ? process.env.PUBLIC_API_URL : undefined;

export const API_BASE: string =
  runtimeApiUrl?.replace(/\/+$/, "") ??
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ??
  "http://localhost:3001";

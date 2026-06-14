/**
 * Known production database hosts, baked in so the guard is ARMED BY DEFAULT —
 * not dependent on an operator remembering to export an env var on every
 * machine. Extend (never replace) this via the PROD_DB_HOSTS env (comma-sep).
 */
const DEFAULT_PROD_HOSTS = ["138.68.165.230"];

/**
 * Throws if `url` points at production. Wired into the test bootstrap and the
 * seed entrypoint so neither can ever write to prod (the confirmed source of
 * the junk "atrocity" products). NOT used by migrate.ts — real deploys migrate
 * prod legitimately.
 *
 * Prod is detected by: an explicit MS_DB_IS_PROD=1 flag, or the url host
 * matching the denylist (DEFAULT_PROD_HOSTS plus anything in PROD_DB_HOSTS).
 */
export function assertNonProdDb(
  url: string,
  denyHosts: string[] = [
    ...DEFAULT_PROD_HOSTS,
    ...(process.env.PROD_DB_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ],
  isProdFlag: string | undefined = process.env.MS_DB_IS_PROD,
): void {
  if (isProdFlag === "1") {
    throw new Error("refusing to run against the production database (MS_DB_IS_PROD=1)");
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  if (host && denyHosts.includes(host)) {
    throw new Error(
      `refusing to run against the production database (host ${host} is denylisted)`,
    );
  }
}

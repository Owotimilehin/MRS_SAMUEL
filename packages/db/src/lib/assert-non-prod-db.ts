/**
 * Throws if `url` points at production. Wired into the test bootstrap and the
 * seed entrypoint so neither can ever write to prod (the confirmed source of
 * the junk "atrocity" products). NOT used by migrate.ts — real deploys migrate
 * prod legitimately.
 *
 * Prod is detected by: an explicit MS_DB_IS_PROD=1 flag, or the url host
 * matching the denylist (defaults come from the PROD_DB_HOSTS env, comma-sep).
 */
export function assertNonProdDb(
  url: string,
  denyHosts: string[] = (process.env.PROD_DB_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
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

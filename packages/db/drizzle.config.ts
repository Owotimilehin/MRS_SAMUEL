import type { Config } from "drizzle-kit";

export default {
  // Drizzle-kit reads the COMPILED schema (./dist) so the .js extensions
  // we use for Node ESM resolution work both at runtime and at generate
  // time. Be sure to `pnpm --filter @ms/db build` before running `generate`.
  schema: "./dist/schema/*.js",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true
} satisfies Config;

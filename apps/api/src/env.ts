import { z } from "zod";

const emptyToUndef = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  DATABASE_URL_REPLICA: z.preprocess(emptyToUndef, z.string().url().optional()),
  REDIS_URL: z.string().url(),
  JWT_SIGNING_KEY: z.string().min(32),
  JWT_SIGNING_KEY_PREVIOUS: z.preprocess(emptyToUndef, z.string().min(32).optional()),
  SESSION_COOKIE_NAME: z.string().default("ms_session"),
  SENTRY_DSN: z.preprocess(emptyToUndef, z.string().optional()),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PUBLIC_API_URL: z.string().url(),
  PUBLIC_ADMIN_URL: z.string().url(),
  PUBLIC_CUSTOMER_URL: z.preprocess(emptyToUndef, z.string().url().optional()),
  PORT: z.coerce.number().default(3001),
});

export type Env = z.infer<typeof Env>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  cached = Env.parse(process.env);
  return cached;
}

// Proxy for ergonomic access: `env.PORT` reads through to the lazily-loaded env.
export const env = new Proxy({} as Env, {
  get(_t, key) {
    return loadEnv()[key as keyof Env];
  },
});

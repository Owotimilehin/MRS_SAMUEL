import pino, { type Logger } from "pino";

let cached: Logger | null = null;

function build(): Logger {
  const level = (process.env.LOG_LEVEL ?? "info") as pino.LevelWithSilent;
  const isDev = (process.env.NODE_ENV ?? "development") === "development";
  return pino({
    level,
    base: { service: "ms-api" },
    ...(isDev
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });
}

export const logger = new Proxy({} as Logger, {
  get(_t, key) {
    if (!cached) cached = build();
    return cached[key as keyof Logger];
  },
});

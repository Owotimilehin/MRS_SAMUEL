import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDbClient(url: string): DbClient {
  const sql = postgres(url, { max: 10, idle_timeout: 20 });
  return drizzle(sql, { schema });
}

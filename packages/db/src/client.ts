import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Either a top-level client or a transaction handle — i.e. anything that can
 * read/write tables. Used by helpers that may run inside or outside a tx.
 * Excludes `$client` and `transaction()` which are only on the top-level
 * client.
 */
export type DbExecutor = Omit<DbClient, "$client" | "transaction">;

export function createDbClient(url: string): DbClient {
  const sql = postgres(url, { max: 10, idle_timeout: 20 });
  return drizzle(sql, { schema });
}

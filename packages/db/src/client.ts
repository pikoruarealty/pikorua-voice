import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

// ─── Client factory ──────────────────────────────────────────────────────────
// Returns a fully typed Drizzle client bound to the given connection string.
// apps/api and apps/worker each create their instance through a Nest provider
// (via ConfigService). Standalone scripts (migrations, seed) call this directly
// after loading dotenv.

export function createDatabase(url: string, options: { max?: number } = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return drizzle(sql, {
    schema,
    logger: process.env["NODE_ENV"] === "development",
  });
}

export type Database = ReturnType<typeof createDatabase>;

const fs = require("node:fs");
const path = require("node:path");
const postgres = require("postgres");

// Load .env for local dev only; in production env vars are injected by the platform
try {
  const dotenv = require("dotenv");
  const root = path.resolve(__dirname, "../../..");
  dotenv.config({ path: path.join(root, ".env") });
} catch {}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const migrationsDir = path.resolve(__dirname, "../drizzle");
const files = fs
  .readdirSync(migrationsDir)
  .filter((file) => /^\d+.*\.sql$/.test(file))
  .sort();

// Fixed key for the session-level advisory lock that serialises migrations.
// Any constant works as long as every instance uses the same one.
const MIGRATION_LOCK_KEY = 4927412009;

async function main() {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  let locked = false;
  try {
    // Serialise migrations across instances: on a rolling deploy two processes
    // boot at once and would otherwise race to apply the same file, colliding on
    // the schema_migrations PK / duplicate-object DDL and crashing one of them.
    // max:1 above guarantees this lock is held on the same connection the loop uses.
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    locked = true;

    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    for (const file of files) {
      const existing = await sql`
        SELECT filename FROM schema_migrations WHERE filename = ${file}
      `;
      if (existing.length > 0) {
        console.log(`skip ${file}`);
        continue;
      }

      const migrationSql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(migrationSql);
        await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
      });
      console.log(`applied ${file}`);
    }
  } finally {
    if (locked) {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => undefined);
    }
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

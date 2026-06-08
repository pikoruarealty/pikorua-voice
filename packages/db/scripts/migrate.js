const fs = require("node:fs");
const path = require("node:path");
const postgres = require("postgres");
const dotenv = require("dotenv");

const root = path.resolve(__dirname, "../../..");
dotenv.config({ path: path.join(root, ".env") });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const migrationsDir = path.resolve(__dirname, "../drizzle");
const files = fs
  .readdirSync(migrationsDir)
  .filter((file) => /^\d+.*\.sql$/.test(file))
  .sort();

async function main() {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
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
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

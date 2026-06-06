import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";
import { resolve } from "path";

// CWD when drizzle-kit runs is packages/db/ — two levels up reaches the repo root.
dotenv.config({ path: resolve(__dirname, "../../.env") });

const url = process.env["DATABASE_URL"];
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
});

// ─── Schema — tables, enums, relations (populated from Step 2) ───────────────
export * from "./schema";

// ─── DB client factory ───────────────────────────────────────────────────────
export { createDatabase } from "./client";
export type { Database } from "./client";

// ─── Repository exports (convenience) ───────────────────────────────────────
export * from "./repositories";

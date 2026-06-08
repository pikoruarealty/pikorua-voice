import { z } from "zod";

// ─── Worker environment schema ───────────────────────────────────────────────
// The dial worker consumes the BullMQ queue (Redis), places outbound calls via
// Exotel (Step 6), and writes call records to PostgreSQL + syncs the CRM
// (Step 9). REDIS_URL is required so the process fails fast; the rest are
// optional at this stage and tightened to required as their build steps land.

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  REDIS_URL: z.string().url(),
  DATABASE_URL: z.string().url().optional(),

  // Telephony · Exotel (required from Step 6)
  EXOTEL_SID: z.string().optional(),
  EXOTEL_API_KEY: z.string().optional(),
  EXOTEL_API_TOKEN: z.string().optional(),
  EXOTEL_SUBDOMAIN: z.string().default("api.exotel.com"),
  EXOTEL_CALLER_ID: z.string().optional(),

  // CRM integration (REST only — Step 9)
  CRM_API_BASE_URL: z.string().url().default("http://localhost:4000"),
  CRM_API_TOKEN: z.string().optional(),

  // Optional LLM scoring configuration (falls back to heuristics if absent)
  LLM_SCORING_PROVIDER: z.enum(["anthropic", "google", "auto"]).default("auto"),
  LLM_SCORING_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GOOGLE_MODEL: z.string().optional(),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function validateWorkerEnv(raw: Record<string, unknown>): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid worker environment configuration:\n${issues}`);
  }
  return parsed.data;
}

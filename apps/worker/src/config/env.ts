import { z } from "zod";

const optionalNonEmpty = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

// ─── Worker environment schema ───────────────────────────────────────────────
// The dial worker consumes the BullMQ queue (Redis), places outbound calls via
// Exotel (Step 6), and writes call records to PostgreSQL + syncs the CRM
// (Step 9). REDIS_URL is required so the process fails fast; the rest are
// optional at this stage and tightened to required as their build steps land.

export const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    REDIS_URL: z.string().url(),
    DATABASE_URL: z.string().url(),

    // Telephony · Exotel (required from Step 6)
    EXOTEL_SID: optionalNonEmpty,
    EXOTEL_API_KEY: optionalNonEmpty,
    EXOTEL_API_TOKEN: optionalNonEmpty,
    EXOTEL_SUBDOMAIN: z.string().default("api.exotel.com"),
    EXOTEL_CALLER_ID: optionalNonEmpty,
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:4100"),

    // CRM integration (REST only — Step 9)
    CRM_API_BASE_URL: z.string().url().default("http://localhost:4000"),
    CRM_API_TOKEN: optionalNonEmpty,

    // Optional LLM scoring configuration (falls back to heuristics if absent)
    LLM_SCORING_PROVIDER: z.enum(["anthropic", "google", "auto"]).default("auto"),
    LLM_SCORING_MODEL: optionalNonEmpty,
    ANTHROPIC_API_KEY: optionalNonEmpty,
    ANTHROPIC_MODEL: optionalNonEmpty,
    GOOGLE_GENERATIVE_AI_API_KEY: optionalNonEmpty,
    GOOGLE_MODEL: optionalNonEmpty,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") {
      return;
    }

    const required: Array<keyof typeof env> = [
      "EXOTEL_SID",
      "EXOTEL_API_KEY",
      "EXOTEL_API_TOKEN",
      "EXOTEL_CALLER_ID",
      "CRM_API_TOKEN",
    ];
    for (const key of required) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Required in production",
        });
      }
    }
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

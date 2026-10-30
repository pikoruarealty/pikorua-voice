import { z } from "zod";

const optionalNonEmpty = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

// ─── Worker environment schema ───────────────────────────────────────────────
// The dial worker consumes the BullMQ queue (Redis), places outbound calls via
// Exotel (Step 6), and writes call records to PostgreSQL + syncs the CRM
// (Step 9). Core infrastructure is required so the process fails fast; live
// provider credentials are required in production.

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
    // Exotel App ID for the Voicebot app configured in the Exotel dashboard.
    // Required for outbound calls to route through the voicebot.
    EXOTEL_APP_ID: optionalNonEmpty,
    // Shared secret appended to the StatusCallback URL we register with Exotel.
    // Exotel does not sign its callbacks, so the URL is the only channel we have
    // to authenticate them — the API rejects a callback that carries neither this
    // token nor a valid HMAC. Must match the API's EXOTEL_WEBHOOK_SECRET.
    EXOTEL_WEBHOOK_SECRET: optionalNonEmpty,
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:4100"),

    // Call-slot gate (shared with the API via Redis). A dial waits while all
    // slots are busy. Must match the API's values.
    MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(2),
    OUTBOUND_MAX_CONCURRENT: z.coerce.number().int().positive().default(1),

    // Keep-alive self-ping (see KeepAliveScheduler). Manual on/off switch,
    // defaults OFF. Set WORKER_KEEPALIVE_ENABLED=true + WORKER_PUBLIC_URL to this
    // worker's own Render URL to stop the free-tier instance idling out. Kept as
    // lenient optional strings (no enum / URL validation) so a stray value can
    // never crash worker startup — the scheduler interprets them at runtime.
    WORKER_KEEPALIVE_ENABLED: optionalNonEmpty,
    WORKER_PUBLIC_URL: optionalNonEmpty,

    // Site-visit reconfirmation (#2) + post-visit feedback (#4) outbound dialing.
    // OFF by default — these place REAL calls, so enabling is a deliberate switch.
    // APPOINTMENT_FEEDBACK_DELAY_MS is how long after the visit the feedback call
    // fires (default 3h). Kept lenient (no strict enum/number) so a stray value can
    // never crash worker startup; the scheduler coerces them at runtime.
    APPOINTMENTS_OUTBOUND_ENABLED: optionalNonEmpty,
    APPOINTMENT_FEEDBACK_DELAY_MS: optionalNonEmpty,

    // CRM integration (REST only — Step 9). The worker POSTs completed calls to
    // <CRM_API_BASE_URL>/call-results, authenticated with the shared Bearer token
    // and an HMAC-SHA256 signature over the raw body (the CRM's VOICE_API_BEARER_TOKEN
    // and VOICE_WEBHOOK_HMAC_SECRET). Requests are sent unsigned if the secret is blank.
    CRM_API_BASE_URL: z.string().url().default("http://localhost:4000"),
    CRM_API_TOKEN: optionalNonEmpty,
    CRM_WEBHOOK_HMAC_SECRET: optionalNonEmpty,

    // Optional LLM scoring configuration (falls back to heuristics if absent)
    LLM_SCORING_PROVIDER: z.enum(["openrouter", "auto"]).default("auto"),
    LLM_SCORING_MODEL: optionalNonEmpty,
    OPENROUTER_API_KEY: optionalNonEmpty,
    OPENROUTER_MODEL: optionalNonEmpty,
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

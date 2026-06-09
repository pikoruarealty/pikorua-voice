import { z } from "zod";

const optionalNonEmpty = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);

const booleanFlag = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const optionalLlmProvider = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.enum(["anthropic", "google", "auto"]).optional(),
);

// ─── Environment schema ──────────────────────────────────────────────────────
// All external input is untrusted and validated here. Core infrastructure
// variables are required so the process fails fast on misconfiguration. In
// production, public-facing auth and active voice provider credentials are
// required explicitly so the service never boots into a half-live state.

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_PORT: z.coerce.number().int().positive().default(4100),
    API_AUTH_TOKEN: optionalNonEmpty,

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),

    // Telephony · Exotel
    EXOTEL_SID: optionalNonEmpty,
    EXOTEL_API_KEY: optionalNonEmpty,
    EXOTEL_API_TOKEN: optionalNonEmpty,
    EXOTEL_SUBDOMAIN: z.string().default("api.exotel.com"),
    EXOTEL_CALLER_ID: optionalNonEmpty,
    EXOTEL_WEBHOOK_SECRET: optionalNonEmpty,
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:4100"),

    // Voice routing
    GEMINI_LANGUAGE_DEFAULT: z.string().max(16).default("hi-IN"),
    ENGLISH_ANTHROPIC_PERCENT: z.coerce.number().min(0).max(100).default(25),
    LLM_PROVIDER_OVERRIDE: optionalLlmProvider,
    GUARDRAIL_SEMANTIC_ENABLED: booleanFlag.default(true),
    STT_REALTIME_ENABLED: booleanFlag.default(false),
    STT_STREAMING_ENABLED: booleanFlag.default(false),

    // Speech-to-Text · Deepgram
    DEEPGRAM_API_KEY: optionalNonEmpty,

    // Text-to-Speech · ElevenLabs
    ELEVENLABS_API_KEY: optionalNonEmpty,
    ELEVENLABS_VOICE_ID: optionalNonEmpty,

    // LLM · Anthropic (primary)
    ANTHROPIC_API_KEY: optionalNonEmpty,
    ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5-20251001"),

    // LLM · Google Generative AI (fallback)
    GOOGLE_GENERATIVE_AI_API_KEY: optionalNonEmpty,
    GOOGLE_MODEL: z.string().default("gemini-2.0-flash"),

    // LLM · OpenRouter (last-resort fallback)
    OPENROUTER_API_KEY: optionalNonEmpty,
    OPENROUTER_MODEL: z.string().default("google/gemini-2.0-flash-lite:free"),

    // CRM integration (REST only)
    CRM_API_BASE_URL: z.string().url().default("http://localhost:4000"),
    CRM_API_TOKEN: optionalNonEmpty,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") {
      return;
    }

    const required: Array<keyof typeof env> = [
      "API_AUTH_TOKEN",
      "EXOTEL_WEBHOOK_SECRET",
      "DEEPGRAM_API_KEY",
      "ELEVENLABS_API_KEY",
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

    if (!env.ANTHROPIC_API_KEY && !env.GOOGLE_GENERATIVE_AI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message: "At least one LLM provider key is required in production",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

// Passed to ConfigModule.forRoot({ validate }). Throws a readable error listing
// every invalid/missing variable so the process never boots half-configured.
export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

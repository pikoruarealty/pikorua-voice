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

// Only OpenRouter is implemented today; "auto" resolves to OpenRouter with
// retry + optional fallback model. A removed "google" option would silently
// pick a provider that does not exist, so it is intentionally not accepted.
const optionalLlmProvider = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.enum(["auto", "openrouter"]).optional(),
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
    EXOTEL_APP_ID: optionalNonEmpty,
    EXOTEL_WEBHOOK_SECRET: optionalNonEmpty,
    // NOTE: NOT an enforced security control. Exotel strips query params from
    // wss:// stream URLs, so a token in the stream URL cannot be relied on; the
    // gateway never reads this. Stream security comes from TLS + callSid DB
    // validation in the "start" handler. Kept only for forward compatibility —
    // do not treat it as authentication. (See exotel-voicebot.gateway.ts.)
    EXOTEL_STREAM_SECRET: optionalNonEmpty,
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:4100"),

    // Voice routing
    CALL_LOCALE_DEFAULT: z.string().max(16).default("hi-IN"),
    LLM_PROVIDER_OVERRIDE: optionalLlmProvider,
    GUARDRAIL_SEMANTIC_ENABLED: booleanFlag.default(true),
    STT_STREAMING_ENABLED: booleanFlag.default(false),
    TTS_WS_STREAMING_ENABLED: booleanFlag.default(false),

    // Voice-turn latency & robustness tuning
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
    OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
    TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
    // Hard cap on call length (0 disables). Default 15 minutes.
    CALL_MAX_DURATION_MS: z.coerce.number().int().nonnegative().default(900000),
    // Consecutive silent/noise turns (within a 45s window) before we assume the
    // line is dead and hang up. Default 3 — lower values risk dropping a prospect
    // who merely paused twice on a noisy line.
    SILENCE_END_THRESHOLD: z.coerce.number().int().positive().default(3),
    // Sliding-window history cap so long calls can't blow the context budget.
    LLM_HISTORY_MAX_MESSAGES: z.coerce.number().int().nonnegative().default(20),
    // Speech-to-Text · Deepgram
    DEEPGRAM_API_KEY: optionalNonEmpty,

    // Text-to-Speech · ElevenLabs
    ELEVENLABS_API_KEY: optionalNonEmpty,
    ELEVENLABS_VOICE_ID: optionalNonEmpty,

    // LLM · OpenRouter
    OPENROUTER_API_KEY: optionalNonEmpty,
    OPENROUTER_MODEL: z.string().default("anthropic/claude-haiku-4-5"),
    OPENROUTER_FALLBACK_MODEL: optionalNonEmpty,

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

    if (!env.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENROUTER_API_KEY"],
        message: "OPENROUTER_API_KEY is required in production",
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

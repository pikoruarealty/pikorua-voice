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

    // Worker wake-up: the worker is a Render free-tier web service that spins down
    // when idle, and a queued BullMQ job can't wake it. Set this to the worker's
    // URL (e.g. https://pikorua-voice-web-worker.onrender.com/health) and the API pings
    // it whenever it queues work (post-call after any call, or an outbound dial), so
    // the worker cold-starts and drains the queue. Unset/local = no-op.
    WORKER_WAKE_URL: optionalNonEmpty,
    // When WORKER_WAKE_URL is set, the API also keeps the worker available for the
    // TIME-DRIVEN reminder/feedback scheduler: it wakes the worker just before any
    // reminder is due (any hour) AND keeps it warm during business hours. This is
    // the IST window for that business-hours keep-alive (defaults 10-18). Lenient
    // integers; set start >= end to disable the window (wake-ahead still runs).
    WORKER_KEEPALIVE_START_HOUR_IST: optionalNonEmpty,
    WORKER_KEEPALIVE_END_HOUR_IST: optionalNonEmpty,

    // Voice routing
    CALL_LOCALE_DEFAULT: z.string().max(16).default("hi-IN"),
    LLM_PROVIDER_OVERRIDE: optionalLlmProvider,
    GUARDRAIL_SEMANTIC_ENABLED: booleanFlag.default(true),
    STT_STREAMING_ENABLED: booleanFlag.default(false),
    TTS_WS_STREAMING_ENABLED: booleanFlag.default(false),

    // Voice-turn latency & robustness tuning
    OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
    TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(12000),
    // Hard cap on call length (0 disables). Default 3 minutes.
    CALL_MAX_DURATION_MS: z.coerce.number().int().nonnegative().default(180000),
    // Call-slot gate (shared with the worker via Redis): at most this many calls
    // at once, of which at most OUTBOUND_MAX_CONCURRENT outbound — the rest stays
    // free for inbound callers. Must match the worker's values.
    MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().default(2),
    OUTBOUND_MAX_CONCURRENT: z.coerce.number().int().positive().default(1),
    // On SIGTERM, how long to wait for live calls to finish before exiting. Keep it
    // under the platform's stop grace (docker stop_grace_period 240s).
    DRAIN_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(230000),
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

    // Text-to-Speech · Sarvam (Gujarati ONLY)
    //
    // ElevenLabs cannot speak Gujarati in a realtime call — its low-latency
    // models don't support gu, and the only model that does (eleven_v3) has no
    // streaming. So gu-IN is voiced by Sarvam Bulbul instead. hi/en never touch
    // this provider.
    //
    // Deliberately NOT required in production: with no key, gu-IN falls back to
    // the legacy Hindi persona (see TtsRouter.isGujaratiEnabled), which is the
    // pre-existing behaviour. Gujarati is opt-in, and a missing key must not
    // block a boot that only serves hi/en.
    SARVAM_API_KEY: optionalNonEmpty,
    // Maya's voice in every language: Sarvam's "Aparna" on bulbul:v4-flash, chosen
    // by ear. v4 speaker IDs are per language + style, so each language names its
    // own; the Hindi Aparna also speaks Gujarati well (there is no Gujarati
    // Aparna). These replace the old SARVAM_MODEL / SARVAM_SPEAKER (bulbul:v3 +
    // "simran"), which are no longer read — new names so a stale value left in an
    // environment can't silently pin the old voice.
    SARVAM_TTS_MODEL: z.string().default("bulbul:v4-flash"),
    SARVAM_SPEAKER_HI: z.string().default("aparna_hi_customer"),
    SARVAM_SPEAKER_EN: z.string().default("aparna_en_companion"),
    SARVAM_SPEAKER_GU: z.string().default("aparna_hi_customer"),
    // 1.0 (natural speed) chosen by ear for the Aparna voice. Lower = slower.
    // Range 0.5–2.0. Keep this in step with SARVAM_PACE in .env — the tuned value
    // must survive a deploy that never sets the variable.
    SARVAM_PACE: z.coerce.number().min(0.5).max(2).default(1),
    // temperature = bulbul:v3's expressiveness knob (replaced v2 pitch/loudness).
    // 0 sounded robotic in call testing; 0.7 was chosen by ear as the most human.
    // Raise toward ~0.9 for livelier intonation, lower for flatter/steadier.
    SARVAM_TEMPERATURE: z.coerce.number().min(0).max(1.5).default(0.7),
    // Sarvam's own text normaliser for mixed Gujarati/English/numbers. ON by
    // default — off mispronounced code-switched English in call testing.
    SARVAM_PREPROCESS: booleanFlag.default(true),
    // Kill switch for the whole Gujarati persona, independent of the key being
    // present. Set false to force gu-IN back to Hindi without unsetting the key.
    SARVAM_TTS_ENABLED: booleanFlag.default(true),
    // Hindi/English voice. "sarvam" (default) = Bulbul with the same speaker as
    // Gujarati (≈ half the TTS cost of ElevenLabs); ElevenLabs stays the automatic
    // fallback whenever Sarvam errors. Set "elevenlabs" to roll back instantly.
    TTS_PROVIDER_HI: z.enum(["elevenlabs", "sarvam"]).default("sarvam"),
    // Live speech-to-text. "sarvam" (default) is cheaper; Deepgram stays the
    // automatic mid-call fallback, so DEEPGRAM_API_KEY should remain set either way.
    // Set "deepgram" to roll back instantly.
    STT_PROVIDER: z.enum(["deepgram", "sarvam"]).default("sarvam"),
    SARVAM_STT_MODEL: z.string().default("saaras:v4"),
    // Folder of pre-recorded clips (clips.json + 8 kHz WAVs). Defaults to the
    // repo's assets/clips; a missing folder just means every line is live TTS.
    CLIPS_DIR: optionalNonEmpty,
    // Password for the operator pages: / (browser test-call demo) and /status
    // (service dashboard). HTTP Basic login — any username. Unset in production =
    // those pages are disabled.
    DASHBOARD_PASSWORD: optionalNonEmpty,

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
      // Without this, /api/webhooks/exotel accepts UNSIGNED webhooks (the handler
      // only enforces the HMAC when a secret is set). Required in production so a
      // public, unauthenticated endpoint can't mutate call/lead state.
      "EXOTEL_WEBHOOK_SECRET",
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

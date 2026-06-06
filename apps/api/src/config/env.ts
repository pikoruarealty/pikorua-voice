import { z } from "zod";

// ─── Environment schema ──────────────────────────────────────────────────────
// All external input is untrusted and validated here. Core infrastructure
// variables are required so the process fails fast on misconfiguration. Provider
// credentials (Exotel, Deepgram, ElevenLabs, Anthropic, Google) and the CRM
// integration are optional at this stage and tightened to required as their
// build steps land — they are declared here so configuration stays centralized
// and strongly typed.

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4100),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Telephony · Exotel
  EXOTEL_SID: z.string().optional(),
  EXOTEL_API_KEY: z.string().optional(),
  EXOTEL_API_TOKEN: z.string().optional(),
  EXOTEL_SUBDOMAIN: z.string().default("api.exotel.com"),
  EXOTEL_CALLER_ID: z.string().optional(),
  EXOTEL_WEBHOOK_SECRET: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:4100"),

  // Speech-to-Text · Deepgram
  DEEPGRAM_API_KEY: z.string().optional(),

  // Text-to-Speech · ElevenLabs
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),

  // LLM · Anthropic (primary)
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5-20251001"),

  // LLM · Google Generative AI (fallback)
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GOOGLE_MODEL: z.string().default("gemini-2.0-flash"),

  // CRM integration (REST only)
  CRM_API_BASE_URL: z.string().url().default("http://localhost:4000"),
  CRM_API_TOKEN: z.string().optional(),
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

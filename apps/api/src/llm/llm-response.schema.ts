import { z } from "zod";

// Expected structured LLM output when we ask for JSON. We accept either a
// plain string reply or a JSON object matching this schema. This lets us
// robustly validate LLM responses before TTS.
export const LlmResponseSchema = z.object({
  reply: z.string().min(1),
  // LLM returns null when no action — accept null, undefined, or a string
  action: z.string().nullable().optional(),
});

export type LlmResponse = z.infer<typeof LlmResponseSchema>;

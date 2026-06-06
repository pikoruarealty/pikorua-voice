import { z } from "zod";

// Expected structured LLM output when we ask for JSON. We accept either a
// plain string reply or a JSON object matching this schema. This lets us
// robustly validate LLM responses before TTS.
export const LlmResponseSchema = z.object({
  reply: z.string().min(1),
  action: z.string().optional(),
});

export type LlmResponse = z.infer<typeof LlmResponseSchema>;

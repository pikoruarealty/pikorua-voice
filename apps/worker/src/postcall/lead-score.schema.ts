import { z } from "zod";

export const LeadScoreLlmSchema = z.object({
  score: z.number().int().min(0).max(100),
  label: z.enum(["hot", "warm", "cold"]),
  rationale: z.string().min(1),
  timeline: z.enum(["immediate", "short_term", "long_term", "exploring", "unknown"]),
  matchedPos: z.array(z.string()).default([]),
  matchedNeg: z.array(z.string()).default([]),
});

export type LeadScoreLlmResult = z.infer<typeof LeadScoreLlmSchema>;

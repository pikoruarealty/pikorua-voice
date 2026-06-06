import { z } from "zod";

export const createCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  source: z.string().max(80).optional(),
  defaultLocale: z.string().max(16).optional(),
  scriptRef: z.string().max(120).optional(),
  dialWindowStart: z.string().max(5).optional(),
  dialWindowEnd: z.string().max(5).optional(),
  maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
  notes: z.string().optional(),
});

export type CreateCampaignDto = z.infer<typeof createCampaignSchema>;

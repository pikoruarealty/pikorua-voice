import { z } from "zod";

const dialTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");

const campaignTargetSchema = z.object({
  crmLeadId: z.string().max(120).optional(),
  fullName: z.string().max(200).optional(),
  phone: z.string().min(5).max(32),
  locale: z.string().max(16).optional(),
  maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const createCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  status: z.enum(["draft", "active", "paused", "completed", "archived"]).optional(),
  source: z.string().max(80).optional(),
  defaultLocale: z.string().max(16).optional(),
  scriptRef: z.string().max(120).optional(),
  dialWindowStart: dialTimeSchema.optional(),
  dialWindowEnd: dialTimeSchema.optional(),
  maxAttempts: z.coerce.number().int().min(1).max(10).optional(),
  notes: z.string().optional(),
  targets: z.array(campaignTargetSchema).max(500).optional(),
});

export type CreateCampaignDto = z.infer<typeof createCampaignSchema>;

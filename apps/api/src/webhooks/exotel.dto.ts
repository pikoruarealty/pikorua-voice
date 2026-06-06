import { z } from "zod";

// Minimal Exotel webhook schema. Accepts common fields but allows passthrough
// for provider-specific payloads. All external input is validated (Rule 8).
export const exotelWebhookSchema = z
  .object({
    CallSid: z.string().optional(),
    CallStatus: z.string().optional(),
    From: z.string().optional(),
    To: z.string().optional(),
    Digits: z.string().optional(),
    Direction: z.string().optional(),
    Event: z.string().optional(),
    Sid: z.string().optional(),
  })
  .passthrough();

export type ExotelWebhookDto = z.infer<typeof exotelWebhookSchema>;

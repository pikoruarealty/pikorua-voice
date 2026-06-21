import { z } from "zod";

// Minimal Exotel webhook schema. Accepts common fields but allows passthrough
// for provider-specific payloads. All external input is validated (Rule 8).
export const exotelWebhookSchema = z
  .object({
    CallSid: z.string().optional(),
    CallStatus: z.string().optional(),
    Status: z.string().optional(),
    EventType: z.string().optional(),
    From: z.string().optional(),
    To: z.string().optional(),
    Digits: z.string().optional(),
    Direction: z.string().optional(),
    Event: z.string().optional(),
    RecordingUrl: z.string().nullable().optional(),
    HangupCause: z.string().nullable().optional(),
    ConversationDuration: z.union([z.string(), z.number()]).nullable().optional(),
    Sid: z.string().optional(),
  })
  .passthrough();

export type ExotelWebhookDto = z.infer<typeof exotelWebhookSchema>;

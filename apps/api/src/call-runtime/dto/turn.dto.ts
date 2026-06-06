import { z } from "zod";

export const turnPayloadSchema = z.object({
  turnIndex: z.coerce.number().int().min(0),
  audioBase64: z.string().min(1),
});

export type TurnPayload = z.infer<typeof turnPayloadSchema>;

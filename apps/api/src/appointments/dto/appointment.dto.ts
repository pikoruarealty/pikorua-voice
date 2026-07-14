import { z } from "zod";

// Authoritative site-visit create (CRM or agent). `scheduledAt` is a concrete
// ISO-8601 instant (offset or Z) — the reminder/feedback schedulers fire off it.
export const createAppointmentSchema = z.object({
  phone: z.string().min(5).max(32),
  scheduledAt: z.string().datetime({ offset: true }),
  locale: z.string().max(16).optional(),
  fullName: z.string().max(200).optional(),
  crmLeadId: z.string().max(120).optional(),
  callId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
});
export type CreateAppointmentDto = z.infer<typeof createAppointmentSchema>;

// Partial update: reschedule (scheduledAt), change status, or record an outcome.
export const updateAppointmentSchema = z
  .object({
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    status: z
      .enum(["scheduled", "confirmed", "rescheduled", "cancelled", "completed", "no_show"])
      .optional(),
    outcome: z.string().max(2000).optional(),
  })
  .refine((v) => v.scheduledAt != null || v.status != null || v.outcome != null, {
    message: "Provide at least one of scheduledAt, status, outcome",
  });
export type UpdateAppointmentDto = z.infer<typeof updateAppointmentSchema>;

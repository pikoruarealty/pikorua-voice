import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// Pikorua Voice — database schema
//
// This service is standalone: it never references the CRM database. Any link to
// a CRM record is stored as an opaque `crm_lead_id` text reference and resolved
// over REST (Rule 4). Money / pricing / inventory are never persisted here
// (Rule 12). Latency, token usage, and guardrail outcomes are captured on each
// conversation turn (Rules 10, 11, 13).
// ─────────────────────────────────────────────────────────────────────────────

// ─── Reusable timestamp columns ──────────────────────────────────────────────
const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date());

// ─── Enums ───────────────────────────────────────────────────────────────────
export const campaignStatus = pgEnum("campaign_status", [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
]);

export const dialStatus = pgEnum("dial_status", [
  "pending",
  "queued",
  "dialing",
  "in_progress",
  "completed",
  "no_answer",
  "busy",
  "failed",
  "voicemail",
  "do_not_call",
  "exhausted",
]);

export const callDirection = pgEnum("call_direction", ["outbound", "inbound"]);

export const callStatus = pgEnum("call_status", [
  "queued",
  "initiated",
  "ringing",
  "in_progress",
  "completed",
  "no_answer",
  "busy",
  "failed",
  "canceled",
]);

export const turnRole = pgEnum("turn_role", ["caller", "assistant", "system"]);

export const scoreLabel = pgEnum("score_label", ["hot", "warm", "cold"]);

export const leadTimeline = pgEnum("lead_timeline", [
  "immediate",
  "short_term",
  "long_term",
  "exploring",
  "unknown",
]);

export const crmSyncType = pgEnum("crm_sync_type", [
  "create_lead",
  "update_lead",
  "add_note",
  "update_status",
]);

export const crmSyncStatus = pgEnum("crm_sync_status", ["pending", "success", "failed", "skipped"]);

export const callEventType = pgEnum("call_event_type", [
  "escalation",
  "hot_alert",
  "consultant_transfer",
  "guardrail_block",
  "fallback_used",
  "dnc_requested",
  "worker_failure",
]);

export const eventSeverity = pgEnum("event_severity", ["info", "warning", "critical"]);

export const webhookStatus = pgEnum("webhook_status", [
  "received",
  "processed",
  "failed",
  "ignored",
]);

// Lifecycle of a site-visit appointment. `scheduled` is the initial state;
// `confirmed`/`rescheduled`/`cancelled` are set by a reconfirmation call (#2);
// `completed`/`no_show` record what actually happened (drives feedback, #4).
export const appointmentStatus = pgEnum("appointment_status", [
  "scheduled",
  "confirmed",
  "rescheduled",
  "cancelled",
  "completed",
  "no_show",
]);

// ─── campaigns ───────────────────────────────────────────────────────────────
// A batch of outbound concierge calls (Step 5). The concierge script content
// lives in code/config (Step 8) keyed by `script_ref`; only the reference is
// stored here.
export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    status: campaignStatus("status").notNull().default("draft"),
    source: varchar("source", { length: 80 }),
    defaultLocale: varchar("default_locale", { length: 16 }).notNull().default("en-IN"),
    scriptRef: varchar("script_ref", { length: 120 }).notNull().default("default"),
    // Local-time dialing window (HH:MM) enforced by the dial worker.
    dialWindowStart: varchar("dial_window_start", { length: 5 }),
    dialWindowEnd: varchar("dial_window_end", { length: 5 }),
    maxAttempts: smallint("max_attempts").notNull().default(3),
    notes: text("notes"),
    createdAt,
    updatedAt,
  },
  (t) => [index("campaigns_status_idx").on(t.status)],
);

// ─── campaign_targets ────────────────────────────────────────────────────────
// The dial list. Each row is one lead to call; the dial worker (Step 6) pulls
// `pending`/retry-due rows. `crm_lead_id` is an opaque REST reference (Rule 4).
export const campaignTargets = pgTable(
  "campaign_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    crmLeadId: varchar("crm_lead_id", { length: 120 }),
    fullName: varchar("full_name", { length: 200 }),
    phone: varchar("phone", { length: 32 }).notNull(),
    locale: varchar("locale", { length: 16 }),
    dialStatus: dialStatus("dial_status").notNull().default("pending"),
    attempts: smallint("attempts").notNull().default(0),
    maxAttempts: smallint("max_attempts").notNull().default(3),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("campaign_targets_campaign_idx").on(t.campaignId),
    index("campaign_targets_dial_status_idx").on(t.dialStatus),
    index("campaign_targets_next_attempt_idx").on(t.nextAttemptAt),
    // A lead is dialed at most once per campaign.
    uniqueIndex("campaign_targets_campaign_phone_uq").on(t.campaignId, t.phone),
  ],
);

// ─── calls ───────────────────────────────────────────────────────────────────
// One row per call attempt (Steps 6–8). `provider_call_sid` is Exotel's CallSid
// (assigned after initiation; NULLs are allowed and treated as distinct).
export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    targetId: uuid("target_id").references(() => campaignTargets.id, { onDelete: "set null" }),
    crmLeadId: varchar("crm_lead_id", { length: 120 }),
    providerCallSid: varchar("provider_call_sid", { length: 120 }),
    direction: callDirection("direction").notNull().default("outbound"),
    status: callStatus("status").notNull().default("queued"),
    fromNumber: varchar("from_number", { length: 32 }),
    toNumber: varchar("to_number", { length: 32 }),
    locale: varchar("locale", { length: 16 }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    initiatedAt: timestamp("initiated_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    recordingUrl: text("recording_url"),
    hangupCause: varchar("hangup_cause", { length: 80 }),
    transferredTo: varchar("transferred_to", { length: 32 }),
    error: text("error"),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Partial unique index: only enforce uniqueness on non-NULL SIDs so that multiple
    // pre-dispatch call rows (providerCallSid = NULL) can coexist without a constraint error.
    uniqueIndex("calls_provider_call_sid_uq")
      .on(t.providerCallSid)
      .where(sql`${t.providerCallSid} IS NOT NULL`),
    index("calls_campaign_idx").on(t.campaignId),
    index("calls_target_idx").on(t.targetId),
    index("calls_status_idx").on(t.status),
  ],
);

// ─── call_turns ──────────────────────────────────────────────────────────────
// Per-turn transcript of the live STT → LLM → TTS loop (Step 8), with latency
// (Rule 11), token usage (Rule 10), and guardrail outcomes (Rule 13).
export const callTurns = pgTable(
  "call_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    turnIndex: integer("turn_index").notNull(),
    role: turnRole("role").notNull(),
    content: text("content").notNull(),
    locale: varchar("locale", { length: 16 }),
    sttMs: integer("stt_ms"),
    llmMs: integer("llm_ms"),
    ttsMs: integer("tts_ms"),
    totalMs: integer("total_ms"),
    llmModel: varchar("llm_model", { length: 80 }),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    // Cost + latency metrics (0005). LLM cost is a USD figure OpenRouter bills.
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    llmCostUsd: numeric("llm_cost_usd", { precision: 12, scale: 8 }),
    ttsChars: integer("tts_chars"),
    ttfaMs: integer("ttfa_ms"),
    guardrailTriggered: boolean("guardrail_triggered").notNull().default(false),
    guardrailRule: varchar("guardrail_rule", { length: 80 }),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    createdAt,
  },
  (t) => [
    index("call_turns_call_idx").on(t.callId),
    uniqueIndex("call_turns_call_turn_uq").on(t.callId, t.turnIndex),
  ],
);

// ─── lead_scores ─────────────────────────────────────────────────────────────
// Post-call scoring (Step 9). Bands: Hot 75–100, Warm 45–74, Cold 0–44 (PRD).
// Manual overrides are logged with a reason (PRD).
export const leadScores = pgTable(
  "lead_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    crmLeadId: varchar("crm_lead_id", { length: 120 }),
    score: smallint("score").notNull(),
    label: scoreLabel("label").notNull(),
    rationale: text("rationale"),
    signals: jsonb("signals").$type<Record<string, unknown>>(),
    timeline: leadTimeline("timeline").notNull().default("unknown"),
    overrideLabel: scoreLabel("override_label"),
    overrideReason: text("override_reason"),
    overrideBy: varchar("override_by", { length: 120 }),
    overrideAt: timestamp("override_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("lead_scores_call_uq").on(t.callId),
    index("lead_scores_label_idx").on(t.label),
    check("lead_scores_score_range", sql`${t.score} >= 0 AND ${t.score} <= 100`),
  ],
);

// ─── crm_sync_log ────────────────────────────────────────────────────────────
// Every REST sync attempt to the Pikorua CRM (Step 9) — success and failure
// are both recorded (Rule 10).
export const crmSyncLog = pgTable(
  "crm_sync_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "cascade" }),
    crmLeadId: varchar("crm_lead_id", { length: 120 }),
    syncType: crmSyncType("sync_type").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }),
    status: crmSyncStatus("status").notNull().default("pending"),
    httpStatus: integer("http_status"),
    attempts: smallint("attempts").notNull().default(0),
    requestPayload: jsonb("request_payload").$type<Record<string, unknown>>(),
    responsePayload: jsonb("response_payload").$type<Record<string, unknown>>(),
    error: text("error"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("crm_sync_log_call_idx").on(t.callId),
    index("crm_sync_log_status_idx").on(t.status),
    uniqueIndex("crm_sync_log_idempotency_key_uq")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

// ─── call_events ─────────────────────────────────────────────────────────────
// Operational events: escalations, HOT-lead alerts, consultant transfers,
// guardrail blocks, fallbacks, DNC requests, worker failures (Rules 10, 13).
export const callEvents = pgTable(
  "call_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    type: callEventType("type").notNull(),
    severity: eventSeverity("severity").notNull().default("info"),
    message: text("message"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt,
  },
  (t) => [index("call_events_call_idx").on(t.callId), index("call_events_type_idx").on(t.type)],
);

// ─── webhook_events ──────────────────────────────────────────────────────────
// Raw inbound Exotel webhooks (Step 7) for signature verification, idempotency,
// and audit ("inbound webhook received" — Rule 10).
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 40 }).notNull().default("exotel"),
    eventType: varchar("event_type", { length: 80 }),
    eventKey: varchar("event_key", { length: 160 }),
    providerCallSid: varchar("provider_call_sid", { length: 120 }),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
    signatureValid: boolean("signature_valid").notNull().default(false),
    status: webhookStatus("status").notNull().default("received"),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("webhook_events_sid_idx").on(t.providerCallSid),
    index("webhook_events_status_idx").on(t.status),
    uniqueIndex("webhook_events_event_key_uq")
      .on(t.eventKey)
      .where(sql`${t.eventKey} IS NOT NULL`),
  ],
);

// ─── appointments ────────────────────────────────────────────────────────────
// A booked site visit. Created either automatically from a qualifying call
// (source="auto", provisional) or authoritatively via the appointments API
// (source="api", confirmed). The reminder scheduler (#2) fires T-24h / T-2h
// reconfirmation calls off `scheduled_at`; the feedback scheduler (#4) fires a
// post-visit call after it passes. Pricing/inventory are never stored here.
export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The call this was created from / most recently linked to. SET NULL so a
    // deleted call never cascades away the appointment.
    callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    crmLeadId: varchar("crm_lead_id", { length: 120 }),
    fullName: varchar("full_name", { length: 200 }),
    phone: varchar("phone", { length: 32 }).notNull(),
    locale: varchar("locale", { length: 16 }),
    // Concrete visit time — schedulers fire relative to this.
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: appointmentStatus("status").notNull().default("scheduled"),
    // "auto" (parsed from a call, provisional) | "api" (authoritative). An auto
    // create must never overwrite a confirmed/api row.
    source: varchar("source", { length: 16 }).notNull().default("auto"),
    confirmed: boolean("confirmed").notNull().default(false),
    // Set once when each reminder dial is enqueued, so every window fires at most
    // once regardless of how often the scheduler ticks.
    reminderT24At: timestamp("reminder_t24_at", { withTimezone: true }),
    reminderT2At: timestamp("reminder_t2_at", { withTimezone: true }),
    // Set once when the post-visit feedback dial is enqueued (#4).
    feedbackCallAt: timestamp("feedback_call_at", { withTimezone: true }),
    // Free-text result after a reconfirm/feedback call ("confirmed", "moved to
    // Sunday 5 PM", "declined — budget").
    outcome: text("outcome"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("appointments_phone_idx").on(t.phone),
    index("appointments_scheduled_at_idx").on(t.scheduledAt),
    index("appointments_status_idx").on(t.status),
    index("appointments_call_idx").on(t.callId),
  ],
);

// ─── Relations ───────────────────────────────────────────────────────────────
export const campaignsRelations = relations(campaigns, ({ many }) => ({
  targets: many(campaignTargets),
  calls: many(calls),
}));

export const campaignTargetsRelations = relations(campaignTargets, ({ one, many }) => ({
  campaign: one(campaigns, {
    fields: [campaignTargets.campaignId],
    references: [campaigns.id],
  }),
  calls: many(calls),
}));

export const callsRelations = relations(calls, ({ one, many }) => ({
  campaign: one(campaigns, { fields: [calls.campaignId], references: [campaigns.id] }),
  target: one(campaignTargets, {
    fields: [calls.targetId],
    references: [campaignTargets.id],
  }),
  turns: many(callTurns),
  score: one(leadScores, { fields: [calls.id], references: [leadScores.callId] }),
  events: many(callEvents),
  crmSyncs: many(crmSyncLog),
  webhookEvents: many(webhookEvents),
}));

export const callTurnsRelations = relations(callTurns, ({ one }) => ({
  call: one(calls, { fields: [callTurns.callId], references: [calls.id] }),
}));

export const leadScoresRelations = relations(leadScores, ({ one }) => ({
  call: one(calls, { fields: [leadScores.callId], references: [calls.id] }),
  campaign: one(campaigns, { fields: [leadScores.campaignId], references: [campaigns.id] }),
}));

export const crmSyncLogRelations = relations(crmSyncLog, ({ one }) => ({
  call: one(calls, { fields: [crmSyncLog.callId], references: [calls.id] }),
}));

export const callEventsRelations = relations(callEvents, ({ one }) => ({
  call: one(calls, { fields: [callEvents.callId], references: [calls.id] }),
  campaign: one(campaigns, { fields: [callEvents.campaignId], references: [campaigns.id] }),
}));

export const webhookEventsRelations = relations(webhookEvents, ({ one }) => ({
  call: one(calls, { fields: [webhookEvents.callId], references: [calls.id] }),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  call: one(calls, { fields: [appointments.callId], references: [calls.id] }),
  campaign: one(campaigns, { fields: [appointments.campaignId], references: [campaigns.id] }),
}));

// ─── Inferred types (Rule 6: $inferSelect / $inferInsert) ────────────────────
export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;

export type CampaignTarget = typeof campaignTargets.$inferSelect;
export type NewCampaignTarget = typeof campaignTargets.$inferInsert;

export type Call = typeof calls.$inferSelect;
export type NewCall = typeof calls.$inferInsert;

export type CallTurn = typeof callTurns.$inferSelect;
export type NewCallTurn = typeof callTurns.$inferInsert;

export type LeadScore = typeof leadScores.$inferSelect;
export type NewLeadScore = typeof leadScores.$inferInsert;

export type CrmSyncLogEntry = typeof crmSyncLog.$inferSelect;
export type NewCrmSyncLogEntry = typeof crmSyncLog.$inferInsert;

export type CallEvent = typeof callEvents.$inferSelect;
export type NewCallEvent = typeof callEvents.$inferInsert;

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;

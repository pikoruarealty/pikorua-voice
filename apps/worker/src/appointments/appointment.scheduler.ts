import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  AppointmentRepository,
  CampaignRepository,
  CampaignTargetRepository,
} from "@pikorua/db";
import type { Appointment, Campaign } from "@pikorua/db";
import { dueFeedback, dueReminder, type ReminderKind } from "./appointment-window";
import { formatIstWhen } from "./visit-date";

// Default gap between the visit time and the post-visit feedback call (#4).
const DEFAULT_FEEDBACK_DELAY_MS = 3 * 60 * 60 * 1000; // 3 hours after the visit

// Drives the two outbound appointment flows off a single 60s tick:
//   • #2 reconfirmation — a T-24h and a T-2h call before each visit
//   • #4 post-visit feedback — a call after the visit passes
// Each firing creates a dedicated single-target system campaign so the outbound
// call carries the right scriptRef (reconfirm/feedback) and appointment context,
// and so the (campaign_id, phone) unique index never collides across a phone's
// repeat visits. Bookkeeping timestamps on the appointment guarantee once-only.
//
// GATED: placing real calls is opt-in via APPOINTMENTS_OUTBOUND_ENABLED. When off
// the scheduler stays idle (appointments, objection capture, and the API still
// work) so a deploy never surprise-dials anyone.
@Injectable()
export class AppointmentScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("AppointmentScheduler");
  private timer: NodeJS.Timeout | null = null;
  private queue: Queue | null = null;
  private redis: Redis | null = null;
  private ticking = false;

  constructor(
    private readonly config: ConfigService,
    private readonly appointmentRepo: AppointmentRepository,
    private readonly campaignRepo: CampaignRepository,
    private readonly targetRepo: CampaignTargetRepository,
  ) {}

  private enabled(): boolean {
    const raw = this.config.get("APPOINTMENTS_OUTBOUND_ENABLED");
    return raw === true || String(raw ?? "false").toLowerCase() === "true";
  }

  private feedbackDelayMs(): number {
    const v = Number(this.config.get("APPOINTMENT_FEEDBACK_DELAY_MS") ?? DEFAULT_FEEDBACK_DELAY_MS);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_FEEDBACK_DELAY_MS;
  }

  async onModuleInit() {
    if (!this.enabled()) {
      this.logger.log(
        "APPOINTMENTS_OUTBOUND_ENABLED is off — reminder/feedback dialing disabled",
      );
      return;
    }
    const redisUrl = String(this.config.get("REDIS_URL") ?? "");
    if (!redisUrl) {
      this.logger.warn("REDIS_URL not set; appointment scheduler disabled");
      return;
    }
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue("dial", { connection: this.redis });
    this.queue.on("error", (err: Error) => {
      this.logger.warn(`appointment queue error (non-fatal): ${String(err)}`);
    });
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
    await this.tick();
    this.logger.log("Appointment scheduler started");
  }

  // One tick: fire any due reminders, then any due feedback calls. Guarded so a
  // slow tick never overlaps the next.
  async tick(): Promise<void> {
    if (this.ticking || !this.queue) return;
    this.ticking = true;
    try {
      await this.runReminders();
      await this.runFeedback();
    } catch (err) {
      this.logger.warn(`appointment tick failed: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async runReminders(): Promise<void> {
    const now = new Date();
    const candidates = await this.appointmentRepo.findReminderCandidates(now, 100);
    for (const appt of candidates) {
      const kind = dueReminder(
        appt.scheduledAt,
        now,
        appt.reminderT24At != null,
        appt.reminderT2At != null,
      );
      if (!kind) continue;
      // Mark BEFORE enqueue (at-most-once): a failed enqueue skips this reminder
      // rather than risking a repeat dial. The other window still fires later.
      await this.markReminder(appt.id, kind, now);
      await this.enqueueScriptCall(appt, "reconfirm", kind);
    }
  }

  private async runFeedback(): Promise<void> {
    const cutoff = new Date(Date.now() - this.feedbackDelayMs());
    const candidates = await this.appointmentRepo.findFeedbackCandidates(cutoff, 100);
    const now = new Date();
    for (const appt of candidates) {
      if (appt.status === "cancelled") continue;
      if (!dueFeedback(appt.scheduledAt, now, this.feedbackDelayMs(), appt.feedbackCallAt != null)) {
        continue;
      }
      await this.appointmentRepo.update(appt.id, { feedbackCallAt: now });
      await this.enqueueScriptCall(appt, "feedback", "feedback");
    }
  }

  private async markReminder(id: string, kind: ReminderKind, at: Date): Promise<void> {
    await this.appointmentRepo.update(
      id,
      kind === "t24" ? { reminderT24At: at } : { reminderT2At: at },
    );
  }

  // Create a purpose dial for this appointment and enqueue it. Honors an existing
  // do_not_call opt-out. The outbound call resolves its scriptRef from the system
  // campaign (via providerCallSid → call → campaign) and its appointment context
  // from the target metadata.
  private async enqueueScriptCall(
    appt: Appointment,
    scriptRef: "reconfirm" | "feedback",
    tag: string,
  ): Promise<void> {
    if (!this.queue) return;
    try {
      if (await this.targetRepo.isPhoneDoNotCall(appt.phone)) {
        this.logger.log(`Skipping ${tag} dial for appointment=${appt.id} — phone is do_not_call`);
        return;
      }
      const campaign = await this.ensureDialCampaign(appt, scriptRef, tag);
      const target = await this.targetRepo.create({
        campaignId: campaign.id,
        crmLeadId: appt.crmLeadId ?? null,
        fullName: appt.fullName ?? null,
        phone: appt.phone,
        locale: appt.locale ?? campaign.defaultLocale,
        dialStatus: "queued",
        metadata: {
          appointmentId: appt.id,
          scriptRef,
          scheduledAtHuman: formatIstWhen(new Date(appt.scheduledAt)),
        },
      });
      await this.queue.add("dial-target", { targetId: target.id }, { jobId: `dial:${target.id}` });
      this.logger.log(
        `Enqueued ${scriptRef} (${tag}) dial for appointment=${appt.id} target=${target.id}`,
      );
    } catch (err) {
      this.logger.warn(`Failed to enqueue ${tag} dial for appointment=${appt.id}: ${String(err)}`);
    }
  }

  // A single-target system campaign per (appointment, dial) so the phone never
  // collides on the (campaign_id, phone) unique index. Idempotent by `source`.
  private async ensureDialCampaign(
    appt: Appointment,
    scriptRef: "reconfirm" | "feedback",
    tag: string,
  ): Promise<Campaign> {
    const source = `appt:${appt.id}:${tag}`;
    const existing = await this.campaignRepo.findBySource(source);
    if (existing) return existing;
    return this.campaignRepo.create({
      name: scriptRef === "reconfirm" ? "Site-visit reconfirmation" : "Post-visit feedback",
      status: "active",
      source,
      scriptRef,
      defaultLocale: appt.locale ?? "hi-IN",
      notes: `System campaign — ${scriptRef} dial for appointment ${appt.id}.`,
    });
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.queue?.close().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }
}

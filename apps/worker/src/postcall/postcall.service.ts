import { Injectable, Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AxiosError } from "axios";
import {
  LeadScoreRepository,
  CrmSyncLogRepository,
  CallEventRepository,
  CallRepository,
  CallTurnRepository,
  CampaignRepository,
  CampaignTargetRepository,
  AppointmentRepository,
} from "@pikorua/db";
import type { Call, Campaign, NewCallEvent, NewCrmSyncLogEntry, NewLeadScore } from "@pikorua/db";
import { LeadScoreLlmService } from "./lead-score-llm.service";
import type { LeadBreakdown } from "./lead-score.schema";
import { buildCallResultPayload, type CrmEventInput } from "./crm-payload";
import { postCallResult } from "./crm-client";
import { resolveVisitDate, formatIstWhen } from "../appointments/visit-date";

@Injectable()
export class PostCallProcessingService {
  private readonly logger = new Logger("PostCallProcessingService");

  constructor(
    @Inject(LeadScoreRepository) private readonly leadRepo: LeadScoreRepository,
    @Inject(CrmSyncLogRepository) private readonly crmLogRepo: CrmSyncLogRepository,
    @Inject(CallEventRepository) private readonly eventRepo: CallEventRepository,
    @Inject(CallRepository) private readonly callRepo: CallRepository,
    @Inject(CallTurnRepository) private readonly turnRepo: CallTurnRepository,
    @Inject(CampaignRepository) private readonly campaignRepo: CampaignRepository,
    @Inject(CampaignTargetRepository) private readonly targetRepo: CampaignTargetRepository,
    @Inject(AppointmentRepository) private readonly appointmentRepo: AppointmentRepository,
    private readonly scorer: LeadScoreLlmService,
    private readonly config: ConfigService,
  ) {}

  // Lightweight heuristic scoring and CRM sync
  async processCall(callId: string) {
    const call = await this.callRepo.findById(callId);
    if (!call) {
      this.logger.warn(`Call not found: ${callId}`);
      return;
    }

    // Idempotency: this call may be enqueued more than once — the Exotel
    // `completed` webhook AND the gateway both drive post-call so every call
    // reaches the CRM even if one signal is missing. `leadRepo.upsert` and the
    // CRM sync are already idempotent, but the HOT-alert insert (call_events)
    // is not, so a second run would emit a duplicate alert. If this call was
    // already scored, it's fully processed — stop here.
    const existingScore = await this.leadRepo.findByCallId(callId).catch(() => undefined);
    if (existingScore) {
      this.logger.log(`Call ${callId} already scored — skipping duplicate post-call run`);
      return;
    }

    const turns = await this.turnRepo.findByCallId(callId);
    const callerTurns = turns.filter((t) => t.role === "caller");
    const transcriptSource = callerTurns.length > 0 ? callerTurns : turns;
    const transcript = transcriptSource.map((t) => t.content).join(" \n");

    // Heuristic signals (fallback when the LLM scorer is unavailable).
    // "yes" / "no" are intentionally excluded — they appear too freely in
    // real-estate Hinglish ("yes I understand", "no problem") to be reliable
    // signals. Prefer multi-word phrases that indicate clear intent.
    const positive = [
      "interested",
      "site visit",
      "visit",
      "book",
      "appointment",
      "buy",
      "purchase",
      "schedule",
      "when can",
      "call me",
      "contact me",
    ];
    const negative = [
      "not interested",
      "don't call",
      "do not call",
      "stop",
      "unsubscribe",
      "no thanks",
    ];

    const matchedPos: string[] = [];
    const matchedNeg: string[] = [];

    const lc = transcript.toLowerCase();
    for (const p of positive) if (lc.includes(p)) matchedPos.push(p);
    for (const n of negative) if (lc.includes(n)) matchedNeg.push(n);

    // Broker / agent self-identification → not a genuine buyer. Mirrors the LLM
    // scorer's hard "broker → 0" override so the rule STILL holds on the
    // keyword-only fallback (when the LLM scorer is unavailable). Kept to
    // unambiguous real-estate terms: bare "agent" is deliberately excluded
    // (insurance / travel agents are not brokers) while "estate agent" and
    // "property agent" are caught. Devanagari variants cover Hinglish transcripts.
    const BROKER_TERMS = [
      "broker",
      "realtor",
      "dalal",
      "dalaal",
      "estate agent",
      "property dealer",
      "property agent",
      "real estate agent",
      "channel partner",
      "दलाल",
      "ब्रोकर",
    ];
    const matchedBroker = BROKER_TERMS.filter((t) => lc.includes(t));
    const isBrokerHeuristic = matchedBroker.length > 0;

    const timelineHeuristic: NewLeadScore["timeline"] =
      lc.includes("now") || lc.includes("today") || lc.includes("immediately")
        ? "immediate"
        : "unknown";

    const llmScore = await this.scorer.evaluate(transcript, String(call.locale ?? "en-IN"));

    // Heuristic fallback score. A broker/agent self-ID forces 0 (matching the LLM
    // override); otherwise base 50 nudged by positive/negative keyword hits.
    const heuristicScore = isBrokerHeuristic
      ? 0
      : Math.max(0, Math.min(100, Math.round(50 + matchedPos.length * 12 - matchedNeg.length * 20)));
    const score = llmScore?.score ?? heuristicScore;
    const label: NewLeadScore["label"] =
      llmScore?.label ?? (score >= 75 ? "hot" : score >= 45 ? "warm" : "cold");
    const rationale =
      llmScore?.rationale ??
      (isBrokerHeuristic
        ? `broker/agent self-identified (${matchedBroker.join(", ")})`
        : `pos=${matchedPos.length} neg=${matchedNeg.length}`);
    const timeline: NewLeadScore["timeline"] = llmScore?.timeline ?? timelineHeuristic;

    // A minimal breakdown for the broker fallback keeps the CRM "why" surface
    // consistent with the LLM path — profession shows as broker even on fallback.
    const heuristicBreakdown: LeadBreakdown | null = isBrokerHeuristic
      ? {
          professionCategory: "broker",
          profession: matchedBroker[0] ?? null,
          budget: null,
          requirements: null,
          location: null,
          currentResidence: null,
          siteVisit: { intent: false, when: null, gapDays: null },
          sampleHouseInterest: null,
          objections: [],
        }
      : null;
    const breakdown: LeadBreakdown | null = llmScore?.breakdown ?? heuristicBreakdown;

    const signals = llmScore
      ? {
          source: "llm",
          matchedPos: llmScore.matchedPos,
          matchedNeg: llmScore.matchedNeg,
          breakdown: llmScore.breakdown,
        }
      : { source: "heuristic", matchedPos, matchedNeg, matchedBroker, breakdown };

    // Upsert lead score
    try {
      const leadScore: NewLeadScore = {
        callId: call.id,
        campaignId: call.campaignId ?? null,
        crmLeadId: call.crmLeadId ?? null,
        score,
        label,
        rationale,
        signals,
        timeline,
      };
      await this.leadRepo.upsert(leadScore);
    } catch (err) {
      this.logger.warn(
        "Failed to upsert lead score",
        err instanceof Error ? err.stack : String(err),
      );
    }

    // Emit HOT alert
    if (label === "hot") {
      try {
        const event: NewCallEvent = {
          callId: call.id,
          campaignId: call.campaignId ?? null,
          type: "hot_alert",
          severity: "critical",
          message: "Lead scored HOT",
          payload: {
            score,
            matchedPos: signals.matchedPos,
            matchedNeg: signals.matchedNeg,
            source: signals.source,
          },
        };
        await this.eventRepo.create(event);
      } catch (err) {
        this.logger.warn(
          "Failed to create hot alert",
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    // CRM sync: create log entry then attempt REST call if configured
    const crmBase = String(this.config.get("CRM_API_BASE_URL") ?? "");
    const crmToken = String(this.config.get("CRM_API_TOKEN") ?? "");
    const crmHmacSecret = String(this.config.get("CRM_WEBHOOK_HMAC_SECRET") ?? "");
    const syncType = "create_lead" as const;
    const idempotencyKey = `pikorua:${syncType}:${call.id}`;

    const scoredAt = new Date().toISOString();
    const events: CrmEventInput[] =
      label === "hot" ? [{ type: "hot_alert", at: scoredAt, detail: { score } }] : [];

    // Campaign name is best-effort; a lookup failure must not block the sync.
    const campaign = call.campaignId
      ? await this.campaignRepo.findById(call.campaignId).catch(() => null)
      : null;

    // Appointments (#2/#4): update the linked appointment for reconfirm/feedback
    // calls, or auto-create a provisional one from a qualifying concierge call.
    // Best-effort — never blocks scoring or the CRM sync.
    await this.syncAppointment(call, campaign, breakdown).catch((err) =>
      this.logger.warn("Appointment sync failed", err instanceof Error ? err.stack : String(err)),
    );

    const crmPayload = buildCallResultPayload({
      call,
      turns,
      campaign,
      score: {
        value: score,
        label,
        rationale,
        timeline,
        positive: signals.matchedPos ?? [],
        negative: signals.matchedNeg ?? [],
        breakdown,
        source: signals.source,
        scoredAt,
      },
      events,
    });

    const logData: NewCrmSyncLogEntry = {
      callId: call.id,
      crmLeadId: call.crmLeadId ?? null,
      syncType,
      idempotencyKey,
      status: "pending",
      attempts: 0,
      requestPayload: crmPayload,
    };
    const log = await this.crmLogRepo.createOrGetByIdempotencyKey(logData);
    if (log.status === "success") {
      return;
    }

    if (!crmBase) {
      await this.crmLogRepo.updateStatus(log.id, "skipped", {
        responsePayload: { reason: "CRM not configured" },
      });
      return;
    }

    try {
      const resp = await postCallResult(crmBase, crmPayload, {
        bearerToken: crmToken || undefined,
        hmacSecret: crmHmacSecret || undefined,
        idempotencyKey,
      });
      await this.crmLogRepo.updateStatus(log.id, "success", {
        httpStatus: resp.status,
        responsePayload: this.toRecord(resp.data),
        attempts: (log.attempts ?? 0) + 1,
      });
    } catch (err) {
      this.logger.warn("CRM sync failed", err instanceof Error ? err.stack : String(err));
      const axiosErr = err as AxiosError;
      const status = axiosErr?.response?.status ?? null;
      const data = axiosErr?.response?.data ?? { message: String(err) };
      await this.crmLogRepo.updateStatus(log.id, "failed", {
        httpStatus: status,
        responsePayload: this.toRecord(data),
        attempts: (log.attempts ?? 0) + 1,
        error: String(err),
      });
    }
  }

  // Auto-provisional window: an active visit for the same phone within 12h of the
  // resolved time is treated as the same booking (dedup for re-runs / repeat calls).
  private static readonly APPOINTMENT_DEDUP_MS = 12 * 60 * 60 * 1000;

  // The lead's own phone: on an outbound call it's the callee; on an inbound call
  // it's the caller (our ExoPhone is the other side).
  private leadPhone(call: Call): string | null {
    const phone = call.direction === "inbound" ? call.fromNumber : call.toNumber;
    return phone && phone.trim() ? phone.trim() : null;
  }

  private async appointmentIdForCall(call: Call): Promise<string | null> {
    if (!call.targetId) return null;
    const target = await this.targetRepo.findById(call.targetId).catch(() => undefined);
    const md = (target?.metadata ?? {}) as Record<string, unknown>;
    return typeof md.appointmentId === "string" ? md.appointmentId : null;
  }

  // Reconcile the appointment side effects of this call.
  //   • reconfirm call → mark the linked appointment confirmed or cancelled
  //   • feedback call  → mark it completed and record the objection summary
  //   • default call   → auto-create a provisional appointment when a site visit
  //                      was agreed with a resolvable date (the API path handles
  //                      authoritative ones; an api/confirmed row is never touched)
  private async syncAppointment(
    call: Call,
    campaign: Campaign | null | undefined,
    breakdown: LeadBreakdown | null,
  ): Promise<void> {
    const scriptRef = campaign?.scriptRef ?? "default";

    if (scriptRef === "reconfirm" || scriptRef === "feedback") {
      const apptId = await this.appointmentIdForCall(call);
      if (!apptId) return;
      if (scriptRef === "reconfirm") {
        const stillOn = breakdown?.siteVisit?.intent ?? true;
        await this.appointmentRepo.update(apptId, {
          status: stillOn ? "confirmed" : "cancelled",
          confirmed: stillOn,
          outcome: stillOn ? "Reconfirmed on reminder call" : "Declined on reminder call",
        });
      } else {
        const objections = breakdown?.objections ?? [];
        await this.appointmentRepo.update(apptId, {
          status: "completed",
          outcome: objections.length
            ? `Feedback — objections: ${objections.map((o) => o.category).join(", ")}`
            : "Feedback collected — no objection raised",
        });
      }
      return;
    }

    // Default concierge call: provisional appointment from an agreed visit.
    const sv = breakdown?.siteVisit;
    if (!sv?.intent) return;
    const phone = this.leadPhone(call);
    if (!phone) return;
    const scheduledAt = resolveVisitDate(new Date(), sv.gapDays ?? null);
    if (!scheduledAt) return;

    const existing = await this.appointmentRepo.findActiveNear(
      phone,
      scheduledAt,
      PostCallProcessingService.APPOINTMENT_DEDUP_MS,
    );
    if (existing) return;

    await this.appointmentRepo.create({
      callId: call.id,
      campaignId: call.campaignId ?? null,
      crmLeadId: call.crmLeadId ?? null,
      fullName: null,
      phone,
      locale: call.locale ?? null,
      scheduledAt,
      status: "scheduled",
      source: "auto",
      confirmed: false,
      metadata: {
        when: sv.when ?? null,
        gapDays: sv.gapDays ?? null,
        scheduledAtHuman: formatIstWhen(scheduledAt),
      },
    });
    this.logger.log(
      `Auto-created provisional appointment for call=${call.id} at ${scheduledAt.toISOString()}`,
    );
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return { value };
  }
}

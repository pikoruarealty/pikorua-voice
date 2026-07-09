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
} from "@pikorua/db";
import type { NewCallEvent, NewCrmSyncLogEntry, NewLeadScore } from "@pikorua/db";
import { LeadScoreLlmService } from "./lead-score-llm.service";
import type { LeadBreakdown } from "./lead-score.schema";
import { buildCallResultPayload, type CrmEventInput } from "./crm-payload";
import { postCallResult } from "./crm-client";

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

    const timelineHeuristic: NewLeadScore["timeline"] =
      lc.includes("now") || lc.includes("today") || lc.includes("immediately")
        ? "immediate"
        : "unknown";

    const llmScore = await this.scorer.evaluate(transcript, String(call.locale ?? "en-IN"));
    const score =
      llmScore?.score ??
      Math.max(0, Math.min(100, Math.round(50 + matchedPos.length * 12 - matchedNeg.length * 20)));
    const label: NewLeadScore["label"] =
      llmScore?.label ?? (score >= 75 ? "hot" : score >= 45 ? "warm" : "cold");
    const rationale = llmScore?.rationale ?? `pos=${matchedPos.length} neg=${matchedNeg.length}`;
    const timeline: NewLeadScore["timeline"] = llmScore?.timeline ?? timelineHeuristic;
    const signals = llmScore
      ? {
          source: "llm",
          matchedPos: llmScore.matchedPos,
          matchedNeg: llmScore.matchedNeg,
          breakdown: llmScore.breakdown,
        }
      : { source: "heuristic", matchedPos, matchedNeg };

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
        breakdown: llmScore?.breakdown ?? null,
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

  private toRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return { value };
  }
}

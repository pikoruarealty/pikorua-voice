import { Injectable, Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { type AxiosError } from "axios";
import {
  LeadScoreRepository,
  CrmSyncLogRepository,
  CallEventRepository,
  CallRepository,
  CallTurnRepository,
} from "@pikorua/db";
import type { NewCallEvent, NewCrmSyncLogEntry, NewLeadScore } from "@pikorua/db";
import { LeadScoreLlmService } from "./lead-score-llm.service";

@Injectable()
export class PostCallProcessingService {
  private readonly logger = new Logger("PostCallProcessingService");

  constructor(
    @Inject(LeadScoreRepository) private readonly leadRepo: LeadScoreRepository,
    @Inject(CrmSyncLogRepository) private readonly crmLogRepo: CrmSyncLogRepository,
    @Inject(CallEventRepository) private readonly eventRepo: CallEventRepository,
    @Inject(CallRepository) private readonly callRepo: CallRepository,
    @Inject(CallTurnRepository) private readonly turnRepo: CallTurnRepository,
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

    const turns = await this.turnRepo.findByCallId(callId);
    const callerTurns = turns.filter((t) => t.role === "caller");
    const transcriptSource = callerTurns.length > 0 ? callerTurns : turns;
    const transcript = transcriptSource.map((t) => t.content).join(" \n");

    // Heuristic signals (fallback when the LLM scorer is unavailable)
    const positive = [
      "interested",
      "yes",
      "buy",
      "purchase",
      "schedule",
      "demo",
      "call me",
      "contact me",
      "lead",
    ];
    const negative = ["no", "not interested", "stop", "unsubscribe", "no thanks"];

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
      ? { source: "llm", matchedPos: llmScore.matchedPos, matchedNeg: llmScore.matchedNeg }
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
    const syncType = "create_lead" as const;
    const idempotencyKey = `pikorua:${syncType}:${call.id}`;

    const crmPayload = {
      callId: call.id,
      transcript,
      score,
      label,
      crmLeadId: call.crmLeadId,
      source: signals.source,
    };
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
      const url = `${crmBase.replace(/\/$/, "")}/leads`;
      const resp = await axios.post(url, crmPayload, {
        headers: {
          ...(crmToken ? { Authorization: `Bearer ${crmToken}` } : {}),
          "Idempotency-Key": idempotencyKey,
        },
        timeout: 5000,
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

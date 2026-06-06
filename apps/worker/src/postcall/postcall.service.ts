import { Injectable, Inject, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import {
  LeadScoreRepository,
  CrmSyncLogRepository,
  CallEventRepository,
  CallRepository,
  CallTurnRepository,
} from "@pikorua/db";

@Injectable()
export class PostCallProcessingService {
  private readonly logger = new Logger("PostCallProcessingService");

  constructor(
    @Inject(LeadScoreRepository) private readonly leadRepo: LeadScoreRepository,
    @Inject(CrmSyncLogRepository) private readonly crmLogRepo: CrmSyncLogRepository,
    @Inject(CallEventRepository) private readonly eventRepo: CallEventRepository,
    @Inject(CallRepository) private readonly callRepo: CallRepository,
    @Inject(CallTurnRepository) private readonly turnRepo: CallTurnRepository,
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
    const transcript = turns.map((t) => t.content).join(" \n");

    // Heuristic signals
    const positive = ["interested", "yes", "buy", "purchase", "schedule", "demo", "call me", "contact me", "lead"];
    const negative = ["no", "not interested", "stop", "unsubscribe", "no thanks"];

    const matchedPos: string[] = [];
    const matchedNeg: string[] = [];

    const lc = transcript.toLowerCase();
    for (const p of positive) if (lc.includes(p)) matchedPos.push(p);
    for (const n of negative) if (lc.includes(n)) matchedNeg.push(n);

    let score = 50 + matchedPos.length * 12 - matchedNeg.length * 20;
    score = Math.max(0, Math.min(100, Math.round(score)));
    const label = score >= 75 ? "hot" : score >= 45 ? "warm" : "cold";

    const rationale = `pos=${matchedPos.length} neg=${matchedNeg.length}`;

    // timeline heuristic
    const timeline = lc.includes("now") || lc.includes("today") || lc.includes("immediately") ? "immediate" : "unknown";

    // Upsert lead score
    try {
      await this.leadRepo.upsert({
        callId: call.id,
        campaignId: call.campaignId ?? null,
        crmLeadId: call.crmLeadId ?? null,
        score: score as any,
        label: label as any,
        rationale,
        signals: { matchedPos, matchedNeg },
        timeline: timeline as any,
      } as any);
    } catch (err) {
      this.logger.warn("Failed to upsert lead score", err instanceof Error ? err.stack : String(err));
    }

    // Emit HOT alert
    if (label === "hot") {
      try {
        await this.eventRepo.create({
          callId: call.id,
          campaignId: call.campaignId ?? null,
          type: "hot_alert",
          severity: "critical",
          message: "Lead scored HOT",
          payload: { score, matchedPos, matchedNeg },
        } as any);
      } catch (err) {
        this.logger.warn("Failed to create hot alert", err instanceof Error ? err.stack : String(err));
      }
    }

    // CRM sync: create log entry then attempt REST call if configured
    const crmBase = String(this.config.get("CRM_API_BASE_URL") ?? "");
    const crmToken = String(this.config.get("CRM_API_TOKEN") ?? "");
    const syncType = "create_lead" as const;

    const log = await this.crmLogRepo.create({
      callId: call.id,
      crmLeadId: call.crmLeadId ?? null,
      syncType,
      status: "pending",
      attempts: 0,
      requestPayload: { callId: call.id, transcript, score, label },
    } as any);

    if (!crmBase) {
      await this.crmLogRepo.updateStatus(log.id, "skipped", { responsePayload: { reason: "CRM not configured" } } as any);
      return;
    }

    try {
      const url = `${crmBase.replace(/\/$/, "")}/leads`;
      const resp = await axios.post(url, { callId: call.id, transcript, score, label, crmLeadId: call.crmLeadId }, { headers: crmToken ? { Authorization: `Bearer ${crmToken}` } : undefined, timeout: 5000 });
      await this.crmLogRepo.updateStatus(log.id, "success", { httpStatus: resp.status, responsePayload: resp.data, attempts: (log.attempts ?? 0) + 1 } as any);
    } catch (err) {
      this.logger.warn("CRM sync failed", err instanceof Error ? err.stack : String(err));
      const status = err?.response?.status ?? null;
      const data = err?.response?.data ?? { message: String(err) };
      await this.crmLogRepo.updateStatus(log.id, "failed", { httpStatus: status, responsePayload: data, attempts: (log.attempts ?? 0) + 1, error: String(err) } as any);
    }
  }
}

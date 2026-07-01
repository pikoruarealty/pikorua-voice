import type { Call, CallTurn, Campaign } from "@pikorua/db";

/** Score fields as computed by post-call processing, shaped for the CRM payload. */
export interface CrmScoreInput {
  value: number;
  label: "hot" | "warm" | "cold";
  rationale: string;
  timeline: string;
  positive: string[];
  negative: string[];
  source: string;
  scoredAt: string;
}

export interface CrmEventInput {
  type: string;
  at: string;
  detail?: Record<string, unknown>;
}

export interface BuildCallResultParams {
  call: Call;
  turns: CallTurn[];
  campaign?: Campaign | null;
  score: CrmScoreInput;
  events: CrmEventInput[];
}

// The CRM's locale enum is the 2-letter language subtag (hi | en | gu); our rows
// store BCP-47 tags like "hi-IN". Normalize so values line up with their schema.
function shortLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  return locale.split(/[-_]/)[0].toLowerCase();
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Assemble the structured `/call-results` payload (PRD §7.2) from what we already
 * persist: the call row, its transcript turns, the owning campaign, and the
 * computed score. This is stored verbatim in `crm_sync_log.request_payload` so a
 * retry re-sends the exact same body.
 */
export function buildCallResultPayload(params: BuildCallResultParams) {
  const { call, turns, campaign, score, events } = params;

  return {
    callId: call.id,
    crmLeadId: call.crmLeadId ?? null,
    campaign: call.campaignId ? { id: call.campaignId, name: campaign?.name ?? null } : null,
    direction: call.direction,
    call: {
      exotelCallSid: call.providerCallSid ?? null,
      status: call.status,
      from: call.fromNumber ?? null,
      to: call.toNumber ?? null,
      locale: shortLocale(call.locale),
      timestamps: {
        queued: iso(call.queuedAt),
        initiated: iso(call.initiatedAt),
        answered: iso(call.answeredAt),
        ended: iso(call.endedAt),
      },
      durationSec: call.durationSeconds ?? null,
      recordingUrl: call.recordingUrl ?? null,
      hangupCause: call.hangupCause ?? null,
      transferTarget: call.transferredTo ?? null,
    },
    transcript: {
      turns: [...turns]
        .sort((a, b) => a.turnIndex - b.turnIndex)
        .map((turn) => ({
          index: turn.turnIndex,
          role: turn.role,
          text: turn.content,
          locale: shortLocale(turn.locale),
          telemetry: {
            sttLatencyMs: turn.sttMs ?? null,
            llmLatencyMs: turn.llmMs ?? null,
            ttsLatencyMs: turn.ttsMs ?? null,
            tokens: {
              prompt: turn.promptTokens ?? null,
              completion: turn.completionTokens ?? null,
            },
            guardrailFlags: turn.guardrailTriggered && turn.guardrailRule ? [turn.guardrailRule] : [],
          },
        })),
    },
    score: {
      value: score.value,
      label: score.label,
      rationale: score.rationale,
      timeline: score.timeline,
      signals: {
        positive: score.positive,
        negative: score.negative,
      },
      source: score.source,
      scoredAt: score.scoredAt,
    },
    events,
  };
}

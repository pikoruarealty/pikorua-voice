import type { Call, CallTurn, Campaign, CampaignTarget } from "@pikorua/db";
import type { LeadBreakdown } from "./lead-score.schema";

/** Score fields as computed by post-call processing, shaped for the CRM payload. */
export interface CrmScoreInput {
  value: number;
  label: "hot" | "warm" | "cold";
  rationale: string;
  timeline: string;
  positive: string[];
  negative: string[];
  // Per-criterion facts (profession, budget, location, site-visit gap, …) so the
  // CRM can show WHY a lead scored as it did. Null when the LLM scorer didn't run.
  breakdown: LeadBreakdown | null;
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
  // The dial-list row this call came from, when it was an outbound campaign call.
  // Its fullName is a HUMAN-ENTERED name and therefore beats anything the scorer
  // pulls out of a noisy transcript.
  target?: CampaignTarget | null;
}

// The lead's own number — never the ExoPhone.
//
// `call.fromNumber` / `call.toNumber` SWAP by direction: outbound is
// exophone → lead, inbound is lead → exophone. Sending both and letting the CRM
// guess is what produced mangled lead cards, so resolve it here where the
// direction is known for certain.
function leadPhone(call: Call): string | null {
  const phone = call.direction === "inbound" ? call.fromNumber : call.toNumber;
  return normalizePhone(phone);
}

// Normalize to E.164-ish (+91XXXXXXXXXX) so the CRM never has to parse Exotel's
// mixed formats. Exotel returns Indian numbers variously as "09427620852",
// "9427620852" or "+919427620852"; a leading 0 is the domestic trunk prefix, and
// pasting it in front of a country code (the "+0 94276 20852" the CRM displayed)
// produces a number nobody can dial.
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  const bare = digits.replace(/^0+/, ""); // drop the domestic trunk prefix
  if (!bare) return null;
  if (bare.startsWith("91") && bare.length === 12) return `+${bare}`;
  if (bare.length === 10) return `+91${bare}`;
  // Unrecognised shape (short codes, the ExoPhone landline): pass through
  // unprefixed rather than inventing a country code.
  return bare;
}

// The CRM's locale enum is the 2-letter language subtag (hi | en | gu); our rows
// store BCP-47 tags like "hi-IN". Normalize so values line up with their schema.
function shortLocale(locale: string | null | undefined): string | null {
  if (!locale) return null;
  return locale.split(/[-_]/)[0].toLowerCase();
}

// First value that is a non-blank string, else null. The scorer is instructed to
// emit null for undisclosed facts, but models also return "", "null" and "unknown";
// letting those through puts the literal text "unknown" on a CRM lead card.
function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (/^(null|undefined|n\/a|na|unknown|not stated|not provided)$/i.test(trimmed)) continue;
    return trimmed;
  }
  return null;
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
  const { call, turns, campaign, score, events, target } = params;
  const b = score.breakdown;

  return {
    callId: call.id,
    crmLeadId: call.crmLeadId ?? null,
    // Flat contact block the CRM renders directly on the lead card. Every value
    // also exists inside `score.breakdown`; this is the agreed shape so the CRM
    // never has to dig through the score or guess which number is the human.
    lead: {
      // Human-entered dial-list name beats the scorer's transcript extraction:
      // STT mangles names ("મેરા નામ નિખિલે"), a campaign upload does not.
      name: firstNonEmpty(target?.fullName, b?.name),
      phone: leadPhone(call),
      company: firstNonEmpty(b?.company),
      profession: firstNonEmpty(b?.profession),
      // The caller's PREFERRED micro-market, which is what sales acts on — not
      // where they currently live (that stays in breakdown.currentResidence).
      city: firstNonEmpty(b?.location),
      budget: firstNonEmpty(b?.budget),
      requirements: firstNonEmpty(b?.requirements),
    },
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
      breakdown: score.breakdown,
      // Surface objections at the top of the score too (also inside breakdown) so
      // the CRM can show "why they hesitated" without digging into the breakdown.
      objections: score.breakdown?.objections ?? [],
      source: score.source,
      scoredAt: score.scoredAt,
    },
    events,
  };
}

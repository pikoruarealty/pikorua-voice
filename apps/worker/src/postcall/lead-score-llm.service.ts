import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { LeadScoreLlmSchema, type LeadScoreLlmResult } from "./lead-score.schema";

@Injectable()
export class LeadScoreLlmService {
  private readonly logger = new Logger("LeadScoreLlmService");

  constructor(private readonly config: ConfigService) {}

  private buildPrompt(transcript: string, locale: string) {
    return [
      "You are a senior sales-desk analyst for PIKORA Group, an ultra-luxury real-estate advisory in Ahmedabad. Score the lead quality of this post-call transcript for the CRM.",
      "Return STRICT JSON only (no prose, no code fences) with keys: score, label, rationale, timeline, matchedPos, matchedNeg, breakdown.",
      "",
      "HARD RULES — these override the point-based score:",
      '1. If the caller identifies as a broker, agent, realtor, dalal, estate agent, channel partner, or property dealer → breakdown.professionCategory = "broker" and score = 0. They are not genuine buyers.',
      '2. If the caller says they are a builder/developer, OR is enquiring on behalf of a friend/relative (not for themselves) → professionCategory = "builder" or "friend" and score in the 50-60 band.',
      '3. Otherwise the caller is a prospective end-user buyer → professionCategory = "end_user" (or "unknown" if genuinely unclear). Score with the rubric below.',
      "",
      "END-USER RUBRIC — start from a base of 5 and add points for each signal the caller genuinely discloses (final score capped at 100):",
      '• Specific budget figure stated (e.g. "5 crore", not a vague "depends"): +15',
      "• Clear requirement / configuration stated (e.g. 4 BHK, 5 BHK, size): +10",
      "• Preferred location / micro-market stated: +10",
      "• Profession / occupation disclosed (signals paying capacity): +10",
      "• Current residence location disclosed: +5",
      "• Willingness to see the sample house / model flat: +10",
      "• Site-visit intent AND timing (sooner = stronger):",
      "    - visit within the next 7 days: +25",
      "    - within 8-14 days: +15",
      "    - within 15-21 days: +5",
      "    - agreed but no clear/near date, or beyond 3 weeks: 0",
      "  Interpret timing relative to the call date; each additional week of gap drops this by ~10.",
      "",
      "label bands (derive from the FINAL score): hot = 75-100, warm = 45-74, cold = 0-44.",
      "timeline must be one of: immediate, short_term, long_term, exploring, unknown.",
      "matchedPos / matchedNeg: short phrases from the transcript that raised / lowered the score.",
      "breakdown must be an object with keys: professionCategory (broker|builder|friend|end_user|unknown), name (string|null), company (string|null), profession (string|null), budget (string|null), requirements (string|null), location (string|null), currentResidence (string|null), siteVisit { intent (bool), when (string|null), gapDays (int|null) }, sampleHouseInterest (bool|null), objections (array).",
      'name: the caller\'s OWN name exactly as they gave it, transliterated to Latin script ("નિખિલ" → "Nikhil"). The CRM shows it as the lead\'s title. Take only a name the caller states about THEMSELF — never Maya\'s name, the company, or a third party they mention. null if never given.',
      'company: the caller\'s employer or their own business name ("Matangi Traders"). Keep this SEPARATE from profession — profession is the role ("Director", "doctor"), company is the organisation. null if not stated.',
      "objections: for EACH reason the caller gives for hesitating or not proceeding, add { category, detail }. category ∈ price | possession_timeline | location | family_decision | loan_finance | comparison | layout_size | amenities | other. detail = the caller's own words (verbatim or lightly paraphrased). Use [] when the caller raised no objection. This matters most on post-visit feedback calls, where capturing WHY they didn't commit is the goal.",
      "Use ONLY facts present in the transcript. Do not invent details; use null when a fact was not disclosed.",
      `Locale: ${locale}`,
      `Transcript:\n${transcript}`,
    ].join("\n");
  }

  private stripFences(raw: string): string {
    return raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
  }

  private clampResult(result: LeadScoreLlmResult): LeadScoreLlmResult {
    let score = Math.max(0, Math.min(100, Math.round(result.score)));

    // Hard business overrides — enforced in code so the rules can't drift with
    // the model's chosen number (broker → 0; builder/friend → 50-60 band).
    const category = result.breakdown?.professionCategory ?? "unknown";
    if (category === "broker") {
      score = 0;
    } else if (category === "builder" || category === "friend") {
      score = Math.min(60, Math.max(50, score));
    }

    const label = score >= 75 ? "hot" : score >= 45 ? "warm" : "cold";
    return {
      ...result,
      score,
      label,
      matchedPos: result.matchedPos ?? [],
      matchedNeg: result.matchedNeg ?? [],
    };
  }

  async evaluate(transcript: string, locale = "en-IN"): Promise<LeadScoreLlmResult | null> {
    const trimmed = transcript.trim();
    if (!trimmed) {
      return null;
    }

    const provider = String(this.config.get("LLM_SCORING_PROVIDER") ?? "auto") as
      | "openrouter"
      | "auto";
    const prompt = this.buildPrompt(trimmed, locale);

    if (provider === "openrouter" || provider === "auto") {
      const openRouterKey = String(this.config.get("OPENROUTER_API_KEY") ?? "");
      if (openRouterKey) {
        const model = String(
          this.config.get("LLM_SCORING_MODEL") ??
            this.config.get("OPENROUTER_MODEL") ??
            "anthropic/claude-haiku-4-5",
        );
        try {
          const res = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
              model,
              max_tokens: 700,
              messages: [{ role: "user", content: prompt }],
            },
            {
              headers: {
                Authorization: `Bearer ${openRouterKey}`,
                "Content-Type": "application/json",
              },
              timeout: 8000,
            },
          );

          const raw = String(res.data?.choices?.[0]?.message?.content ?? "");
          const parsed = LeadScoreLlmSchema.parse(JSON.parse(this.stripFences(raw)));
          this.logger.log(`LLM scoring(openrouter/${model}) succeeded`);
          return this.clampResult(parsed);
        } catch (err) {
          this.logger.warn(
            "OpenRouter scoring request failed",
            err instanceof Error ? err.stack : String(err),
          );
          return null;
        }
      }
    }

    return null;
  }
}

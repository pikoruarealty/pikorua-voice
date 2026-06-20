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
      "You are scoring a sales call transcript for lead quality.",
      "Return STRICT JSON only with keys: score, label, rationale, timeline, matchedPos, matchedNeg.",
      "score must be an integer 0-100.",
      "label must be one of hot, warm, cold.",
      "timeline must be one of immediate, short_term, long_term, exploring, unknown.",
      `Locale: ${locale}`,
      `Transcript:\n${transcript}`,
      "Use only the transcript. Do not invent facts.",
    ].join("\n\n");
  }

  private stripFences(raw: string): string {
    return raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
  }

  private clampResult(result: LeadScoreLlmResult): LeadScoreLlmResult {
    const score = Math.max(0, Math.min(100, Math.round(result.score)));
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
              max_tokens: 400,
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

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

    const provider = String(this.config.get("LLM_SCORING_PROVIDER") ?? "auto") as "anthropic" | "google" | "auto";
    const prompt = this.buildPrompt(trimmed, locale);

    if (provider === "anthropic" || provider === "auto") {
      const anthropicKey = String(this.config.get("ANTHROPIC_API_KEY") ?? "");
      if (anthropicKey) {
        const model = String(this.config.get("LLM_SCORING_MODEL") ?? this.config.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001");
        try {
          const res = await axios.post(
            "https://api.anthropic.com/v1/messages",
            {
              model,
              max_tokens: 400,
              messages: [{ role: "user", content: prompt }],
            },
            {
              headers: {
                "x-api-key": anthropicKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
              },
              timeout: 8000,
            },
          );

          const raw = String(res.data?.content?.[0]?.text ?? res.data?.content?.[0]?.value ?? "");
          const parsed = LeadScoreLlmSchema.parse(JSON.parse(raw));
          this.logger.log(`LLM scoring(anthropic/${model}) succeeded`);
          return this.clampResult(parsed);
        } catch (err) {
          this.logger.warn("Anthropic scoring request failed", err instanceof Error ? err.stack : String(err));
          if (provider === "anthropic") {
            return null;
          }
        }
      }
    }

    if (provider === "google" || provider === "auto") {
      const googleKey = String(this.config.get("GOOGLE_GENERATIVE_AI_API_KEY") ?? "");
      if (googleKey) {
        const model = String(this.config.get("LLM_SCORING_MODEL") ?? this.config.get("GOOGLE_MODEL") ?? "gemini-2.0-flash");
        try {
          const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            { contents: [{ role: "user", parts: [{ text: prompt }] }] },
            { params: { key: googleKey }, timeout: 8000 },
          );

          const raw = String(res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
          const parsed = LeadScoreLlmSchema.parse(JSON.parse(raw));
          this.logger.log(`LLM scoring(google/${model}) succeeded`);
          return this.clampResult(parsed);
        } catch (err) {
          this.logger.warn("Google scoring request failed", err instanceof Error ? err.stack : String(err));
          if (provider === "google") {
            return null;
          }
        }
      }
    }

    return null;
  }
}

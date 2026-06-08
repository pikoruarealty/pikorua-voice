import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

@Injectable()
export class LlmService {
  private readonly logger = new Logger("LlmService");
  constructor(private readonly config: ConfigService) {}

  async generate(
    prompt: string,
    opts?: { model?: string; provider?: "anthropic" | "google" | "auto" },
  ) {
    const start = Date.now();
    const provider = opts?.provider ?? "auto";

    if (provider === "anthropic" || provider === "auto") {
      const anthropicKey = this.config.get<string>("ANTHROPIC_API_KEY");
      const anthropicModel = String(
        this.config.get("ANTHROPIC_MODEL") ?? opts?.model ?? "claude-haiku-4-5-20251001",
      );
      if (anthropicKey) {
        try {
          const res = await axios.post(
            "https://api.anthropic.com/v1/messages",
            {
              model: anthropicModel,
              max_tokens: 300,
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
          const text: string = res.data?.content?.[0]?.text ?? res.data?.content?.[0]?.value ?? "";
          const ms = Date.now() - start;
          this.logger.log(`LLM(anthropic/${anthropicModel}) ${ms}ms`);
          return { text, llmMs: ms, model: anthropicModel, tokens: null };
        } catch (err) {
          this.logger.warn(
            "Anthropic request failed",
            err instanceof Error ? err.stack : String(err),
          );
          if (provider === "anthropic") {
            throw new ServiceUnavailableException("Anthropic request failed");
          }
        }
      }
    }

    // Google Gemini fallback
    const googleKey = this.config.get<string>("GOOGLE_GENERATIVE_AI_API_KEY");
    const googleModel = String(this.config.get("GOOGLE_MODEL") ?? "gemini-2.0-flash");
    if (provider === "google" || provider === "auto") {
      if (googleKey) {
        try {
          const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:generateContent`,
            { contents: [{ role: "user", parts: [{ text: prompt }] }] },
            { params: { key: googleKey }, timeout: 8000 },
          );
          const text: string = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          const ms = Date.now() - start;
          this.logger.log(`LLM(google/${googleModel}) ${ms}ms`);
          return { text, llmMs: ms, model: googleModel, tokens: null };
        } catch (err) {
          this.logger.error(
            "Google Gemini request failed",
            err instanceof Error ? err.stack : String(err),
          );
          if (provider === "google") {
            throw new ServiceUnavailableException("Google Gemini request failed");
          }
        }
      }
    }

    this.logger.error("No LLM provider available or configured");
    throw new ServiceUnavailableException("No LLM provider available or configured");
  }
}

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

@Injectable()
export class LlmService {
  private readonly logger = new Logger("LlmService");
  constructor(private readonly config: ConfigService) {}

  // Ask Anthropic first; fall back to Google Generative AI on failure.
  async generate(prompt: string, opts?: { model?: string }) {
    const start = Date.now();
    const anthropicKey = this.config.get("ANTHROPIC_API_KEY");
    const anthropicModel = String(this.config.get("ANTHROPIC_MODEL") ?? opts?.model ?? "claude-v1");

    if (anthropicKey) {
      try {
        const res = await axios.post(
          `https://api.anthropic.com/v1/complete`,
          { model: anthropicModel, prompt: prompt, max_tokens: 300 },
          { headers: { Authorization: `Bearer ${anthropicKey}` }, timeout: 5000 },
        );
        const text = res.data?.completion ?? res.data?.text ?? "";
        const ms = Date.now() - start;
        this.logger.log(`LLM(anthropic) ${ms}ms`);
        return { text, llmMs: ms, model: anthropicModel, tokens: null };
      } catch (err) {
        this.logger.warn("Anthropic request failed, falling back to Google", err instanceof Error ? err.stack : String(err));
      }
    }

    // Google fallback
    const googleKey = this.config.get("GOOGLE_GENERATIVE_AI_API_KEY");
    const googleModel = String(this.config.get("GOOGLE_MODEL") ?? "gemini-2.0-flash");
    if (googleKey) {
      try {
        const res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta2/models/${googleModel}:generate`,
          { prompt: { text: prompt } },
          { params: { key: googleKey }, timeout: 5000 },
        );
        const text = res.data?.candidates?.[0]?.content ?? "";
        const ms = Date.now() - start;
        this.logger.log(`LLM(google) ${ms}ms`);
        return { text, llmMs: ms, model: googleModel, tokens: null };
      } catch (err) {
        this.logger.error("Google Generative AI fallback failed", err instanceof Error ? err.stack : String(err));
      }
    }

    this.logger.error("No LLM available");
    return { text: "", llmMs: Date.now() - start, model: "none", tokens: null };
  }
}

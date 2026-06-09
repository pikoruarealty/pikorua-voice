import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

export type LlmMessage = { role: "user" | "assistant"; content: string };

export type LlmResult = {
  text: string;
  llmMs: number;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
};

@Injectable()
export class LlmService {
  private readonly logger = new Logger("LlmService");
  constructor(private readonly config: ConfigService) {}

  async generate(
    messages: LlmMessage[],
    opts?: {
      model?: string;
      provider?: "anthropic" | "google" | "auto";
      systemPrompt?: string;
      maxTokens?: number;
    },
  ): Promise<LlmResult> {
    const start = Date.now();
    const provider = opts?.provider ?? "auto";
    const maxTokens = opts?.maxTokens ?? 300;

    if (provider === "anthropic" || provider === "auto") {
      const anthropicKey = this.config.get<string>("ANTHROPIC_API_KEY");
      const anthropicModel = String(
        this.config.get("ANTHROPIC_MODEL") ?? opts?.model ?? "claude-haiku-4-5-20251001",
      );
      if (anthropicKey) {
        try {
          const body: Record<string, unknown> = {
            model: anthropicModel,
            max_tokens: maxTokens,
            messages,
          };
          if (opts?.systemPrompt) {
            body.system = opts.systemPrompt;
          }
          const res = await axios.post("https://api.anthropic.com/v1/messages", body, {
            headers: {
              "x-api-key": anthropicKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            timeout: 8000,
          });
          const text: string = res.data?.content?.[0]?.text ?? res.data?.content?.[0]?.value ?? "";
          const ms = Date.now() - start;
          const promptTokens: number | null = res.data?.usage?.input_tokens ?? null;
          const completionTokens: number | null = res.data?.usage?.output_tokens ?? null;
          this.logger.log(
            `LLM(anthropic/${anthropicModel}) ${ms}ms prompt=${promptTokens ?? "?"} completion=${completionTokens ?? "?"}`,
          );
          return { text, llmMs: ms, model: anthropicModel, promptTokens, completionTokens };
        } catch (err) {
          const message = this.providerFailureMessage("Anthropic", err);
          this.logger.warn(
            message,
            err instanceof Error ? err.stack : String(err),
          );
          if (provider === "anthropic") {
            throw new ServiceUnavailableException(message);
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
          // Map messages to Gemini format; prepend system prompt as a user turn if provided
          const geminiContents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
          if (opts?.systemPrompt) {
            // Gemini doesn't have a system role — inject as first user message with model ack
            geminiContents.push({
              role: "user",
              parts: [{ text: `[System]: ${opts.systemPrompt}` }],
            });
            geminiContents.push({ role: "model", parts: [{ text: "Understood." }] });
          }
          for (const m of messages) {
            geminiContents.push({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: m.content }],
            });
          }
          const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:generateContent`,
            {
              contents: geminiContents,
              generationConfig: { maxOutputTokens: maxTokens },
            },
            { params: { key: googleKey }, timeout: 8000 },
          );
          const text: string = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          const ms = Date.now() - start;
          const promptTokens: number | null = res.data?.usageMetadata?.promptTokenCount ?? null;
          const completionTokens: number | null =
            res.data?.usageMetadata?.candidatesTokenCount ?? null;
          this.logger.log(
            `LLM(google/${googleModel}) ${ms}ms prompt=${promptTokens ?? "?"} completion=${completionTokens ?? "?"}`,
          );
          return { text, llmMs: ms, model: googleModel, promptTokens, completionTokens };
        } catch (err) {
          const message = this.providerFailureMessage("Google Gemini", err);
          this.logger.error(
            message,
            err instanceof Error ? err.stack : String(err),
          );
          if (provider === "google") {
            throw new ServiceUnavailableException(message);
          }
        }
      }
    }

    // OpenRouter fallback — OpenAI-compatible endpoint
    const openRouterKey = this.config.get<string>("OPENROUTER_API_KEY");
    const openRouterModel = String(this.config.get("OPENROUTER_MODEL") ?? "google/gemini-2.0-flash-lite:free");
    if (openRouterKey) {
      try {
        const orMessages: Array<{ role: string; content: string }> = [];
        if (opts?.systemPrompt) {
          orMessages.push({ role: "system", content: opts.systemPrompt });
        }
        for (const m of messages) {
          orMessages.push({ role: m.role, content: m.content });
        }
        const res = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          { model: openRouterModel, max_tokens: maxTokens, messages: orMessages },
          {
            headers: {
              "Authorization": `Bearer ${openRouterKey}`,
              "Content-Type": "application/json",
            },
            timeout: 12000,
          },
        );
        const text: string = res.data?.choices?.[0]?.message?.content ?? "";
        const ms = Date.now() - start;
        const promptTokens: number | null = res.data?.usage?.prompt_tokens ?? null;
        const completionTokens: number | null = res.data?.usage?.completion_tokens ?? null;
        this.logger.log(`LLM(openrouter/${openRouterModel}) ${ms}ms prompt=${promptTokens ?? "?"} completion=${completionTokens ?? "?"}`);
        return { text, llmMs: ms, model: openRouterModel, promptTokens, completionTokens };
      } catch (err) {
        this.logger.error("OpenRouter request failed", err instanceof Error ? err.stack : String(err));
      }
    }

    this.logger.error("No LLM provider available or configured");
    throw new ServiceUnavailableException("No LLM provider available or configured");
  }

  private providerFailureMessage(provider: string, err: unknown): string {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status === 429) return `${provider} quota or rate limit exceeded`;
    if (status === 401 || status === 403) return `${provider} authentication failed`;
    return `${provider} request failed`;
  }
}

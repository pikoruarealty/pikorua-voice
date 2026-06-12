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

export type LlmOptions = {
  model?: string;
  provider?: "anthropic" | "google" | "auto" | "openrouter";
  systemPrompt?: string;
  maxTokens?: number;
  // Aborts the in-flight request — used by the per-turn watchdog and barge-in.
  signal?: AbortSignal;
};

// Circuit breaker: after this many consecutive failures a provider is skipped
// for OPEN_MS so a down provider doesn't add its full timeout to every turn.
const BREAKER_THRESHOLD = 2;
const BREAKER_OPEN_MS = 30_000;

type ProviderHealth = { consecutiveFailures: number; openUntil: number };

@Injectable()
export class LlmService {
  private readonly logger = new Logger("LlmService");
  private readonly health = new Map<string, ProviderHealth>();

  constructor(private readonly config: ConfigService) {}

  // Voice turns must fail fast: a slow provider is indistinguishable from dead
  // air to the caller. Default 3s per provider (was 8s) — fallback chain still
  // completes well under the old single-provider timeout.
  private llmTimeoutMs(): number {
    return Number(this.config.get("LLM_TIMEOUT_MS") ?? 3000);
  }

  private openRouterTimeoutMs(): number {
    return Number(this.config.get("OPENROUTER_TIMEOUT_MS") ?? 4000);
  }

  private breakerOpen(provider: string): boolean {
    return (this.health.get(provider)?.openUntil ?? 0) > Date.now();
  }

  private recordFailure(provider: string) {
    const h = this.health.get(provider) ?? { consecutiveFailures: 0, openUntil: 0 };
    h.consecutiveFailures += 1;
    if (h.consecutiveFailures >= BREAKER_THRESHOLD) {
      h.openUntil = Date.now() + BREAKER_OPEN_MS;
      this.logger.warn(`Circuit open for LLM provider=${provider} (${BREAKER_OPEN_MS}ms)`);
    }
    this.health.set(provider, h);
  }

  private recordSuccess(provider: string) {
    this.health.set(provider, { consecutiveFailures: 0, openUntil: 0 });
  }

  async generate(messages: LlmMessage[], opts?: LlmOptions): Promise<LlmResult> {
    const start = Date.now();
    const provider = opts?.provider ?? "auto";
    const maxTokens = opts?.maxTokens ?? 300;

    // OpenRouter as PRIMARY (e.g. Claude Haiku via OpenRouter for fast voice
    // turns). On failure, falls through to the Gemini block below.
    if (provider === "openrouter" && !this.breakerOpen("openrouter")) {
      const result = await this.tryOpenRouter(messages, opts, start, maxTokens);
      if (result) return result;
      this.logger.warn("OpenRouter primary failed — falling back to Gemini");
    }

    if (provider === "anthropic" || provider === "auto") {
      const anthropicKey = this.config.get<string>("ANTHROPIC_API_KEY");
      const anthropicModel = String(
        this.config.get("ANTHROPIC_MODEL") ?? opts?.model ?? "claude-haiku-4-5-20251001",
      );
      if (anthropicKey && !this.breakerOpen("anthropic")) {
        try {
          const body = this.anthropicBody(messages, opts, maxTokens, anthropicModel, false);
          const res = await axios.post("https://api.anthropic.com/v1/messages", body, {
            headers: this.anthropicHeaders(anthropicKey),
            timeout: this.llmTimeoutMs(),
            signal: opts?.signal,
          });
          const text: string = res.data?.content?.[0]?.text ?? res.data?.content?.[0]?.value ?? "";
          const ms = Date.now() - start;
          const promptTokens: number | null = res.data?.usage?.input_tokens ?? null;
          const completionTokens: number | null = res.data?.usage?.output_tokens ?? null;
          this.logger.log(
            `LLM(anthropic/${anthropicModel}) ${ms}ms prompt=${promptTokens ?? "?"} completion=${completionTokens ?? "?"}`,
          );
          this.recordSuccess("anthropic");
          return { text, llmMs: ms, model: anthropicModel, promptTokens, completionTokens };
        } catch (err) {
          this.recordFailure("anthropic");
          const message = this.providerFailureMessage("Anthropic", err);
          this.logger.warn(message, err instanceof Error ? err.stack : String(err));
          if (provider === "anthropic") {
            throw new ServiceUnavailableException(message);
          }
        }
      }
    }

    // Google Gemini fallback
    const googleKey = this.config.get<string>("GOOGLE_GENERATIVE_AI_API_KEY");
    const googleModel = String(this.config.get("GOOGLE_MODEL") ?? "gemini-2.0-flash");
    if (provider === "google" || provider === "auto" || provider === "openrouter") {
      if (googleKey && !this.breakerOpen("google")) {
        const geminiContents = this.geminiContents(messages, opts);
        // One retry with a short backoff — free-tier 429s are often transient
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await axios.post(
              `https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:generateContent`,
              {
                contents: geminiContents,
                // Lower temperature keeps Hinglish output on real, common words
                generationConfig: { maxOutputTokens: maxTokens, temperature: 0.6 },
              },
              { params: { key: googleKey }, timeout: this.llmTimeoutMs(), signal: opts?.signal },
            );
            const text: string = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
            const ms = Date.now() - start;
            const promptTokens: number | null = res.data?.usageMetadata?.promptTokenCount ?? null;
            const completionTokens: number | null =
              res.data?.usageMetadata?.candidatesTokenCount ?? null;
            this.logger.log(
              `LLM(google/${googleModel}) ${ms}ms prompt=${promptTokens ?? "?"} completion=${completionTokens ?? "?"}`,
            );
            this.recordSuccess("google");
            return { text, llmMs: ms, model: googleModel, promptTokens, completionTokens };
          } catch (err) {
            const message = this.providerFailureMessage("Google Gemini", err);
            this.logger.error(message, err instanceof Error ? err.stack : String(err));
            if (attempt === 0 && !opts?.signal?.aborted) {
              await new Promise((r) => setTimeout(r, 600));
              continue;
            }
            this.recordFailure("google");
            if (provider === "google") {
              throw new ServiceUnavailableException(message);
            }
          }
        }
      }
    }

    // OpenRouter as last-resort fallback (skip if it was already tried as primary)
    if (provider !== "openrouter" && !this.breakerOpen("openrouter")) {
      const result = await this.tryOpenRouter(messages, opts, start, maxTokens);
      if (result) return result;
    }

    this.logger.error("No LLM provider available or configured");
    throw new ServiceUnavailableException("No LLM provider available or configured");
  }

  // Streaming generation: deltas are forwarded to onDelta as they arrive so the
  // caller can dispatch sentences to TTS while the rest of the reply generates.
  // Provider fallback only happens if NOTHING was emitted yet — once deltas have
  // been spoken downstream we can't switch providers mid-utterance.
  async generateStream(
    messages: LlmMessage[],
    opts: LlmOptions,
    onDelta: (text: string) => void,
  ): Promise<LlmResult> {
    const start = Date.now();
    const provider = opts.provider ?? "auto";
    const maxTokens = opts.maxTokens ?? 300;
    let emitted = false;
    const guardedDelta = (t: string) => {
      if (t) {
        emitted = true;
        onDelta(t);
      }
    };

    const attempts: Array<() => Promise<LlmResult | null>> = [];

    if (provider === "openrouter") {
      attempts.push(() => this.streamOpenRouter(messages, opts, start, maxTokens, guardedDelta));
    }
    if (provider === "anthropic" || provider === "auto") {
      attempts.push(() => this.streamAnthropic(messages, opts, start, maxTokens, guardedDelta));
    }
    if (provider === "google" || provider === "auto" || provider === "openrouter") {
      attempts.push(() => this.streamGemini(messages, opts, start, maxTokens, guardedDelta));
    }
    if (provider !== "openrouter") {
      attempts.push(() => this.streamOpenRouter(messages, opts, start, maxTokens, guardedDelta));
    }

    for (const attempt of attempts) {
      if (opts.signal?.aborted) {
        throw new ServiceUnavailableException("LLM stream aborted");
      }
      try {
        const result = await attempt();
        if (result) return result;
      } catch (err) {
        if (emitted || opts.signal?.aborted) throw err;
        // Nothing spoken yet — safe to fall through to the next provider.
      }
    }

    this.logger.error("No LLM provider available for streaming");
    throw new ServiceUnavailableException("No LLM provider available or configured");
  }

  private anthropicHeaders(key: string) {
    return {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
  }

  private anthropicBody(
    messages: LlmMessage[],
    opts: LlmOptions | undefined,
    maxTokens: number,
    model: string,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      // Lower temperature keeps Hinglish output on real, common words
      temperature: 0.6,
      messages,
    };
    if (stream) body.stream = true;
    if (opts?.systemPrompt) {
      // The system prompt is large (~2.5k words) and identical across every
      // turn of a call — cache_control cuts Anthropic TTFT and input cost.
      body.system = opts.systemPrompt
        ? [{ type: "text", text: opts.systemPrompt, cache_control: { type: "ephemeral" } }]
        : undefined;
    }
    return body;
  }

  private geminiContents(messages: LlmMessage[], opts?: LlmOptions) {
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
    return geminiContents;
  }

  private async streamAnthropic(
    messages: LlmMessage[],
    opts: LlmOptions,
    start: number,
    maxTokens: number,
    onDelta: (text: string) => void,
  ): Promise<LlmResult | null> {
    const key = this.config.get<string>("ANTHROPIC_API_KEY");
    const model = String(this.config.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001");
    if (!key || this.breakerOpen("anthropic")) return null;
    try {
      const res = await axios.post(
        "https://api.anthropic.com/v1/messages",
        this.anthropicBody(messages, opts, maxTokens, model, true),
        {
          headers: this.anthropicHeaders(key),
          responseType: "stream",
          timeout: this.llmTimeoutMs(),
          signal: opts.signal,
        },
      );
      let text = "";
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      await this.consumeSse(res.data, (data) => {
        try {
          const event = JSON.parse(data);
          if (event.type === "message_start") {
            promptTokens = event.message?.usage?.input_tokens ?? null;
          } else if (event.type === "content_block_delta") {
            const delta: string = event.delta?.text ?? "";
            text += delta;
            onDelta(delta);
          } else if (event.type === "message_delta") {
            completionTokens = event.usage?.output_tokens ?? completionTokens;
          }
        } catch {
          // ignore non-JSON SSE payloads
        }
      });
      const ms = Date.now() - start;
      this.logger.log(`LLM-stream(anthropic/${model}) ${ms}ms completion=${completionTokens ?? "?"}`);
      this.recordSuccess("anthropic");
      return { text, llmMs: ms, model, promptTokens, completionTokens };
    } catch (err) {
      this.recordFailure("anthropic");
      this.logger.warn(
        this.providerFailureMessage("Anthropic (stream)", err),
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }

  private async streamGemini(
    messages: LlmMessage[],
    opts: LlmOptions,
    start: number,
    maxTokens: number,
    onDelta: (text: string) => void,
  ): Promise<LlmResult | null> {
    const key = this.config.get<string>("GOOGLE_GENERATIVE_AI_API_KEY");
    const model = String(this.config.get("GOOGLE_MODEL") ?? "gemini-2.0-flash");
    if (!key || this.breakerOpen("google")) return null;
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`,
        {
          contents: this.geminiContents(messages, opts),
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.6 },
        },
        {
          params: { key, alt: "sse" },
          responseType: "stream",
          timeout: this.llmTimeoutMs(),
          signal: opts.signal,
        },
      );
      let text = "";
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      await this.consumeSse(res.data, (data) => {
        try {
          const event = JSON.parse(data);
          const delta: string = event.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          if (delta) {
            text += delta;
            onDelta(delta);
          }
          if (event.usageMetadata) {
            promptTokens = event.usageMetadata.promptTokenCount ?? promptTokens;
            completionTokens = event.usageMetadata.candidatesTokenCount ?? completionTokens;
          }
        } catch {
          // ignore non-JSON SSE payloads
        }
      });
      const ms = Date.now() - start;
      this.logger.log(`LLM-stream(google/${model}) ${ms}ms completion=${completionTokens ?? "?"}`);
      this.recordSuccess("google");
      return { text, llmMs: ms, model, promptTokens, completionTokens };
    } catch (err) {
      this.recordFailure("google");
      this.logger.warn(
        this.providerFailureMessage("Google Gemini (stream)", err),
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }

  private async streamOpenRouter(
    messages: LlmMessage[],
    opts: LlmOptions,
    start: number,
    maxTokens: number,
    onDelta: (text: string) => void,
  ): Promise<LlmResult | null> {
    const key = this.config.get<string>("OPENROUTER_API_KEY");
    if (!key || this.breakerOpen("openrouter")) return null;
    const model = String(this.config.get("OPENROUTER_MODEL") ?? "anthropic/claude-haiku-4.5");
    try {
      const orMessages: Array<{ role: string; content: string }> = [];
      if (opts.systemPrompt) orMessages.push({ role: "system", content: opts.systemPrompt });
      for (const m of messages) orMessages.push({ role: m.role, content: m.content });
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model,
          max_tokens: maxTokens,
          messages: orMessages,
          stream: true,
          provider: { sort: "latency" },
        },
        {
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          responseType: "stream",
          timeout: this.openRouterTimeoutMs(),
          signal: opts.signal,
        },
      );
      let text = "";
      await this.consumeSse(res.data, (data) => {
        if (data === "[DONE]") return;
        try {
          const event = JSON.parse(data);
          const delta: string = event.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            text += delta;
            onDelta(delta);
          }
        } catch {
          // ignore non-JSON SSE payloads
        }
      });
      const ms = Date.now() - start;
      this.logger.log(`LLM-stream(openrouter/${model}) ${ms}ms`);
      this.recordSuccess("openrouter");
      return { text, llmMs: ms, model, promptTokens: null, completionTokens: null };
    } catch (err) {
      this.recordFailure("openrouter");
      this.logger.warn(
        "OpenRouter stream failed",
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }

  // Minimal SSE reader: yields the payload of each `data:` line.
  private async consumeSse(
    stream: AsyncIterable<Buffer>,
    onData: (data: string) => void,
  ): Promise<void> {
    let buffer = "";
    for await (const chunk of stream) {
      buffer += chunk.toString("utf8").replace(/\r/g, "");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("data:")) onData(line.slice(5).trim());
        }
      }
    }
    // Flush a trailing event without the final blank line.
    for (const line of buffer.split("\n")) {
      if (line.startsWith("data:")) onData(line.slice(5).trim());
    }
  }

  // OpenAI-compatible call via OpenRouter. Returns null on failure so callers
  // can fall through to the next provider.
  private async tryOpenRouter(
    messages: LlmMessage[],
    opts: LlmOptions | undefined,
    start: number,
    maxTokens: number,
  ): Promise<LlmResult | null> {
    const openRouterKey = this.config.get<string>("OPENROUTER_API_KEY");
    if (!openRouterKey) return null;
    const openRouterModel = String(
      this.config.get("OPENROUTER_MODEL") ?? "anthropic/claude-haiku-4.5",
    );
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
        {
          model: openRouterModel,
          max_tokens: maxTokens,
          messages: orMessages,
          // Route to the lowest-latency upstream for this model
          provider: { sort: "latency" },
        },
        {
          headers: {
            "Authorization": `Bearer ${openRouterKey}`,
            "Content-Type": "application/json",
          },
          timeout: this.openRouterTimeoutMs(),
          signal: opts?.signal,
        },
      );
      const text: string = res.data?.choices?.[0]?.message?.content ?? "";
      const ms = Date.now() - start;
      const promptTokens: number | null = res.data?.usage?.prompt_tokens ?? null;
      const completionTokens: number | null = res.data?.usage?.completion_tokens ?? null;
      this.logger.log(
        `LLM(openrouter/${openRouterModel}) ${ms}ms prompt=${promptTokens ?? "?"} completion=${completionTokens ?? "?"}`,
      );
      this.recordSuccess("openrouter");
      return { text, llmMs: ms, model: openRouterModel, promptTokens, completionTokens };
    } catch (err) {
      this.recordFailure("openrouter");
      this.logger.error(
        "OpenRouter request failed",
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }

  private providerFailureMessage(provider: string, err: unknown): string {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status === 429) return `${provider} quota or rate limit exceeded`;
    if (status === 401 || status === 403) return `${provider} authentication failed`;
    return `${provider} request failed`;
  }
}

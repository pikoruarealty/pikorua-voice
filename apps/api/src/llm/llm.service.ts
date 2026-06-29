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
  provider?: "auto" | "openrouter";
  systemPrompt?: string;
  maxTokens?: number;
  // Aborts the in-flight request — used by the per-turn watchdog and barge-in.
  signal?: AbortSignal;
};

// Circuit breaker: after this many consecutive failures a provider is skipped
// for OPEN_MS so a down provider doesn't add its full timeout to every turn.
const BREAKER_THRESHOLD = 3;
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
    const maxTokens = opts?.maxTokens ?? 400;

    // OpenRouter primary
    if ((provider === "openrouter" || provider === "auto") && !this.breakerOpen("openrouter")) {
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
    const maxTokens = opts.maxTokens ?? 400;
    let emitted = false;
    const guardedDelta = (t: string) => {
      if (t) {
        emitted = true;
        onDelta(t);
      }
    };

    const attempts: Array<() => Promise<LlmResult | null>> = [];

    // OpenRouter primary (up to 3 attempts), then OpenRouter fallback model
    if (provider === "openrouter" || provider === "auto") {
      attempts.push(() => this.streamOpenRouter(messages, opts, start, maxTokens, guardedDelta));
      attempts.push(() => this.streamOpenRouter(messages, opts, start, maxTokens, guardedDelta));
      attempts.push(() => this.streamOpenRouter(messages, opts, start, maxTokens, guardedDelta));
      const fallbackModel = this.config.get<string>("OPENROUTER_FALLBACK_MODEL");
      if (fallbackModel) {
        attempts.push(() =>
          this.streamOpenRouter(messages, opts, start, maxTokens, guardedDelta, fallbackModel),
        );
      }
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

  private async streamOpenRouter(
    messages: LlmMessage[],
    opts: LlmOptions,
    start: number,
    maxTokens: number,
    onDelta: (text: string) => void,
    modelOverride?: string,
  ): Promise<LlmResult | null> {
    const key = this.config.get<string>("OPENROUTER_API_KEY");
    const breakerKey = modelOverride ? `openrouter-fallback` : "openrouter";
    if (!key || this.breakerOpen(breakerKey)) return null;
    const model =
      modelOverride ?? String(this.config.get("OPENROUTER_MODEL") ?? "anthropic/claude-haiku-4-5");
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
      this.recordSuccess(breakerKey);
      return { text, llmMs: ms, model, promptTokens: null, completionTokens: null };
    } catch (err) {
      this.recordFailure(breakerKey);
      this.logger.warn("OpenRouter stream failed", err instanceof Error ? err.stack : String(err));
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
      this.config.get("OPENROUTER_MODEL") ?? "anthropic/claude-haiku-4-5",
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
            Authorization: `Bearer ${openRouterKey}`,
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

import { Injectable, Inject, Logger, ServiceUnavailableException } from "@nestjs/common";
import { DeepgramService } from "../stt/deepgram.service";
import { DeepgramRealtimeService } from "../stt/deepgram-realtime.service";
import { LlmService, type LlmMessage } from "../llm/llm.service";
import { ElevenlabsService } from "../tts/elevenlabs.service";
import { GuardrailService } from "../llm/guardrail.service";
import { LlmResponseSchema } from "../llm/llm-response.schema";
import {
  CallTurnRepository,
  CallRepository,
  CampaignRepository,
  CampaignTargetRepository,
} from "@pikorua/db";
import type { NewCallTurn } from "@pikorua/db";
import { ConfigService } from "@nestjs/config";

// Per-call state: conversation history + resolved context for prompt building.
// Stamped with lastActivityAt so stale entries can be evicted.
type CallState = {
  history: LlmMessage[];
  systemPrompt: string;
  lastActivityAt: number;
};

// Evict call state after 2 hours of inactivity. This covers a missed terminal
// webhook while keeping memory bounded on a busy server.
const STALE_MS = 2 * 60 * 60 * 1000;

@Injectable()
export class CallRuntimeService {
  private readonly logger = new Logger("CallRuntimeService");

  // Per-call state: conversation history + cached system prompt.
  private readonly calls = new Map<string, CallState>();

  constructor(
    private readonly stt: DeepgramService,
    private readonly sttRealtime: DeepgramRealtimeService,
    private readonly llm: LlmService,
    private readonly tts: ElevenlabsService,
    private readonly guardrail: GuardrailService,
    @Inject(CallTurnRepository) private readonly turnRepo: CallTurnRepository,
    @Inject(CallRepository) private readonly callRepo: CallRepository,
    @Inject(CampaignRepository) private readonly campaignRepo: CampaignRepository,
    @Inject(CampaignTargetRepository) private readonly targetRepo: CampaignTargetRepository,
    private readonly config: ConfigService,
  ) {
    // Periodic stale-entry eviction — runs every 30 minutes.
    const timer = setInterval(() => this.evictStale(), 30 * 60 * 1000);
    // Don't prevent process exit.
    if (timer.unref) timer.unref();
  }

  // Build a detailed system prompt grounded in lead and campaign context.
  // Called once per call (cached in CallState thereafter).
  private async buildSystemPrompt(
    locale: string,
    campaignId: string | null | undefined,
    targetId: string | null | undefined,
  ): Promise<string> {
    let leadName = "the caller";
    let campaignName = "Pikorua";
    let campaignNotes = "";

    try {
      if (campaignId) {
        const campaign = await this.campaignRepo.findById(campaignId);
        if (campaign) {
          campaignName = campaign.name;
          campaignNotes = campaign.notes ?? "";
        }
      }
      if (targetId) {
        const target = await this.targetRepo.findById(targetId);
        if (target?.fullName) leadName = target.fullName;
      }
    } catch (err) {
      this.logger.warn("Failed to fetch lead/campaign context for prompt", String(err));
    }

    const notesBlock = campaignNotes ? `\nCampaign briefing: ${campaignNotes}` : "";

    if (locale.toLowerCase().startsWith("hi") || locale.toLowerCase().startsWith("gu")) {
      return [
        `You are Priya, a friendly outbound concierge at Pikorua — a premium real estate company.`,
        `You are talking with ${leadName} about ${campaignName}.${notesBlock}`,
        `LANGUAGE: Always speak in casual everyday Hinglish — the way young urban Indians actually talk on the phone, mixing simple Hindi and common English words. Examples: "Haan bilkul, koi baat nahi", "Acha to basically baat yeh hai", "dekhiye yeh property kaafi acchi hai", "aapko kab convenient rahega?". Use simple, daily-use words. NEVER use heavy, literary or Sanskritized Hindi (avoid words like "sampatti", "vyakti", "uchit", "kripya") — just say property, person, theek hai, please. Keep English words that everyone uses naturally (call, time, property, area, budget).`,
        `STYLE: Sound like a warm, friendly human on a real phone call — not a scripted bot. Use natural fillers occasionally ("hmm", "acha", "haan ji"). Short replies only — 1 to 2 sentences max. Ask only one question at a time. Use contractions and a relaxed tone.`,
        `RULES: Never quote prices or guarantee returns. If not interested, wrap up warmly.`,
      ].join(" ");
    }

    return [
      `You are Priya, a friendly outbound concierge at Pikorua — a premium real estate company.`,
      `You are talking with ${leadName} about ${campaignName}.${notesBlock}`,
      `STYLE: Be warm, casual, and natural — like a helpful friend, not a call centre agent. Short replies, 1-2 sentences max. Ask only one question per turn.`,
      `RULES: Never quote prices or guarantee returns. If not interested, wrap up warmly.`,
    ].join(" ");
  }

  // Process one audio turn: accepts callId and audio buffer containing caller speech.
  // Returns { audio, transcript, reply } for playback to caller.
  async handleTurn(callId: string, turnIndex: number, audioBuffer: Buffer) {
    const call = await this.callRepo.findById(callId);
    const locale = String(call?.locale ?? this.config.get("GEMINI_LANGUAGE_DEFAULT") ?? "hi-IN");

    const sttStart = Date.now();
    const useRealtime = String(this.config.get("STT_REALTIME_ENABLED") ?? "false") === "true";
    const useLowLatency = String(this.config.get("STT_STREAMING_ENABLED") ?? "false") === "true";
    let sttResult: { text: string; sttMs?: number };
    if (useRealtime) {
      sttResult = await this.sttRealtime
        .transcribeRealtime(audioBuffer, 16000, 5000, locale)
        .catch(async (err) => {
          this.logger.warn(
            "Realtime STT failed, falling back to low-latency",
            err instanceof Error ? err.stack : String(err),
          );
          return this.stt.transcribeLowLatency(audioBuffer, "audio/wav", 300, locale);
        });
    } else if (useLowLatency) {
      sttResult = await this.stt.transcribeLowLatency(audioBuffer, "audio/wav", 300, locale);
    } else {
      sttResult = await this.stt.transcribeBuffer(audioBuffer, "audio/wav", locale);
    }
    const sttEnd = Date.now();
    const { text, sttMs } = sttResult;
    const isHinglish =
      locale.toLowerCase().startsWith("hi") || locale.toLowerCase().startsWith("gu");
    if (!text.trim()) {
      // Empty transcript usually means silence, background noise, or the caller
      // talking over us — not a fatal error. Re-prompt gently instead of killing
      // the call so they get a chance to repeat themselves.
      this.logger.warn(`Empty transcript on call=${callId} turn=${turnIndex} — re-prompting`);
      const reprompt = isHinglish
        ? "Sorry, aapki awaaz thodi clear nahi aayi — ek baar phir bol sakte hain?"
        : "Sorry, I didn't quite catch that — could you say that again?";
      const { audio } = await this.tts.synthesize(reprompt);
      return { audio, transcript: "", reply: reprompt };
    }

    // Retrieve or initialise per-call state.
    // System prompt is built once and cached; subsequent turns reuse it (no extra DB reads).
    let state = this.calls.get(callId);
    if (!state) {
      const systemPrompt = await this.buildSystemPrompt(locale, call?.campaignId, call?.targetId);
      state = { history: [], systemPrompt, lastActivityAt: Date.now() };
      this.calls.set(callId, state);
    }
    state.lastActivityAt = Date.now();
    state.history.push({ role: "user", content: text });

    // Decide LLM provider based on call locale and rollout percentage.
    const llmStart = Date.now();
    let provider: "anthropic" | "google" | "auto" = "auto";
    try {
      const providerOverride = this.config.get<"anthropic" | "google" | "auto" | undefined>(
        "LLM_PROVIDER_OVERRIDE",
      );
      if (providerOverride) {
        provider = providerOverride;
      } else {
        const anthropicPercent = Number(this.config.get("ENGLISH_ANTHROPIC_PERCENT") ?? 25);
        if (locale.toLowerCase().startsWith("en")) {
          provider = Math.random() * 100 < anthropicPercent ? "anthropic" : "google";
        } else {
          provider = "google";
        }
      }
    } catch {
      provider = "auto";
    }

    const {
      text: rawLlmText,
      llmMs,
      model,
      promptTokens,
      completionTokens,
    } = await this.llm.generate(state.history, {
      provider,
      systemPrompt: state.systemPrompt,
      maxTokens: 80,
    });
    const llmEnd = Date.now();

    if (!String(rawLlmText ?? "").trim()) {
      await this.failCall(callId, "LLM returned no reply");
      throw new ServiceUnavailableException("LLM provider returned no reply");
    }

    // Try to parse structured JSON output; fall back to raw text.
    let reply = String(rawLlmText ?? "");
    try {
      const parsed = JSON.parse(reply);
      const validated = LlmResponseSchema.parse(parsed);
      reply = validated.reply;
    } catch {
      // Not JSON or schema mismatch — continue with raw text
    }

    // Guardrail check (hard rules + semantic LLM check).
    const guard = await this.guardrail.check(reply);
    let guardrailTriggered = false;
    let guardrailRule: string | null = null;
    // `spokenReply` is what goes to TTS and is returned to the caller.
    // `reply` (the original LLM output) is kept in history so the model sees its
    // own outputs across turns, not sanitized stand-ins, preserving coherence.
    const spokenReply =
      guard.triggered && guard.replacement && guard.replacement.trim() ? guard.replacement : reply;
    if (guard.triggered) {
      guardrailTriggered = true;
      guardrailRule = guard.rule;
    }

    // Append the LLM's actual output to history (not the guardrail replacement).
    state.history.push({ role: "assistant", content: reply });

    const ttsStart = Date.now();
    const { audio, ttsMs } = await this.tts.synthesize(spokenReply);
    if (audio.length === 0) {
      await this.failCall(callId, "TTS returned empty audio");
      throw new ServiceUnavailableException("TTS provider returned empty audio");
    }

    const sttElapsed = sttMs ?? Math.max(0, sttEnd - sttStart);
    const llmElapsed = llmMs ?? Math.max(0, llmEnd - llmStart);

    const callerTurn: NewCallTurn = {
      callId,
      turnIndex: turnIndex * 2,
      role: "caller",
      content: text,
      locale,
      sttMs: sttElapsed,
      totalMs: sttElapsed,
      guardrailTriggered: false,
      fallbackUsed: false,
    } as NewCallTurn;

    const ttsEnd = Date.now();
    const ttsElapsed = ttsMs ?? Math.max(0, ttsEnd - ttsStart);
    const totalMs = sttElapsed + llmElapsed + ttsElapsed;

    const assistantTurn: NewCallTurn = {
      callId,
      turnIndex: turnIndex * 2 + 1,
      role: "assistant",
      // Store the spoken text in the DB record (audit trail of what the caller heard).
      content: spokenReply,
      locale,
      sttMs: sttElapsed,
      llmMs: llmElapsed,
      ttsMs: ttsElapsed,
      totalMs,
      llmModel: model ?? "",
      promptTokens: promptTokens ?? null,
      completionTokens: completionTokens ?? null,
      guardrailTriggered,
      guardrailRule,
      fallbackUsed: guardrailTriggered,
    } as NewCallTurn;

    try {
      await this.turnRepo.create(callerTurn);
      await this.turnRepo.create(assistantTurn);
    } catch (err) {
      this.logger.warn(
        "Failed to persist call turn",
        err instanceof Error ? err.stack : String(err),
      );
    }

    this.logger.log(
      `Turn ${turnIndex} call=${callId} stt=${sttMs}ms llm=${llmMs}ms tts=${ttsMs}ms tokens=${promptTokens}+${completionTokens}`,
    );
    return { audio, transcript: text, reply: spokenReply };
  }

  // Called by webhook handler when a call reaches a terminal state.
  clearHistory(callId: string) {
    this.calls.delete(callId);
  }

  private evictStale() {
    const cutoff = Date.now() - STALE_MS;
    let evicted = 0;
    for (const [id, state] of this.calls) {
      if (state.lastActivityAt < cutoff) {
        this.calls.delete(id);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.logger.log(`Evicted ${evicted} stale call state(s)`);
    }
  }

  private async failCall(callId: string, reason: string) {
    this.calls.delete(callId);
    try {
      await this.callRepo.update(callId, { status: "failed", error: reason });
    } catch (err) {
      this.logger.warn(
        `Failed to mark call ${callId} failed`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}

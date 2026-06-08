import { Injectable, Inject, Logger, ServiceUnavailableException } from "@nestjs/common";
import { DeepgramService } from "../stt/deepgram.service";
import { DeepgramRealtimeService } from "../stt/deepgram-realtime.service";
import { LlmService } from "../llm/llm.service";
import { ElevenlabsService } from "../tts/elevenlabs.service";
import { GuardrailService } from "../llm/guardrail.service";
import { LlmResponseSchema } from "../llm/llm-response.schema";
import { CallTurnRepository, CallRepository } from "@pikorua/db";
import type { NewCallTurn } from "@pikorua/db";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class CallRuntimeService {
  private readonly logger = new Logger("CallRuntimeService");

  constructor(
    private readonly stt: DeepgramService,
    private readonly sttRealtime: DeepgramRealtimeService,
    private readonly llm: LlmService,
    private readonly tts: ElevenlabsService,
    private readonly guardrail: GuardrailService,
    @Inject(CallTurnRepository) private readonly turnRepo: CallTurnRepository,
    @Inject(CallRepository) private readonly callRepo: CallRepository,
    private readonly config: ConfigService,
  ) {}

  // Process one audio turn: accepts `callId` and audio buffer containing caller speech.
  // Returns { audio: Buffer } for playback to caller.
  async handleTurn(callId: string, turnIndex: number, audioBuffer: Buffer) {
    // Determine call locale early so STT can use appropriate language
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
    const { text, sttMs } = sttResult;
    if (!text.trim()) {
      await this.failCall(callId, "STT returned no transcript");
      throw new ServiceUnavailableException("Speech provider returned no transcript");
    }

    // Build system prompt based on locale. Production would include richer
    // system instructions, conversation history, guardrails and locale handling.
    let systemPrompt = "Respond concisely as Pikorua's Concierge, ask one question.";
    if (locale.toLowerCase().startsWith("hi")) {
      systemPrompt = "आप पिको́रुआ के कंसियरज हैं। संक्षेप में उत्तर दें और एक प्रश्न पूछें।";
    } else if (locale.toLowerCase().startsWith("gu")) {
      systemPrompt = "તમે પિકોરુઆના કન્સિયરજ છો. સંક્ષિપ્ત રીતે જવાબ આપો અને એક પ્રશ્ન પૂછો.";
    } else if (locale.toLowerCase().startsWith("en")) {
      systemPrompt = "Respond concisely as Pikorua's Concierge, ask one question.";
    }

    const prompt = `${systemPrompt}\nCaller said: ${text}`;

    // Decide LLM provider based on call locale and rollout percentage.
    const llmStart = Date.now();
    let provider: "anthropic" | "google" | "auto" = "auto";
    try {
      const anthropicPercent = Number(this.config.get("ENGLISH_ANTHROPIC_PERCENT") ?? 25);
      if (locale.toLowerCase().startsWith("en")) {
        const roll = Math.random() * 100;
        if (roll < anthropicPercent) provider = "anthropic";
        else provider = "google";
      } else {
        provider = "google";
      }
    } catch {
      provider = "auto";
    }

    const { text: rawLlmText, llmMs, model } = await this.llm.generate(prompt, { provider });
    if (!String(rawLlmText ?? "").trim()) {
      await this.failCall(callId, "LLM returned no reply");
      throw new ServiceUnavailableException("LLM provider returned no reply");
    }

    // Try to parse structured JSON output from the LLM; if it matches our
    // schema use the `reply` field, otherwise treat the raw text as the reply.
    let reply = String(rawLlmText ?? "");
    try {
      const parsed = JSON.parse(reply);
      const validated = LlmResponseSchema.parse(parsed);
      reply = validated.reply;
    } catch {
      // Not JSON or schema mismatch — continue with raw text
    }

    // Run guardrail checks and replace reply if needed
    const guard = this.guardrail.check(reply);
    let guardrailTriggered = false;
    let guardrailRule: string | null = null;
    if (guard.triggered) {
      guardrailTriggered = true;
      guardrailRule = guard.rule;
      reply = guard.replacement ?? "";
    }

    const ttsStart = Date.now();
    const { audio, ttsMs } = await this.tts.synthesize(reply);
    if (audio.length === 0) {
      await this.failCall(callId, "TTS returned empty audio");
      throw new ServiceUnavailableException("TTS provider returned empty audio");
    }

    const callerTurn: NewCallTurn = {
      callId,
      turnIndex: turnIndex * 2,
      role: "caller",
      content: text,
      locale,
      sttMs: sttMs ?? Math.max(0, Date.now() - sttStart),
      totalMs: sttMs ?? Math.max(0, Date.now() - sttStart),
      guardrailTriggered: false,
      fallbackUsed: false,
    } as NewCallTurn;

    const totalMs =
      (sttMs ?? Math.max(0, llmStart - sttStart)) +
      (llmMs ?? Math.max(0, ttsStart - llmStart)) +
      (ttsMs ?? Math.max(0, Date.now() - ttsStart));

    const assistantTurn: NewCallTurn = {
      callId,
      turnIndex: turnIndex * 2 + 1,
      role: "assistant",
      content: reply,
      locale,
      sttMs: sttMs ?? Math.max(0, Date.now() - sttStart),
      llmMs: llmMs ?? Math.max(0, Date.now() - llmStart),
      ttsMs: ttsMs ?? Math.max(0, Date.now() - ttsStart),
      totalMs,
      llmModel: model ?? "",
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
      `Handled turn ${turnIndex} for call ${callId} — stt ${sttMs}ms llm ${llmMs}ms tts ${ttsMs}ms`,
    );
    return { audio, transcript: text, reply };
  }

  private async failCall(callId: string, reason: string) {
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

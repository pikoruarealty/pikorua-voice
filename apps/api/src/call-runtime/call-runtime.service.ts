import { Injectable, Inject, Logger } from "@nestjs/common";
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
      sttResult = await this.sttRealtime.transcribeRealtime(audioBuffer).catch(async (err) => {
        this.logger.warn("Realtime STT failed, falling back to low-latency", err instanceof Error ? err.stack : String(err));
        return this.stt.transcribeLowLatency(audioBuffer, "audio/wav", 300, locale);
      });
    } else if (useLowLatency) {
      sttResult = await this.stt.transcribeLowLatency(audioBuffer, "audio/wav", 300, locale);
    } else {
      sttResult = await this.stt.transcribeBuffer(audioBuffer, "audio/wav", locale);
    }
    const { text, sttMs } = sttResult;
    const { text, sttMs } = sttResult;

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

    // Decide LLM provider based on call locale and VAPI percent / IVR mapping
    const llmStart = Date.now();
    let provider: "anthropic" | "google" | "auto" = "auto";
    try {
      const call = await this.callRepo.findById(callId);
      const locale = String(call?.locale ?? this.config.get("GEMINI_LANGUAGE_DEFAULT") ?? "hi-IN");
      const vapiPercent = Number(this.config.get("VAPI_PERCENT") ?? 25);
      // If locale is English, allow Vapi path for configured percent, else use Gemini (google)
      if (locale.toLowerCase().startsWith("en")) {
        const roll = Math.random() * 100;
        if (roll < vapiPercent) provider = "anthropic"; // Vapi path (anthropic/claude)
        else provider = "google"; // Gemini
      } else {
        // Hindi or Gujarati -> Gemini
        provider = "google";
      }
    } catch {
      provider = "auto";
    }

    const { text: rawLlmText, llmMs, model } = await this.llm.generate(prompt, { provider });

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

    // Persist call turn with latency and token usage placeholders
    const newTurn: NewCallTurn = {
      callId,
      turnIndex,
      role: "assistant",
      content: reply,
      locale: "en-IN",
      sttMs: sttMs ?? Math.max(0, Date.now() - sttStart),
      llmMs: llmMs ?? Math.max(0, Date.now() - llmStart),
      ttsMs: ttsMs ?? Math.max(0, Date.now() - ttsStart),
      totalMs: (sttMs ?? 0) + (llmMs ?? 0) + (ttsMs ?? 0),
      llmModel: model ?? "",
      promptTokens: null as any,
      completionTokens: null as any,
      guardrailTriggered,
      guardrailRule,
      fallbackUsed: guardrailTriggered,
    } as NewCallTurn;

    try {
      await this.turnRepo.create(newTurn);
    } catch (err) {
      this.logger.warn("Failed to persist call turn", err instanceof Error ? err.stack : String(err));
    }

    this.logger.log(`Handled turn ${turnIndex} for call ${callId} — stt ${sttMs}ms llm ${llmMs}ms tts ${ttsMs}ms`);
    return { audio };
  }
}

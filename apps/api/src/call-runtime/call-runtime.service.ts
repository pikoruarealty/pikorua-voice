import { Injectable, Inject, Logger } from "@nestjs/common";
import { DeepgramService } from "../stt/deepgram.service";
import { LlmService } from "../llm/llm.service";
import { ElevenlabsService } from "../tts/elevenlabs.service";
import { CallTurnRepository } from "@pikorua/db";
import type { NewCallTurn } from "@pikorua/db";

@Injectable()
export class CallRuntimeService {
  private readonly logger = new Logger("CallRuntimeService");

  constructor(
    private readonly stt: DeepgramService,
    private readonly llm: LlmService,
    private readonly tts: ElevenlabsService,
    @Inject(CallTurnRepository) private readonly turnRepo: CallTurnRepository,
  ) {}

  // Process one audio turn: accepts `callId` and audio buffer containing caller speech.
  // Returns { audio: Buffer } for playback to caller.
  async handleTurn(callId: string, turnIndex: number, audioBuffer: Buffer) {
    const sttStart = Date.now();
    const { text, sttMs } = await this.stt.transcribeBuffer(audioBuffer);

    // Build prompt for LLM (simple form). Production would include system prompt,
    // conversation history, guardrails and locale handling (Rule 12/13).
    const prompt = `Caller said: ${text}\nRespond concisely as Pikorua's Concierge, ask one question.`;

    const llmStart = Date.now();
    const { text: llmText, llmMs, model } = await this.llm.generate(prompt);

    const ttsStart = Date.now();
    const { audio, ttsMs } = await this.tts.synthesize(llmText);

    // Persist call turn with latency and token usage placeholders
    const newTurn: NewCallTurn = {
      callId,
      turnIndex,
      role: "assistant",
      content: llmText,
      locale: "en-IN",
      sttMs: sttMs ?? Math.max(0, Date.now() - sttStart),
      llmMs: llmMs ?? Math.max(0, Date.now() - llmStart),
      ttsMs: ttsMs ?? Math.max(0, Date.now() - ttsStart),
      totalMs: (sttMs ?? 0) + (llmMs ?? 0) + (ttsMs ?? 0),
      llmModel: model ?? "",
      promptTokens: null as any,
      completionTokens: null as any,
      guardrailTriggered: false,
      fallbackUsed: false,
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

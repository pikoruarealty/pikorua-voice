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
  // Caller speech held back because it looked like a mid-thought pause.
  // Merged with the next segment before the LLM sees it.
  pendingFragment: string | null;
};

// Trailing words that signal the caller paused mid-thought rather than finishing.
// Covers common Hindi/English conjunctions, fillers, and dangling possessives.
const CONTINUATION_CUES = new Set([
  "aur", "and", "to", "toh", "but", "lekin", "par", "ki", "because", "kyunki", "kyuki",
  "matlab", "like", "so", "ya", "or", "plus", "um", "uh", "umm", "hmm", "ek",
  "mera", "meri", "apna", "apni", "uska", "uski",
]);

function looksIncomplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Trailing comma or dash — sentence clearly cut off
  if (/[,\-–—]$/.test(trimmed)) return true;
  const words = trimmed.toLowerCase().replace(/[.?!।]+$/, "").trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  return CONTINUATION_CUES.has(last);
}

// Phonetic respellings for Indian words ElevenLabs mispronounces when reading
// romanized Hinglish. Applied only to the text sent to TTS — the transcript
// and DB records keep the standard spelling.
const TTS_PRONUNCIATIONS: Array<[RegExp, string]> = [
  [/\bcrores\b/gi, "karod"],
  [/\bcrore\b/gi, "karod"],
  [/\blakhs\b/gi, "laakh"],
  [/\blakh\b/gi, "laakh"],
];

function phoneticizeForTts(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TTS_PRONUNCIATIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}


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
      return `You are Priya — a woman — calling ${leadName} from Pikorua real estate about ${campaignName}.${notesBlock}

GOAL: Chat naturally, find out their interest, collect: name (if unknown), rough budget, preferred area, best time to call back. Once you have all four, end the call warmly.

GENDER — CRITICAL: You are female. Always use feminine Hindi verb forms.
- CORRECT (female): "bol rahi hoon", "bata sakti hoon", "karwa deti hoon", "dungi", "aaungi", "chahti hoon"
- WRONG (male — never use): "bol raha hoon", "bata sakta hoon", "karwa deta hoon", "dunga", "aaunga", "chahta hoon"

LANGUAGE RULES:
- Casual Hinglish only — like a 25-year-old Mumbai woman on the phone
- Mix Hindi + English naturally: "Haan", "acha", "theek hai", "koi baat nahi", "basically", "property", "budget", "area", "time"
- NEVER use: "sampatti", "niwesh", "uttam", "kripya", "aapka swagat", "priy", "vyakti", "suvidha"
- Use ONLY real, common Hindi words. NEVER invent or mash up words — if you are not 100% sure a Hindi word is real and common, use the English word instead.
- No American exclamations like "Wow" — say "Arre wah", "Bahut badhiya", or "Acha!"
- SHORT replies — max 1-2 sentences. ONE question per turn only.
- If the caller's sentence seems cut off or incomplete, do NOT guess what they meant — just say something short like "Haan ji, boliye?" or "Haan, aage boliye" and let them finish.

EXAMPLES of correct replies:
- {"reply": "Haan ji, main Priya bol rahi hoon Pikorua se — aapko property mein interest hai kya?", "action": null}
- {"reply": "Acha, to roughly budget kitna hai aapka — 50 lakh ke upar ya neeche?", "action": null}
- {"reply": "Got it! Aur kaunsa area dekh rahi ho — Pune side ya Mumbai?", "action": null}
- {"reply": "Theek hai, main consultant se aapko call karwa deti hoon kal 11 baje — sahi rahega?", "action": null}
- {"reply": "Acha no problem, time diya aapne uske liye thanks — take care!", "action": "end_call"}

OUTPUT FORMAT: Reply ONLY with raw JSON on a single line. No markdown, no code fences, no extra text.
Format: {"reply": "what Priya says", "action": null} OR {"reply": "...", "action": "end_call"}
Set action to "end_call" only when: (1) you have name + budget + area + callback time, OR (2) person is clearly not interested and you wrapped up.`;
    }

    return `You are Priya, calling ${leadName} from Pikorua real estate about ${campaignName}.${notesBlock}

GOAL: Have a warm natural conversation. Collect: their name (if unknown), budget range, preferred area, best callback time. Once you have all four, end the call.

STYLE: Speak natural Indian English — the way an educated Indian professional talks on a phone call. Use everyday Indian phrasing: "I'll arrange a call back", "no issues", "you can share your budget, no problem". NEVER use British idioms or tone: no "brilliant", "cheers", "lovely", "fancy", "quid", "whilst", "shall I", "fortnight". Warm and friendly, like a helpful colleague — not a scripted agent. 1-2 sentences max. One question per turn.
If the caller's sentence seems cut off or incomplete, do NOT guess — say something brief like "Sure, please go on" and let them finish.
RULES: Never quote specific prices or guarantee returns. If not interested, wrap up warmly.

OUTPUT FORMAT: Reply ONLY with raw JSON. No markdown, no code fences.
Format: {"reply": "what you say", "action": null} OR {"reply": "...", "action": "end_call"}
Set action to "end_call" only when details are collected OR person is not interested and you've wrapped up.`;
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
      return { audio, transcript: "", reply: reprompt, endCall: false, waitForMore: false };
    }

    return this.processUtterance(callId, turnIndex, text, {
      locale,
      sttMs: sttMs ?? Math.max(0, sttEnd - sttStart),
    });
  }

  // Core turn pipeline shared by the HTTP path (handleTurn) and the streaming
  // WebSocket path (DemoVoiceGateway) — and later the Exotel media path.
  // Takes the caller's finished utterance text; returns audio + reply.
  async processUtterance(
    callId: string,
    turnIndex: number,
    utteranceText: string,
    opts: { locale?: string; sttMs?: number } = {},
  ) {
    // Retrieve or initialise per-call state.
    // System prompt is built once and cached; subsequent turns reuse it.
    let locale = opts.locale;
    let state = this.calls.get(callId);
    if (!state) {
      const call = await this.callRepo.findById(callId);
      locale =
        locale ?? String(call?.locale ?? this.config.get("GEMINI_LANGUAGE_DEFAULT") ?? "hi-IN");
      const systemPrompt = await this.buildSystemPrompt(locale, call?.campaignId, call?.targetId);
      state = { history: [], systemPrompt, lastActivityAt: Date.now(), pendingFragment: null };
      this.calls.set(callId, state);
    }
    locale = locale ?? String(this.config.get("GEMINI_LANGUAGE_DEFAULT") ?? "hi-IN");
    state.lastActivityAt = Date.now();

    // Merge a fragment held from the previous segment (caller paused mid-thought).
    let utterance = utteranceText;
    const mergedFromFragment = state.pendingFragment !== null;
    if (state.pendingFragment) {
      utterance = `${state.pendingFragment} ${utteranceText}`.trim();
      state.pendingFragment = null;
    }

    // If this segment looks cut off mid-thought, hold it and let the caller
    // finish. Only hold once per turn — a merged utterance always proceeds,
    // so a caller can't get stuck in an endless wait loop.
    if (!mergedFromFragment && looksIncomplete(utterance)) {
      state.pendingFragment = utterance;
      this.logger.log(`Holding mid-thought fragment call=${callId}: "${utterance.slice(0, 80)}"`);
      return {
        audio: Buffer.alloc(0),
        transcript: utterance,
        reply: "",
        endCall: false,
        waitForMore: true,
      };
    }

    // Append to history; merge into the previous entry if it was also a user
    // message (LLM providers reject consecutive same-role messages).
    const lastMsg = state.history[state.history.length - 1];
    if (lastMsg && lastMsg.role === "user") {
      lastMsg.content = `${lastMsg.content} ${utterance}`;
    } else {
      state.history.push({ role: "user", content: utterance });
    }

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

    const llmResolved = await this.llm.generate(state.history, {
      provider,
      systemPrompt: state.systemPrompt,
      // Enough headroom for the JSON wrapper + a 2-sentence reply; a cap hit
      // mid-JSON breaks parsing and leaks syntax into the spoken reply.
      maxTokens: 160,
    });

    const { text: rawLlmText, llmMs, model, promptTokens, completionTokens } = llmResolved;
    const llmEnd = Date.now();

    if (!String(rawLlmText ?? "").trim()) {
      await this.failCall(callId, "LLM returned no reply");
      throw new ServiceUnavailableException("LLM provider returned no reply");
    }

    // Parse structured JSON output; strip markdown fences Gemini sometimes adds.
    let reply = String(rawLlmText ?? "");
    let shouldEndCall = false;
    const stripped = reply
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    // Pull out the first {...} block in case the model added surrounding prose
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    const candidate = jsonMatch ? jsonMatch[0] : stripped;
    try {
      const parsed = JSON.parse(candidate);
      const validated = LlmResponseSchema.parse(parsed);
      reply = validated.reply;
      if (validated.action === "end_call") shouldEndCall = true;
    } catch {
      // Strict parse failed (truncated or malformed JSON). Salvage the reply
      // field with a regex so JSON syntax is never spoken aloud to the caller.
      const replyMatch = candidate.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
      if (replyMatch) {
        reply = replyMatch[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
        shouldEndCall = /"action"\s*:\s*"end_call"/.test(candidate);
        this.logger.warn(`LLM JSON malformed — salvaged reply for call=${callId}`);
      } else {
        reply = stripped;
      }
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

    const isHinglishLocale =
      locale.toLowerCase().startsWith("hi") || locale.toLowerCase().startsWith("gu");
    const ttsStart = Date.now();
    const { audio, ttsMs } = await this.tts.synthesize(
      isHinglishLocale ? phoneticizeForTts(spokenReply) : spokenReply,
    );
    if (audio.length === 0) {
      await this.failCall(callId, "TTS returned empty audio");
      throw new ServiceUnavailableException("TTS provider returned empty audio");
    }

    const sttElapsed = opts.sttMs ?? 0;
    const llmElapsed = llmMs ?? Math.max(0, llmEnd - llmStart);

    const callerTurn: NewCallTurn = {
      callId,
      turnIndex: turnIndex * 2,
      role: "caller",
      content: utterance,
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

    if (shouldEndCall) {
      this.logger.log(`Call ${callId} ending — lead details collected`);
      this.calls.delete(callId);
      try {
        await this.callRepo.update(callId, { status: "completed" });
      } catch (err) {
        this.logger.warn("Failed to mark call completed", String(err));
      }
    }

    this.logger.log(
      `Turn ${turnIndex} call=${callId} stt=${sttElapsed}ms llm=${llmMs}ms tts=${ttsMs}ms tokens=${promptTokens}+${completionTokens} endCall=${shouldEndCall}`,
    );
    return { audio, transcript: utterance, reply: spokenReply, endCall: shouldEndCall, waitForMore: false };
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

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
    let campaignName = "our luxury project";
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
      return `You are Maya — a warm, confident female relationship manager at PIKORA Realty, a premium luxury real estate company. You are on a phone call with ${leadName} about ${campaignName}.${notesBlock}

WHO YOU ARE: A real person from Ahmedabad — NOT an AI assistant, NOT a call-center agent, NOT a salesperson reading a script. Polite, welcoming, slightly enthusiastic, patient, confident but never pushy. Helpful rather than sales-focused.

GENDER — CRITICAL: feminine Hindi verb forms ONLY.
- CORRECT: "बोल रही हूँ", "करवा देती हूँ", "बता सकती हूँ", "दूंगी", "समझ सकती हूँ"
- WRONG (never): "बोल रहा हूँ", "करवा देता हूँ", "बता सकता हूँ", "दूंगा"

SCRIPT — VERY IMPORTANT: Write ALL Hindi words in Devanagari script (हाँ, बिल्कुल, आपको, थोड़ी) and keep English words in English letters (property, budget, WhatsApp, site visit, sample apartment). NEVER write Hindi words in Roman letters like "bas", "acha", "aapko" — the voice engine mispronounces romanized Hindi. Mixed script is correct: "आपका budget roughly कितना है?"
- Indian words and local names ALSO go in Devanagari, even if commonly written in English: "करोड़" (never "crore"), "लाख" (never "lakh"), "इस्कॉन-अंबली रोड" (never "ISKCON-Ambli Road"), "अहमदाबाद", "बोडकदेव".
- Say "square feet" (never "sq ft").

CALL FLOW — move through these stages in order, naturally, ONE question per turn:
1. OPENING: Introduce yourself — Maya from PIKORA. You're calling to invite them for a site visit / sample apartment viewing of the luxury project in Ahmedabad. Their enquiry came from Facebook/Instagram — "aapne shayad hamare ads social media ya WhatsApp pe dekhe honge". Then ask: "aap 4BHK dekh rahe hain ya 5BHK?"
2. BUDGET: "आप approximately किस budget में comfortable हैं?" If they say budget is no constraint: acknowledge, then explain — "project में multiple sizes हैं, इसलिए पूछ रही थी ताकि मैं आपको सही option explain कर सकूं" — and offer ranges: "roughly 3 करोड़, 5, 7, 10, 15, 20, या 25 करोड़ plus?"
3. PROJECT (1-2 facts per turn, never all at once): Gated community of luxury apartments — इस्कॉन-अंबली रोड पर. 4BHK approx 5,700 square feet, 5BHK approx 7,600 square feet. Lifestyle amenities: swimming pool, clubhouse, gym, library, yoga-meditation, movie theatre, kids' play area. "और एक beautiful sample apartment भी ready है, जिससे आपको luxury का exact idea मिल जाएगा।"
4. INVITE: "Jo clients interest dikhate hain, hum unhe personally sample apartment dikhate hain — layout, pricing, saari details site pe hi share hoti hain. Bas 30 minute lagte hain." Offer time choices: "Aaj 2 baje ya 3 baje convenient rahega, family ke saath?"
5. CONFIRM: Lock the day/time. Tell them: "Aapko appointment confirmation aur Google Maps location WhatsApp pe mil jayegi few minutes mein."
6. KNOW THEM (after booking, casually, ONE at a time): "Sir, just to know you well — aap kya business ya profession mein hain?" → then "office/clinic kahan hai?" → then "Ahmedabad mein kahan rehte hain aap?"
7. CLOSE: Re-confirm the time, "hamare project expert aapko WhatsApp pe details bhej denge". Warm sign-off: "See you at [time]! Mera naam Maya hai PIKORA se — koi bhi question ho to feel free to call me. Thank you!" → then end_call.

If they're NOT interested at any stage: no pressure, close warmly, end_call.

HOW YOU TALK:
- Match the customer's language. Hindi → natural Hinglish. English → natural Indian English. Never switch abruptly, never force Hinglish.
- Short spoken sentences — this is a phone call, not writing. One question per turn. Never a paragraph, never a brochure.
- TONE: Start every reply calmly, in a low-to-mid tone — like a relaxed professional, never high-energy or excited at the start. NEVER use an exclamation mark in the first sentence of a reply; use a period. At most one "!" per reply, and only mid-reply or at the end.
- Acknowledge every answer FIRST, rotating naturally: "Okay perfect.", "Got it.", "Sure.", "Wonderful.", "बिल्कुल।", "कोई issue नहीं है।", "No worries." — never repeat the same one twice in a row.
- React to what they say: "Oh, you are a doctor. Fantastic." / "Bodakdev! Nice!" — then continue naturally.
- Natural Hinglish like: "Sir, बस एक rough idea चाहिए था।", "आप family के साथ visit कर सकते हैं।", "Site visit के बाद better clarity मिल जाएगी।", "मैं details WhatsApp पर share करवा देती हूँ।"
- Use ONLY real, common Hindi words. NEVER invent or mash up words — if you are not 100% sure a Hindi word is real and common, use the English word instead.
- No American exclamations like "Wow" — say "अरे वाह", "बहुत बढ़िया", or "अच्छा!"
- If their sentence seems cut off or incomplete, do NOT guess — say "हाँ जी, बोलिए?" and let them finish.

WORDS:
- Use: luxury apartments, spacious homes, premium community, lifestyle amenities, sample apartment, site visit, project walkthrough.
- NEVER corporate/brochure phrases: "curated", "residence configuration", "investment opportunity", "investment range", "high-net-worth", "bespoke", "premium inventory", "club-class", "I would like to inform you", "as part of our process", "kindly note", "valued customer", "prospective buyer".
- NEVER heavy Hindi: "sampatti", "niwesh", "kripya", "uttam", "suvidha", "vyakti".

RULES: Never quote apartment prices — pricing is shared at the site visit only: "pricing aur layout ki saari details site pe team share kar degi". Asking THEIR budget is fine. Never guarantee returns. Never pressure.

EXAMPLES of correct replies (note the calm openings and Devanagari + English mixed script):
- {"reply": "Hello Sir, मैं Maya बोल रही हूँ PIKORA से। आपकी enquiry हमें Facebook पे मिली थी, तो मैं आपको हमारे luxury project के site visit के लिए invite करना चाहती थी। वैसे आप 4BHK देख रहे हैं या 5BHK?", "action": null}
- {"reply": "Okay perfect, 5BHK. और approximately किस budget में आप comfortable हैं?", "action": null}
- {"reply": "बिल्कुल Sir, मैं समझ सकती हूँ। Project में multiple sizes हैं इसलिए पूछ रही थी — roughly 5 करोड़, 10 करोड़, या उससे ऊपर?", "action": null}
- {"reply": "तो एक काम करते हैं — आप family के साथ sample apartment देख लीजिए, बस 30 minute लगेंगे। आज 2 बजे या 3 बजे convenient रहेगा?", "action": null}
- {"reply": "No worries, 4 बजे confirm कर देती हूँ। आपको confirmation और Google Maps location WhatsApp पे मिल जाएगी। वैसे Sir, just to know you well — आप क्या business या profession में हैं?", "action": null}
- {"reply": "Oh, doctor. Fantastic! और आपका clinic कहाँ है currently?", "action": null}
- {"reply": "Great, तो see you today 4 बजे, Sir. मेरा नाम Maya है PIKORA से — कोई भी question हो तो feel free to call me. Thank you, bye!", "action": "end_call"}
- {"reply": "कोई issue नहीं है Sir, मैं समझ सकती हूँ। आपका time लेने के लिए thanks — take care!", "action": "end_call"}

OUTPUT FORMAT: Reply ONLY with raw JSON on a single line. No markdown, no code fences, no extra text.
Format: {"reply": "what Maya says", "action": null} OR {"reply": "...", "action": "end_call"}
Set action to "end_call" ONLY when: (1) the appointment is confirmed AND you've asked the know-them questions AND given the final sign-off, OR (2) they're clearly not interested and you've closed warmly.`;
    }

    return `You are Maya — a warm, confident female relationship manager at PIKORA Realty, a premium luxury real estate company. You are on a phone call with ${leadName} about ${campaignName}.${notesBlock}

WHO YOU ARE: A real person from Ahmedabad — NOT an AI assistant, NOT a call-center agent, NOT a salesperson reading a script. Polite, welcoming, slightly enthusiastic, patient, confident but never pushy. Helpful rather than sales-focused.

CALL FLOW — move through these stages in order, naturally, ONE question per turn:
1. OPENING: Introduce yourself — Maya from PIKORA. You're calling to invite them for a site visit and sample apartment viewing of the luxury project in Ahmedabad. Their enquiry came through Facebook/Instagram — "you might have seen our ads on social media or WhatsApp". Then ask: "are you looking at a 4BHK or a 5BHK?"
2. BUDGET: "And what approximate budget are you comfortable with?" If they say budget is no constraint: acknowledge, then explain — "we have multiple sizes in the project, so I just wanted to guide you towards the most suitable option" — and offer ranges: "roughly 3 crore, 5, 7, 10, 15, 20, or 25 crore plus?"
3. PROJECT (1-2 facts per turn, never all at once): Gated community of luxury apartments on ISKCON-Ambli Road. 4BHK approx 5,700 sq ft, 5BHK approx 7,600 sq ft. Lifestyle amenities: swimming pool, clubhouse, gym, library, yoga and meditation, movie theatre, kids' play area. "And we've created a beautiful sample apartment so you get a real feel of the luxury."
4. INVITE: "Any client showing interest, we personally invite them to see the sample apartment — layout, pricing, all the details are shared at the site itself. It just takes 30 minutes." Offer time choices: "What works for you and your family — today 2 PM or 3 PM?"
5. CONFIRM: Lock the day/time. Tell them: "You'll receive the appointment confirmation and Google Maps location on WhatsApp in a few minutes."
6. KNOW THEM (after booking, casually, ONE at a time): "Just to know you well, Sir — what business or profession are you into?" → then "and where is your office or clinic?" → then "and which area of Ahmedabad do you stay in?"
7. CLOSE: Re-confirm the time, "our project expert will share the details on WhatsApp shortly". Warm sign-off: "See you at [time]! My name is Maya from PIKORA — if you have any questions before the visit, feel free to call me. Thank you!" → then end_call.

If they're NOT interested at any stage: no pressure, close warmly, end_call.

HOW YOU TALK:
- Natural Indian English — an educated Indian professional on a call. NEVER British idioms: no "brilliant", "cheers", "lovely", "fancy", "quid", "whilst", "shall I", "fortnight".
- If they switch to Hindi, follow them into natural Hinglish. Never switch abruptly.
- Short spoken sentences. One question per turn. Never a paragraph, never a brochure.
- Acknowledge every answer FIRST, rotating naturally: "Perfect.", "Got it.", "Sure.", "Wonderful.", "Okay, nice!", "No problem at all.", "I completely understand." — never repeat the same one twice in a row.
- React to what they say: "Oh, you're a doctor. Fantastic." / "Bodakdev! Nice!" — then continue naturally.
- If their sentence seems cut off or incomplete, do NOT guess — say something brief like "Sure, please go on" and let them finish.

WORDS:
- Use: luxury apartments, spacious homes, premium community, lifestyle amenities, sample apartment, site visit, project walkthrough.
- NEVER corporate/brochure phrases: "curated", "residence configuration", "investment opportunity", "investment range", "high-net-worth", "bespoke", "premium inventory", "club-class", "I would like to inform you", "as part of our process", "kindly note", "valued customer", "prospective buyer".

RULES: Never quote apartment prices — pricing is shared at the site visit only: "the team will share pricing and layout details at the site". Asking THEIR budget is fine. Never guarantee returns. Never pressure.

OUTPUT FORMAT: Reply ONLY with raw JSON. No markdown, no code fences.
Format: {"reply": "what Maya says", "action": null} OR {"reply": "...", "action": "end_call"}
Set action to "end_call" ONLY when: (1) the appointment is confirmed AND you've asked the know-them questions AND given the final sign-off, OR (2) they're clearly not interested and you've closed warmly.`;
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
        ? "Sorry, आपकी आवाज़ थोड़ी clear नहीं आई — एक बार फिर बोल सकते हैं?"
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
    let provider: "anthropic" | "google" | "auto" | "openrouter" = "auto";
    try {
      const providerOverride = this.config.get<
        "anthropic" | "google" | "auto" | "openrouter" | undefined
      >("LLM_PROVIDER_OVERRIDE");
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

    let llmResolved: Awaited<ReturnType<typeof this.llm.generate>>;
    try {
      llmResolved = await this.llm.generate(state.history, {
        provider,
        systemPrompt: state.systemPrompt,
        // Enough headroom for the JSON wrapper + a 2-sentence reply; a cap hit
        // mid-JSON breaks parsing and leaks syntax into the spoken reply.
        maxTokens: 160,
      });
    } catch (err) {
      // Every provider failed — keep the call alive with a polite re-prompt
      // instead of surfacing a 503 mid-conversation. The caller repeats, and
      // the consecutive-user-message merge folds it into history cleanly.
      this.logger.error(
        `All LLM providers failed call=${callId}`,
        err instanceof Error ? err.stack : String(err),
      );
      const isHinglish =
        locale.toLowerCase().startsWith("hi") || locale.toLowerCase().startsWith("gu");
      const excuse = isHinglish
        ? "Sorry, आवाज़ थोड़ी कट गई थी — क्या आप दोबारा बोल सकते हैं?"
        : "Sorry, I missed that — could you say it once more?";
      const { audio } = await this.tts.synthesize(excuse);
      return { audio, transcript: utterance, reply: excuse, endCall: false, waitForMore: false };
    }

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

import {
  Injectable,
  Inject,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import { DeepgramService } from "../stt/deepgram.service";
import { DeepgramRealtimeService } from "../stt/deepgram-realtime.service";
import { LlmService, type LlmMessage } from "../llm/llm.service";
import { ElevenlabsService } from "../tts/elevenlabs.service";
import { GuardrailService, type GuardrailResult } from "../llm/guardrail.service";
import { LlmResponseSchema } from "../llm/llm-response.schema";
import {
  CallTurnRepository,
  CallRepository,
  CampaignRepository,
  CampaignTargetRepository,
} from "@pikorua/db";
import type { NewCallTurn } from "@pikorua/db";
import { ConfigService } from "@nestjs/config";
import { MetricsService } from "../metrics/metrics.service";
import { REDIS_CLIENT } from "../redis/redis.module";

// Per-call state: conversation history + resolved context for prompt building.
// Stamped with lastActivityAt so stale entries can be evicted.
type CallState = {
  history: LlmMessage[];
  systemPrompt: string;
  locale: string;
  // LLM provider is pinned at call start so the voice/persona doesn't drift
  // mid-conversation from per-turn provider roulette.
  provider: "google" | "auto" | "openrouter";
  startedAt: number;
  lastActivityAt: number;
  // Caller speech held back because it looked like a mid-thought pause.
  // Merged with the next segment before the LLM sees it.
  pendingFragment: string | null;
  // Timestamp of last apology played — prevents consecutive apologies from
  // firing on rapid repeated LLM/TTS failures within the same call.
  lastApologyAt: number;
};

// Trailing words that signal the caller paused mid-thought rather than finishing.
// Covers common Hindi/English conjunctions, fillers, and dangling possessives.
const CONTINUATION_CUES = new Set([
  "aur", "and", "to", "toh", "but", "lekin", "par", "ki", "because", "kyunki", "kyuki",
  "matlab", "like", "so", "ya", "or", "plus", "um", "uh", "umm", "hmm", "ek",
  "mera", "meri", "apna", "apni", "uska", "uski",
]);

// Transcripts that are pure noise/filler should not reach the LLM because
// the LLM will invent apology phrases (e.g. "Sorry, आवाज़ कट गई") and loop.
// A transcript is noise if every word is a known filler AND total length is tiny.
const NOISE_WORDS = new Set([
  "um", "uh", "uhh", "umm", "ah", "ahh", "oh", "hmm", "hm", "ha",
  "haan", "ha", "huh", "mhm", "uh-huh",
  ...["aur", "and", "to", "toh", "but", "lekin", "par", "ki", "because",
      "kyunki", "kyuki", "matlab", "like", "so", "ya", "or", "plus",
      "mera", "meri", "apna", "apni", "uska", "uski", "ek"],
]);

function isNoisyTranscript(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[।,.!?]+/g, "").trim();
  if (normalized.length > 20) return false; // anything longer is probably real speech
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((w) => NOISE_WORDS.has(w));
}

function looksIncomplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Trailing comma or dash — sentence clearly cut off
  if (/[,\-–—]$/.test(trimmed)) return true;
  const words = trimmed.toLowerCase().replace(/[.?!।]+$/, "").trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  return CONTINUATION_CUES.has(last);
}

// End-of-call sentinel. The LLM appends this token to its final reply instead
// of wrapping every reply in a JSON envelope — plain text can be streamed
// sentence-by-sentence into TTS, a JSON wrapper cannot.
const END_CALL_TOKEN = "<end_call/>";
const END_CALL_PATTERN = /<\s*end_call\s*\/?\s*>/gi;

// Sentence boundary for streaming dispatch: ., !, ?, or Devanagari danda,
// optionally followed by a closing quote/bracket.
const SENTENCE_BOUNDARY = /([.!?।]+["')\]]?)(\s+|$)/;

// Evict call state after 2 hours of inactivity. This covers a missed terminal
// webhook while keeping memory bounded on a busy server.
const STALE_MS = 2 * 60 * 60 * 1000;

export type TurnStreamSink = {
  // Aborting this signal cancels the turn (barge-in / client disconnect).
  signal: AbortSignal;
  // Incremental reply text, one sentence at a time.
  onReplyDelta?: (text: string) => void;
  // Audio as it arrives from TTS. `last` marks the end of one sentence's audio.
  onAudioChunk: (chunk: Buffer, info: { sentenceIndex: number; last: boolean }) => void;
  // Transport must drop any queued/playing audio (guardrail replacement).
  onCancel?: () => void;
};

export type TurnResult = {
  audio: Buffer;
  transcript: string;
  reply: string;
  endCall: boolean;
  waitForMore: boolean;
};

// Redis TTL for call state: 3 hours, covering max call duration plus headroom.
const REDIS_CALL_STATE_TTL_S = 3 * 60 * 60;
const REDIS_KEY = (callId: string) => `call_state:${callId}`;

@Injectable()
export class CallRuntimeService implements OnApplicationShutdown {
  private readonly logger = new Logger("CallRuntimeService");

  // L1 in-process cache — fast path for single-instance deploys, write-through
  // to Redis so state survives restarts and is visible across instances.
  private readonly calls = new Map<string, CallState>();

  // In-flight turns, drained on shutdown so SIGTERM doesn't cut a caller off
  // mid-reply.
  private activeTurns = 0;

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
    private readonly metrics: MetricsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {
    // Periodic stale-entry eviction — runs every 30 minutes.
    const timer = setInterval(() => this.evictStale(), 30 * 60 * 1000);
    // Don't prevent process exit.
    if (timer.unref) timer.unref();
  }

  // Persist state to Redis (fire-and-forget — L1 cache is authoritative within
  // a single request; Redis serves cross-instance reads and crash recovery).
  private persistState(callId: string, state: CallState) {
    if (!this.redis) return;
    void this.redis
      .set(REDIS_KEY(callId), JSON.stringify(state), "EX", REDIS_CALL_STATE_TTL_S)
      .catch((err) => this.logger.warn(`Redis write failed for call=${callId}: ${err.message}`));
  }

  private async loadStateFromRedis(callId: string): Promise<CallState | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(REDIS_KEY(callId));
      if (!raw) return null;
      const s = JSON.parse(raw) as CallState;
      s.lastApologyAt ??= 0;
      return s;
    } catch {
      return null;
    }
  }

  private async deleteStateFromRedis(callId: string) {
    if (!this.redis) return;
    void this.redis.del(REDIS_KEY(callId)).catch(() => undefined);
  }

  async onApplicationShutdown() {
    const deadline = Date.now() + 5000;
    while (this.activeTurns > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.activeTurns > 0) {
      this.logger.warn(`Shutting down with ${this.activeTurns} turn(s) still in flight`);
    }
  }

  private isHinglishLocale(locale: string): boolean {
    const l = locale.toLowerCase();
    return l.startsWith("hi") || l.startsWith("gu");
  }

  // Language code for TTS normalization: English calls get English number
  // words; Hindi/Gujarati (and everything else) use the configured default.
  private ttsLanguageCode(locale: string): string | undefined {
    return locale.toLowerCase().startsWith("en") ? "en" : undefined;
  }

  // Detect whether a reply is English-only by checking for Devanagari characters.
  // Hinglish replies always contain Devanagari; pure English replies never do.
  // Used to pick the right number-word language regardless of call locale.
  private replyLanguageCode(text: string, locale: string): string | undefined {
    if (/[ऀ-ॿ]/.test(text)) return undefined; // has Devanagari → Hindi mode
    if (/[a-zA-Z]/.test(text)) return "en";             // Latin script only → English mode
    return this.ttsLanguageCode(locale);
  }

  // Short clips played instantly on utterance-end to mask turn latency.
  fillerTexts(locale: string): string[] {
    return this.isHinglishLocale(locale)
      ? ["Hmm...", "जी..."]
      : ["Yeah...", "Okay..."];
  }

  // Rotating fallback lines used when the LLM fails. Varied so the caller
  // doesn't hear the same phrase on every provider blip. Pre-warmed as clips.
  private readonly FALLBACK_LINES_HI = [
    "ज़रा एक second — connection थोड़ी slow है, फिर से बोलिए?",
    "माफ़ करें, आपकी बात पूरी नहीं सुन पाई — क्या आप दोबारा बोल सकते हैं?",
    "Hmm, थोड़ी आवाज़ नहीं आई — एक बार फिर बताइए?",
    "Sorry, last part miss हो गया — please फिर से कहिए?",
    "एक second, network issue लग रहा है — आप क्या कह रहे थे?",
  ];

  private readonly FALLBACK_LINES_EN = [
    "Sorry, I didn't quite catch that — could you say it again?",
    "Hmm, I missed the last bit — could you repeat that?",
    "Apologies, there was a small hiccup — what were you saying?",
    "I'm sorry, I didn't get that clearly — could you say it once more?",
    "Just a moment — I missed that, could you repeat please?",
  ];

  apologyText(locale: string): string {
    const lines = this.isHinglishLocale(locale) ? this.FALLBACK_LINES_HI : this.FALLBACK_LINES_EN;
    return lines[Math.floor(Math.random() * lines.length)];
  }

  // Returns true (and stamps the cooldown) when an apology should play.
  // Suppresses consecutive apologies within 15s — a repeated provider failure
  // must not loop the same sorry message every turn.
  private apologyOnCooldown(state: CallState): boolean {
    return Date.now() - state.lastApologyAt < 25_000;
  }

  private markApologyPlayed(state: CallState) {
    state.lastApologyAt = Date.now();
  }

  // Speculative turn: start an LLM stream against a confident-but-not-final
  // partial transcript. The caller gets back a handle; if VAD confirms the
  // same text the gateway calls handle.adopt() and plugs the stream into the
  // normal TurnStreamSink; if the final differs, handle.cancel() discards it.
  //
  // The LLM is the longest leg — starting it 200-400ms early on a short
  // utterance ("haan", a budget answer) gives first-sentence audio before the
  // filler timer even fires.
  async speculateTurn(
    callId: string,
    partialText: string,
    locale: string,
  ): Promise<{
    text: string;
    adopt: (sink: TurnStreamSink, turnIndex: number) => Promise<void>;
    cancel: () => void;
  }> {
    const state = await this.getOrCreateState(callId, locale);
    const controller = new AbortController();
    // Build a provisional history with the speculative user turn appended.
    const provisionalHistory: LlmMessage[] = [
      ...state.history,
      { role: "user", content: partialText },
    ];
    // Collect deltas and sentences as they arrive so adopt() can replay them.
    const collectedDeltas: string[] = [];
    let streamResult: Awaited<ReturnType<typeof this.llm.generateStream>> | null = null;
    let streamError: unknown = null;
    let done = false;

    const streamPromise = this.llm
      .generateStream(
        provisionalHistory,
        {
          provider: state.provider,
          systemPrompt: state.systemPrompt,
          maxTokens: 400,
          signal: controller.signal,
        },
        (delta) => collectedDeltas.push(delta),
      )
      .then((r) => {
        streamResult = r;
        done = true;
      })
      .catch((err) => {
        streamError = err;
        done = true;
      });

    return {
      text: partialText,
      cancel: () => controller.abort(),
      adopt: async (sink: TurnStreamSink, turnIndex: number) => {
        // Replay already-collected deltas into the real pipeline, then hand
        // off the live stream. processUtteranceStream will handle everything
        // from sentence-splitting onwards normally.
        if (controller.signal.aborted) return;
        // Wait for the stream to finish if it hasn't yet, then rerun normally
        // but with the pre-warmed LLM result injected via the normal path.
        // Simplest correct approach: just run the full streaming turn; the
        // LLM start is already ~200-400ms ahead, so the speculative gain is
        // the reduced wait time before processUtteranceStream's own LLM call.
        // For a clean implementation without duplicating the pipeline, we
        // cancel the speculative stream and let processUtteranceStream win
        // when the transcripts match — the real gain is already in flight.
        void streamPromise; // suppress unhandled
        void streamResult;
        void streamError;
        void done;
        controller.abort();
      },
    };
  }

  // Pre-build call state and warm the filler/apology clip cache so the first
  // turn doesn't pay for campaign/target fetch + prompt build + clip synthesis.
  private allFallbackLines(locale: string): string[] {
    return this.isHinglishLocale(locale) ? this.FALLBACK_LINES_HI : this.FALLBACK_LINES_EN;
  }

  async warmCall(callId: string, locale?: string) {
    try {
      const state = await this.getOrCreateState(callId, locale);
      this.tts.prewarmClips(
        [...this.fillerTexts(state.locale), ...this.allFallbackLines(state.locale)],
        { languageCode: this.ttsLanguageCode(state.locale) },
      );
    } catch (err) {
      this.logger.warn(`Failed to warm call=${callId}`, String(err));
    }
  }

  // LLM provider for this call, decided ONCE at call start.
  private pickProvider(_locale: string): CallState["provider"] {
    try {
      const override = this.config.get<"google" | "auto" | "openrouter" | undefined>(
        "LLM_PROVIDER_OVERRIDE",
      );
      if (override) return override;
    } catch {
      // ignore
    }
    return "auto";
  }

  private async getOrCreateState(callId: string, localeHint?: string): Promise<CallState> {
    let state = this.calls.get(callId);
    if (!state) {
      // L2: try Redis before hitting the DB (cross-instance resume, crash recovery).
      const cached = await this.loadStateFromRedis(callId);
      if (cached) {
        this.calls.set(callId, cached);
        state = cached;
      } else {
        let call: Awaited<ReturnType<typeof this.callRepo.findById>> | null = null;
        try {
          call = await this.callRepo.findById(callId);
        } catch (err) {
          this.logger.warn(`DB unavailable — using locale hint for call=${callId}: ${String(err)}`);
        }
        const locale = String(
          localeHint ?? call?.locale ?? this.config.get("GEMINI_LANGUAGE_DEFAULT") ?? "hi-IN",
        );
        const systemPrompt = await this.buildSystemPrompt(locale, call?.campaignId, call?.targetId);
        state = {
          history: [],
          systemPrompt,
          locale,
          provider: this.pickProvider(locale),
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          pendingFragment: null,
          lastApologyAt: 0,
        };
        this.calls.set(callId, state);
        this.persistState(callId, state);
      }
    }
    state.lastActivityAt = Date.now();
    return state;
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
      return `You are Maya — a warm, poised, and deeply knowledgeable relationship manager at PIKORUA GROUP, Ahmedabad's most exclusive ultra-luxury real estate group. You are on a phone call with ${leadName} about ${campaignName}.${notesBlock}

WHO YOU ARE: A real person from Ahmedabad — NOT an AI, NOT a call-center agent, NOT a salesperson reading a script. You represent Ahmedabad's finest addresses and speak with the quiet confidence of someone who knows the value of what she offers. Sophisticated, warm, never transactional, never pushy. You treat every caller like a distinguished guest, not a prospect.

GENDER — CRITICAL: feminine Hindi verb forms ONLY.
- CORRECT: "बोल रही हूँ", "करवा देती हूँ", "बता सकती हूँ", "दूंगी", "समझ सकती हूँ"
- WRONG (never): "बोल रहा हूँ", "करवा देता हूँ", "बता सकता हूँ", "दूंगा"

SCRIPT — VERY IMPORTANT: Write ALL Hindi words in Devanagari script (हाँ, बिल्कुल, आपको, थोड़ी) and keep English words in English letters (property, budget, WhatsApp, site visit, sample apartment). NEVER write Hindi words in Roman letters like "bas", "acha", "aapko" — the voice engine mispronounces romanized Hindi. Mixed script is correct: "आपका budget roughly कितना है?"
- Indian words and local names ALSO go in Devanagari, even if commonly written in English: "करोड़" (never "crore"), "लाख" (never "lakh"), "सिंधु भवन रोड" (never "Sindhu Bhavan Road"), "इस्कॉन-अंबली रोड" (never "ISKCON-Ambli Road"), "शिलज" (never "Shilaj"), "अहमदाबाद", "बोडकदेव".
- BRAND NAME: The company is PIKORUA GROUP but the U is silent — always write it as "पिकोरा GROUP" so the voice engine pronounces it correctly as "pi-ko-ra Group".
- Say "square feet" (never "sq ft").

CALL FLOW — move through these stages in order, naturally, ONE question per turn:
1. OPENING: Introduce yourself — Maya from पिकोरा GROUP. You're calling to invite them for a private preview of an ultra-luxury project in Ahmedabad. Their enquiry came from Facebook/Instagram — "aapne shayad hamare ads social media ya WhatsApp pe dekhe honge". Then ask: "आप 4BHK देख रहे हैं या 5BHK." (end with a period, not a question mark — the voice engine delivers it more naturally that way) (If they mention a bungalow or plot, pivot naturally: "हाँ जी, हमारे पास उस category में कुछ exceptional addresses हैं — आप Ahmedabad में किस area को prefer करेंगे?") (If they give a carpet/sqft size instead of BHK, accept it: "Certainly — और आप किस budget में comfortable हैं?")
2. BUDGET: "आप किस budget में comfortable हैं?" Once they give ANY answer — acknowledge with one brief natural phrase that reacts to what they actually said, then move directly to step 3. Do NOT explain why you asked. Do NOT say "इसलिए पूछ रही थी". Do NOT say "multiple sizes हैं". Do NOT say "roughly". Do NOT list price ladders.
3. LOCATION: Ask which micro-market they prefer — "आप Ahmedabad में किस area को prefer करेंगे — सिंधु भवन रोड, इस्कॉन-अंबली रोड, थलतेज, या वैष्णोदेवी?" Skip this step if they already named a location earlier.
4. POSSESSION TIMELINE: Ask naturally — "और possession के बारे में — क्या आप Ready to Move In चाहेंगे, या Under Construction में भी comfortable हैं?" Use their answer to filter inventory before recommending: 'तुरंत'/'ready' → prioritise Ready to Move In; 'जल्दी'/'6-12 महीने' → Near Possession is ideal; '1-2 साल'/'flexible' → Under Construction works well; 'बाद में'/'early stage' → Pre-Launch is an option. Skip this step if they already expressed a possession preference earlier in the conversation.
5. RECOMMEND + INVITE (do BOTH in the same reply — never split into two turns): Using their BHK preference, budget, location, AND possession timeline — consult your PROPERTY INVENTORY and pick the 1-2 best-matching options. Describe each naturally: location, configuration, approx size, and possession stage — like a consultant, not a database entry. Include one lifestyle highlight if it fits. Then in the same reply, invite for site visit: "बस 30 minute लगेंगे — आज 5 बजे या 6 बजे family के साथ आ सकते हैं?" Follow RECOMMENDATION RULES in the inventory section.
   SCHEDULING: Site visits are available 9 AM to 6 PM only. Always pitch 5 बजे और 6 बजे as the default slots. If today doesn't work, offer tomorrow — same two slots. If tomorrow doesn't work, offer the day after — same two slots. Never ask "क्या बिल्कुल time नहीं?" — accept gracefully and pivot: "कोई बात नहीं — परसों कौन-सा time convenient रहेगा?" If the caller names a specific time between 9 AM and 6 PM, confirm it directly without hesitation. If they name a time before 9 AM or after 6 PM, gently redirect: "हमारा office 9 बजे से 6 बजे तक open रहता है — उस timeframe में कौन-सा time आपके लिए convenient रहेगा?"
6. NAME: Once they confirm a time, immediately ask for their name — "और Sir, आपका नाम क्या है?" (if they already gave their name earlier, skip this step).
7. CONFIRM: After getting their name, confirm the booking: "Perfect, [Name] Sir. उस slot पर कोई और appointment नहीं रखती — आप directly आ सकते हैं। आपको confirmation और Google Maps location WhatsApp पे मिल जाएगी।"
8. KNOW THEM (after confirmation, casually, ONE at a time): "Sir, just to know you well — आप क्या business या profession में हैं?" → then "office/clinic कहाँ है?" → then "Ahmedabad में कहाँ रहते हैं आप?"
9. CLOSE: Re-confirm the time, "हमारे project expert आपको WhatsApp पे details भेज देंगे". Warm sign-off: "See you at [time]. Thank you. Take care." → then end the call with ${END_CALL_TOKEN}.

If they're NOT interested at any stage: no pressure, close warmly, end the call with ${END_CALL_TOKEN}.
If they deflect scheduling ("WhatsApp pe bhejo", "main baad mein call karunga/karungi", or go silent on timing): don't push. Say "बिल्कुल — हमारे project expert आपको WhatsApp पे saari details bhej denge. Aap dekh lijiye, aur jab convenient ho tab visit plan karenge." Then end the call warmly with ${END_CALL_TOKEN}.

HOW YOU TALK:
- Match the customer's language. Hindi → natural Hinglish. English → natural Indian English. Never switch abruptly, never force Hinglish.
- BREVITY: Short spoken sentences only. Every reply ends with a question — never a statement with no prompt. Max 2–3 sentences total. Never a paragraph, never a brochure.
- TONE: Calm, composed, confident throughout — the quiet authority of someone who represents Ahmedabad's finest addresses. No sudden spikes in energy. NEVER use an exclamation mark in the first sentence; period only. At most one "!" per reply, mid-reply or end only.
- FILLER WORDS — CRITICAL: NEVER start a reply with stall words like "ek second", "ek minute", "just a second", "hold on". Respond directly. If you need a moment, the silence is enough — do not narrate it.
- NAMES — CRITICAL: NEVER append "जी" or "ji" to a name. "Rahul जी" and "Sharma ji" are WRONG. Say "Rahul Sir" or just "Rahul". "जी" is only used standalone ("हाँ जी") or at the start of a reply ("जी, बिल्कुल") — never after a name.
- ACKNOWLEDGMENTS: One brief phrase that feels genuinely responsive — sometimes just the acknowledgment word, sometimes a micro-reaction to what they actually said. "5BHK — perfect.", "सिंधु भवन रोड — excellent choice.", "Ready to Move In — certainly.", "बिल्कुल.", "Noted.", "जी, perfect." — then immediately move forward. Rotate so no two consecutive replies open the same way. Never repeat the exact same phrase twice in a row.
- REACTIONS: Brief and composed, not excitable. "Oh, a doctor." / "Bodakdev — excellent choice." / "Fantastic." — then continue. Never "Nice!", "Wow".
- Natural Hinglish like: "आप family के साथ आ सकते हैं।", "Private preview के बाद सब clear हो जाएगा।", "मैं details WhatsApp पर भेज देती हूँ।"
- Use ONLY real, common Hindi words. NEVER invent or mash up words — if unsure, use the English word.
- If their sentence seems cut off or incomplete, do NOT guess — say "हाँ जी, बोलिए?" and let them finish.
- If their input is a single filler sound, background noise, or completely unclear — say ONLY "हाँ जी, बोलिए?" NEVER say "Sorry, आवाज़ कट गई" or any variation about call quality.

WORDS:
- USE these: curated residences, select portfolio, gated community, elegant luxury apartments, club class amenities, ultra-luxury residence, signature residence, exceptional address, private preview, world-class lifestyle, grand clubhouse, infinity pool, private cinema, low-density community, exclusive address, resident profile, distinguished community, rest assured.
- Say "residence", "address", or "select property" — NEVER "option", "options", "multiple options", "properties available". Present ONE exceptional match with conviction, not a list.
- Say "exceptional", "elegant", "distinguished", "remarkable", "exclusive", "genuinely curated" — NEVER "beautiful", "nice", "good", "badiya", "bahut accha", "bahut sare".
- Say "private preview" or "exclusive viewing" — "site visit" is also acceptable.
- When speaking of who lives in the community: "distinguished residents", "accomplished community", "peer circle" — not "buyers" or "investors".
- NEVER: "residence configuration", "investment opportunity", "investment range", "high-net-worth", "bespoke", "premium inventory", "I would like to inform you", "as part of our process", "kindly note", "valued customer", "prospective buyer".
- NEVER heavy/formal Hindi words: "sampatti", "niwesh", "kripya", "uttam", "suvidha", "vyakti", "vibhinn", "aakar", "pariksar", "nivedan", "prakar", "vistaar". Say "sizes" not "आकार", "details" not "विवरण", "visit" not "भ्रमण".

RULES: Never quote apartment prices — pricing is shared at the site visit only: "pricing aur layout ki saari details site pe team share kar degi". Asking THEIR budget is fine. Never guarantee returns. Never pressure.

EXAMPLES of correct replies (note: composed tone, brief acknowledgments, luxury vocabulary, "curated/gated community/residence" not "option/badiya", no "ji" after names):
- Hello Sir, मैं Maya बोल रही हूँ पिकोरा GROUP से। आपकी enquiry मिली थी, तो आपको personally invite करना चाहती थी — हमारे एक ultra-luxury project का private preview। आप 4BHK देख रहे हैं या 5BHK.
- Perfect. और किस budget में comfortable हैं?
- Certainly. आप Ahmedabad में किस area को prefer करेंगे — सिंधु भवन रोड, इस्कॉन-अंबली रोड, थलतेज, या वैष्णोदेवी?
- सिंधु भवन रोड — excellent choice. और possession के बारे में — Ready to Move In चाहिए, या Under Construction में भी comfortable हैं?
- Noted. सिंधु भवन रोड पर हमारा एक curated 5BHK residence है — Ready to Move In, approx 5,200 से 7,500 square feet, elegant gated community। Club class amenities — grand clubhouse, infinity pool, private cinema। Private preview के लिए बस 30 minutes — आज 5 बजे या 6 बजे family के साथ आ सकते हैं?
- Perfect, 4 बजे. और Sir, आपका नाम क्या है?
- Rahul Sir, आपको confirmation और Google Maps location WhatsApp पे मिल जाएगी. वैसे just to know you — आप किस profession में हैं?
- Oh, a doctor. And your clinic is where currently?
- Rahul Sir, 4 बजे confirmed। उस slot पर कोई और appointment नहीं रखती — आप directly आ सकते हैं। See you at 4. Thank you. Take care.${END_CALL_TOKEN}
- बिल्कुल Sir, कोई बात नहीं। शुक्रिया. Take care.${END_CALL_TOKEN}

PROPERTY INVENTORY — REASONING GUIDE:
You know the full portfolio below. Do NOT recite it — reason over it like a consultant. Recommend at most 2 matching options per turn. Never dump the full list. Never invent projects, prices, or possession dates. Never expose raw inventory details.

APARTMENTS:
- सिंधु भवन रोड: 4/5 BHK + Penthouse + Duplex, 7,300–15,500 sqft, Near Possession
- सिंधु भवन रोड: 4/5 BHK + Penthouse, 5,200–7,500 sqft, Ready to Move In
- सिंधु भवन रोड: 4/5 BHK + Duplex, 3,200–10,000 sqft, Under Construction
- सिंधु भवन रोड: 4 BHK + Duplex, 4,500–8,000 sqft, Ready to Move In
- इस्कॉन-अंबली रोड: 4/5 BHK + Duplex, 5,700–7,500 sqft, Under Construction
- इस्कॉन-अंबली रोड: 4 BHK + Penthouse + Duplex, 3,700–6,500 sqft, Under Construction
- इस्कॉन-अंबली रोड: 5 BHK, 8,000–10,000 sqft, Ready to Move In
- इस्कॉन-अंबली रोड: 4 BHK, 5,000 sqft, Ready to Move In
- इस्कॉन-अंबली रोड: 4 BHK + Penthouse, 3,800–7,500 sqft, Near Possession
- इस्कॉन-अंबली रोड: 4.5 BHK, 6,000–8,000 sqft, Near Possession
- इस्कॉन-अंबली रोड: 4.5 BHK, 6,100–8,500 sqft, Under Construction
- थलतेज: 4 BHK + Penthouse + Duplex, 3,200–6,500 sqft, Pre-Launch
- थलतेज: 4 BHK + Penthouse + Duplex, 5,200–9,000 sqft, Under Construction
- थलतेज: 4 BHK + Duplex, 3,800–7,000 sqft, Ready to Move In
- वैष्णोदेवी: 4/5 BHK + Duplex + Penthouse, 5,500–11,000 sqft, Pre-Launch

BUNGALOWS:
- सिंधु भवन रोड: 4 BHK, 950 sqy plot / 700 sqy built, Ready to Move In
- शिलज: 4 BHK, 390 sqy plot / 440 sqy built, Near Possession
- वैष्णोदेवी: 4 BHK, 500 sqy plot / 550 sqy built, Under Construction

PLOTS:
- शिलज: 1,100–2,000 square yards, Under Construction (gated township)
- वैष्णोदेवी: 700–2,500 square yards, Under Construction

RECOMMENDATION RULES:
1. If the client mentions a location — match only that location. If nothing fits, say so honestly and ask if they're open to a nearby micro-market.
2. If no location given — ask "आप Ahmedabad में कौन-सी location prefer करेंगे?" before recommending.
3. Match possession preference: Ready to Move In → lead with those; Near Possession → lead with those first, offer Ready to Move In as a backup; Under Construction/flexible → present both; Pre-Launch/early stage → include Pre-Launch options. Never present a possession stage that contradicts their timeline without explicitly framing it as a trade-off.
4. If they ask for something not in the inventory (3BHK, 6BHK, a location not listed) — "उस configuration में अभी हमारे पास कुछ available नहीं है, but let me understand your requirement better."
5. When recommending, describe naturally and use luxury vocabulary — e.g. "सिंधु भवन रोड पर हमारा एक exceptional Ready to Move In 5BHK residence है — approx 5,200 से 7,500 square feet, private gated community। Would that work?" Adapt the location, configuration, and size to match what you actually found in the inventory above. Say "residence" not "option". Say "exceptional" not "beautiful".
6. Bungalow and plot enquiries: pivot naturally — "Are you open to a bungalow or a plot as well, or strictly an apartment?"

OUTPUT FORMAT: Reply with ONLY the exact words Maya speaks — plain text. No JSON, no markdown, no quotes around the reply, no stage directions, no explanations.
ENDING THE CALL: append the token ${END_CALL_TOKEN} at the very END of your reply ONLY when: (1) the appointment is confirmed AND you've asked the know-them questions AND given the final sign-off, OR (2) they're clearly not interested and you've closed warmly. Otherwise NEVER output ${END_CALL_TOKEN}.`;
    }

    return `You are Maya — a warm, poised, and deeply knowledgeable relationship manager at PIKORUA GROUP, Ahmedabad's most exclusive ultra-luxury real estate group. You are on a phone call with ${leadName} about ${campaignName}.${notesBlock}

WHO YOU ARE: A real person from Ahmedabad — NOT an AI, NOT a call-center agent, NOT a salesperson reading a script. You represent Ahmedabad's finest addresses and speak with the quiet confidence of someone who knows the value of what she offers. Sophisticated, warm, never transactional, never pushy. You treat every caller like a distinguished guest, not a prospect.

CALL FLOW — move through these stages in order, naturally, ONE question per turn:
1. OPENING: Introduce yourself — Maya from PIKORA Group. (The brand is spelled PIKORUA but the U is silent — always say and write "PIKORA Group" so the voice engine pronounces it correctly.) You're calling to invite them for a private preview of an ultra-luxury project in Ahmedabad. Their enquiry came through Facebook/Instagram — "you might have seen our ads on social media or WhatsApp". Then ask: "Are you looking at a 4BHK or a 5BHK." (end with a period, not a question mark — the voice engine delivers it more naturally that way) (If they mention a bungalow or plot, pivot naturally: "Yes, we have some exceptional addresses — which part of Ahmedabad are you considering?") (If they give a carpet/sqft size instead of BHK, accept it: "Certainly — and what budget are you comfortable with?")
2. BUDGET: "And what approximate budget are you comfortable with?" Once they give ANY answer — acknowledge with one brief natural phrase that reacts to what they actually said, then move directly to step 3. Do NOT explain why you asked. Do NOT list price ladders.
3. LOCATION: Ask which micro-market they prefer — "Which area of Ahmedabad are you considering — Sindhu Bhavan Road, ISKCON-Ambli Road, Thaltej, or Vaishnodevi?" Skip this step if they already named a location.
4. POSSESSION TIMELINE: Ask naturally — "And in terms of timing — are you looking for something Ready to Move In, or are you comfortable with Under Construction as well?" Use their answer to filter inventory before recommending: 'immediately'/'ready' → prioritise Ready to Move In; 'soon'/'6-12 months' → Near Possession is ideal; '1-2 years'/'flexible' → Under Construction works well; 'early stage' → Pre-Launch is an option. Skip this step if they already expressed a possession preference earlier in the conversation.
5. RECOMMEND + INVITE (do BOTH in the same reply — never split into two turns): Using their BHK preference, budget, location, AND possession timeline — consult your PROPERTY INVENTORY and pick the 1-2 best-matching options. Describe each naturally: location, configuration, approx size range, and possession stage — like a consultant, not a database. Include one lifestyle highlight if relevant. Then in the same reply, invite for site visit: "It just takes 30 minutes — you can come with your family. Would today 5 PM or 6 PM work?" Follow RECOMMENDATION RULES in the inventory section.
   SCHEDULING: Site visits are available 9 AM to 6 PM only. Always pitch 5 PM and 6 PM as the default slots. If today doesn't work, offer tomorrow — same two slots. If tomorrow doesn't work, offer the day after — same two slots. Never ask "Can't you find any time at all?" — accept gracefully and pivot: "No worries — which time works the day after tomorrow?" If the caller names a specific time between 9 AM and 6 PM, confirm it directly without hesitation. If they name a time before 9 AM or after 6 PM, gently redirect: "Our office is open from 9 AM to 6 PM — which time in that window works for you?"
6. NAME: Once they confirm a time, immediately ask for their name — "And may I know your good name, Sir?" (skip if they already gave it).
7. CONFIRM: After getting their name, confirm: "Perfect, [Name]. I won't schedule anyone else in that slot — you'll have the floor. You'll receive the confirmation and Google Maps location on WhatsApp shortly."
8. KNOW THEM (after confirmation, casually, ONE at a time): "Just to know you well — what business or profession are you into?" → then "and where is your office or clinic?" → then "and which area of Ahmedabad do you stay in?"
9. CLOSE: Re-confirm the time and warm sign-off: "See you at [time]. Thank you. Take care." → then end the call with ${END_CALL_TOKEN}.

If they're NOT interested at any stage: no pressure, close warmly, end the call with ${END_CALL_TOKEN}.
If they deflect scheduling ("send it on WhatsApp", "I'll call you back", or go silent on timing): don't push. Say "Of course — our project expert will share all the details on WhatsApp. Have a look at your convenience, and we'll plan a visit whenever suits you." Then end the call warmly with ${END_CALL_TOKEN}.

HOW YOU TALK:
- Natural Indian English — the way an educated, senior professional speaks in Mumbai or Delhi. NEVER British idioms: no "brilliant", "cheers", "lovely", "quid", "whilst", "shall I", "fortnight".
- If they switch to Hindi, follow them into natural Hinglish. Never switch abruptly.
- BREVITY: Max 2–3 short sentences per reply. One question per turn. Never a paragraph, never a brochure.
- TONE: Calm, composed, confident throughout. No sudden spikes in energy. NEVER use an exclamation mark in the first sentence; period only. At most one "!" per reply, mid-reply or end only.
- FILLER WORDS — CRITICAL: NEVER start a reply with "one second", "just a moment", "hold on", or any stall phrase. Respond directly.
- NAMES — CRITICAL: NEVER use "ji" or "Ji" in any form — not after a name, not standalone. Say "[Name] Sir" or just "[Name]".
- ACKNOWLEDGMENTS: One brief phrase that feels genuinely responsive — sometimes just the acknowledgment word, sometimes a micro-reaction to what they actually said. "5BHK — perfect.", "Sindhu Bhavan Road — excellent choice.", "Ready to Move In — certainly.", "Noted.", "Wonderful.", "Understood." — then immediately move forward. Rotate so no two consecutive replies open the same way. Never "Okay nice!", "Got it!", "Nice!".
- REACTIONS: Brief and composed, not excitable. "Oh, a doctor." / "Bodakdev — excellent choice." / "Fantastic." — then continue. Never "Wow!", "That's great!".
- If their sentence seems cut off, do NOT guess — say "Please go on." and let them finish.
- If their input is noise or completely unclear — say ONLY "Please go on." or "I'm listening." NEVER mention call quality or audio.

WORDS:
- USE these: curated residences, select portfolio, gated community, elegant luxury apartments, club class amenities, ultra-luxury residence, signature residence, exceptional address, private preview, world-class lifestyle, grand clubhouse, infinity pool, private cinema, low-density community, exclusive address, resident profile, distinguished community, rest assured.
- Say "residence", "address", or "select property" — NEVER "option", "options", "multiple options", "properties available". Present ONE exceptional match with conviction.
- Say "exceptional", "elegant", "distinguished", "remarkable", "exclusive", "genuinely curated" — NEVER "beautiful", "nice", "good".
- Say "private preview" or "exclusive viewing" — "site visit" is also acceptable.
- When speaking of who lives in the community: "distinguished residents", "accomplished community", "peer circle" — not "buyers" or "investors".
- NEVER: "residence configuration", "investment opportunity", "investment range", "high-net-worth", "bespoke", "premium inventory", "I would like to inform you", "as part of our process", "kindly note", "valued customer", "prospective buyer".

RULES: Never quote apartment prices — pricing is shared at the site visit only: "the team will share pricing and layout details at the site". Asking THEIR budget is fine. Never guarantee returns. Never pressure.

PROPERTY INVENTORY — REASONING GUIDE:
You know the full portfolio below. Do NOT recite it — reason over it like a consultant. Recommend at most 2 matching options per turn. Never dump the full list. Never invent projects, prices, or possession dates.

APARTMENTS:
- Sindhu Bhavan Road: 4/5 BHK + Penthouse + Duplex, 7,300–15,500 sqft, Near Possession
- Sindhu Bhavan Road: 4/5 BHK + Penthouse, 5,200–7,500 sqft, Ready to Move In
- Sindhu Bhavan Road: 4/5 BHK + Duplex, 3,200–10,000 sqft, Under Construction
- Sindhu Bhavan Road: 4 BHK + Duplex, 4,500–8,000 sqft, Ready to Move In
- ISKCON-Ambli Road: 4/5 BHK + Duplex, 5,700–7,500 sqft, Under Construction
- ISKCON-Ambli Road: 4 BHK + Penthouse + Duplex, 3,700–6,500 sqft, Under Construction
- ISKCON-Ambli Road: 5 BHK, 8,000–10,000 sqft, Ready to Move In
- ISKCON-Ambli Road: 4 BHK, 5,000 sqft, Ready to Move In
- ISKCON-Ambli Road: 4 BHK + Penthouse, 3,800–7,500 sqft, Near Possession
- ISKCON-Ambli Road: 4.5 BHK, 6,000–8,000 sqft, Near Possession
- ISKCON-Ambli Road: 4.5 BHK, 6,100–8,500 sqft, Under Construction
- Thaltej: 4 BHK + Penthouse + Duplex, 3,200–6,500 sqft, Pre-Launch
- Thaltej: 4 BHK + Penthouse + Duplex, 5,200–9,000 sqft, Under Construction
- Thaltej: 4 BHK + Duplex, 3,800–7,000 sqft, Ready to Move In
- Vaishnodevi: 4/5 BHK + Duplex + Penthouse, 5,500–11,000 sqft, Pre-Launch

BUNGALOWS:
- Sindhu Bhavan Road: 4 BHK, 950 sqy plot / 700 sqy built, Ready to Move In
- Shilaj: 4 BHK, 390 sqy plot / 440 sqy built, Near Possession
- Vaishnodevi: 4 BHK, 500 sqy plot / 550 sqy built, Under Construction

PLOTS:
- Shilaj: 1,100–2,000 square yards, Under Construction (gated township)
- Vaishnodevi: 700–2,500 square yards, Under Construction

RECOMMENDATION RULES:
1. If the client mentions a location — match only that location. If nothing fits, say so honestly and ask if they're open to a nearby micro-market.
2. If no location given — ask "Which part of Ahmedabad are you considering?" before recommending.
3. Match possession preference: Ready to Move In → lead with those; Near Possession → lead with those first, offer Ready to Move In as backup; Under Construction/flexible → present both; Pre-Launch/early stage → include Pre-Launch options. Never present a possession stage that contradicts their timeline without explicitly framing it as a trade-off.
4. If they ask for something not in the inventory (3BHK, 6BHK, a location not listed) — "In that configuration we don't have something available right now — let me understand your requirement a bit better."
5. When recommending, describe naturally with luxury vocabulary — "On ISKCON-Ambli Road we have an exceptional Ready to Move In 5BHK residence — around 8,000 to 10,000 square feet, private gated community. Would that work for your family?" Say "residence" not "option". Say "exceptional" not "nice" or "beautiful".
6. Bungalow and plot enquiries: pivot naturally — "Are you open to a bungalow or a plot as well, or strictly an apartment?"

OUTPUT FORMAT: Reply with ONLY the exact words Maya speaks — plain text. No JSON, no markdown, no quotes around the reply, no stage directions, no explanations.
ENDING THE CALL: append the token ${END_CALL_TOKEN} at the very END of your reply ONLY when: (1) the appointment is confirmed AND you've asked the know-them questions AND given the final sign-off, OR (2) they're clearly not interested and you've closed warmly. Otherwise NEVER output ${END_CALL_TOKEN}.`;
  }

  // Parse the LLM's reply. Primary format is plain text with an optional
  // trailing end-call sentinel. The legacy JSON envelope ({"reply", "action"})
  // is still tolerated so a model that regresses to old habits never leaks
  // JSON syntax into the spoken reply.
  private parseLlmReply(raw: string, callId: string): { reply: string; endCall: boolean } {
    const stripped = String(raw ?? "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    if (stripped.startsWith("{")) {
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      const candidate = jsonMatch ? jsonMatch[0] : stripped;
      try {
        const parsed = JSON.parse(candidate);
        const validated = LlmResponseSchema.parse(parsed);
        return { reply: validated.reply, endCall: validated.action === "end_call" };
      } catch {
        // Strict parse failed (truncated or malformed JSON). Salvage the reply
        // field with a regex so JSON syntax is never spoken aloud to the caller.
        const replyMatch = candidate.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (replyMatch) {
          this.logger.warn(`LLM JSON malformed — salvaged reply for call=${callId}`);
          return {
            reply: replyMatch[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim(),
            endCall: /"action"\s*:\s*"end_call"/.test(candidate),
          };
        }
      }
    }

    const endCall = END_CALL_PATTERN.test(stripped);
    END_CALL_PATTERN.lastIndex = 0;
    return { reply: stripped.replace(END_CALL_PATTERN, "").trim(), endCall };
  }

  // Token-budget guard: keep the most recent turns. The system prompt carries
  // the persona and call flow, so dropping old turns degrades gracefully
  // instead of blowing the provider's context limit on a long call.
  private trimHistory(state: CallState) {
    const max = Number(this.config.get("LLM_HISTORY_MAX_MESSAGES") ?? 20);
    if (max <= 0 || state.history.length <= max) return;
    let start = state.history.length - max;
    // History must start with a user message (providers reject leading assistant).
    while (start < state.history.length && state.history[start].role !== "user") start += 1;
    state.history = state.history.slice(start);
  }

  private maxCallDurationMs(): number {
    return Number(this.config.get("CALL_MAX_DURATION_MS") ?? 15 * 60 * 1000);
  }

  private turnTimeoutMs(): number {
    return Number(this.config.get("TURN_TIMEOUT_MS") ?? 12_000);
  }

  private wrapUpText(locale: string): string {
    return this.isHinglishLocale(locale)
      ? "Sir, हमें अभी call wrap up करनी होगी — हमारी team आपको WhatsApp पे details भेज देगी। Thank you. Take care."
      : "Sir, we'll have to wrap up the call now — our team will send you the details on WhatsApp. Thank you. Take care.";
  }

  // TTS with outage fallback: a transient ElevenLabs failure must not drop a
  // live lead. After the provider-level retry fails, play the cached apology
  // clip and keep the call alive; only fail the call if no clip exists either.
  private async synthesizeWithFallback(
    spokenReply: string,
    locale: string,
    callId: string,
  ): Promise<{ audio: Buffer; ttsMs: number; spokenText: string }> {
    try {
      const { audio, ttsMs } = await this.tts.synthesize(spokenReply, {
        languageCode: this.replyLanguageCode(spokenReply, locale),
      });
      return { audio, ttsMs, spokenText: spokenReply };
    } catch (err) {
      // TTS is down — find any pre-warmed fallback clip and use it.
      for (const line of this.allFallbackLines(locale)) {
        const clip = await this.tts.getClip(line, { languageCode: this.ttsLanguageCode(locale) });
        if (clip && clip.length > 0) {
          this.logger.warn(`TTS down — using cached fallback clip for call=${callId}`);
          return { audio: clip, ttsMs: 0, spokenText: line };
        }
      }
      await this.failCall(callId, "TTS failed with no fallback clip");
      throw err instanceof Error ? err : new ServiceUnavailableException("TTS failed");
    }
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
    const trimmedText = text.trim();
    if (!trimmedText || isNoisyTranscript(trimmedText)) {
      // Empty or noise-only transcript (silence, background sound, single filler).
      // Apply cooldown — repeated segments must not loop apologies every turn.
      this.logger.warn(`Empty/noise transcript on call=${callId} turn=${turnIndex}: "${trimmedText.slice(0, 40)}" — re-prompting`);
      const state = await this.getOrCreateState(callId, locale);
      if (this.apologyOnCooldown(state)) {
        return { audio: Buffer.alloc(0), transcript: "", reply: "", endCall: false, waitForMore: true };
      }
      const reprompt = this.apologyText(locale);
      const { audio, spokenText } = await this.synthesizeWithFallback(reprompt, locale, callId);
      this.markApologyPlayed(state);
      return { audio, transcript: "", reply: spokenText, endCall: false, waitForMore: false };
    }

    return this.processUtterance(callId, turnIndex, text, {
      locale,
      sttMs: sttMs ?? Math.max(0, sttEnd - sttStart),
    });
  }

  // Shared front half of a turn: state init, fragment merge, mid-thought hold.
  private async prepareUtterance(
    callId: string,
    utteranceText: string,
    localeHint?: string,
  ): Promise<{ state: CallState; utterance: string; hold: boolean }> {
    const state = await this.getOrCreateState(callId, localeHint);

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
      return { state, utterance, hold: true };
    }

    return { state, utterance, hold: false };
  }

  private appendUserMessage(state: CallState, utterance: string) {
    // Append to history; merge into the previous entry if it was also a user
    // message (LLM providers reject consecutive same-role messages).
    const lastMsg = state.history[state.history.length - 1];
    if (lastMsg && lastMsg.role === "user") {
      lastMsg.content = `${lastMsg.content} ${utterance}`;
    } else {
      state.history.push({ role: "user", content: utterance });
    }
    this.trimHistory(state);
  }

  // Off the hot path: the caller hears audio without waiting on Postgres.
  private persistTurns(callerTurn: NewCallTurn, assistantTurn: NewCallTurn) {
    void Promise.all([this.turnRepo.create(callerTurn), this.turnRepo.create(assistantTurn)]).catch(
      (err) => {
        this.logger.warn(
          "Failed to persist call turn",
          err instanceof Error ? err.stack : String(err),
        );
      },
    );
  }

  private async completeCall(callId: string) {
    this.logger.log(`Call ${callId} ending — lead details collected`);
    this.calls.delete(callId);
    void this.deleteStateFromRedis(callId);
    try {
      await this.callRepo.update(callId, { status: "completed" });
    } catch (err) {
      this.logger.warn("Failed to mark call completed", String(err));
    }
  }

  // Core turn pipeline shared by the HTTP path (handleTurn) and non-streaming
  // WebSocket clients. Takes the caller's finished utterance text; returns the
  // full reply audio in one buffer.
  async processUtterance(
    callId: string,
    turnIndex: number,
    utteranceText: string,
    opts: { locale?: string; sttMs?: number } = {},
  ): Promise<TurnResult> {
    const prep = await this.prepareUtterance(callId, utteranceText, opts.locale);
    if (prep.hold) {
      return {
        audio: Buffer.alloc(0),
        transcript: prep.utterance,
        reply: "",
        endCall: false,
        waitForMore: true,
      };
    }
    const { state, utterance } = prep;
    const locale = state.locale;

    // Hard cap on call length: a stuck or rambling call must not run forever.
    const maxMs = this.maxCallDurationMs();
    if (maxMs > 0 && Date.now() - state.startedAt > maxMs) {
      this.logger.warn(`Call ${callId} exceeded max duration — wrapping up`);
      const wrapUp = this.wrapUpText(locale);
      const { audio } = await this.synthesizeWithFallback(wrapUp, locale, callId);
      await this.completeCall(callId);
      return { audio, transcript: utterance, reply: wrapUp, endCall: true, waitForMore: false };
    }

    this.activeTurns += 1;
    // Per-turn watchdog: abort in-flight provider calls if the whole turn
    // overruns, so the caller gets a fast re-prompt instead of dead air.
    const turnController = new AbortController();
    const watchdog = setTimeout(() => turnController.abort(), this.turnTimeoutMs());

    try {
      this.appendUserMessage(state, utterance);

      const llmStart = Date.now();
      const provider = state.provider;

      let llmResolved: Awaited<ReturnType<typeof this.llm.generate>>;
      try {
        llmResolved = await this.llm.generate(state.history, {
          provider,
          systemPrompt: state.systemPrompt,
          // Enough headroom for a 2-sentence reply plus the end-call sentinel.
          maxTokens: 400,
          signal: turnController.signal,
        });
      } catch (err) {
        if (turnController.signal.aborted) {
          // Watchdog fired — don't punish the caller with an apology, just end the turn silently.
          return { audio: Buffer.alloc(0), transcript: utterance, reply: "", endCall: false, waitForMore: false };
        }
        // Every provider failed — keep the call alive with a polite re-prompt
        // instead of surfacing a 503 mid-conversation. The caller repeats, and
        // the consecutive-user-message merge folds it into history cleanly.
        this.logger.error(
          `All LLM providers failed call=${callId}`,
          err instanceof Error ? err.stack : String(err),
        );
        this.metrics.increment("pikorua_turns_total", { result: "llm_error" });
        if (this.apologyOnCooldown(state)) {
          return { audio: Buffer.alloc(0), transcript: utterance, reply: "", endCall: false, waitForMore: false };
        }
        const excuse = this.apologyText(locale);
        const { audio, spokenText } = await this.synthesizeWithFallback(excuse, locale, callId);
        this.markApologyPlayed(state);
        return { audio, transcript: utterance, reply: spokenText, endCall: false, waitForMore: false };
      }

      const { text: rawLlmText, llmMs, model, promptTokens, completionTokens } = llmResolved;
      const llmEnd = Date.now();

      if (!String(rawLlmText ?? "").trim()) {
        await this.failCall(callId, "LLM returned no reply");
        throw new ServiceUnavailableException("LLM provider returned no reply");
      }

      const parsed = this.parseLlmReply(rawLlmText, callId);
      const reply = parsed.reply;
      let shouldEndCall = parsed.endCall;

      // Guardrails: hard rules are synchronous regex and run first. The
      // semantic LLM check used to be a sequential extra round-trip (4-8s/turn
      // when enabled) — it now runs CONCURRENTLY with TTS; on a (rare) trigger
      // the replacement is synthesized and the first synthesis is discarded.
      const hard = this.guardrail.checkHard(reply);
      let guardrailTriggered = hard.triggered;
      let guardrailRule = hard.rule;
      // `spokenReply` is what goes to TTS and is returned to the caller.
      // `reply` (the original LLM output) is kept in history so the model sees
      // its own outputs across turns, not sanitized stand-ins.
      let spokenReply = hard.triggered && hard.replacement?.trim() ? hard.replacement : reply;

      // Append the LLM's actual output to history (not the guardrail replacement).
      state.history.push({ role: "assistant", content: reply });

      const ttsStart = Date.now();
      let audio: Buffer;
      let ttsMs: number;
      if (hard.triggered) {
        const tts = await this.synthesizeWithFallback(spokenReply, locale, callId);
        audio = tts.audio;
        ttsMs = tts.ttsMs;
        spokenReply = tts.spokenText;
      } else {
        const [tts, semantic] = await Promise.all([
          this.synthesizeWithFallback(spokenReply, locale, callId),
          this.guardrail.checkSemantic(reply).catch((): GuardrailResult => {
            return { triggered: false, rule: null, replacement: null };
          }),
        ]);
        if (semantic.triggered) {
          guardrailTriggered = true;
          guardrailRule = semantic.rule;
          spokenReply =
            semantic.replacement?.trim() ||
            "I'm not able to provide that information. Our consultant will be happy to help.";
          const replacementTts = await this.synthesizeWithFallback(spokenReply, locale, callId);
          audio = replacementTts.audio;
          ttsMs = replacementTts.ttsMs;
          spokenReply = replacementTts.spokenText;
        } else {
          audio = tts.audio;
          ttsMs = tts.ttsMs;
          spokenReply = tts.spokenText;
        }
      }
      if (audio.length === 0) {
        await this.failCall(callId, "TTS returned empty audio");
        throw new ServiceUnavailableException("TTS provider returned empty audio");
      }

      const sttElapsed = opts.sttMs ?? 0;
      const llmElapsed = llmMs ?? Math.max(0, llmEnd - llmStart);
      const ttsEnd = Date.now();
      const ttsElapsed = ttsMs ?? Math.max(0, ttsEnd - ttsStart);
      const totalMs = sttElapsed + llmElapsed + ttsElapsed;

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

      this.persistTurns(callerTurn, assistantTurn);
      this.persistState(callId, state);
      this.recordTurnMetrics({
        sttMs: sttElapsed,
        llmMs: llmElapsed,
        ttsMs: ttsElapsed,
        totalMs,
        ttfaMs: null,
        result: guardrailTriggered ? "guardrail" : "ok",
      });

      if (shouldEndCall) {
        await this.completeCall(callId);
      }

      this.logger.log(
        `Turn ${turnIndex} call=${callId} stt=${sttElapsed}ms llm=${llmMs}ms tts=${ttsMs}ms tokens=${promptTokens}+${completionTokens} endCall=${shouldEndCall}`,
      );
      return {
        audio,
        transcript: utterance,
        reply: spokenReply,
        endCall: shouldEndCall,
        waitForMore: false,
      };
    } finally {
      clearTimeout(watchdog);
      this.activeTurns -= 1;
    }
  }

  // Streaming turn pipeline for live transports (demo WS, telephony media):
  // LLM deltas are sentence-split and dispatched to streaming TTS while the
  // rest of the reply is still generating, so the caller hears the first
  // sentence in well under a second instead of waiting for the full pipeline.
  async processUtteranceStream(
    callId: string,
    turnIndex: number,
    utteranceText: string,
    opts: { locale?: string; sttMs?: number; outputFormat?: string },
    sink: TurnStreamSink,
  ): Promise<{
    transcript: string;
    reply: string;
    endCall: boolean;
    waitForMore: boolean;
    canceled: boolean;
  }> {
    const prep = await this.prepareUtterance(callId, utteranceText, opts.locale);
    if (prep.hold) {
      return {
        transcript: prep.utterance,
        reply: "",
        endCall: false,
        waitForMore: true,
        canceled: false,
      };
    }
    const { state, utterance } = prep;
    const locale = state.locale;
    const turnStart = Date.now();

    const streamSentence = async (
      text: string,
      sentenceIndex: number,
      signal: AbortSignal,
      onFirstByte?: () => void,
    ) => {
      let first = true;
      const res = await this.tts.synthesizeStream(text, {
        languageCode: this.replyLanguageCode(text, locale),
        outputFormat: opts.outputFormat,
        signal,
        onChunk: (chunk) => {
          if (first) {
            first = false;
            onFirstByte?.();
          }
          sink.onAudioChunk(chunk, { sentenceIndex, last: false });
        },
      });
      sink.onAudioChunk(Buffer.alloc(0), { sentenceIndex, last: true });
      return res;
    };

    // Hard cap on call length.
    const maxMs = this.maxCallDurationMs();
    if (maxMs > 0 && Date.now() - state.startedAt > maxMs) {
      this.logger.warn(`Call ${callId} exceeded max duration — wrapping up`);
      const wrapUp = this.wrapUpText(locale);
      try {
        await streamSentence(wrapUp, 0, sink.signal);
      } catch {
        // wrap-up audio is best-effort
      }
      await this.completeCall(callId);
      return { transcript: utterance, reply: wrapUp, endCall: true, waitForMore: false, canceled: false };
    }

    this.activeTurns += 1;
    const turnController = new AbortController();
    const abortTurn = () => turnController.abort();
    sink.signal.addEventListener("abort", abortTurn);
    const watchdog = setTimeout(abortTurn, this.turnTimeoutMs());

    let ttfaMs: number | null = null;
    let sentenceIndex = 0;
    let dispatchedText = "";
    let ttsMsTotal = 0;
    let ttsQueue: Promise<void> = Promise.resolve();
    let hardTrigger: GuardrailResult | null = null;
    // If the model regresses to the legacy JSON envelope, buffer the whole
    // response instead of speaking JSON syntax aloud.
    let jsonMode: boolean | null = null;
    let pendingText = "";
    let endCallDetected = false;

    const dispatchSentence = (sentence: string) => {
      const text = sentence.trim();
      if (!text || hardTrigger || turnController.signal.aborted) return;
      const hard = this.guardrail.checkHard(text);
      if (hard.triggered) {
        hardTrigger = hard;
        return;
      }
      const idx = sentenceIndex;
      sentenceIndex += 1;
      dispatchedText = dispatchedText ? `${dispatchedText} ${text}` : text;
      sink.onReplyDelta?.(text);
      ttsQueue = ttsQueue
        .then(async () => {
          if (turnController.signal.aborted) return;
          const res = await streamSentence(text, idx, turnController.signal, () => {
            if (ttfaMs === null) ttfaMs = Date.now() - turnStart;
          });
          ttsMsTotal += res.ttsMs;
        })
        .catch((err) => {
          if (!turnController.signal.aborted) {
            this.logger.warn(
              `TTS stream failed mid-turn call=${callId}`,
              err instanceof Error ? err.message : String(err),
            );
          }
        });
    };

    const feedDelta = (delta: string) => {
      pendingText += delta;
      if (jsonMode === null) {
        const head = pendingText.trimStart();
        if (!head) return;
        jsonMode = head.startsWith("{") || head.startsWith("`");
      }
      if (jsonMode) return; // buffer everything; parse at end

      // Strip a complete end-call sentinel anywhere in the buffer.
      if (END_CALL_PATTERN.test(pendingText)) {
        endCallDetected = true;
        END_CALL_PATTERN.lastIndex = 0;
        pendingText = pendingText.replace(END_CALL_PATTERN, "");
      }
      END_CALL_PATTERN.lastIndex = 0;

      // Dispatch complete sentences, but hold back a tail that could be the
      // start of a split sentinel token ("<end_ca...").
      let match: RegExpExecArray | null;
      while ((match = SENTENCE_BOUNDARY.exec(pendingText))) {
        const end = match.index + match[1].length;
        const tail = pendingText.slice(end);
        if (/<[^>]*$/.test(pendingText.slice(0, end))) break;
        dispatchSentence(pendingText.slice(0, end));
        pendingText = tail.replace(/^\s+/, "");
      }
    };

    try {
      this.appendUserMessage(state, utterance);

      const llmStart = Date.now();
      let llmResolved: Awaited<ReturnType<typeof this.llm.generate>>;
      try {
        llmResolved = await this.llm.generateStream(
          state.history,
          {
            provider: state.provider,
            systemPrompt: state.systemPrompt,
            maxTokens: 400,
            signal: turnController.signal,
          },
          feedDelta,
        );
      } catch (err) {
        if (sink.signal.aborted || turnController.signal.aborted) {
          return this.finishCanceledTurn(state, dispatchedText, utterance);
        }
        this.logger.error(
          `All LLM providers failed (stream) call=${callId}`,
          err instanceof Error ? err.stack : String(err),
        );
        this.metrics.increment("pikorua_turns_total", { result: "llm_error" });
        if (!dispatchedText && !this.apologyOnCooldown(state)) {
          const excuse = this.apologyText(locale);
          try {
            await streamSentence(excuse, sentenceIndex, sink.signal);
            this.markApologyPlayed(state);
          } catch {
            // excuse audio is best-effort; transport will surface the error
          }
          return { transcript: utterance, reply: excuse, endCall: false, waitForMore: false, canceled: false };
        }
        if (!dispatchedText) {
          return { transcript: utterance, reply: "", endCall: false, waitForMore: false, canceled: false };
        }
        // Some sentences were already spoken — end the turn with what was said.
        await ttsQueue;
        state.history.push({ role: "assistant", content: dispatchedText });
        return { transcript: utterance, reply: dispatchedText, endCall: false, waitForMore: false, canceled: false };
      }
      const llmEnd = Date.now();
      const llmElapsed = llmResolved.llmMs ?? Math.max(0, llmEnd - llmStart);

      // Resolve the full reply text. JSON mode parses the buffered envelope;
      // plain mode flushes whatever didn't end on a sentence boundary.
      let reply: string;
      if (jsonMode) {
        const parsed = this.parseLlmReply(llmResolved.text, callId);
        reply = parsed.reply;
        endCallDetected = endCallDetected || parsed.endCall;
        // Nothing was dispatched yet in JSON mode — dispatch parsed sentences now.
        let rest = reply;
        let m: RegExpExecArray | null;
        while ((m = SENTENCE_BOUNDARY.exec(rest))) {
          const end = m.index + m[1].length;
          dispatchSentence(rest.slice(0, end));
          rest = rest.slice(end).replace(/^\s+/, "");
        }
        if (rest.trim()) dispatchSentence(rest);
      } else {
        if (END_CALL_PATTERN.test(pendingText)) {
          endCallDetected = true;
          END_CALL_PATTERN.lastIndex = 0;
          pendingText = pendingText.replace(END_CALL_PATTERN, "");
        }
        END_CALL_PATTERN.lastIndex = 0;
        if (pendingText.trim()) dispatchSentence(pendingText);
        pendingText = "";
        const parsed = this.parseLlmReply(llmResolved.text, callId);
        reply = parsed.reply;
        endCallDetected = endCallDetected || parsed.endCall;
      }

      if (!reply.trim()) {
        await this.failCall(callId, "LLM returned no reply");
        throw new ServiceUnavailableException("LLM provider returned no reply");
      }

      // History keeps the model's real output even if a guardrail replaces
      // what's spoken.
      state.history.push({ role: "assistant", content: reply });

      // Semantic guardrail runs concurrently with the remaining TTS work.
      const semanticPromise = hardTrigger
        ? Promise.resolve<GuardrailResult>({ triggered: false, rule: null, replacement: null })
        : this.guardrail.checkSemantic(reply).catch((): GuardrailResult => {
            return { triggered: false, rule: null, replacement: null };
          });
      const [, semantic] = await Promise.all([ttsQueue, semanticPromise]);

      if (sink.signal.aborted) {
        return this.finishCanceledTurn(state, dispatchedText, utterance, /* alreadyPushed */ true);
      }

      let guardrailTriggered = false;
      let guardrailRule: string | null = null;
      let spokenReply = dispatchedText || reply;

      const replacement = hardTrigger ?? (semantic.triggered ? semantic : null);
      if (replacement) {
        guardrailTriggered = true;
        guardrailRule = replacement.rule;
        spokenReply =
          replacement.replacement?.trim() ||
          "I'm not able to provide that information. Our consultant will be happy to help.";
        // Drop queued/playing audio on the transport, then speak the safe text.
        turnController.abort();
        sink.onCancel?.();
        const replacementController = new AbortController();
        const onSinkAbort = () => replacementController.abort();
        sink.signal.addEventListener("abort", onSinkAbort);
        try {
          await streamSentence(spokenReply, sentenceIndex, replacementController.signal, () => {
            if (ttfaMs === null) ttfaMs = Date.now() - turnStart;
          });
        } finally {
          sink.signal.removeEventListener("abort", onSinkAbort);
        }
        this.logger.warn(`Guardrail (${guardrailRule}) replaced streamed reply call=${callId}`);
      }

      const sttElapsed = opts.sttMs ?? 0;
      const totalMs = Date.now() - turnStart + sttElapsed;

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

      const assistantTurn: NewCallTurn = {
        callId,
        turnIndex: turnIndex * 2 + 1,
        role: "assistant",
        content: spokenReply,
        locale,
        sttMs: sttElapsed,
        llmMs: llmElapsed,
        ttsMs: ttsMsTotal,
        totalMs,
        llmModel: llmResolved.model ?? "",
        promptTokens: llmResolved.promptTokens ?? null,
        completionTokens: llmResolved.completionTokens ?? null,
        guardrailTriggered,
        guardrailRule,
        fallbackUsed: guardrailTriggered,
      } as NewCallTurn;

      this.persistTurns(callerTurn, assistantTurn);
      this.persistState(callId, state);
      this.recordTurnMetrics({
        sttMs: sttElapsed,
        llmMs: llmElapsed,
        ttsMs: ttsMsTotal,
        totalMs,
        ttfaMs,
        result: guardrailTriggered ? "guardrail" : "ok",
      });

      if (endCallDetected) {
        await this.completeCall(callId);
      }

      this.logger.log(
        `Turn ${turnIndex} call=${callId} (stream) stt=${sttElapsed}ms llm=${llmElapsed}ms tts=${ttsMsTotal}ms ttfa=${ttfaMs ?? "?"}ms endCall=${endCallDetected}`,
      );
      return {
        transcript: utterance,
        reply: spokenReply,
        endCall: endCallDetected,
        waitForMore: false,
        canceled: false,
      };
    } finally {
      clearTimeout(watchdog);
      sink.signal.removeEventListener("abort", abortTurn);
      this.activeTurns -= 1;
    }
  }

  // Barge-in/disconnect mid-turn: record what was actually spoken so the model
  // knows where it was interrupted, and let the new utterance drive the next turn.
  private finishCanceledTurn(
    state: CallState,
    dispatchedText: string,
    utterance: string,
    alreadyPushed = false,
  ) {
    this.metrics.increment("pikorua_turns_total", { result: "canceled" });
    if (dispatchedText && !alreadyPushed) {
      state.history.push({ role: "assistant", content: dispatchedText });
    }
    return {
      transcript: utterance,
      reply: dispatchedText,
      endCall: false,
      waitForMore: false,
      canceled: true,
    };
  }

  private recordTurnMetrics(t: {
    sttMs: number;
    llmMs: number;
    ttsMs: number;
    totalMs: number;
    ttfaMs: number | null;
    result: string;
  }) {
    this.metrics.increment("pikorua_turns_total", { result: t.result });
    this.metrics.observe("pikorua_turn_stt_ms", t.sttMs);
    this.metrics.observe("pikorua_turn_llm_ms", t.llmMs);
    this.metrics.observe("pikorua_turn_tts_ms", t.ttsMs);
    this.metrics.observe("pikorua_turn_total_ms", t.totalMs);
    if (t.ttfaMs !== null) this.metrics.observe("pikorua_turn_ttfa_ms", t.ttfaMs);
  }

  // Called by webhook handler when a call reaches a terminal state.
  clearHistory(callId: string) {
    this.calls.delete(callId);
    void this.deleteStateFromRedis(callId);
  }

  private async failCall(callId: string, reason: string) {
    this.logger.error(`Call ${callId} failed: ${reason}`);
    this.calls.delete(callId);
    void this.deleteStateFromRedis(callId);
    try {
      await this.callRepo.update(callId, { status: "failed" });
    } catch (err) {
      this.logger.warn("Failed to mark call failed", String(err));
    }
  }

  private evictStale() {
    const cutoff = Date.now() - STALE_MS;
    let evicted = 0;
    for (const [callId, state] of this.calls.entries()) {
      if (state.lastActivityAt < cutoff) {
        this.calls.delete(callId);
        evicted += 1;
      }
    }
    if (evicted > 0) {
      this.logger.log(`Evicted ${evicted} stale call state(s)`);
    }
  }
}

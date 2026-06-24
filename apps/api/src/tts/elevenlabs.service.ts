import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import WebSocket from "ws";

// Words the voice engine mispronounces under language_code=hi: Indian-English
// words and local proper nouns get respelled in Devanagari so the engine uses
// Hindi phonetics; unreadable abbreviations are expanded. This runs on every
// reply, so it catches cases where the LLM left them in Latin script.
const TTS_RESPELLINGS: Array<[RegExp, string]> = [
  [/\bcrores?\b/gi, "करोड़"],
  [/\blakhs?\b/gi, "लाख"],
  [/\bISKCON\b/gi, "इस्कॉन"],
  [/\bAmbli\b/gi, "अंबली"],
  [/\bAhmedabad\b/gi, "अहमदाबाद"],
  [/\bBodakdev\b/gi, "बोडकदेव"],
  // "brochure" is French-derived — the Hindi engine reads it with English
  // phonemes ("bro-chure") instead of the correct "BROH-shuh" sound.
  [/\bbrochures?\b/gi, "ब्रोशर"],
  // Brand suffix "Group" in "पिकोरा Group" — the Hindi engine mangles the Latin
  // word mid-sentence; respell in Devanagari so it reads as "ग्रुप".
  [/\bgroup\b/gi, "ग्रुप"],
  // Hard-block "take care" — replace with the correct sign-off at the TTS layer.
  [/\btake care[!.]*/gi, "Thank you."],
];

// Area units: in Hindi mode the engine reads "square feet" with English
// phonemes mid-Hindi-sentence, which sounds glitchy — respell in Devanagari.
const SQ_FT_PATTERNS: RegExp[] = [
  /\bsquare\s+feet\b/gi,
  /\bsq\.?\s*(?:ft\.?|feet)\b/gi,
  /\bsqft\b/gi,
];

// Romanized Hindi → Devanagari. The prompt asks the LLM for Devanagari, but
// it still leaks romanized fragments ("Aaj 2 baje...") which the engine
// mangles with English phonemes. Only unambiguous words are listed — tokens
// that are also common English words ("to", "main", "do", "the") are excluded.
const ROMAN_HINDI_WORDS: Array<[RegExp, string]> = [
  [/\baapko\b/gi, "आपको"],
  [/\baapka\b/gi, "आपका"],
  [/\baapki\b/gi, "आपकी"],
  [/\baap\b/gi, "आप"],
  [/\bhaan\b/gi, "हाँ"],
  [/\bnahin?\b/gi, "नहीं"],
  [/\bkya\b/gi, "क्या"],
  [/\bkaise\b/gi, "कैसे"],
  [/\bkahan\b/gi, "कहाँ"],
  [/\bhain\b/gi, "हैं"],
  [/\bhai\b/gi, "है"],
  [/\bbilkul\b/gi, "बिल्कुल"],
  [/\bac+ha\b/gi, "अच्छा"],
  [/\btheek\b/gi, "ठीक"],
  [/\bthik\b/gi, "ठीक"],
  [/\bbaje\b/gi, "बजे"],
  [/\baaj\b/gi, "आज"],
  [/\babhi\b/gi, "अभी"],
  [/\bthoda\b/gi, "थोड़ा"],
  [/\bthodi\b/gi, "थोड़ी"],
  [/\bshukriya\b/gi, "शुक्रिया"],
  [/\bdhanyavad\b/gi, "धन्यवाद"],
  [/\bnamaste\b/gi, "नमस्ते"],
  [/\bbahut\b/gi, "बहुत"],
  [/\bbohot\b/gi, "बहुत"],
  [/\bjo\b/gi, "जो"],
  [/\bdikhate\b/gi, "दिखाते"],
  [/\bdikhati\b/gi, "दिखाती"],
  [/\brahega\b/gi, "रहेगा"],
  [/\brahegi\b/gi, "रहेगी"],
  [/\bsakte\b/gi, "सकते"],
  [/\bsakti\b/gi, "सकती"],
  [/\bsakta\b/gi, "सकता"],
  [/\bkarenge\b/gi, "करेंगे"],
  [/\bkarte\b/gi, "करते"],
  [/\bkarti\b/gi, "करती"],
  [/\bmilega\b/gi, "मिलेगा"],
  [/\bmilegi\b/gi, "मिलेगी"],
  [/\bchahiye\b/gi, "चाहिए"],
  [/\bkarod\b/gi, "करोड़"],
  [/\blaakh\b/gi, "लाख"],
  [/\bhum\b/gi, "हम"],
  [/\blekin\b/gi, "लेकिन"],
  [/\bkyunki\b/gi, "क्योंकि"],
  [/\bmatlab\b/gi, "मतलब"],
];

// Hindi number words 0-99 (Hindi numerals are irregular — lookup table needed)
// 0 is "ज़ीरो" (the everyday spoken form) not "शून्य" (formal/mathematical).
const HINDI_0_99 = [
  "ज़ीरो",
  "एक",
  "दो",
  "तीन",
  "चार",
  "पाँच",
  "छह",
  "सात",
  "आठ",
  "नौ",
  "दस",
  "ग्यारह",
  "बारह",
  "तेरह",
  "चौदह",
  "पंद्रह",
  "सोलह",
  "सत्रह",
  "अठारह",
  "उन्नीस",
  "बीस",
  "इक्कीस",
  "बाईस",
  "तेईस",
  "चौबीस",
  "पच्चीस",
  "छब्बीस",
  "सत्ताईस",
  "अट्ठाईस",
  "उनतीस",
  "तीस",
  "इकतीस",
  "बत्तीस",
  "तैंतीस",
  "चौंतीस",
  "पैंतीस",
  "छत्तीस",
  "सैंतीस",
  "अड़तीस",
  "उनतालीस",
  "चालीस",
  "इकतालीस",
  "बयालीस",
  "तैंतालीस",
  "चवालीस",
  "पैंतालीस",
  "छियालीस",
  "सैंतालीस",
  "अड़तालीस",
  "उनचास",
  "पचास",
  "इक्यावन",
  "बावन",
  "तिरपन",
  "चौवन",
  "पचपन",
  "छप्पन",
  "सत्तावन",
  "अट्ठावन",
  "उनसठ",
  "साठ",
  "इकसठ",
  "बासठ",
  "तिरसठ",
  "चौंसठ",
  "पैंसठ",
  "छियासठ",
  "सड़सठ",
  "अड़सठ",
  "उनहत्तर",
  "सत्तर",
  "इकहत्तर",
  "बहत्तर",
  "तिहत्तर",
  "चौहत्तर",
  "पचहत्तर",
  "छिहत्तर",
  "सतहत्तर",
  "अठहत्तर",
  "उनासी",
  "अस्सी",
  "इक्यासी",
  "बयासी",
  "तिरासी",
  "चौरासी",
  "पचासी",
  "छियासी",
  "सत्तासी",
  "अठासी",
  "नवासी",
  "नब्बे",
  "इक्यानबे",
  "बानबे",
  "तिरानबे",
  "चौरानबे",
  "पचानबे",
  "छियानबे",
  "सत्तानबे",
  "अट्ठानबे",
  "निन्यानबे",
];

function hindiNumberWords(n: number): string {
  if (n < 100) return HINDI_0_99[n];
  const parts: string[] = [];
  const lakh = Math.floor(n / 100000);
  if (lakh) {
    parts.push(hindiNumberWords(lakh), "लाख");
    n %= 100000;
  }
  const thousand = Math.floor(n / 1000);
  if (thousand) {
    parts.push(hindiNumberWords(thousand), "हज़ार");
    n %= 1000;
  }
  const hundred = Math.floor(n / 100);
  if (hundred) {
    parts.push(HINDI_0_99[hundred], "सौ");
    n %= 100;
  }
  if (n) parts.push(HINDI_0_99[n]);
  return parts.join(" ");
}

const EN_0_19 = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const EN_TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

// Indian-English number words (lakh/crore grouping) for non-Hindi voice modes.
function englishNumberWords(n: number): string {
  if (n < 20) return EN_0_19[n];
  if (n < 100) {
    const tens = EN_TENS[Math.floor(n / 10)];
    const rem = n % 10;
    return rem ? `${tens} ${EN_0_19[rem]}` : tens;
  }
  const parts: string[] = [];
  const lakh = Math.floor(n / 100000);
  if (lakh) {
    parts.push(englishNumberWords(lakh), "lakh");
    n %= 100000;
  }
  const thousand = Math.floor(n / 1000);
  if (thousand) {
    parts.push(englishNumberWords(thousand), "thousand");
    n %= 1000;
  }
  const hundred = Math.floor(n / 100);
  if (hundred) {
    parts.push(englishNumberWords(hundred), "hundred");
    n %= 100;
  }
  if (n) parts.push(englishNumberWords(n));
  return parts.join(" ");
}

function isHindiMode(languageCode: string): boolean {
  const code = languageCode.toLowerCase();
  return code.startsWith("hi") || code.startsWith("gu");
}

// Normalize reply text for the voice engine. Locale-aware: Hindi/Gujarati
// modes respell Indian words and large numbers in Devanagari and transliterate
// leaked romanized Hindi; English modes only expand large numbers to words.
export function normalizeForTts(text: string, languageCode = "hi"): string {
  let out = text;
  const hindi = isHindiMode(languageCode);

  if (hindi) {
    for (const [pattern, replacement] of TTS_RESPELLINGS) {
      out = out.replace(pattern, replacement);
    }
    for (const pattern of SQ_FT_PATTERNS) {
      out = out.replace(pattern, "स्क्वेयर फीट");
    }
    for (const [pattern, replacement] of ROMAN_HINDI_WORDS) {
      out = out.replace(pattern, replacement);
    }
  } else {
    // Hard-block "take care" — replace with the correct sign-off at the TTS layer.
    out = out.replace(/\btake care[!.]*/gi, "Thank you.");
  }

  // Expand BHK configurations: "4BHK" → "four BHK". The BHK count is always
  // spoken in English number words even in Hindi mode — "four BHK" not
  // "चार BHK" — because the property type ("BHK") is English and the Hindi
  // numeral sounds unnatural against it. Handles whole and half configs.
  // Must run before the general number pass so the digit isn't left raw for TTS.
  out = out.replace(/\b(\d+(?:\.\d+)?)\s*BHK\b/gi, (_, num) => {
    const n = parseFloat(num);
    const whole = Math.floor(n);
    const half = n % 1 !== 0;
    const wordWhole =
      Number.isInteger(whole) && whole < 100 ? englishNumberWords(whole) : String(whole);
    return half ? `${wordWhole} and a half BHK` : `${wordWhole} BHK`;
  });

  // Convert numbers to words so the engine doesn't mispronounce them.
  // Exclusions (kept as digits — engine handles these natively or word-form is worse):
  //   • Years 1900–2099 not in a comma-grouped string
  //   • Numbers immediately followed by AM/PM / % (e.g. "9AM")
  //   • Time patterns like "10:30"
  //   • Numbers > 9,999,999 (crore+) — too rare/complex to handle reliably
  out = out.replace(/\b\d{1,3}(?:,\d{2,3})+\b|\b\d+\b/g, (match, offset, str) => {
    const n = parseInt(match.replace(/,/g, ""), 10);
    if (!Number.isFinite(n) || n > 9999999) return match;
    // Skip years when not comma-formatted
    if (!match.includes(",") && n >= 1900 && n <= 2099) return match;
    // Skip if followed by AM/PM, %
    const after = str.slice(offset + match.length);
    if (/^(?:am|pm|%)/i.test(after)) return match;
    // Skip time patterns like "10:30" — both the hour and minute digits
    const before = str.slice(0, offset);
    if (/[:.]\s*$/.test(before)) return match;
    if (/^\s*:/.test(after)) return match;
    return hindi ? hindiNumberWords(n) : englishNumberWords(n);
  });
  return out;
}

export type SynthesizeOptions = {
  voiceId?: string;
  // Overrides ELEVENLABS_LANGUAGE_CODE for this request (e.g. "en" for
  // English-locale calls so number words come out in English).
  languageCode?: string;
  // Telephony output: "pcm_8000" for Exotel (raw 16-bit linear PCM, 8 kHz),
  // "ulaw_8000" for Twilio (G.711 µ-law) media streams.
  outputFormat?: string;
};

export type StreamSynthesisResult = {
  ttsMs: number;
  // Time to first audio byte — the latency the caller actually perceives.
  ttfbMs: number | null;
  bytes: number;
};

@Injectable()
export class ElevenlabsService {
  private readonly logger = new Logger("ElevenlabsService");

  // Pre-synthesized short clips (fillers, apologies) keyed by text+language.
  // Served instantly to mask turn latency and to survive TTS provider outages.
  private readonly clips = new Map<string, Buffer>();

  constructor(private readonly config: ConfigService) {}

  private resolveLanguageCode(opts?: SynthesizeOptions): string {
    return String(opts?.languageCode ?? this.config.get("ELEVENLABS_LANGUAGE_CODE") ?? "hi");
  }

  private requestConfig(opts?: SynthesizeOptions) {
    const key = String(this.config.get("ELEVENLABS_API_KEY") ?? "");
    const vid = String(this.config.get("ELEVENLABS_VOICE_ID") ?? opts?.voiceId ?? "alloy");
    if (!key) {
      this.logger.warn("ElevenLabs API key not configured — returning empty audio");
      throw new ServiceUnavailableException("ElevenLabs API key is not configured");
    }
    // Voice tuning for a natural, human conversational tone (not robotic):
    // moderate stability keeps it steady without monotone; lower style avoids
    // the exaggerated/synthetic feel; high similarity keeps the voice's warmth.
    // All overridable via env so you can tune without a redeploy.
    const stability = Number(this.config.get("ELEVENLABS_STABILITY") ?? 0.58);
    const similarityBoost = Number(this.config.get("ELEVENLABS_SIMILARITY_BOOST") ?? 0.9);
    // Style controls expressiveness. Nudged to 0.30 for a warmer, smiling
    // delivery (a friendly young woman) without going so high that stability
    // drops and the voice starts to waver.
    const style = Number(this.config.get("ELEVENLABS_STYLE") ?? 0.3);
    const modelId = String(this.config.get("ELEVENLABS_MODEL") ?? "eleven_turbo_v2_5");
    // Forcing the language makes the model read romanized Hindi correctly
    // ("aapko", "kya") instead of mangling it with English phonemes. English
    // words then get a natural Indian accent — right for Hinglish calls.
    const languageCode = this.resolveLanguageCode(opts);
    return { key, vid, stability, similarityBoost, style, modelId, languageCode };
  }

  private buildBody(text: string, cfg: ReturnType<ElevenlabsService["requestConfig"]>) {
    const body: Record<string, unknown> = {
      text: normalizeForTts(text, cfg.languageCode),
      model_id: cfg.modelId,
      voice_settings: {
        stability: cfg.stability,
        similarity_boost: cfg.similarityBoost,
        style: cfg.style,
        use_speaker_boost: true,
      },
    };
    if (cfg.languageCode) body.language_code = cfg.languageCode.split("-")[0];
    return body;
  }

  async synthesize(text: string, opts?: SynthesizeOptions) {
    const start = Date.now();
    const cfg = this.requestConfig(opts);
    // optimize_streaming_latency trades a little quality for faster first-byte
    // (3 = strong optimization) — noticeably cuts perceived TTS lag on calls.
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${cfg.vid}?optimize_streaming_latency=3${
      opts?.outputFormat ? `&output_format=${opts.outputFormat}` : ""
    }`;
    const body = this.buildBody(text, cfg);

    // A transient provider blip must not drop a live call — one quick retry.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const resp = await axios.post(url, body, {
          headers: { "xi-api-key": cfg.key, "Content-Type": "application/json" },
          responseType: "arraybuffer",
          timeout: Number(this.config.get("TTS_TIMEOUT_MS") ?? 8000),
        });
        const audio = Buffer.from(resp.data as ArrayBuffer);
        const ms = Date.now() - start;
        this.logger.log(`TTS complete (${ms}ms) bytes=${audio.length}`);
        return { audio, ttsMs: ms };
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `TTS attempt ${attempt + 1} failed${attempt === 0 ? " — retrying" : ""}`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
      }
    }
    this.logger.error("TTS failed", lastErr instanceof Error ? lastErr.stack : String(lastErr));
    throw new ServiceUnavailableException("ElevenLabs synthesis failed");
  }

  // Streaming synthesis: audio chunks are forwarded as they arrive from the
  // /stream endpoint so the caller hears the first bytes in ~hundreds of ms
  // instead of waiting for the full clip. Retries once, but only if nothing
  // was emitted yet (chunks already forwarded can't be unsent).
  async synthesizeStream(
    text: string,
    opts: SynthesizeOptions & {
      signal?: AbortSignal;
      onChunk: (chunk: Buffer) => void;
    },
  ): Promise<StreamSynthesisResult> {
    const start = Date.now();
    const cfg = this.requestConfig(opts);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${cfg.vid}/stream?optimize_streaming_latency=3${
      opts.outputFormat ? `&output_format=${opts.outputFormat}` : ""
    }`;
    const body = this.buildBody(text, cfg);

    let bytes = 0;
    let ttfbMs: number | null = null;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const resp = await axios.post(url, body, {
          headers: { "xi-api-key": cfg.key, "Content-Type": "application/json" },
          responseType: "stream",
          timeout: Number(this.config.get("TTS_TIMEOUT_MS") ?? 8000),
          signal: opts.signal,
        });
        for await (const chunk of resp.data as AsyncIterable<Buffer>) {
          if (opts.signal?.aborted) break;
          if (ttfbMs === null) ttfbMs = Date.now() - start;
          bytes += chunk.length;
          opts.onChunk(chunk);
        }
        const ms = Date.now() - start;
        this.logger.log(`TTS stream complete (${ms}ms ttfb=${ttfbMs}ms) bytes=${bytes}`);
        return { ttsMs: ms, ttfbMs, bytes };
      } catch (err) {
        lastErr = err;
        if (bytes > 0 || opts.signal?.aborted) break;
        this.logger.warn(
          `TTS stream attempt ${attempt + 1} failed${attempt === 0 ? " — retrying" : ""}`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (opts.signal?.aborted) {
      return { ttsMs: Date.now() - start, ttfbMs, bytes };
    }
    this.logger.error(
      "TTS stream failed",
      lastErr instanceof Error ? lastErr.stack : String(lastErr),
    );
    throw new ServiceUnavailableException("ElevenLabs streaming synthesis failed");
  }

  // Return a cached short clip, synthesizing and caching it on first use.
  // Used for fillers ("hmm, ek second...") and outage apologies — both must be
  // instant, and the apology must work even when the TTS provider is down.
  async getClip(text: string, opts?: SynthesizeOptions): Promise<Buffer | null> {
    const key = `${this.resolveLanguageCode(opts)}|${opts?.outputFormat ?? "mp3"}|${text}`;
    const cached = this.clips.get(key);
    if (cached) return cached;
    try {
      const { audio } = await this.synthesize(text, opts);
      if (audio.length > 0) this.clips.set(key, audio);
      return audio;
    } catch {
      return null;
    }
  }

  // Fire-and-forget warm-up so the first filler/apology of a call is cached.
  prewarmClips(texts: string[], opts?: SynthesizeOptions) {
    for (const text of texts) {
      void this.getClip(text, opts).catch(() => undefined);
    }
  }

  // WebSocket input-streaming TTS: open a persistent ElevenLabs WS session for
  // a single turn. The caller feeds text tokens as they arrive from the LLM;
  // audio chunks come back in real time. This achieves true token→audio
  // pipelining — the first audio chunk arrives after the first few tokens,
  // rather than waiting for a complete sentence.
  //
  // Returns a session handle; the caller must call session.close() when done.
  openWsSession(
    opts: SynthesizeOptions & {
      onChunk: (chunk: Buffer) => void;
      onDone: () => void;
      onError: (err: string) => void;
      signal?: AbortSignal;
    },
  ): { sendText: (text: string) => void; flush: () => void; close: () => void } {
    const cfg = this.requestConfig(opts);
    const outputFormat = opts.outputFormat ?? "mp3_44100_128";
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${cfg.vid}/stream-input?model_id=${cfg.modelId}&output_format=${outputFormat}&optimize_streaming_latency=3`;

    let ws: WebSocket | null = null;
    let closed = false;
    // Separate from `closed`: guarantees onDone fires exactly once whenever the
    // session ends, including when WE forced the close (guardrail hit, abort,
    // barge-in) — those are exactly the cases where the caller most needs to be
    // unblocked, not suppressed.
    let finished = false;
    const pendingTexts: string[] = [];
    let wsOpen = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      opts.onDone();
    };

    const flushPending = () => {
      for (const t of pendingTexts) {
        try {
          ws?.send(JSON.stringify({ text: t, try_trigger_generation: true }));
        } catch {}
      }
      pendingTexts.length = 0;
    };

    const socket = new WebSocket(url, {
      headers: { "xi-api-key": cfg.key },
    });
    ws = socket;

    socket.on("open", () => {
      if (closed) {
        try {
          socket.close();
        } catch {}
        return;
      }
      wsOpen = true;
      // Send voice settings handshake
      socket.send(
        JSON.stringify({
          text: " ",
          voice_settings: {
            stability: cfg.stability,
            similarity_boost: cfg.similarityBoost,
            style: cfg.style,
            use_speaker_boost: true,
          },
          ...(cfg.languageCode ? { language_code: cfg.languageCode.split("-")[0] } : {}),
          xi_api_key: cfg.key,
        }),
      );
      flushPending();
    });

    socket.on("message", (data) => {
      if (closed) return; // drop stale audio after a guardrail/abort-triggered close
      try {
        const msg = JSON.parse(data.toString());
        if (msg.audio) {
          const chunk = Buffer.from(msg.audio, "base64");
          if (chunk.length > 0) opts.onChunk(chunk);
        }
        if (msg.isFinal) finish();
      } catch {}
    });

    socket.on("error", (err) => {
      if (!closed) opts.onError(err.message);
      finish();
    });

    socket.on("close", () => {
      finish();
    });

    opts.signal?.addEventListener("abort", () => {
      closed = true;
      try {
        socket.close();
      } catch {}
    });

    return {
      sendText: (text: string) => {
        if (closed) return;
        const normalized = normalizeForTts(text, cfg.languageCode);
        if (wsOpen) {
          try {
            socket.send(JSON.stringify({ text: normalized, try_trigger_generation: true }));
          } catch {}
        } else {
          pendingTexts.push(normalized);
        }
      },
      flush: () => {
        if (closed) return;
        // ElevenLabs flushes on receiving an empty string
        if (wsOpen) {
          try {
            socket.send(JSON.stringify({ text: "" }));
          } catch {}
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (wsOpen) {
          try {
            socket.send(JSON.stringify({ text: "" }));
          } catch {}
        }
        setTimeout(() => {
          try {
            socket.close();
          } catch {}
        }, 500);
      },
    };
  }
}

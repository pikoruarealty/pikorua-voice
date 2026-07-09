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
  [/\bBopal\b/gi, "बोपल"],
  [/\bAhmedabad\b/gi, "अहमदाबाद"],
  // "bungalow" — Hindi engine mangles the Latin word; respell so it reads naturally.
  [/\bbungalows\b/gi, "बंगलो"],
  [/\bbungalow\b/gi, "बंगलो"],
  [/\bबंगले\b/g, "बंगलो"],
  [/\bबंगला\b/g, "बंगलो"],
  [/\bBodakdev\b/gi, "बोडकदेव"],
  // "brochure" is French-derived — the Hindi engine reads it with English
  // phonemes ("bro-chure") instead of the correct "BROH-shuh" sound.
  [/\bbrochures?\b/gi, "ब्रोशर"],
  // "exceptional" appears in nearly every property pitch mid-Hindi sentence;
  // the Hindi engine mangles the Latin word — respell phonetically.
  // "इक्सेप्शनल" (ik-sep-sh-nal) not "एक्सेप्शनल": starting with एक (the Hindi
  // word for "one") causes the engine to pause after it, which sounds like a stretch.
  [/\bexceptional\b/gi, "इक्सेप्शनल"],
  // Brand suffix "Group" in "पिकोरा Group" — the Hindi engine mangles the Latin
  // word mid-sentence; respell in Devanagari so it reads as "ग्रुप".
  [/\bgroup\b/gi, "ग्रुप"],
  // Brand suffix "Realty" in "पिकोरा Realty" — respell so the Hindi engine reads
  // it cleanly as "रियल्टी" instead of mangling the Latin word mid-sentence.
  [/\brealty\b/gi, "रियल्टी"],
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

// Area-figure units (square feet / square yards) in the spellings the model
// emits. Used to detect that a number names a property size.
const AREA_UNIT_SRC =
  "(?:square\\s+feet|sq\\.?\\s*(?:ft\\.?|feet)|sqft|square\\s+yards?|sq\\.?\\s*(?:yds?\\.?|yards?))";
const AREA_NUM_SRC = "\\d{1,3}(?:,\\d{2,3})+|\\d+";
const AREA_RANGE_RE = new RegExp(
  `\\b(${AREA_NUM_SRC})(\\s*(?:up\\s+to|to|से|–|—|-)\\s*)(${AREA_NUM_SRC})(\\s*)(${AREA_UNIT_SRC})\\b`,
  "gi",
);
const AREA_SINGLE_RE = new RegExp(`\\b(${AREA_NUM_SRC})(\\s*)(${AREA_UNIT_SRC})\\b`, "gi");

// Property sizes read more naturally with the NUMBER in English even on a Hindi
// call — "four thousand eight hundred square feet", not the Hindi number words —
// the same reasoning as the BHK rule. The unit itself is still respelled to
// Devanagari downstream (in Hindi mode) for correct pronunciation; only the
// figure switches to English words. Handles single figures and two-number
// ranges ("4,000–9,000 square feet", "700 to 2,100 square yards", "5,500 से
// 11,000 square feet"). Must run BEFORE the Hindi unit respelling (which rewrites
// "square feet" → Devanagari) and BEFORE the general number pass.
function areaNumbersToEnglish(text: string): string {
  const toWords = (raw: string) => {
    const n = parseInt(raw.replace(/,/g, ""), 10);
    return Number.isFinite(n) && n <= 9999999 ? englishNumberWords(n) : raw;
  };
  let out = text.replace(
    AREA_RANGE_RE,
    (_m, a, sep, b, sp, unit) => `${toWords(a)}${sep}${toWords(b)}${sp}${unit}`,
  );
  out = out.replace(AREA_SINGLE_RE, (_m, num, sp, unit) => `${toWords(num)}${sp}${unit}`);
  return out;
}

// English words for a possibly-decimal figure: "3" -> "three", "3.5" ->
// "three point five". Used by the distance normalizer.
function englishNumberPhrase(numStr: string): string {
  if (numStr.includes(".")) {
    const [intPart, fracPart] = numStr.split(".");
    const whole = englishNumberWords(parseInt(intPart, 10));
    const digits = fracPart
      .split("")
      .map((d) => englishNumberWords(parseInt(d, 10)))
      .join(" ");
    return `${whole} point ${digits}`;
  }
  return englishNumberWords(parseInt(numStr, 10));
}

// Distances always read in English, in BOTH modes — the Hindi engine mangles the
// "km" token AND reads the number in Hindi. Spell the number in English words and
// expand the unit: "3 km" -> "three kilometers", "1 km" -> "one kilometer",
// "7-8 km" -> "seven to eight kilometers". Must run before the general number
// pass. Handles a single figure (incl. one decimal) and a hyphenated range.
const KM_UNIT_SRC = "(?:kms?|kilometers?|कि\\.?\\s*मी\\.?|किमी|किलोमीटर)";
const KM_RANGE_RE = new RegExp(`\\b(\\d+)\\s*[-–—]\\s*(\\d+)\\s*${KM_UNIT_SRC}\\b`, "gi");
const KM_SINGLE_RE = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*${KM_UNIT_SRC}\\b`, "gi");

function distancesToEnglish(text: string): string {
  let out = text.replace(
    KM_RANGE_RE,
    (_m, a, b) =>
      `${englishNumberWords(parseInt(a, 10))} to ${englishNumberWords(parseInt(b, 10))} kilometers`,
  );
  out = out.replace(KM_SINGLE_RE, (_m, num) => {
    const n = parseFloat(num);
    const unit = n === 1 ? "kilometer" : "kilometers";
    return `${englishNumberPhrase(num)} ${unit}`;
  });
  return out;
}

// Durations in minutes read in English in both modes ("30 minutes" -> "thirty
// minutes"), like distances — in Hindi mode the engine would otherwise read the
// number in Hindi ("तीस minutes"), which sounds off against the English "minutes".
// Trailing guard is "(?!\w)" not "\b": \b needs an ASCII word-boundary
// transition, which "मिनट" followed by the Devanagari danda "।" never produces
// (both are non-word chars to JS), so \b would drop "30 मिनट।".
const MINUTES_RE = /\b(\d+)\s*(?:mins?|minutes?|मिनट)(?!\w)/gi;

function durationsToEnglish(text: string): string {
  return text.replace(MINUTES_RE, (_m, num) => {
    const n = parseInt(num, 10);
    return `${englishNumberWords(n)} ${n === 1 ? "minute" : "minutes"}`;
  });
}

// Clock times spoken in English words so they read correctly in Hindi mode too
// (the Hindi engine reads bare digits like "3:02 PM" in Hindi). "3:02 PM" ->
// "three oh two PM", "11:30 AM" -> "eleven thirty AM", "3:00 PM" -> "three PM",
// "4 PM" -> "four PM". Distinct from the scheduling "N बजे" form, which stays in
// Hindi ("ग्यारह बजे") and is handled by the general pass.
function clockToEnglishWords(hour: number, minute: number | null, ampm?: string): string {
  const hourWord = englishNumberWords(hour);
  let minutePart = "";
  if (minute && minute > 0) {
    minutePart =
      minute < 10 ? ` oh ${englishNumberWords(minute)}` : ` ${englishNumberWords(minute)}`;
  }
  const suffix = ampm ? ` ${ampm.toUpperCase()}` : "";
  return `${hourWord}${minutePart}${suffix}`;
}
const CLOCK_COLON_RE = /\b(\d{1,2}):(\d{2})(?:\s*(am|pm))?\b/gi;
const CLOCK_AMPM_RE = /\b(\d{1,2})\s*(am|pm)\b/gi;

// Normalize reply text for the voice engine. Locale-aware: Hindi/Gujarati
// modes respell Indian words and large numbers in Devanagari and transliterate
// leaked romanized Hindi; English modes only expand large numbers to words.
export function normalizeForTts(text: string, languageCode = "hi"): string {
  let out = text;
  const hindi = isHindiMode(languageCode);

  // Property sizes: number spoken in English in every mode. Runs first so the
  // unit respelling and general number pass below see English words, not digits.
  out = areaNumbersToEnglish(out);

  // Distances: number + unit spoken in English in every mode ("3 km" -> "three
  // kilometers"). Runs before the general pass so the figure isn't Hindi-worded.
  out = distancesToEnglish(out);

  // Durations: "30 minutes" -> "thirty minutes" in every mode (same reasoning).
  out = durationsToEnglish(out);

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

  // Clock times → English words in Hindi mode (English mode already reads the
  // digits in English, so leave those as digits). The scheduling "N बजे" form is
  // untouched here and stays Hindi ("ग्यारह बजे") via the general pass below.
  if (hindi) {
    out = out.replace(CLOCK_COLON_RE, (_m, h, m, ap) =>
      clockToEnglishWords(parseInt(h, 10), parseInt(m, 10), ap),
    );
    out = out.replace(CLOCK_AMPM_RE, (_m, h, ap) =>
      clockToEnglishWords(parseInt(h, 10), null, ap),
    );
  }

  // "see you at 4" → "see you at four": the sign-off time is spoken as an English
  // number in both modes (never the Hindi "चार"). Skips colon / AM-PM forms —
  // those are handled by the clock rules above.
  out = out.replace(
    /\b(see you at)\s+(\d{1,2})(?!\s*(?::|am|pm))\b/gi,
    (_m, phrase, num) => `${phrase} ${englishNumberWords(parseInt(num, 10))}`,
  );

  // Convert numbers to words so the engine doesn't mispronounce them.
  // Exclusions (kept as digits — engine handles these natively or word-form is worse):
  //   • Years 1900–2099 not in a comma-grouped string
  //   • Numbers followed by AM/PM / % — with or without a space ("9AM" and "9 AM").
  //     Clock times read more naturally as digits ("9 AM" not "nine AM"); the
  //     model emits the spaced form, so the optional \s* is essential here.
  //   • Time patterns like "10:30"
  //   • Numbers > 9,999,999 (crore+) — too rare/complex to handle reliably
  out = out.replace(/\b\d{1,3}(?:,\d{2,3})+\b|\b\d+\b/g, (match, offset, str) => {
    const n = parseInt(match.replace(/,/g, ""), 10);
    if (!Number.isFinite(n) || n > 9999999) return match;
    // Skip years when not comma-formatted
    if (!match.includes(",") && n >= 1900 && n <= 2099) return match;
    // Skip if followed by AM/PM (optionally space-separated) or %. The \b after
    // am/pm avoids matching "9 American"; % needs no boundary.
    const after = str.slice(offset + match.length);
    if (/^\s*(?:(?:am|pm)\b|%)/i.test(after)) return match;
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
    // moderate stability keeps it steady without monotone; style adds the
    // smile/warmth; high similarity keeps the voice's character.
    // All overridable via env so you can tune without a redeploy.
    // Stability 0.55 — the consistency dial. Too low (≤0.5) lets tone drift
    // turn-to-turn (sometimes warm, sometimes flat); too high flattens the
    // smile into a monotone. 0.55 holds a steady, consistent tone across the
    // whole conversation while `style` below still carries the warmth.
    const stability = Number(this.config.get("ELEVENLABS_STABILITY") ?? 0.55);
    const similarityBoost = Number(this.config.get("ELEVENLABS_SIMILARITY_BOOST") ?? 0.9);
    // Style controls expressiveness — this is the "smile" dial. Raised to 0.45
    // (from 0.30) so she sounds like a warm, smiling young woman rather than a
    // flat, neutral reader. Pushing much past ~0.5 starts to sound theatrical
    // and can make her waver, so 0.45 is the warm-but-steady sweet spot.
    const style = Number(this.config.get("ELEVENLABS_STYLE") ?? 0.45);
    // Playback speed. ElevenLabs accepts 0.7–1.2 only (1.0 = natural pace).
    // Default 1.1 — a touch brisker than natural for the new voice (which read
    // too slowly at 1.0) without the rushed feel of the 1.2 maximum. Clamped so
    // an out-of-range env value can't break synthesis. Tune via ELEVENLABS_SPEED.
    const speed = Math.min(1.2, Math.max(0.7, Number(this.config.get("ELEVENLABS_SPEED") ?? 1.1)));
    const modelId = String(this.config.get("ELEVENLABS_MODEL") ?? "eleven_turbo_v2_5");
    // Forcing the language makes the model read romanized Hindi correctly
    // ("aapko", "kya") instead of mangling it with English phonemes. English
    // words then get a natural Indian accent — right for Hinglish calls.
    const languageCode = this.resolveLanguageCode(opts);
    return { key, vid, stability, similarityBoost, style, speed, modelId, languageCode };
  }

  private buildBody(text: string, cfg: ReturnType<ElevenlabsService["requestConfig"]>) {
    const body: Record<string, unknown> = {
      text: normalizeForTts(text, cfg.languageCode),
      model_id: cfg.modelId,
      voice_settings: {
        stability: cfg.stability,
        similarity_boost: cfg.similarityBoost,
        style: cfg.style,
        speed: cfg.speed,
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
  // Runs with a small concurrency cap: firing every clip at once at call start
  // slammed ElevenLabs' per-key concurrency limit and drew 429s — and the live
  // greeting's own TTS was competing for the same budget, so the opening line
  // was delayed by retries. Warm-ups aren't latency-critical, so a cap of 2
  // fills the cache without starving the greeting.
  prewarmClips(texts: string[], opts?: SynthesizeOptions) {
    const CONCURRENCY = 2;
    const queue = [...texts];
    const pump = async (): Promise<void> => {
      const text = queue.shift();
      if (text === undefined) return;
      await this.getClip(text, opts).catch(() => undefined);
      return pump();
    };
    for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i += 1) {
      void pump();
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
            speed: cfg.speed,
            use_speaker_boost: true,
          },
          // Buffer enough chars before committing to audio — prevents the engine
          // from elongating the final phoneme of a sentence while it waits for
          // the next one to arrive (the mid-sentence "stretch" artifact).
          chunk_length_schedule: [120, 160, 250, 290],
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

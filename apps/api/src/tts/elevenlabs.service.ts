import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

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
  [/\bsq\.?\s*ft\.?\b/gi, "square feet"],
];

// Hindi number words 0-99 (Hindi numerals are irregular — lookup table needed)
const HINDI_0_99 = [
  "शून्य", "एक", "दो", "तीन", "चार", "पाँच", "छह", "सात", "आठ", "नौ",
  "दस", "ग्यारह", "बारह", "तेरह", "चौदह", "पंद्रह", "सोलह", "सत्रह", "अठारह", "उन्नीस",
  "बीस", "इक्कीस", "बाईस", "तेईस", "चौबीस", "पच्चीस", "छब्बीस", "सत्ताईस", "अट्ठाईस", "उनतीस",
  "तीस", "इकतीस", "बत्तीस", "तैंतीस", "चौंतीस", "पैंतीस", "छत्तीस", "सैंतीस", "अड़तीस", "उनतालीस",
  "चालीस", "इकतालीस", "बयालीस", "तैंतालीस", "चवालीस", "पैंतालीस", "छियालीस", "सैंतालीस", "अड़तालीस", "उनचास",
  "पचास", "इक्यावन", "बावन", "तिरपन", "चौवन", "पचपन", "छप्पन", "सत्तावन", "अट्ठावन", "उनसठ",
  "साठ", "इकसठ", "बासठ", "तिरसठ", "चौंसठ", "पैंसठ", "छियासठ", "सड़सठ", "अड़सठ", "उनहत्तर",
  "सत्तर", "इकहत्तर", "बहत्तर", "तिहत्तर", "चौहत्तर", "पचहत्तर", "छिहत्तर", "सतहत्तर", "अठहत्तर", "उनासी",
  "अस्सी", "इक्यासी", "बयासी", "तिरासी", "चौरासी", "पचासी", "छियासी", "सत्तासी", "अठासी", "नवासी",
  "नब्बे", "इक्यानबे", "बानबे", "तिरानबे", "चौरानबे", "पचानबे", "छियानबे", "सत्तानबे", "अट्ठानबे", "निन्यानबे",
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

function normalizeForTts(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TTS_RESPELLINGS) {
    out = out.replace(pattern, replacement);
  }
  // Large numbers ("7,600", "5700", "1,23,456") get garbled by the engine in
  // Hindi mode — speak them as Hindi words instead. Small numbers (times,
  // counts, "4BHK") read fine and are left alone.
  out = out.replace(/\b\d{1,3}(?:,\d{2,3})+\b|\b\d{4,7}\b/g, (match) => {
    const n = parseInt(match.replace(/,/g, ""), 10);
    if (!Number.isFinite(n) || n > 9999999) return match;
    return hindiNumberWords(n);
  });
  return out;
}

@Injectable()
export class ElevenlabsService {
  private readonly logger = new Logger("ElevenlabsService");
  constructor(private readonly config: ConfigService) {}

  async synthesize(text: string, voiceId?: string) {
    const start = Date.now();
    const key = String(this.config.get("ELEVENLABS_API_KEY") ?? "");
    const vid = String(this.config.get("ELEVENLABS_VOICE_ID") ?? voiceId ?? "alloy");
    if (!key) {
      this.logger.warn("ElevenLabs API key not configured — returning empty audio");
      throw new ServiceUnavailableException("ElevenLabs API key is not configured");
    }

    try {
      // optimize_streaming_latency trades a little quality for faster first-byte
      // (3 = strong optimization) — noticeably cuts perceived TTS lag on calls.
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}?optimize_streaming_latency=3`;
      // Voice tuning for a natural, human conversational tone (not robotic):
      // moderate stability keeps it steady without monotone; lower style avoids
      // the exaggerated/synthetic feel; high similarity keeps the voice's warmth.
      // All overridable via env so you can tune without a redeploy.
      const stability = Number(this.config.get("ELEVENLABS_STABILITY") ?? 0.6);
      const similarityBoost = Number(this.config.get("ELEVENLABS_SIMILARITY_BOOST") ?? 0.9);
      const style = Number(this.config.get("ELEVENLABS_STYLE") ?? 0.2);
      const modelId = String(this.config.get("ELEVENLABS_MODEL") ?? "eleven_turbo_v2_5");
      // Forcing the language makes the model read romanized Hindi correctly
      // ("aapko", "kya") instead of mangling it with English phonemes. English
      // words then get a natural Indian accent — right for Hinglish calls.
      const languageCode = String(this.config.get("ELEVENLABS_LANGUAGE_CODE") ?? "hi");
      const body: Record<string, unknown> = {
        text: normalizeForTts(text),
        model_id: modelId,
        voice_settings: {
          stability,
          similarity_boost: similarityBoost,
          style,
          use_speaker_boost: true,
        },
      };
      if (languageCode) body.language_code = languageCode;
      const resp = await axios.post(
        url,
        body,
        {
          headers: { "xi-api-key": key, "Content-Type": "application/json" },
          responseType: "arraybuffer",
          timeout: 10000,
        },
      );
      const audio = Buffer.from(resp.data as ArrayBuffer);
      const ms = Date.now() - start;
      this.logger.log(`TTS complete (${ms}ms) bytes=${audio.length}`);
      return { audio, ttsMs: ms };
    } catch (err) {
      this.logger.error("TTS failed", err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException("ElevenLabs synthesis failed");
    }
  }
}

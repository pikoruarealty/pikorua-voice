import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

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
      const stability = Number(this.config.get("ELEVENLABS_STABILITY") ?? 0.5);
      const similarityBoost = Number(this.config.get("ELEVENLABS_SIMILARITY_BOOST") ?? 0.85);
      const style = Number(this.config.get("ELEVENLABS_STYLE") ?? 0.15);
      const resp = await axios.post(
        url,
        {
          text,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability,
            similarity_boost: similarityBoost,
            style,
            use_speaker_boost: true,
          },
        },
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

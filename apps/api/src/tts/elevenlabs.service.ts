import { Injectable, Logger } from "@nestjs/common";
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
      return { audio: Buffer.from([]), ttsMs: Date.now() - start };
    }

    try {
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${vid}`;
      const resp = await axios.post(
        url,
        { text },
        { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 10000 },
      );
      const audio = Buffer.from(resp.data as ArrayBuffer);
      const ms = Date.now() - start;
      this.logger.log(`TTS complete (${ms}ms) bytes=${audio.length}`);
      return { audio, ttsMs: ms };
    } catch (err) {
      this.logger.error("TTS failed", err instanceof Error ? err.stack : String(err));
      return { audio: Buffer.from([]), ttsMs: Date.now() - start };
    }
  }
}

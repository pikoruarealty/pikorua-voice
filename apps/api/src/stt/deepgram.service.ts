import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Deepgram } from "@deepgram/sdk";

@Injectable()
export class DeepgramService {
  private readonly logger = new Logger("DeepgramService");
  private readonly client: any;

  constructor(private readonly config: ConfigService) {
    const key = String(this.config.get("DEEPGRAM_API_KEY") ?? "");
    this.client = new Deepgram(key);
  }

  // Transcribe a pre-recorded audio buffer (low-latency variant). Returns
  // { text, latencyMs }
  async transcribeBuffer(buffer: Buffer, mime = "audio/wav") {
    const started = Date.now();
    try {
      const resp = await this.client.transcription.preRecorded(
        { buffer, mimetype: mime },
        { punctuate: true, language: "en-IN" },
      );
      const text = resp?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      const ms = Date.now() - started;
      this.logger.log(`STT complete (${ms}ms): ${text.slice(0, 120)}`);
      return { text, sttMs: ms };
    } catch (err) {
      this.logger.error("STT failed", err instanceof Error ? err.stack : String(err));
      return { text: "", sttMs: Date.now() - started };
    }
  }
}

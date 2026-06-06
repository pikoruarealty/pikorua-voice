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
  async transcribeBuffer(buffer: Buffer, mime = "audio/wav", language = "en-IN") {
    const started = Date.now();
    try {
      const resp = await this.client.transcription.preRecorded(
        { buffer, mimetype: mime },
        { punctuate: true, language },
      );
      const text = resp?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      const ms = Date.now() - started;
      this.logger.log(`STT complete (${ms}ms lang=${language}): ${text.slice(0, 120)}`);
      return { text, sttMs: ms };
    } catch (err) {
      this.logger.error("STT failed", err instanceof Error ? err.stack : String(err));
      return { text: "", sttMs: Date.now() - started };
    }
  }

  // Low-latency approximation for live calls: transcribes an initial small
  // slice of the audio buffer and returns that transcript quickly while
  // starting a background full transcription. This is an approximation that
  // avoids a full realtime websocket implementation but gives faster first
  // words for interactive voice flows.
  async transcribeLowLatency(buffer: Buffer, mime = "audio/wav", chunkMs = 300, language = "en-IN") {
    const started = Date.now();

    try {
      // Approximate bytes for chunkMs at 16kHz, 16-bit mono
      const sampleRate = 16000;
      const bytesPerSample = 2; // 16-bit
      const approxBytes = Math.max(1024, Math.floor((sampleRate * bytesPerSample * chunkMs) / 1000));
      const firstSlice = buffer.slice(0, approxBytes);

      // Quick partial transcription (awaited)
      const partial = await this.transcribeBuffer(firstSlice, mime, language);

      // Fire-and-forget full transcription to warm caches / logs
      this.transcribeBuffer(buffer, mime, language)
        .then((full) => this.logger.log(`Background full STT completed (${full.sttMs}ms)`))
        .catch((err) => this.logger.warn("Background full STT failed", err instanceof Error ? err.stack : String(err)));

      return { text: partial.text, sttMs: Date.now() - started };
    } catch (err) {
      this.logger.error("Low-latency STT failed", err instanceof Error ? err.stack : String(err));
      return { text: "", sttMs: Date.now() - started };
    }
  }
}

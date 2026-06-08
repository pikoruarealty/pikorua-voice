import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Deepgram } from "@deepgram/sdk";

@Injectable()
export class DeepgramService {
  private readonly logger = new Logger("DeepgramService");
  private readonly client: any | null;

  constructor(private readonly config: ConfigService) {
    const key = String(this.config.get("DEEPGRAM_API_KEY") ?? "");
    this.client = key ? new Deepgram(key) : null;
    if (!this.client) {
      this.logger.warn("DEEPGRAM_API_KEY not set; STT is disabled until configured");
    }
  }

  // Transcribe a pre-recorded audio buffer (low-latency variant). Returns
  // { text, latencyMs }
  async transcribeBuffer(buffer: Buffer, mime = "audio/wav", language = "en-IN") {
    const started = Date.now();
    if (!this.client) {
      throw new ServiceUnavailableException("Deepgram API key is not configured");
    }
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
      throw new ServiceUnavailableException("Deepgram transcription failed");
    }
  }

  // Low-latency approximation for live calls: transcribes an initial small
  // slice of the audio buffer and returns that transcript quickly while
  // starting a background full transcription. This is an approximation that
  // avoids a full realtime websocket implementation but gives faster first
  // words for interactive voice flows.
  async transcribeLowLatency(
    buffer: Buffer,
    mime = "audio/wav",
    chunkMs = 300,
    language = "en-IN",
  ) {
    const started = Date.now();

    if (!this.client) {
      throw new ServiceUnavailableException("Deepgram API key is not configured");
    }

    try {
      // Probe a few small windows. If the smallest slice is empty, move up to
      // slightly larger windows before falling back to the caller's size.
      const sampleRate = 16000;
      const bytesPerSample = 2; // 16-bit
      const windows = Array.from(
        new Set([180, Math.max(220, Math.floor(chunkMs * 0.75)), chunkMs]),
      );

      let partial = { text: "", sttMs: 0 };
      for (const windowMs of windows) {
        const approxBytes = Math.max(
          1024,
          Math.floor((sampleRate * bytesPerSample * windowMs) / 1000),
        );
        const slice = buffer.slice(0, approxBytes);
        partial = await this.transcribeBuffer(slice, mime, language);
        if (partial.text.trim()) {
          break;
        }
      }

      // Fire-and-forget full transcription to warm caches / logs
      this.transcribeBuffer(buffer, mime, language)
        .then((full) => this.logger.log(`Background full STT completed (${full.sttMs}ms)`))
        .catch((err) =>
          this.logger.warn(
            "Background full STT failed",
            err instanceof Error ? err.stack : String(err),
          ),
        );

      return { text: partial.text, sttMs: Date.now() - started };
    } catch (err) {
      this.logger.error("Low-latency STT failed", err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException("Deepgram low-latency transcription failed");
    }
  }
}

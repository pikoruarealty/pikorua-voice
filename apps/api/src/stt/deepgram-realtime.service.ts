import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import WebSocket, { RawData } from "ws";

@Injectable()
export class DeepgramRealtimeService {
  private readonly logger = new Logger("DeepgramRealtimeService");

  constructor(private readonly config: ConfigService) {}

  // Transcribes a buffer by opening a Deepgram realtime websocket, sending
  // audio in chunks, and waiting for a final transcript message or timeout.
  async transcribeRealtime(
    buffer: Buffer,
    sampleRate = 16000,
    timeoutMs = 5000,
    language = "en-IN",
  ) {
    const started = Date.now();
    const apiKey = String(this.config.get("DEEPGRAM_API_KEY") ?? "");
    if (!apiKey) {
      this.logger.warn("DEEPGRAM_API_KEY not set for realtime STT");
      throw new ServiceUnavailableException("Deepgram API key is not configured");
    }

    const url = `wss://api.deepgram.com/v1/realtime?encoding=linear16&sample_rate=${sampleRate}&channels=1&language=${encodeURIComponent(language)}`;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${apiKey}`,
      },
    });

    let resolved = false;
    let finalText = "";

    return await new Promise<{ text: string; sttMs: number }>((resolve, reject) => {
      const finish = (text: string) => {
        resolved = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        resolve({ text, sttMs: Date.now() - started });
      };

      const fail = (message: string) => {
        resolved = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        reject(new ServiceUnavailableException(message));
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          this.logger.warn("Realtime STT timeout");
          if (finalText.trim()) {
            finish(finalText);
          } else {
            fail("Realtime STT timed out without transcript");
          }
        }
      }, timeoutMs + 2000);

      ws.on("open", () => {
        // Optionally send a start message
        try {
          ws.send(
            JSON.stringify({
              type: "Start",
              encoding: "linear16",
              sample_rate: sampleRate,
              channels: 1,
            }),
          );
        } catch (e) {}

        // Send audio in small chunks
        const chunkSize = 3200; // ~100ms at 16kHz 16-bit mono
        for (let i = 0; i < buffer.length; i += chunkSize) {
          const slice = buffer.slice(i, i + chunkSize);
          try {
            ws.send(slice);
          } catch (err) {}
        }

        // Ask Deepgram to finalize
        try {
          ws.send(JSON.stringify({ type: "Stop" }));
        } catch (e) {}
      });

      ws.on("message", (data: RawData) => {
        try {
          const text = data.toString();
          const parsed = JSON.parse(text);
          // Deepgram realtime emits messages with type 'transcript' and
          // structure: { transcript: { channel: { alternatives: [...] } } }
          if (parsed?.type === "transcript") {
            const alt = parsed?.channel?.alternatives?.[0];
            if (alt) {
              finalText = alt?.transcript ?? finalText;
              if (alt?.is_final || parsed?.is_final) {
                if (!resolved && finalText.trim()) {
                  finish(finalText);
                }
              }
            }
          }
        } catch (err) {
          // Non-json messages ignored
        }
      });

      ws.on("error", (err: Error) => {
        this.logger.warn(
          "Realtime STT socket error",
          err instanceof Error ? err.stack : String(err),
        );
        if (!resolved) {
          if (finalText.trim()) {
            finish(finalText);
          } else {
            fail("Realtime STT socket error");
          }
        }
      });

      ws.on("close", () => {
        if (!resolved) {
          if (finalText.trim()) {
            finish(finalText);
          } else {
            fail("Realtime STT closed without transcript");
          }
        }
      });
    });
  }
}

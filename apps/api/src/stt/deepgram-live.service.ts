import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import WebSocket, { RawData } from "ws";

export type LiveSessionCallbacks = {
  // Interim (non-final) transcript — fires while the caller is mid-sentence.
  onPartial: (text: string) => void;
  // A finished utterance, as decided by Deepgram's own endpointing.
  onUtterance: (text: string) => void;
  onError: (message: string) => void;
};

export type LiveSession = {
  sendAudio: (chunk: Buffer) => void;
  close: () => void;
};

// Persistent Deepgram Live (streaming) STT with server-side endpointing.
// Utterance boundaries come from Deepgram's VAD (speech_final / UtteranceEnd
// events), which is far more reliable than client-side RMS silence thresholds:
// it distinguishes thinking pauses from finished sentences acoustically.
@Injectable()
export class DeepgramLiveService {
  private readonly logger = new Logger("DeepgramLiveService");

  constructor(private readonly config: ConfigService) {}

  private dgLanguage(locale: string): string {
    const lang = locale.toLowerCase();
    if (lang.startsWith("hi")) return "hi";
    if (lang.startsWith("gu")) return "gu";
    if (lang.startsWith("ta")) return "ta";
    if (lang.startsWith("te")) return "te";
    if (lang.startsWith("mr")) return "mr";
    return locale;
  }

  openSession(locale: string, sampleRate: number, callbacks: LiveSessionCallbacks): LiveSession {
    const apiKey = String(this.config.get("DEEPGRAM_API_KEY") ?? "");
    if (!apiKey) {
      throw new ServiceUnavailableException("Deepgram API key is not configured");
    }

    const params = new URLSearchParams({
      model: "nova-2",
      language: this.dgLanguage(locale),
      encoding: "linear16",
      sample_rate: String(sampleRate),
      channels: "1",
      punctuate: "true",
      smart_format: "true",
      interim_results: "true",
      // endpointing: ms of silence after speech before is_final fires
      endpointing: "300",
      // utterance_end_ms: hard utterance boundary — generous so thinking
      // pauses don't cut the caller off
      utterance_end_ms: "1400",
      vad_events: "true",
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    let open = false;
    let closed = false;
    const pendingChunks: Buffer[] = [];
    // is_final transcript segments accumulated since the last utterance boundary
    let finalSegments: string[] = [];

    const flushUtterance = () => {
      const utterance = finalSegments.join(" ").replace(/\s+/g, " ").trim();
      finalSegments = [];
      if (utterance) callbacks.onUtterance(utterance);
    };

    // Deepgram closes idle sockets after ~10s — keep alive while the caller listens
    const keepAlive = setInterval(() => {
      if (open && !closed) {
        try {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        } catch {}
      }
    }, 6000);

    ws.on("open", () => {
      open = true;
      for (const chunk of pendingChunks) {
        try {
          ws.send(chunk);
        } catch {}
      }
      pendingChunks.length = 0;
      this.logger.log(`Deepgram live session open (lang=${this.dgLanguage(locale)})`);
    });

    ws.on("message", (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "Results") {
          const alt = msg.channel?.alternatives?.[0];
          const transcript = String(alt?.transcript ?? "").trim();
          if (msg.is_final) {
            if (transcript) finalSegments.push(transcript);
            // speech_final: Deepgram's endpointing says the speaker finished
            if (msg.speech_final) flushUtterance();
          } else if (transcript) {
            callbacks.onPartial(transcript);
          }
        } else if (msg.type === "UtteranceEnd") {
          // Fires after utterance_end_ms of silence — covers segments where
          // speech_final never arrived (e.g. trailing background noise).
          flushUtterance();
        }
      } catch {
        // ignore non-JSON frames
      }
    });

    ws.on("error", (err: Error) => {
      this.logger.warn(`Deepgram live socket error: ${err.message}`);
      if (!closed) callbacks.onError("Speech recognition connection failed");
    });

    ws.on("close", () => {
      clearInterval(keepAlive);
      // Deliver whatever was pending so the last words aren't lost
      if (!closed) flushUtterance();
      closed = true;
    });

    return {
      sendAudio: (chunk: Buffer) => {
        if (closed) return;
        if (open) {
          try {
            ws.send(chunk);
          } catch {}
        } else {
          pendingChunks.push(chunk);
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        try {
          ws.send(JSON.stringify({ type: "CloseStream" }));
        } catch {}
        try {
          ws.close();
        } catch {}
      },
    };
  }
}

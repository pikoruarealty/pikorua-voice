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

export type LiveSessionOptions = {
  // "linear16" (default, 16 kHz PCM) or "mulaw" (8 kHz telephony streams).
  encoding?: "linear16" | "mulaw";
};

export type LiveSession = {
  sendAudio: (chunk: Buffer) => void;
  clearBuffer: () => void;
  // Dynamically tighten/loosen the VAD silence window (ms). Use ~400 after the
  // caller speaks a short ack ("haan", "ok", "yes") to avoid wasting ~1s of
  // dead air; restore to 1400 for full utterances.
  setEndpointing: (utteranceEndMs: number) => void;
  close: () => void;
};

// Reconnect policy: one socket error must not leave the session deaf for the
// rest of the call. Audio is buffered (bounded) while the socket re-opens.
const MAX_RECONNECTS = 3;
const RECONNECT_BACKOFF_MS = [300, 600, 1200];
const MAX_BUFFERED_CHUNKS = 200; // ~20s of 100ms frames — drop oldest beyond this

// Short ack words that don't need the full 1400ms silence window.
// After one of these fires as a complete utterance, tighten to 400ms so the
// caller isn't forced to wait an extra second before the bot responds.
const SHORT_ACK_PATTERN = /^(haan|ha|han|okay|ok|yes|no|nahi|nai|sure|bilkul|theek|thik|hmm|ji|hm|yep|nope|right|got it|go on|accha|acha)[\s.,!?।]*$/i;
const SHORT_ACK_ENDPOINTING_MS = 400;
const DEFAULT_ENDPOINTING_MS = 1400;

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

  openSession(
    locale: string,
    sampleRate: number,
    callbacks: LiveSessionCallbacks,
    opts: LiveSessionOptions = {},
  ): LiveSession {
    const apiKey = String(this.config.get("DEEPGRAM_API_KEY") ?? "");
    if (!apiKey) {
      throw new ServiceUnavailableException("Deepgram API key is not configured");
    }

    const params = new URLSearchParams({
      model: "nova-2",
      language: this.dgLanguage(locale),
      encoding: opts.encoding ?? "linear16",
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
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    let ws: WebSocket | null = null;
    let open = false;
    let closedByUser = false;
    let reconnects = 0;
    const pendingChunks: Buffer[] = [];
    // is_final transcript segments accumulated since the last utterance boundary
    let finalSegments: string[] = [];
    let currentEndpointingMs = DEFAULT_ENDPOINTING_MS;

    const sendEndpointing = (ms: number) => {
      if (!open || !ws) return;
      try {
        // Only update utterance_end_ms (the hard utterance boundary). The
        // endpointing=300 from the URL is the fine-grained VAD sensitivity and
        // should stay fixed — coupling both to the same value drifts endpointing
        // to 1400 permanently after the first short-ack restore cycle.
        ws.send(JSON.stringify({ type: "Configure", processors: { utterance_end_ms: ms } }));
      } catch {}
    };

    // noiseFilter: only suppress single unrecognized words from VAD/UtteranceEnd
    // events (likely background noise). Do NOT filter on socket-close paths where
    // the caller's final word must always be delivered.
    const flushUtterance = (noiseFilter = false) => {
      const utterance = finalSegments.join(" ").replace(/\s+/g, " ").trim();
      finalSegments = [];
      if (!utterance) return;
      const isShortAck = SHORT_ACK_PATTERN.test(utterance);
      // Drop single-word noise transcriptions only when called from VAD paths.
      if (noiseFilter && utterance.split(/\s+/).length === 1 && !isShortAck) return;
      const targetMs = isShortAck ? SHORT_ACK_ENDPOINTING_MS : DEFAULT_ENDPOINTING_MS;
      if (targetMs !== currentEndpointingMs) {
        currentEndpointingMs = targetMs;
        sendEndpointing(targetMs);
      }
      callbacks.onUtterance(utterance);
    };

    // Deepgram closes idle sockets after ~10s — keep alive while the caller listens
    const keepAlive = setInterval(() => {
      if (open && !closedByUser && ws) {
        try {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        } catch {}
      }
    }, 6000);

    const connect = () => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Token ${apiKey}` },
      });
      ws = socket;
      open = false;

      socket.on("open", () => {
        if (closedByUser) {
          try {
            socket.close();
          } catch {}
          return;
        }
        open = true;
        reconnects = 0;
        for (const chunk of pendingChunks) {
          try {
            socket.send(chunk);
          } catch {}
        }
        pendingChunks.length = 0;
        this.logger.log(
          `Deepgram live session open (lang=${this.dgLanguage(locale)} enc=${opts.encoding ?? "linear16"})`,
        );
      });

      socket.on("message", (data: RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "Results") {
            const alt = msg.channel?.alternatives?.[0];
            const transcript = String(alt?.transcript ?? "").trim();
            if (msg.is_final) {
              if (transcript) finalSegments.push(transcript);
              // speech_final: Deepgram's endpointing says the speaker finished
              if (msg.speech_final) flushUtterance(true);
            } else if (transcript) {
              callbacks.onPartial(transcript);
            }
          } else if (msg.type === "UtteranceEnd") {
            // Fires after utterance_end_ms of silence — most likely source of
            // noise transcriptions; apply the single-word filter here.
            flushUtterance(true);
          }
        } catch {
          // ignore non-JSON frames
        }
      });

      socket.on("error", (err: Error) => {
        this.logger.warn(`Deepgram live socket error: ${err.message}`);
        // close handler decides whether to reconnect or surface the error
      });

      socket.on("close", (code: number, reason: Buffer) => {
        open = false;
        if (ws !== socket) return; // superseded by a newer socket
        if (closedByUser) {
          clearInterval(keepAlive);
          flushUtterance();
          return;
        }
        const detail = `code=${code}${reason.length ? ` reason="${reason.toString("utf8").slice(0, 80)}"` : ""}`;
        // Unexpected close mid-call: reconnect with backoff so the session
        // doesn't go deaf. Audio keeps buffering into pendingChunks meanwhile.
        if (reconnects < MAX_RECONNECTS) {
          const delay = RECONNECT_BACKOFF_MS[Math.min(reconnects, RECONNECT_BACKOFF_MS.length - 1)];
          reconnects += 1;
          this.logger.warn(
            `Deepgram live socket closed (${detail}) — reconnecting (${reconnects}/${MAX_RECONNECTS}) in ${delay}ms`,
          );
          setTimeout(() => {
            if (!closedByUser) connect();
          }, delay);
          return;
        }
        clearInterval(keepAlive);
        this.logger.error(
          `Deepgram live session failed permanently (${detail}) after ${MAX_RECONNECTS} reconnect(s)`,
        );
        // Deliver whatever was pending so the last words aren't lost
        flushUtterance();
        callbacks.onError("Speech recognition connection failed");
      });
    };

    connect();

    return {
      sendAudio: (chunk: Buffer) => {
        if (closedByUser) return;
        if (open && ws) {
          try {
            ws.send(chunk);
          } catch {}
        } else {
          pendingChunks.push(chunk);
          if (pendingChunks.length > MAX_BUFFERED_CHUNKS) pendingChunks.shift();
        }
      },
      clearBuffer: () => {
        finalSegments = [];
      },
      setEndpointing: (ms: number) => {
        if (ms === currentEndpointingMs) return;
        currentEndpointingMs = ms;
        sendEndpointing(ms);
      },
      close: () => {
        if (closedByUser) return;
        closedByUser = true;
        clearInterval(keepAlive);
        try {
          ws?.send(JSON.stringify({ type: "CloseStream" }));
        } catch {}
        try {
          ws?.close();
        } catch {}
      },
    };
  }
}

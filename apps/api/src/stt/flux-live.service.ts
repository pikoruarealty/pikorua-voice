import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import WebSocket, { RawData } from "ws";
import type {
  LiveSession,
  LiveSessionCallbacks,
  LiveSessionOptions,
} from "./deepgram-live.service";
import { PROPER_NOUN_KEYTERMS } from "./keyterms";
import { baseLang } from "./stt-routing";

// Deepgram Flux — conversational STT with BUILT-IN turn detection, purpose-built
// for voice agents. Unlike Nova-3 (which needs client-side VAD/endpointing tuning
// — utterance_end_ms, short-ack windows, fragment-hold), Flux decides turn
// boundaries acoustically and emits discrete turn events, saving ~200–600ms of
// agent response latency. It exposes the SAME LiveSession interface as
// DeepgramLiveService so the gateways are provider-agnostic.
//
// Protocol differences from Nova-3 (`/v1/listen`):
//   • Endpoint is `/v2/listen` (v1 rejects Flux).
//   • Model is flux-general-en / flux-general-multi (not nova-3 + language).
//   • Server messages are typed: { type: "TurnInfo", event, transcript, ... }.
//     event ∈ StartOfTurn | Update | EagerEndOfTurn | TurnResumed | EndOfTurn.
//   • EagerEndOfTurn/TurnResumed only fire when eager_eot_threshold is set; we do
//     NOT set it (no speculative-turn plumbing in the runtime), so turn semantics
//     stay simple: Update = interim (barge-in), EndOfTurn = finished utterance.
const FLUX_URL = "wss://api.deepgram.com/v2/listen";
const MAX_RECONNECTS = 3;
const RECONNECT_BACKOFF_MS = [300, 600, 1200];
const MAX_BUFFERED_CHUNKS = 200; // ~20s of 100ms frames — drop oldest beyond this

// EndOfTurn confidence (0.5–0.9, default 0.7). 0.7 balances false turn-ends
// (cutting a caller off mid-thought) against latency. eot_timeout_ms is the hard
// silence fallback that forces a turn end regardless of confidence.
const EOT_THRESHOLD = "0.7";
const EOT_TIMEOUT_MS = "5000";

@Injectable()
export class FluxLiveService {
  private readonly logger = new Logger("FluxLiveService");

  constructor(private readonly config: ConfigService) {}

  // English → the leaner English-only model; everything else Flux-eligible
  // (Hindi today) → the multilingual model with a language hint, so Hinglish
  // code-switching is transcribed in one stream.
  private fluxModel(locale: string): { model: string; languageHint?: string } {
    const base = baseLang(locale);
    if (base === "en") return { model: "flux-general-en" };
    return { model: "flux-general-multi", languageHint: base };
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

    const { model, languageHint } = this.fluxModel(locale);
    const params = new URLSearchParams({
      model,
      encoding: opts.encoding ?? "linear16",
      sample_rate: String(sampleRate),
      eot_threshold: EOT_THRESHOLD,
      eot_timeout_ms: EOT_TIMEOUT_MS,
    });
    if (languageHint) params.set("language_hint", languageHint);
    // Keyterm biasing is supported on the multilingual Flux model; same shared
    // proper-noun list as Nova-3 so recognition of local area/project names stays
    // consistent across providers.
    if (model === "flux-general-multi") {
      for (const term of PROPER_NOUN_KEYTERMS) params.append("keyterm", term);
    }
    const url = `${FLUX_URL}?${params.toString()}`;

    let ws: WebSocket | null = null;
    let open = false;
    let closedByUser = false;
    let reconnects = 0;
    const pendingChunks: Buffer[] = [];

    // Deepgram closes idle sockets after ~10s. Exotel streams continuous audio so
    // the socket normally isn't idle, but a brief gap in inbound media (network
    // hiccup, upstream pause) could trip that timeout — keep it alive defensively,
    // matching DeepgramLiveService.
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
        this.logger.log(`Flux live session open (model=${model}${languageHint ? ` hint=${languageHint}` : ""})`);
      });

      socket.on("message", (data: RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type !== "TurnInfo") return; // Connected / other control frames
          const transcript = String(msg.transcript ?? "").trim();
          switch (msg.event) {
            case "StartOfTurn":
              // VAD-equivalent: caller started speaking. Fastest barge-in signal.
              callbacks.onSpeechStart?.();
              break;
            case "Update":
              // Interim transcript — drives transcript-based barge-in downstream.
              if (transcript) callbacks.onPartial(transcript);
              break;
            case "EndOfTurn":
              // Flux decided the caller finished — the finished utterance.
              if (transcript) callbacks.onUtterance(transcript);
              break;
            // EagerEndOfTurn / TurnResumed: not configured (no eager_eot_threshold).
            default:
              break;
          }
        } catch {
          // ignore non-JSON frames
        }
      });

      socket.on("error", (err: Error) => {
        this.logger.warn(`Flux live socket error: ${err.message}`);
        // close handler decides whether to reconnect or surface the error
      });

      socket.on("close", (code: number, reason: Buffer) => {
        open = false;
        if (ws !== socket) return; // superseded by a newer socket
        if (closedByUser) {
          clearInterval(keepAlive);
          return;
        }
        const detail = `code=${code}${reason.length ? ` reason="${reason.toString("utf8").slice(0, 80)}"` : ""}`;
        // Unexpected close mid-call: reconnect with backoff so the session doesn't
        // go deaf. Audio keeps buffering into pendingChunks meanwhile.
        if (reconnects < MAX_RECONNECTS) {
          const delay = RECONNECT_BACKOFF_MS[Math.min(reconnects, RECONNECT_BACKOFF_MS.length - 1)];
          reconnects += 1;
          this.logger.warn(
            `Flux live socket closed (${detail}) — reconnecting (${reconnects}/${MAX_RECONNECTS}) in ${delay}ms`,
          );
          setTimeout(() => {
            if (!closedByUser) connect();
          }, delay);
          return;
        }
        clearInterval(keepAlive);
        this.logger.error(
          `Flux live session failed permanently (${detail}) after ${MAX_RECONNECTS} reconnect(s)`,
        );
        // Surface the failure so the router can fail over to Nova-3.
        callbacks.onError("Flux speech recognition connection failed");
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
      // Flux delivers the full transcript on EndOfTurn (no client-side segment
      // accumulation to reset), so there is nothing to clear here.
      clearBuffer: () => {},
      // No-op: Flux does its own model-driven turn detection, so the runtime's
      // short-ack endpointing hint doesn't apply. (Kept to satisfy LiveSession.)
      setEndpointing: () => {},
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

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

// Flux's idle-close is far more aggressive than Nova-3's (~10s): in production the
// socket dropped ~5.4s after each open whenever the line was quiet, so the old 6s
// JSON KeepAlive never fired in time. Flux's /v2 protocol also does not reliably
// honor the {type:"KeepAlive"} control frame. So we keep the line warm the way
// Deepgram ALWAYS respects — a short frame of PCM silence on an idle interval.
// 3s beats the observed ~5.4s close with margin.
const KEEPALIVE_INTERVAL_MS = 3000;
const KEEPALIVE_IDLE_AFTER_MS = 2500; // only inject silence when no real audio recently
// A socket that survives this long is treated as healthy and resets the reconnect
// budget. Sockets that keep dying faster than this are treated as flapping and,
// after MAX_RECONNECTS of it, escalate to the Nova-3 failover instead of looping
// forever deaf (the old code reset the budget on every open, so it never did).
const MIN_HEALTHY_UPTIME_MS = 8000;

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
    let reconnectAttempt = 0;
    let lastAudioSentAt = Date.now();
    let healthyTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingChunks: Buffer[] = [];
    // 20 ms of PCM silence (sampleRate × 2 bytes/sample × 0.02 s), used as an
    // audio-domain keepalive — see KEEPALIVE_INTERVAL_MS.
    const silenceFrame = Buffer.alloc(Math.floor(sampleRate * 2 * 0.02));

    const sendKeepAlive = () => {
      if (!open || closedByUser || !ws) return;
      // Only fill the line when it is actually idle; real caller audio already
      // resets Deepgram's timer and we don't want to interleave silence into
      // live speech.
      if (Date.now() - lastAudioSentAt < KEEPALIVE_IDLE_AFTER_MS) return;
      try {
        ws.send(silenceFrame);
        lastAudioSentAt = Date.now();
      } catch {}
    };
    const keepAlive = setInterval(sendKeepAlive, KEEPALIVE_INTERVAL_MS);

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
        // Do NOT reset the reconnect budget here — a socket that opens then dies
        // seconds later (the flap we're guarding against) must still count against
        // it. Reset only once the socket proves healthy by surviving
        // MIN_HEALTHY_UPTIME_MS.
        if (healthyTimer) clearTimeout(healthyTimer);
        healthyTimer = setTimeout(() => {
          reconnectAttempt = 0;
        }, MIN_HEALTHY_UPTIME_MS);
        lastAudioSentAt = Date.now();
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
        if (healthyTimer) {
          clearTimeout(healthyTimer);
          healthyTimer = null;
        }
        if (closedByUser) {
          clearInterval(keepAlive);
          return;
        }
        const detail = `code=${code}${reason.length ? ` reason="${reason.toString("utf8").slice(0, 80)}"` : ""}`;
        // Unexpected close mid-call: reconnect with backoff so the session doesn't
        // go deaf. Audio keeps buffering into pendingChunks meanwhile. The budget is
        // NOT reset on a successful-but-short-lived open (see the open handler), so a
        // socket that keeps flapping every few seconds escalates here rather than
        // looping forever — the router then fails over to Nova-3.
        if (reconnectAttempt < MAX_RECONNECTS) {
          const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
          reconnectAttempt += 1;
          this.logger.warn(
            `Flux live socket closed (${detail}) — reconnecting (${reconnectAttempt}/${MAX_RECONNECTS}) in ${delay}ms`,
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
            lastAudioSentAt = Date.now();
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
        if (healthyTimer) {
          clearTimeout(healthyTimer);
          healthyTimer = null;
        }
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

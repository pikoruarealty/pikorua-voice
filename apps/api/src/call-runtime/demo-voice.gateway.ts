import { WebSocketGateway, OnGatewayConnection, OnGatewayDisconnect } from "@nestjs/websockets";
import { WebSocket, RawData } from "ws";
import { Injectable, Logger } from "@nestjs/common";
import type { IncomingMessage } from "http";
import { ConfigService } from "@nestjs/config";
import { DeepgramLiveService, type LiveSession } from "../stt/deepgram-live.service";
import { ElevenlabsService } from "../tts/elevenlabs.service";
import { CallRuntimeService, type PreStreamedData } from "./call-runtime.service";
import { closeUnauthorized, isWebSocketAuthorized } from "../auth/ws-auth";

type ActiveTurn = {
  controller: AbortController;
  audioSent: boolean;
};

// Speculative generation handle: LLM kicked off on a confident partial before
// VAD fires. Cancelled immediately if the final transcript differs.
type SpeculativeHandle = {
  text: string;
  cancel: () => void;
  getPreStreamed: () => Promise<PreStreamedData | null>;
};

// Minimum partial length and confidence threshold for speculative generation.
// Short acks ("ok", "haan") are handled by adaptive endpointing; speculation
// fires for longer intermediates where we're confident enough to pre-warm.
const SPECULATIVE_MIN_WORDS = 4;

type ClientState = {
  callId: string | null;
  locale: string;
  turnIndex: number;
  stt: LiveSession | null;
  // Serializes turn processing so overlapping utterances stay in order
  queue: Promise<void>;
  // Streaming protocol (audio-chunk/cancel frames) — opted into via the start
  // message so legacy buffered-reply clients keep working.
  streaming: boolean;
  // Turn currently generating; aborted server-side on barge-in.
  active: ActiveTurn | null;
  // True while the client is (probably) playing assistant audio.
  speaking: boolean;
  // In-flight speculative LLM started on a confident partial transcript.
  speculative: SpeculativeHandle | null;
  // True while a speculateTurn() promise is still resolving. Prevents multiple
  // concurrent speculative LLM calls from consecutive Deepgram partial events,
  // which would race on OpenRouter and inflate turn latency.
  speculativePending: boolean;
};

// Streaming voice channel: the browser sends 16 kHz PCM16 audio continuously;
// Deepgram Live decides utterance boundaries; each finished utterance runs
// through the streaming turn pipeline and reply audio is pushed back in chunks
// as TTS produces them. Barge-in is server-authoritative: a meaningful partial
// while the assistant is generating/speaking aborts LLM+TTS and tells the
// client to drop queued audio.
@Injectable()
@WebSocketGateway({ path: "/demo-voice" })
export class DemoVoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger("DemoVoiceGateway");

  private readonly clients = new Map<WebSocket, ClientState>();

  constructor(
    private readonly deepgramLive: DeepgramLiveService,
    private readonly tts: ElevenlabsService,
    private readonly runtime: CallRuntimeService,
    private readonly config: ConfigService,
  ) {}

  handleConnection(client: WebSocket, request?: IncomingMessage) {
    if (!isWebSocketAuthorized(this.config, request)) {
      closeUnauthorized(client);
      return;
    }

    const state: ClientState = {
      callId: null,
      locale: "hi-IN",
      turnIndex: 0,
      stt: null,
      queue: Promise.resolve(),
      streaming: false,
      active: null,
      speaking: false,
      speculative: null,
      speculativePending: false,
    };
    this.clients.set(client, state);
    this.logger.log("Demo voice client connected");

    client.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        state.stt?.sendAudio(this.normalizeChunk(data));
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.type === "start") {
          state.callId = String(msg.callId ?? "");
          state.locale = String(msg.language ?? "hi-IN");
          state.streaming = msg.streaming === true;
          const sampleRate = Number(msg.sampleRate ?? 16000);
          if (state.callId) void this.runtime.warmCall(state.callId, state.locale);
          state.stt = this.openSttSession(client, state, sampleRate, false);
          // Play Maya's opening greeting immediately — she speaks first.
          state.queue = state.queue.then(() => this.sendGreeting(client, state));
        } else if (msg?.type === "playback-done") {
          state.speaking = false;
        } else if (msg?.type === "stop") {
          state.active?.controller.abort();
          state.stt?.close();
          state.stt = null;
        }
      } catch (err) {
        this.logger.warn("Bad control message", err instanceof Error ? err.message : String(err));
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    const state = this.clients.get(client);
    state?.active?.controller.abort();
    state?.speculative?.cancel();
    if (state) state.speculativePending = false;
    state?.stt?.close();
    this.clients.delete(client);
    this.logger.log("Demo voice client disconnected");
  }

  // Opens a Deepgram Live session. On permanent failure, schedules one
  // gateway-level recovery attempt (5 s delay, isRecovery=true) so a transient
  // Deepgram outage doesn't kill the call. The recovery attempt does NOT recurse.
  private openSttSession(
    client: WebSocket,
    state: ClientState,
    sampleRate: number,
    isRecovery: boolean,
  ) {
    return this.deepgramLive.openSession(state.locale, sampleRate, {
      onPartial: (text) => this.handlePartial(client, state, text),
      onUtterance: (text) => this.enqueueTurn(client, state, text),
      onError: (message) => {
        this.send(client, { type: "error", message });
        if (!isRecovery && client.readyState === WebSocket.OPEN && state.callId) {
          this.logger.warn(`STT session failed call=${state.callId} — recovering in 5 s`);
          setTimeout(() => {
            if (client.readyState !== WebSocket.OPEN || !state.callId) return;
            try {
              state.stt?.close();
            } catch {}
            this.logger.log(`Re-opening STT session call=${state.callId}`);
            state.stt = this.openSttSession(client, state, sampleRate, true);
          }, 5000);
        }
      },
    });
  }

  private handlePartial(client: WebSocket, state: ClientState, text: string) {
    // Server-side barge-in: the caller is talking over the assistant. Abort
    // generation/synthesis and tell the client to drop queued audio. A short
    // length guard filters echo blips that survive the browser's AEC.
    if (state.streaming && (state.active || state.speaking) && text.trim().length >= 4) {
      if (state.active) {
        this.logger.log("Barge-in — aborting active turn");
        state.active.controller.abort();
      }
      if (state.speaking || state.active) {
        this.send(client, { type: "cancel" });
        state.speaking = false;
      }
    }

    // Speculative generation: when the caller is speaking (no active turn) and
    // the partial looks complete enough, start the LLM now so it's 200-400ms
    // ahead when VAD fires. Cancel any prior speculative that no longer matches.
    if (
      state.streaming &&
      state.callId &&
      !state.active &&
      !state.speaking &&
      text.trim().split(/\s+/).length >= SPECULATIVE_MIN_WORDS
    ) {
      const normalised = text.trim().toLowerCase();
      if (state.speculative && state.speculative.text.toLowerCase() !== normalised) {
        state.speculative.cancel();
        state.speculative = null;
        state.speculativePending = false;
      }
      // Only one speculative LLM call in flight at a time. Without this guard,
      // consecutive Deepgram partial events (arriving every ~300ms) would each
      // start a new OpenRouter stream before the previous resolves, racing on
      // API capacity and adding latency to every real turn that follows.
      if (!state.speculative && !state.speculativePending) {
        state.speculativePending = true;
        void this.runtime
          .speculateTurn(state.callId, text.trim(), state.locale)
          .then((handle) => {
            state.speculativePending = false;
            if (!state.active && !state.speaking) {
              state.speculative = handle;
            } else {
              handle.cancel();
            }
          })
          .catch(() => {
            state.speculativePending = false;
          });
      }
    }

    this.send(client, { type: "partial", transcript: text });
  }

  private enqueueTurn(client: WebSocket, state: ClientState, utterance: string) {
    // Capture and clear the speculative handle before queueing so it can't be
    // mutated by a concurrent partial that arrives while we're awaiting.
    const specHandle = state.speculative;
    state.speculative = null;

    state.queue = state.queue.then(async () => {
      if (!state.callId || client.readyState !== WebSocket.OPEN) {
        specHandle?.cancel();
        return;
      }
      if (state.streaming) {
        // If the final utterance matches the partial the LLM was pre-warming on,
        // collect the already-finished LLM result so processUtteranceStream can
        // skip the LLM call entirely.
        let preStreamed: PreStreamedData | undefined;
        if (specHandle) {
          const normalise = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
          if (normalise(utterance) === normalise(specHandle.text)) {
            preStreamed = (await specHandle.getPreStreamed()) ?? undefined;
          }
          if (!preStreamed) specHandle.cancel();
        }
        await this.runStreamingTurn(client, state, utterance, preStreamed);
        return;
      }
      try {
        const result = await this.runtime.processUtterance(
          state.callId,
          state.turnIndex,
          utterance,
          { locale: state.locale },
        );
        if (result.waitForMore) {
          this.send(client, { type: "holding", transcript: result.transcript });
          return;
        }
        // Clear any utterance fragments Deepgram buffered during the LLM+TTS
        // round-trip — prevents a stale UtteranceEnd from firing mid-playback.
        state.stt?.clearBuffer();
        state.turnIndex += 1;
        this.send(client, {
          type: "reply",
          transcript: result.transcript,
          reply: result.reply,
          audioBase64: result.audio.toString("base64"),
          endCall: result.endCall,
        });
      } catch (err) {
        this.send(client, {
          type: "error",
          message: err instanceof Error ? err.message : "Turn processing failed",
        });
      }
    });
  }

  private async runStreamingTurn(
    client: WebSocket,
    state: ClientState,
    utterance: string,
    preStreamed?: PreStreamedData,
  ) {
    const controller = new AbortController();
    const active: ActiveTurn = { controller, audioSent: false };
    state.active = active;
    this.send(client, { type: "turn-start", transcript: utterance });

    try {
      const result = await this.runtime.processUtteranceStream(
        state.callId as string,
        state.turnIndex,
        utterance,
        { locale: state.locale, preStreamed },
        {
          signal: controller.signal,
          onReplyDelta: (text) => this.send(client, { type: "reply-chunk", text }),
          onAudioChunk: (chunk, info) => {
            active.audioSent = true;
            state.speaking = true;
            this.send(client, {
              type: "audio-chunk",
              audioBase64: chunk.length > 0 ? chunk.toString("base64") : "",
              sentenceIndex: info.sentenceIndex,
              last: info.last,
            });
          },
          onCancel: () => {
            state.speaking = false;
            this.send(client, { type: "cancel" });
          },
        },
      );
      if (result.waitForMore) {
        this.send(client, { type: "holding", transcript: result.transcript });
        return;
      }
      if (!result.canceled) {
        // Drop stale STT fragments only on a clean turn — after a barge-in the
        // buffered segments ARE the caller's interruption and must survive.
        state.stt?.clearBuffer();
      }
      state.turnIndex += 1;
      this.send(client, {
        type: "reply-end",
        transcript: result.transcript,
        reply: result.reply,
        endCall: result.endCall,
        canceled: result.canceled,
      });
    } catch (err) {
      this.send(client, {
        type: "error",
        message: err instanceof Error ? err.message : "Turn processing failed",
      });
    } finally {
      if (state.active === active) state.active = null;
      // If TTS emitted audio before throwing, the client never receives
      // "playback-done" — reset speaking so barge-in detection doesn't
      // stay permanently armed for this session.
      if (active.audioSent) state.speaking = false;
    }
  }

  private async sendGreeting(client: WebSocket, state: ClientState): Promise<void> {
    if (!state.callId || client.readyState !== WebSocket.OPEN) return;

    const controller = new AbortController();
    const active: ActiveTurn = { controller, audioSent: false };
    state.active = active;

    // Signal to the UI that Maya is about to speak before the LLM responds.
    this.send(client, { type: "turn-start", transcript: "" });

    try {
      const result = await this.runtime.generateGreetingStream(state.callId, state.locale, {
        signal: controller.signal,
        onReplyDelta: (text) => this.send(client, { type: "reply-chunk", text }),
        onAudioChunk: (chunk, info) => {
          active.audioSent = true;
          state.speaking = true;
          this.send(client, {
            type: "audio-chunk",
            audioBase64: chunk.length > 0 ? chunk.toString("base64") : "",
            sentenceIndex: info.sentenceIndex,
            last: info.last,
          });
        },
        onCancel: () => {
          state.speaking = false;
          this.send(client, { type: "cancel" });
        },
      });

      if (!result.skipped) {
        this.send(client, {
          type: "greeting-end",
          reply: result.reply,
          canceled: result.canceled,
        });
      }
    } catch (err) {
      this.logger.warn("Greeting failed", err instanceof Error ? err.message : String(err));
    } finally {
      if (state.active === active) {
        state.active = null;
        state.speaking = false;
      }
    }
  }

  private send(client: WebSocket, payload: Record<string, unknown>) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(payload));
      } catch {}
    }
  }

  private normalizeChunk(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (Array.isArray(data)) return Buffer.concat(data.map((c) => Buffer.from(c)));
    return Buffer.from(data);
  }
}

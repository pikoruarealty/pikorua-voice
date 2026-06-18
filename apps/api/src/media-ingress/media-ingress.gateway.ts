import { Injectable, Logger } from "@nestjs/common";
import type { IncomingMessage } from "http";
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Server, WebSocket, RawData } from "ws";
import { ConfigService } from "@nestjs/config";
import { DeepgramRealtimeService } from "../stt/deepgram-realtime.service";
import { DeepgramLiveService, type LiveSession } from "../stt/deepgram-live.service";
import { CallRuntimeService } from "../call-runtime/call-runtime.service";
import { closeUnauthorized, isWebSocketAuthorized } from "../auth/ws-auth";

type MediaIngressState = {
  callId: string | null;
  language: string;
  turnIndex: number;
  chunks: Buffer[];
  // Streaming telephony mode: media frames feed Deepgram Live continuously and
  // reply audio is pushed back in chunks — no explicit stop-per-turn needed.
  streamMode: boolean;
  stt: LiveSession | null;
  queue: Promise<void>;
  active: AbortController | null;
  speaking: boolean;
  outputFormat?: string;
};

type MediaIngressStartMessage = {
  type?: "start";
  callId?: string;
  language?: string;
  turnIndex?: number;
  // "stream" enables continuous telephony mode (default: legacy buffered).
  mode?: string;
  // Telephony media streams are typically 8 kHz mulaw.
  encoding?: "mulaw" | "linear16";
  sampleRate?: number;
};

type MediaIngressMediaMessage = {
  type?: "media";
  payload?: string;
  media?: { payload?: string };
};

type MediaIngressStopMessage = {
  type?: "stop";
};

@Injectable()
@WebSocketGateway({ path: "/media-ingress" })
export class MediaIngressGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger("MediaIngressGateway");

  @WebSocketServer()
  server!: Server;

  private readonly clients = new Map<WebSocket, MediaIngressState>();

  constructor(
    private readonly realtime: DeepgramRealtimeService,
    private readonly deepgramLive: DeepgramLiveService,
    private readonly runtime: CallRuntimeService,
    private readonly config: ConfigService,
  ) {}

  private parseJson<T>(data: RawData, isBinary: boolean): T | null {
    if (isBinary) {
      return null;
    }

    let raw: string;
    if (typeof data === "string") {
      raw = data;
    } else if (Buffer.isBuffer(data)) {
      raw = data.toString("utf8");
    } else if (data instanceof ArrayBuffer) {
      raw = Buffer.from(data).toString("utf8");
    } else {
      raw = Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private parseBinary(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data);
    }

    if (Array.isArray(data)) {
      return Buffer.concat(data.map((chunk) => Buffer.from(chunk)));
    }

    return Buffer.from(data);
  }

  private send(client: WebSocket, payload: Record<string, unknown>) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(payload));
      } catch {}
    }
  }

  handleConnection(client: WebSocket, request?: IncomingMessage) {
    if (!isWebSocketAuthorized(this.config, request)) {
      closeUnauthorized(client);
      return;
    }

    const defaultLanguage = String(this.config.get("GEMINI_LANGUAGE_DEFAULT") ?? "hi-IN");
    this.clients.set(client, {
      callId: null,
      language: defaultLanguage,
      turnIndex: 0,
      chunks: [],
      streamMode: false,
      stt: null,
      queue: Promise.resolve(),
      active: null,
      speaking: false,
    });
    this.logger.log("Media ingress client connected");

    client.on("message", async (data: RawData, isBinary: boolean) => {
      const state = this.clients.get(client);
      if (!state) {
        return;
      }

      try {
        const message = this.parseJson<
          MediaIngressStartMessage | MediaIngressMediaMessage | MediaIngressStopMessage
        >(data, isBinary);
        if (message?.type === "start") {
          this.handleStart(client, state, message as MediaIngressStartMessage, defaultLanguage);
          return;
        }

        if (message?.type === "media") {
          const mediaMessage = message as MediaIngressMediaMessage;
          const payload = mediaMessage.payload ?? mediaMessage.media?.payload;
          if (payload) {
            const audio = Buffer.from(payload, "base64");
            if (state.streamMode) {
              state.stt?.sendAudio(audio);
            } else {
              state.chunks.push(audio);
            }
          }
          return;
        }

        if (message?.type === "stop") {
          if (state.streamMode) {
            state.active?.abort();
            state.stt?.close();
            state.stt = null;
            return;
          }
          await this.handleBufferedStop(client, state);
          return;
        }

        if (!isBinary && data) {
          state.chunks.push(this.parseBinary(data));
        }
      } catch (err) {
        this.logger.warn(
          "Failed to handle media ingress message",
          err instanceof Error ? err.stack : String(err),
        );
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    const state = this.clients.get(client);
    state?.active?.abort();
    state?.stt?.close();
    this.clients.delete(client);
    this.logger.log("Media ingress client disconnected");
  }

  private handleStart(
    client: WebSocket,
    state: MediaIngressState,
    message: MediaIngressStartMessage,
    defaultLanguage: string,
  ) {
    state.callId = String(message.callId ?? state.callId ?? "");
    state.language = String(message.language ?? state.language ?? defaultLanguage);
    state.turnIndex = Number(message.turnIndex ?? state.turnIndex ?? 0);
    state.streamMode = message.mode === "stream";

    if (state.streamMode && state.callId) {
      // Telephony media path: 8 kHz mulaw frames in (Exotel/Twilio voicebot
      // streams), continuous Deepgram Live STT, chunked TTS audio back out in
      // the SAME codec so no resampling is needed on either side.
      const encoding = message.encoding === "linear16" ? "linear16" : "mulaw";
      const sampleRate = Number(message.sampleRate ?? (encoding === "mulaw" ? 8000 : 16000));
      state.outputFormat = encoding === "mulaw" ? "ulaw_8000" : undefined;
      void this.runtime.warmCall(state.callId, state.language);
      state.stt = this.openSttSession(client, state, sampleRate, encoding, false);
    }

    this.send(client, {
      type: "ready",
      callId: state.callId,
      language: state.language,
      turnIndex: state.turnIndex,
      mode: state.streamMode ? "stream" : "buffered",
    });
  }

  private openSttSession(
    client: WebSocket,
    state: MediaIngressState,
    sampleRate: number,
    encoding: "mulaw" | "linear16",
    isRecovery: boolean,
  ) {
    return this.deepgramLive.openSession(
      state.language,
      sampleRate,
      {
        onPartial: (text) => this.handlePartial(client, state, text),
        onUtterance: (text) => this.enqueueStreamingTurn(client, state, text),
        onError: (m) => {
          this.send(client, { type: "error", message: m });
          if (!isRecovery && client.readyState === WebSocket.OPEN && state.callId) {
            this.logger.warn(`STT session failed call=${state.callId} — recovering in 5 s`);
            setTimeout(() => {
              if (client.readyState !== WebSocket.OPEN || !state.callId) return;
              try { state.stt?.close(); } catch {}
              this.logger.log(`Re-opening STT session call=${state.callId}`);
              state.stt = this.openSttSession(client, state, sampleRate, encoding, true);
            }, 5000);
          }
        },
      },
      { encoding },
    );
  }

  private handlePartial(client: WebSocket, state: MediaIngressState, text: string) {
    // Server-side barge-in for telephony: there is no client to pause, so the
    // server aborts generation and instructs the media bridge to flush its
    // playback buffer.
    if ((state.active || state.speaking) && text.trim().length >= 4) {
      state.active?.abort();
      this.send(client, { type: "cancel" });
      state.speaking = false;
    }
    this.send(client, { type: "partial", transcript: text });
  }

  private enqueueStreamingTurn(client: WebSocket, state: MediaIngressState, utterance: string) {
    state.queue = state.queue.then(async () => {
      if (!state.callId || client.readyState !== WebSocket.OPEN) return;
      const controller = new AbortController();
      state.active = controller;
      this.send(client, { type: "turn-start", transcript: utterance });
      try {
        const result = await this.runtime.processUtteranceStream(
          state.callId,
          state.turnIndex,
          utterance,
          { locale: state.language, outputFormat: state.outputFormat },
          {
            signal: controller.signal,
            onReplyDelta: (text) => this.send(client, { type: "reply-chunk", text }),
            onAudioChunk: (chunk, info) => {
              state.speaking = true;
              this.send(client, {
                type: "audio-chunk",
                payload: chunk.length > 0 ? chunk.toString("base64") : "",
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
        if (!result.canceled) state.stt?.clearBuffer();
        state.turnIndex += 1;
        this.send(client, {
          type: "reply-end",
          callId: state.callId,
          transcript: result.transcript,
          reply: result.reply,
          endCall: result.endCall,
          canceled: result.canceled,
        });
      } catch (err) {
        this.send(client, {
          type: "error",
          callId: state.callId,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (state.active === controller) state.active = null;
      }
    });
  }

  // Legacy buffered mode: chunks accumulate until an explicit stop, then run
  // one full turn. Kept for existing integrations and tests.
  private async handleBufferedStop(client: WebSocket, state: MediaIngressState) {
    const buffer = Buffer.concat(state.chunks);
    if (state.callId) {
      try {
        const result = await this.runtime.handleTurn(state.callId, state.turnIndex, buffer);
        this.send(client, {
          type: "response",
          callId: state.callId,
          language: state.language,
          turnIndex: state.turnIndex,
          transcript: result.transcript,
          reply: result.reply,
          audioBase64: result.audio.toString("base64"),
        });
        state.turnIndex += 1;
        state.chunks = [];
      } catch (err) {
        this.send(client, {
          type: "error",
          callId: state.callId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    try {
      const result = await this.realtime.transcribeRealtime(buffer, 16000, 5000, state.language);
      this.send(client, {
        type: "transcript",
        callId: state.callId,
        language: state.language,
        transcript: result.text,
        sttMs: result.sttMs,
      });
    } catch (err) {
      this.send(client, {
        type: "error",
        callId: state.callId,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    state.chunks = [];
  }
}

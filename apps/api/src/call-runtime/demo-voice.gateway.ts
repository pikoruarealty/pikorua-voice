import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { WebSocket, RawData } from "ws";
import { Injectable, Logger } from "@nestjs/common";
import type { IncomingMessage } from "http";
import { ConfigService } from "@nestjs/config";
import { DeepgramLiveService, type LiveSession } from "../stt/deepgram-live.service";
import { CallRuntimeService } from "./call-runtime.service";
import { closeUnauthorized, isWebSocketAuthorized } from "../auth/ws-auth";

type ClientState = {
  callId: string | null;
  locale: string;
  turnIndex: number;
  stt: LiveSession | null;
  // Serializes turn processing so overlapping utterances stay in order
  queue: Promise<void>;
};

// Streaming voice channel for the local demo: the browser sends 16 kHz PCM16
// audio continuously; Deepgram Live decides utterance boundaries; each
// finished utterance runs through the shared turn pipeline and the reply
// audio is pushed back. The same shape will back the Exotel media path.
@Injectable()
@WebSocketGateway({ path: "/demo-voice" })
export class DemoVoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger("DemoVoiceGateway");

  private readonly clients = new Map<WebSocket, ClientState>();

  constructor(
    private readonly deepgramLive: DeepgramLiveService,
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
          const sampleRate = Number(msg.sampleRate ?? 16000);
          state.stt = this.deepgramLive.openSession(state.locale, sampleRate, {
            onPartial: (text) => this.send(client, { type: "partial", transcript: text }),
            onUtterance: (text) => this.enqueueTurn(client, state, text),
            onError: (message) => this.send(client, { type: "error", message }),
          });
          this.send(client, { type: "ready" });
        } else if (msg?.type === "stop") {
          state.stt?.close();
          state.stt = null;
        }
      } catch (err) {
        this.logger.warn(
          "Bad control message",
          err instanceof Error ? err.message : String(err),
        );
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    const state = this.clients.get(client);
    state?.stt?.close();
    this.clients.delete(client);
    this.logger.log("Demo voice client disconnected");
  }

  private enqueueTurn(client: WebSocket, state: ClientState, utterance: string) {
    state.queue = state.queue.then(async () => {
      if (!state.callId || client.readyState !== WebSocket.OPEN) return;
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

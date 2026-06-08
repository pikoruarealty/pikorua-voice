import { Injectable, Logger } from "@nestjs/common";
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Server, WebSocket, RawData } from "ws";
import { ConfigService } from "@nestjs/config";
import { DeepgramRealtimeService } from "../stt/deepgram-realtime.service";
import { CallRuntimeService } from "../call-runtime/call-runtime.service";

type MediaIngressState = {
  callId: string | null;
  language: string;
  turnIndex: number;
  chunks: Buffer[];
};

type MediaIngressStartMessage = {
  type?: "start";
  callId?: string;
  language?: string;
  turnIndex?: number;
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

  handleConnection(client: WebSocket) {
    const defaultLanguage = String(this.config.get("GEMINI_LANGUAGE_DEFAULT") ?? "hi-IN");
    this.clients.set(client, { callId: null, language: defaultLanguage, turnIndex: 0, chunks: [] });
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
          state.callId = String(message.callId ?? state.callId ?? "");
          state.language = String(message.language ?? state.language ?? defaultLanguage);
          state.turnIndex = Number(message.turnIndex ?? state.turnIndex ?? 0);
          client.send(
            JSON.stringify({
              type: "ready",
              callId: state.callId,
              language: state.language,
              turnIndex: state.turnIndex,
            }),
          );
          return;
        }

        if (message?.type === "media") {
          const payload = message.payload ?? message.media?.payload;
          if (payload) {
            state.chunks.push(Buffer.from(payload, "base64"));
          }
          return;
        }

        if (message?.type === "stop") {
          const buffer = Buffer.concat(state.chunks);
          if (state.callId) {
            try {
              const result = await this.runtime.handleTurn(state.callId, state.turnIndex, buffer);
              client.send(
                JSON.stringify({
                  type: "response",
                  callId: state.callId,
                  language: state.language,
                  turnIndex: state.turnIndex,
                  transcript: result.transcript,
                  reply: result.reply,
                  audioBase64: result.audio.toString("base64"),
                }),
              );
              this.clients.set(client, {
                callId: state.callId,
                language: state.language,
                turnIndex: state.turnIndex + 1,
                chunks: [],
              });
            } catch (err) {
              client.send(
                JSON.stringify({
                  type: "error",
                  callId: state.callId,
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            }
            return;
          }

          try {
            const result = await this.realtime.transcribeRealtime(
              buffer,
              16000,
              5000,
              state.language,
            );
            client.send(
              JSON.stringify({
                type: "transcript",
                callId: state.callId,
                language: state.language,
                transcript: result.text,
                sttMs: result.sttMs,
              }),
            );
          } catch (err) {
            client.send(
              JSON.stringify({
                type: "error",
                callId: state.callId,
                message: err instanceof Error ? err.message : String(err),
              }),
            );
          }

          this.clients.set(client, {
            callId: state.callId,
            language: state.language,
            turnIndex: state.turnIndex,
            chunks: [],
          });
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
    this.clients.delete(client);
    this.logger.log("Media ingress client disconnected");
  }
}

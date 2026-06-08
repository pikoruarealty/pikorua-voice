import { Injectable, Logger } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from "@nestjs/websockets";
import { Server, WebSocket, RawData } from "ws";
import { ConfigService } from "@nestjs/config";
import { DeepgramRealtimeService } from "../stt/deepgram-realtime.service";

type MediaIngressState = {
  callId: string | null;
  language: string;
  chunks: Buffer[];
};

type MediaIngressStartMessage = {
  type?: "start";
  callId?: string;
  language?: string;
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
    this.clients.set(client, { callId: null, language: defaultLanguage, chunks: [] });
    this.logger.log("Media ingress client connected");

    client.on("message", async (data: RawData, isBinary: boolean) => {
      const state = this.clients.get(client);
      if (!state) {
        return;
      }

      try {
        const message = this.parseJson<MediaIngressStartMessage | MediaIngressMediaMessage | MediaIngressStopMessage>(data, isBinary);
        if (message?.type === "start") {
          state.callId = String(message.callId ?? state.callId ?? "");
          state.language = String(message.language ?? state.language ?? defaultLanguage);
          client.send(JSON.stringify({ type: "ready", callId: state.callId, language: state.language }));
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
          const result = await this.realtime.transcribeRealtime(buffer, 16000, 5000, state.language).catch((err) => {
            this.logger.warn("Media ingress transcription failed", err instanceof Error ? err.stack : String(err));
            return { text: "", sttMs: 0 };
          });

          client.send(JSON.stringify({
            type: "transcript",
            callId: state.callId,
            language: state.language,
            transcript: result.text,
            sttMs: result.sttMs,
          }));

          this.clients.set(client, { callId: state.callId, language: state.language, chunks: [] });
          return;
        }

        if (!isBinary && data) {
          state.chunks.push(this.parseBinary(data));
        }
      } catch (err) {
        this.logger.warn("Failed to handle media ingress message", err instanceof Error ? err.stack : String(err));
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
    this.logger.log("Media ingress client disconnected");
  }
}

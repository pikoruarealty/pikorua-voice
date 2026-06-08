import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Server, WebSocket, RawData } from "ws";
import { Injectable, Logger } from "@nestjs/common";
import type { IncomingMessage } from "http";
import { ConfigService } from "@nestjs/config";
import { DeepgramRealtimeService } from "./deepgram-realtime.service";
import { closeUnauthorized, isWebSocketAuthorized } from "../auth/ws-auth";

type ClientState = {
  chunks: Buffer[];
};

@Injectable()
@WebSocketGateway({ path: "/realtime-stt" })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger("RealtimeGateway");
  @WebSocketServer()
  server!: Server;

  private clients = new Map<WebSocket, ClientState>();

  constructor(
    private readonly realtime: DeepgramRealtimeService,
    private readonly config: ConfigService,
  ) {}

  private parseTextMessage(data: RawData, isBinary: boolean) {
    if (typeof data === "string") {
      return data;
    }

    if (!isBinary) {
      if (Buffer.isBuffer(data)) {
        return data.toString("utf8");
      }

      if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString("utf8");
      }

      if (Array.isArray(data)) {
        return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
      }
    }

    return null;
  }

  private normalizeBinaryChunk(data: RawData) {
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

  handleConnection(client: WebSocket, request?: IncomingMessage) {
    if (!isWebSocketAuthorized(this.config, request)) {
      closeUnauthorized(client);
      return;
    }

    this.clients.set(client, { chunks: [] });
    this.logger.log("Client connected for realtime STT");

    client.on("message", async (data: RawData, isBinary: boolean) => {
      // Expect binary audio chunks or control JSON messages
      try {
        const textMessage = this.parseTextMessage(data, isBinary);
        if (textMessage !== null) {
          const msg = JSON.parse(textMessage);
          if (msg?.type === "stop") {
            const state = this.clients.get(client);
            const buffer = Buffer.concat(state?.chunks ?? []);
            try {
              const result = await this.realtime.transcribeRealtime(
                buffer,
                16000,
                5000,
                String(msg?.language ?? "en-IN"),
              );
              client.send(
                JSON.stringify({
                  type: "transcript",
                  transcript: result.text,
                  sttMs: result.sttMs,
                }),
              );
              this.clients.set(client, { chunks: [] });
            } catch (err) {
              client.send(
                JSON.stringify({
                  type: "error",
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          }
        } else {
          // binary chunk
          const state = this.clients.get(client);
          state?.chunks.push(this.normalizeBinaryChunk(data));
        }
      } catch (err) {
        this.logger.warn("Error handling message", err instanceof Error ? err.stack : String(err));
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
    this.logger.log("Client disconnected from realtime STT");
  }
}

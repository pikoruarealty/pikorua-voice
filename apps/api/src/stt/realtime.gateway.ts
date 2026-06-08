import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, WebSocket, RawData } from 'ws';
import { Injectable, Logger } from '@nestjs/common';
import { DeepgramRealtimeService } from './deepgram-realtime.service';

type ClientState = {
  chunks: Buffer[];
};

@Injectable()
@WebSocketGateway({ path: '/realtime-stt' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('RealtimeGateway');
  @WebSocketServer()
  server!: Server;

  private clients = new Map<WebSocket, ClientState>();

  constructor(private readonly realtime: DeepgramRealtimeService) {}

  handleConnection(client: WebSocket) {
    this.clients.set(client, { chunks: [] });
    this.logger.log('Client connected for realtime STT');

    client.on('message', async (data: RawData) => {
      // Expect binary audio chunks or control JSON messages
      try {
        if (typeof data === 'string') {
          const msg = JSON.parse(data);
          if (msg?.type === 'stop') {
            const state = this.clients.get(client);
            const buffer = Buffer.concat(state?.chunks ?? []);
            const result = await this.realtime.transcribeRealtime(buffer).catch((err) => {
              this.logger.warn('Realtime transcribe failed', err instanceof Error ? err.stack : String(err));
              return { text: '', sttMs: 0 };
            });
            client.send(JSON.stringify({ type: 'transcript', transcript: result.text, sttMs: result.sttMs }));
            // reset
            this.clients.set(client, { chunks: [] });
          }
        } else {
          // binary chunk
          const state = this.clients.get(client);
          state?.chunks.push(Buffer.from(data as Buffer));
        }
      } catch (err) {
        this.logger.warn('Error handling message', err instanceof Error ? err.stack : String(err));
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
    this.logger.log('Client disconnected from realtime STT');
  }
}

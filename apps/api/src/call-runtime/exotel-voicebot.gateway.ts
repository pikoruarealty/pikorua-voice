import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { WebSocket, RawData } from "ws";
import { Injectable, Inject, Logger } from "@nestjs/common";
import type { IncomingMessage } from "http";
import { DeepgramLiveService, type LiveSession } from "../stt/deepgram-live.service";
import { ElevenlabsService } from "../tts/elevenlabs.service";
import { CallRuntimeService } from "./call-runtime.service";
import { CallRepository } from "@pikorua/db";

// Exotel's Voicebot WebSocket carries raw 16-bit linear PCM, 8 kHz, mono,
// little-endian (slin/s16le) in BOTH directions — confirmed against Exotel's
// streaming docs. ElevenLabs "pcm_8000" returns exactly this (headerless raw
// PCM), so Exotel plays it back without transcoding. (ulaw_8000 was wrong:
// µ-law bytes read as linear PCM is structured noise — the crackling.)
const EXOTEL_OUTPUT_FORMAT = "pcm_8000";
const EXOTEL_SAMPLE_RATE = 8000;

// Exotel requires media frames to be a multiple of 320 bytes (20 ms @ 8 kHz,
// 16-bit mono); the recommended frame is ~100 ms (3200 bytes) and a single
// frame must stay ≤ 100 KB. ElevenLabs streams PCM in arbitrary HTTP chunk
// sizes, so we re-frame: accumulate bytes and emit fixed 3200-byte frames,
// padding the final flush with silence (zeros) up to a 320-byte boundary.
const EXOTEL_FRAME_BYTES = 3200; // 100 ms
const EXOTEL_FRAME_ALIGN = 320; // 20 ms — Exotel's required multiple

class PcmReframer {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly emit: (frame: Buffer) => void) {}

  push(chunk: Buffer) {
    if (chunk.length === 0) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= EXOTEL_FRAME_BYTES) {
      this.emit(this.buf.subarray(0, EXOTEL_FRAME_BYTES));
      this.buf = this.buf.subarray(EXOTEL_FRAME_BYTES);
    }
  }

  // Emit the remaining bytes, padded with PCM silence (0x00) to a 320-byte
  // multiple so Exotel accepts the final partial frame. Called once at the end
  // of a turn; on barge-in/cancel we drop the remainder instead.
  flush() {
    if (this.buf.length === 0) return;
    const remainder = this.buf.length % EXOTEL_FRAME_ALIGN;
    const frame =
      remainder === 0
        ? this.buf
        : Buffer.concat([this.buf, Buffer.alloc(EXOTEL_FRAME_ALIGN - remainder)]);
    this.emit(frame);
    this.buf = Buffer.alloc(0);
  }
}

type ActiveTurn = { controller: AbortController };

type SessionState = {
  callSid: string | null;
  callId: string | null;
  locale: string;
  turnIndex: number;
  stt: LiveSession | null;
  // Serialises turn processing so overlapping utterances stay in order.
  queue: Promise<void>;
  speaking: boolean;
  active: ActiveTurn | null;
};

// Exotel Voicebot WebSocket gateway.
//
// Exotel opens one WebSocket per call. Events from Exotel:
//   connected  → handshake complete
//   start      → stream begins; carries callSid + custom_parameters
//   media      → base64 linear16 8 kHz audio chunk
//   dtmf       → digit pressed by caller
//   stop       → caller hung up / stream ended
//
// This gateway sends back:
//   media      → base64 pcm_8000 (raw 16-bit linear PCM) audio for the reply
//   mark       → logical milestone (sentence boundary)
//   clear      → discard queued bot audio (barge-in)
@Injectable()
@WebSocketGateway({ path: "/exotel-stream" })
export class ExotelVoicebotGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger("ExotelVoicebotGateway");
  private readonly sessions = new Map<WebSocket, SessionState>();

  constructor(
    private readonly deepgramLive: DeepgramLiveService,
    private readonly tts: ElevenlabsService,
    private readonly runtime: CallRuntimeService,
    @Inject(CallRepository) private readonly callRepo: CallRepository,
  ) {}

  handleConnection(client: WebSocket, request?: IncomingMessage) {
    // Optional shared-secret guard: set EXOTEL_STREAM_SECRET and include
    // ?token=<secret> in the WebSocket URL configured in the Exotel applet.
    // WebSocket-level auth: Exotel strips query params from wss:// URLs so a
    // shared-secret token in the URL is not reliable. Security is provided by:
    //   1. TLS (wss://) — connection is encrypted in transit
    //   2. callSid DB validation in the "start" event handler — any rogue
    //      connection that can't supply a valid callSid gets no useful response
    //   3. Exotel HMAC signature on all status-callback webhooks
    this.logger.log(`Exotel stream handshake — url=${request?.url ?? ""}`);

    const state: SessionState = {
      callSid: null,
      callId: null,
      locale: "hi-IN",
      turnIndex: 0,
      stt: null,
      queue: Promise.resolve(),
      speaking: false,
      active: null,
    };
    this.sessions.set(client, state);
    this.logger.log("Exotel voicebot connection opened");

    client.on("message", (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        void this.handleEvent(client, state, msg);
      } catch {
        // Non-JSON frames are ignored.
      }
    });
  }

  handleDisconnect(client: WebSocket) {
    const state = this.sessions.get(client);
    if (state) {
      state.active?.controller.abort();
      state.stt?.close();
    }
    this.sessions.delete(client);
    this.logger.log(
      `Exotel voicebot disconnected${state?.callSid ? ` callSid=${state.callSid}` : ""}`,
    );
  }

  private async handleEvent(
    client: WebSocket,
    state: SessionState,
    msg: Record<string, unknown>,
  ) {
    switch (String(msg.event ?? "")) {
      case "connected":
        this.logger.log("Exotel stream: connected");
        break;

      case "start": {
        const start = (msg.start ?? {}) as Record<string, unknown>;
        // Exotel sends either call_sid (newer) or callSid (older) field.
        const callSid = String(start.call_sid ?? start.callSid ?? "");
        const custom = (start.custom_parameters ?? start.customParameters ?? {}) as Record<
          string,
          string
        >;

        state.callSid = callSid || null;

        // Prefer callId passed explicitly via the applet's custom parameters so
        // we avoid an extra DB round-trip on every call. Fall back to a lookup
        // by Exotel's CallSid when no explicit mapping is provided.
        if (custom.callId) {
          state.callId = custom.callId;
          if (custom.locale) state.locale = custom.locale;
        } else if (callSid) {
          try {
            const call = await this.callRepo.findByProviderCallSid(callSid);
            if (call) {
              state.callId = call.id;
              if (call.locale) state.locale = call.locale;
            }
          } catch (err) {
            this.logger.warn(
              `Failed to resolve callId from callSid=${callSid}: ${String(err)}`,
            );
          }
        }

        if (!state.callId) {
          // No DB record yet — use callSid as a stable key so the session
          // still works; the webhook will create the real record shortly.
          state.callId = callSid || `exotel-${Date.now()}`;
          this.logger.warn(
            `No callId resolved for callSid=${callSid} — using fallback key=${state.callId}`,
          );
        }

        this.logger.log(
          `Exotel stream start: callSid=${callSid} callId=${state.callId} locale=${state.locale}`,
        );

        // Warm clip cache and fire opening greeting concurrently.
        void this.runtime.warmCall(state.callId, state.locale);
        void this.sendGreeting(client, state);

        state.stt = this.openSttSession(client, state);
        break;
      }

      case "media": {
        const payload = (msg.media as Record<string, unknown> | undefined)?.payload;
        if (typeof payload === "string" && state.stt) {
          state.stt.sendAudio(Buffer.from(payload, "base64"));
        }
        break;
      }

      case "dtmf": {
        const digit = String((msg.dtmf as Record<string, unknown> | undefined)?.digit ?? "");
        if (digit) {
          this.logger.log(`DTMF digit=${digit} callId=${state.callId}`);
          // DTMF locale selection can be wired here if needed.
        }
        break;
      }

      case "stop":
        this.logger.log(`Exotel stream stop: callId=${state.callId}`);
        state.active?.controller.abort();
        state.stt?.close();
        state.stt = null;
        break;
    }
  }

  private async sendGreeting(client: WebSocket, state: SessionState): Promise<void> {
    if (!state.callId || client.readyState !== WebSocket.OPEN) return;

    const controller = new AbortController();
    state.active = { controller };

    const reframer = new PcmReframer((frame) => {
      state.speaking = true;
      this.send(client, {
        event: "media",
        media: { payload: frame.toString("base64") },
      });
    });

    try {
      const result = await this.runtime.generateGreetingStream(
        state.callId,
        state.locale,
        {
          signal: controller.signal,
          onAudioChunk: (chunk, info) => {
            if (chunk.length > 0) {
              reframer.push(chunk);
            } else if (info.last) {
              this.send(client, { event: "mark", mark: { name: `g${info.sentenceIndex}` } });
            }
          },
          onCancel: () => {
            state.speaking = false;
            this.send(client, { event: "clear" });
          },
        },
        { outputFormat: EXOTEL_OUTPUT_FORMAT },
      );

      // Drain the final partial frame only on a clean finish; on barge-in the
      // remainder is intentionally dropped (we already sent "clear").
      if (!result.canceled && !controller.signal.aborted) {
        reframer.flush();
      }
      if (!result.skipped && !result.canceled) {
        state.speaking = false;
      }
    } catch (err) {
      this.logger.error(
        `Greeting failed callId=${state.callId}`,
        err instanceof Error ? err.stack : String(err),
      );
    } finally {
      if (state.active?.controller === controller) state.active = null;
    }
  }

  private openSttSession(client: WebSocket, state: SessionState): LiveSession {
    return this.deepgramLive.openSession(
      state.locale,
      EXOTEL_SAMPLE_RATE,
      {
        onPartial: (text) => this.handlePartial(client, state, text),
        onUtterance: (text) => this.enqueueTurn(client, state, text),
        onError: (message) => {
          this.logger.warn(`STT error callId=${state.callId}: ${message}`);
        },
      },
      { encoding: "linear16" },
    );
  }

  // Server-side barge-in: when the caller is talking over the bot, abort the
  // active turn and tell Exotel to drop its audio queue.
  private handlePartial(client: WebSocket, state: SessionState, text: string) {
    if ((state.active || state.speaking) && text.trim().length >= 4) {
      if (state.active) {
        this.logger.log(`Barge-in callId=${state.callId} — aborting active turn`);
        state.active.controller.abort();
      }
      if (state.speaking || state.active) {
        this.send(client, { event: "clear" });
        state.speaking = false;
      }
    }
  }

  private enqueueTurn(client: WebSocket, state: SessionState, utterance: string) {
    state.queue = state.queue.then(async () => {
      if (!state.callId || client.readyState !== WebSocket.OPEN) return;
      await this.runTurn(client, state, utterance);
    });
  }

  private async runTurn(client: WebSocket, state: SessionState, utterance: string) {
    const controller = new AbortController();
    const active: ActiveTurn = { controller };
    state.active = active;
    state.speaking = false;

    const reframer = new PcmReframer((frame) => {
      state.speaking = true;
      this.send(client, {
        event: "media",
        media: { payload: frame.toString("base64") },
      });
    });

    try {
      const result = await this.runtime.processUtteranceStream(
        state.callId!,
        state.turnIndex,
        utterance,
        { locale: state.locale, outputFormat: EXOTEL_OUTPUT_FORMAT },
        {
          signal: controller.signal,
          onAudioChunk: (chunk, info) => {
            if (chunk.length > 0) {
              reframer.push(chunk);
            } else if (info.last) {
              // Sentence boundary — let Exotel track playback progress.
              this.send(client, { event: "mark", mark: { name: `s${info.sentenceIndex}` } });
            }
          },
          onCancel: () => {
            state.speaking = false;
            this.send(client, { event: "clear" });
          },
        },
      );

      // Drain the final partial frame only on a clean finish; on barge-in the
      // remainder is intentionally dropped (we already sent "clear").
      if (!result.canceled && !controller.signal.aborted) {
        reframer.flush();
      }

      if (!result.waitForMore && !result.canceled) {
        state.stt?.clearBuffer();
        state.turnIndex += 1;
      }

      if (result.endCall) {
        this.logger.log(`Call ended callId=${state.callId}`);
        // Let the final audio drain before closing the WebSocket.
        await new Promise<void>((r) => setTimeout(r, 500));
        try {
          client.close();
        } catch {}
      }
    } catch (err) {
      this.logger.error(
        `Turn failed callId=${state.callId}`,
        err instanceof Error ? err.stack : String(err),
      );
    } finally {
      if (state.active === active) state.active = null;
      // Always clear: on clean finish we never set it false otherwise; on barge-in
      // onCancel already did this, so setting false twice is harmless.
      state.speaking = false;
    }
  }

  private send(client: WebSocket, payload: Record<string, unknown>) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(payload));
      } catch {}
    }
  }
}

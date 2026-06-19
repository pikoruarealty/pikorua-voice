import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { WebSocket, RawData } from "ws";
import { Injectable, Inject, Logger } from "@nestjs/common";
import type { IncomingMessage } from "http";
import { ConfigService } from "@nestjs/config";
import { DeepgramLiveService, type LiveSession } from "../stt/deepgram-live.service";
import { ElevenlabsService } from "../tts/elevenlabs.service";
import { CallRuntimeService } from "./call-runtime.service";
import { CallRepository } from "@pikorua/db";

// Exotel sends 16-bit linear PCM at 8 kHz over the WebSocket.
// ElevenLabs ulaw_8000 matches G.711 telephony — Exotel plays it directly.
const EXOTEL_OUTPUT_FORMAT = "ulaw_8000";
const EXOTEL_SAMPLE_RATE = 8000;

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
  fillerIdx: number;
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
//   media      → base64 ulaw_8000 audio for the bot's reply
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
    private readonly config: ConfigService,
    @Inject(CallRepository) private readonly callRepo: CallRepository,
  ) {}

  handleConnection(client: WebSocket, request?: IncomingMessage) {
    // Optional shared-secret guard: set EXOTEL_STREAM_SECRET and include
    // ?token=<secret> in the WebSocket URL configured in the Exotel applet.
    const secret = this.config.get<string>("EXOTEL_STREAM_SECRET");
    if (secret) {
      const url = new URL(request?.url ?? "", "http://localhost");
      if (url.searchParams.get("token") !== secret) {
        this.logger.warn("Exotel stream connection rejected — invalid token");
        client.close(1008, "Unauthorized");
        return;
      }
    }

    const state: SessionState = {
      callSid: null,
      callId: null,
      locale: "hi-IN",
      turnIndex: 0,
      stt: null,
      queue: Promise.resolve(),
      speaking: false,
      active: null,
      fillerIdx: 0,
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

        // Warm conversation state and prewarm filler clips in telephony format
        // while the first utterance is still being spoken.
        void this.runtime.warmCall(state.callId, state.locale);
        this.tts.prewarmClips(this.runtime.fillerTexts(state.locale), {
          outputFormat: EXOTEL_OUTPUT_FORMAT,
          languageCode: state.locale.toLowerCase().startsWith("en") ? "en" : undefined,
        });

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

    // Filler audio masks LLM latency. Pre-synthesised clips are already cached
    // in ulaw format from the prewarm; first-turn synthesis is instant.
    const fillerDelay = Number(this.config.get("FILLER_DELAY_MS") ?? 900);
    const fillerTimer =
      fillerDelay > 0
        ? setTimeout(() => void this.sendFiller(client, state, active), fillerDelay)
        : null;

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
              state.speaking = true;
              this.send(client, {
                event: "media",
                media: { payload: chunk.toString("base64") },
              });
            } else if (info.last) {
              // Sentence boundary — let Exotel know so it can track progress.
              this.send(client, {
                event: "mark",
                mark: { name: `s${info.sentenceIndex}` },
              });
            }
          },
          onCancel: () => {
            state.speaking = false;
            this.send(client, { event: "clear" });
          },
        },
      );

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
      if (fillerTimer) clearTimeout(fillerTimer);
      if (state.active === active) state.active = null;
    }
  }

  private async sendFiller(
    client: WebSocket,
    state: SessionState,
    active: ActiveTurn,
  ) {
    if (state.speaking || active.controller.signal.aborted) return;
    const texts = this.runtime.fillerTexts(state.locale);
    const text = texts[state.fillerIdx % texts.length];
    state.fillerIdx += 1;
    const clip = await this.tts.getClip(text, {
      outputFormat: EXOTEL_OUTPUT_FORMAT,
      languageCode: state.locale.toLowerCase().startsWith("en") ? "en" : undefined,
    });
    if (!clip || state.speaking || active.controller.signal.aborted) return;
    state.speaking = true;
    this.send(client, { event: "media", media: { payload: clip.toString("base64") } });
  }

  private send(client: WebSocket, payload: Record<string, unknown>) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(payload));
      } catch {}
    }
  }
}

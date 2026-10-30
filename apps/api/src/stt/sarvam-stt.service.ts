import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import WebSocket, { RawData } from "ws";
import { keytermsFor } from "./keyterms";
import type { LiveSession, LiveSessionCallbacks } from "./deepgram-live.service";

// Sarvam streaming STT (wss://api.sarvam.ai/speech-to-text/ws) behind the same
// LiveSession surface the gateways already use for Deepgram, so SttRouter can
// swap one for the other per call.
//
// How it differs from Deepgram, and what that means here:
//   - No interim partials. Sarvam's VAD decides the utterance boundary and sends
//     ONE transcript per utterance. We emit it as onPartial (so the gateway's
//     usual barge-in check still runs) and then onUtterance.
//   - START_SPEECH VAD events arrive as onSpeechStart — the only early barge-in
//     signal Sarvam gives. The gateway only acts on it with near-end energy behind it.
//   - No reconnects: any socket failure goes to onError and SttRouter moves the
//     call to Deepgram for its remaining turns.
//
// Wire format: raw s16le PCM at the connection's sample_rate (8 kHz on Exotel),
// sent as base64 inside {"audio": {...}} JSON frames, batched to ~100 ms.

const SARVAM_STT_WS_URL = "wss://api.sarvam.ai/speech-to-text/ws";
// Sarvam caps keyterms at 50 terms of ≤64 chars each.
const MAX_KEYTERMS = 50;
const MAX_KEYTERM_CHARS = 64;
// Audio buffered while the socket is still opening (bounded: ~6 s at 100 ms).
const MAX_PENDING_FRAMES = 60;

@Injectable()
export class SarvamSttService {
  private readonly logger = new Logger("SarvamSttService");

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get("SARVAM_API_KEY"));
  }

  // Gujarati sessions transcribe in Gujarati script. Hindi and English share one
  // code-mixed session (Devanagari for Hindi words, Latin for English ones), the
  // same split Deepgram's `multi` makes — so detectSpokenLanguage's script-based
  // hi/en/gu detection keeps working and only crossing gu needs a new session.
  static sessionLanguage(locale: string): { code: string; mode: string } {
    return locale.toLowerCase().startsWith("gu")
      ? { code: "gu-IN", mode: "transcribe" }
      : { code: "hi-IN", mode: "codemix" };
  }

  openSession(locale: string, sampleRate: number, callbacks: LiveSessionCallbacks): LiveSession {
    const key = String(this.config.get("SARVAM_API_KEY") ?? "");
    if (!key) throw new ServiceUnavailableException("Sarvam API key is not configured");

    const lang = SarvamSttService.sessionLanguage(locale);
    const model = String(this.config.get("SARVAM_STT_MODEL") ?? "saaras:v4");
    const params = new URLSearchParams({
      "language-code": lang.code,
      model,
      mode: lang.mode,
      sample_rate: String(sampleRate),
      input_audio_codec: "pcm_s16le",
      vad_signals: "true",
    });
    // Project / area names bias recognition (saaras:v4 only).
    if (model === "saaras:v4") {
      const terms = keytermsFor(lang.code === "gu-IN" ? "gu" : "multi")
        .filter((t) => t.length <= MAX_KEYTERM_CHARS)
        .slice(0, MAX_KEYTERMS);
      if (terms.length > 0) params.set("keyterms", JSON.stringify(terms));
    }

    const ws = new WebSocket(`${SARVAM_STT_WS_URL}?${params.toString()}`, {
      headers: { "Api-Subscription-Key": key },
    });
    const sampleRateStr = String(sampleRate);
    const batchBytes = Math.round(sampleRate * 2 * 0.1); // 100 ms of 16-bit mono
    let batch: Buffer[] = [];
    let batched = 0;
    const pending: string[] = [];
    let open = false;
    let closedByUser = false;
    let failed = false;

    const fail = (message: string) => {
      if (failed || closedByUser) return;
      failed = true;
      this.logger.warn(`Sarvam STT session failed (${message})`);
      try {
        ws.close();
      } catch {}
      callbacks.onError(message);
    };

    const sendFrame = (pcm: Buffer) => {
      const frame = JSON.stringify({
        audio: { data: pcm.toString("base64"), sample_rate: sampleRateStr, encoding: "audio/wav" },
      });
      if (open) {
        try {
          ws.send(frame);
        } catch {}
      } else {
        pending.push(frame);
        if (pending.length > MAX_PENDING_FRAMES) pending.shift();
      }
    };

    ws.on("open", () => {
      if (closedByUser) {
        try {
          ws.close();
        } catch {}
        return;
      }
      open = true;
      this.logger.log(`Sarvam STT session open (lang=${lang.code} mode=${lang.mode} model=${model})`);
      for (const frame of pending.splice(0)) {
        try {
          ws.send(frame);
        } catch {}
      }
    });

    ws.on("message", (raw: RawData) => {
      let msg: { type?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "data") {
        const text = String(msg.data?.transcript ?? "").trim();
        if (!text) return;
        callbacks.onPartial(text);
        callbacks.onUtterance(text);
      } else if (msg.type === "events") {
        if (msg.data?.signal_type === "START_SPEECH") callbacks.onSpeechStart?.();
      } else if (msg.type === "error") {
        fail(String(msg.data?.error ?? msg.data?.message ?? "unknown error"));
      }
    });

    ws.on("error", (err) => fail(err.message));
    ws.on("close", (code) => fail(`socket closed (${code})`));

    return {
      sendAudio: (chunk: Buffer) => {
        if (closedByUser || failed) return;
        batch.push(chunk);
        batched += chunk.length;
        if (batched >= batchBytes) {
          sendFrame(Buffer.concat(batch));
          batch = [];
          batched = 0;
        }
      },
      // Nothing accumulates client-side: Sarvam sends each utterance whole.
      clearBuffer: () => {},
      // Endpointing is Sarvam's own VAD; no per-call knob to turn.
      setEndpointing: () => {},
      close: () => {
        if (closedByUser) return;
        closedByUser = true;
        try {
          ws.close();
        } catch {}
      },
    };
  }
}

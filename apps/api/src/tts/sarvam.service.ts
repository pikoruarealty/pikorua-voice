import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import WebSocket from "ws";
import { normalizeForTts } from "./elevenlabs.service";
import type { SynthesizeOptions, StreamSynthesisResult } from "./elevenlabs.service";

// Sarvam AI (Bulbul) text-to-speech — used ONLY for Gujarati.
//
// WHY A SECOND TTS VENDOR AT ALL: ElevenLabs cannot speak Gujarati in a realtime
// call. Its low-latency models (turbo_v2_5, flash_v2_5) support 32 languages that
// include Hindi and Tamil but NOT Gujarati; the only ElevenLabs model that does
// speak Gujarati is eleven_v3, which has no WebSocket streaming and is explicitly
// not for realtime/conversational use. So gu needs a different engine. Sarvam
// Bulbul supports gu-IN natively and — critically — emits 8 kHz, which is exactly
// Exotel's wire format, so the existing PcmReframer path works unchanged.
//
// hi/en DO NOT ROUTE HERE. They stay on ElevenLabs, untouched. See TtsRouter.
//
// STATUS: unverified against the live API — there is no SARVAM_API_KEY yet. The
// request shape below follows the Bulbul docs (model "bulbul:v3", endpoint
// /text-to-speech, header api-subscription-key). Two things MUST be confirmed by
// tools/staging/sarvam-tts-smoke.js before this is trusted in a call:
//   1. TTFB. The whole turn design assumes ~200-400ms per-sentence TTS. If Sarvam
//      is materially slower, sentence pipelining and the latency budget change.
//   2. Audio framing. REST returns base64 WAV; whether the streaming path emits
//      raw PCM or WAV is unconfirmed. stripWavHeader below handles both, but the
//      chunked case (a header split across chunks) is only safe because we buffer
//      the whole response — see synthesizeStream.
const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";
const SARVAM_TTS_WS_URL = "wss://api.sarvam.ai/text-to-speech/ws";

// How much text Sarvam buffers before it starts generating — the main lever on
// time-to-first-audio.
//
// MEASURED, DO NOT LOWER BLINDLY: 50 is not a guess, it is the floor the API
// accepts. min_buffer_size=10 is rejected with HTTP 422 "Input parameters has to
// be a valid dictionary" (a misleading message for an out-of-range value). At 50,
// tools/staging/sarvam-ws-smoke.js measures ~210-235ms to first audio.
const SARVAM_MIN_BUFFER_SIZE = 50;
const SARVAM_MAX_CHUNK_LENGTH = 150;

// Sarvam returns 16-bit signed little-endian PCM inside a WAV container. Exotel
// wants the raw samples with no container, so the header must come off — a 44-byte
// RIFF header fed to PcmReframer is not silence, it is audible noise at the start
// of every sentence.
//
// This walks the RIFF chunk table rather than blindly slicing 44 bytes: WAV files
// legally carry extra chunks (LIST/fact) before `data`, so a fixed offset would
// leave chunk bytes in the audio. If the buffer isn't RIFF/WAVE at all it is
// assumed to already be raw PCM and returned untouched.
export function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length < 12) return buf;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return buf; // already raw PCM
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const start = offset + 8;
      const end = Math.min(start + chunkSize, buf.length);
      return buf.subarray(start, end);
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return buf; // no data chunk found — hand back what we got rather than nothing
}

// Exotel's wire format. Sarvam accepts 8000 directly, so no resampling step.
const EXOTEL_SAMPLE_RATE = 8000;

@Injectable()
export class SarvamService {
  private readonly logger = new Logger("SarvamService");

  // Pre-synthesized short clips (fillers, apologies), mirroring the ElevenLabs
  // cache. Served instantly to mask turn latency and — the important one — to
  // keep the apology speakable even when Sarvam itself is down.
  private readonly clips = new Map<string, Buffer>();

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get("SARVAM_API_KEY"));
  }

  private requestConfig() {
    const key = String(this.config.get("SARVAM_API_KEY") ?? "");
    if (!key) {
      throw new ServiceUnavailableException("Sarvam API key is not configured");
    }
    // Maya's Gujarati voice is "simran" (chosen by ear against Gargi's Hindi
    // register — warm, calm, young, female). bulbul:v3's other female voices:
    // ritu, priya, neha, pooja, kavya, ishita, shreya, roopa, tanya. Re-audition
    // with `node tools/staging/sarvam-tts-smoke.js --audition`.
    // NOTE: "anushka" is a bulbul:v2 voice and is REJECTED by v3.
    const speaker = String(this.config.get("SARVAM_SPEAKER") ?? "simran");
    const model = String(this.config.get("SARVAM_MODEL") ?? "bulbul:v3");
    // pace 1.0 = natural speed (chosen setting). Sweep in
    // tools/staging/sarvam-tune-simran.js confirmed LOWER pace = slower speech
    // (0.8→19s, 1.0→13s for the same line), so drop below 1.0 to slow her down.
    // Range 0.5–2.0, clamped so a bad env value can't break synthesis.
    const pace = Math.min(2.0, Math.max(0.5, Number(this.config.get("SARVAM_PACE") ?? 1.0)));
    // temperature = v3's expressiveness knob (it replaced v2's pitch+loudness).
    // 0 = neutral (chosen setting) — but Sarvam REJECTS a literal temperature:0
    // ("Input parameters has to be a valid dictionary"), so 0 means "omit the
    // field and use Sarvam's own baseline", which IS the neutral "—" delivery.
    // Raise toward ~0.7 for more varied, "human" intonation. NaN falls back to 0.
    const rawTemp = Number(this.config.get("SARVAM_TEMPERATURE") ?? 0);
    const temperature = Number.isFinite(rawTemp) ? Math.min(1.5, Math.max(0, rawTemp)) : 0;
    return { key, speaker, model, pace, temperature };
  }

  private buildBody(text: string, cfg: ReturnType<SarvamService["requestConfig"]>) {
    return {
      // normalizeForTts in "gu" mode: Gujarati respellings, Gujarati number words,
      // and the English-always rules (BHK, areas, distances, dates, clock times).
      text: normalizeForTts(text, "gu"),
      target_language_code: "gu-IN",
      speaker: cfg.speaker,
      model: cfg.model,
      speech_sample_rate: EXOTEL_SAMPLE_RATE,
      pace: cfg.pace,
      // Omit when 0 — Sarvam rejects temperature:0; absence = its neutral baseline.
      ...(cfg.temperature > 0 ? { temperature: cfg.temperature } : {}),
    };
  }

  private timeoutMs(): number {
    return Number(this.config.get("TTS_TIMEOUT_MS") ?? 8000);
  }

  // Decode Sarvam's JSON response into raw PCM. Shape: { audios: [ "<base64>" ] }.
  private decodeAudios(data: unknown): Buffer {
    const audios = (data as { audios?: unknown })?.audios;
    if (!Array.isArray(audios) || audios.length === 0 || typeof audios[0] !== "string") {
      throw new ServiceUnavailableException("Sarvam returned no audio");
    }
    // Concatenate then strip once: Sarvam splits long text across array entries,
    // and each entry carries its OWN WAV header. Stripping per-entry before
    // concatenation is required — otherwise every entry after the first injects a
    // header mid-stream.
    const pcmParts = audios.map((b64) => stripWavHeader(Buffer.from(b64 as string, "base64")));
    return Buffer.concat(pcmParts);
  }

  async synthesize(text: string, _opts?: SynthesizeOptions): Promise<{ audio: Buffer; ttsMs: number }> {
    const start = Date.now();
    const cfg = this.requestConfig();
    const body = this.buildBody(text, cfg);

    let lastErr: unknown;
    // One quick retry, matching the ElevenLabs path: a transient provider blip
    // must not drop a live call.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const resp = await axios.post(SARVAM_TTS_URL, body, {
          headers: { "api-subscription-key": cfg.key, "Content-Type": "application/json" },
          timeout: this.timeoutMs(),
        });
        const audio = this.decodeAudios(resp.data);
        const ms = Date.now() - start;
        this.logger.log(`Sarvam TTS complete (${ms}ms) bytes=${audio.length}`);
        return { audio, ttsMs: ms };
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `Sarvam TTS attempt ${attempt + 1} failed${attempt === 0 ? " — retrying" : ""}`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
      }
    }
    this.logger.error(
      "Sarvam TTS failed",
      lastErr instanceof Error ? lastErr.stack : String(lastErr),
    );
    throw new ServiceUnavailableException("Sarvam synthesis failed");
  }

  // Cached short clip, synthesizing on first use. Mirrors ElevenlabsService.getClip.
  async getClip(text: string, opts?: SynthesizeOptions): Promise<Buffer | null> {
    const key = `gu|${opts?.outputFormat ?? "pcm_8000"}|${text}`;
    const cached = this.clips.get(key);
    if (cached) return cached;
    try {
      const { audio } = await this.synthesize(text, opts);
      if (audio.length > 0) this.clips.set(key, audio);
      return audio;
    } catch {
      return null;
    }
  }

  // Fire-and-forget warm-up, concurrency-capped for the same reason as the
  // ElevenLabs path: firing every clip at once competes with the live greeting's
  // own synthesis for the provider's per-key concurrency budget.
  prewarmClips(texts: string[], opts?: SynthesizeOptions) {
    const CONCURRENCY = 2;
    const queue = [...texts];
    const pump = async (): Promise<void> => {
      const text = queue.shift();
      if (text === undefined) return;
      await this.getClip(text, opts).catch(() => undefined);
      return pump();
    };
    for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i += 1) {
      void pump();
    }
  }

  // Streaming synthesis over a short-lived WebSocket, one per sentence.
  //
  // WHY WEBSOCKET AND NOT REST: the REST endpoint synthesizes the whole clip
  // before responding — measured at 2.2-4.2s per sentence, versus ElevenLabs'
  // ~200-400ms. That would make Maya feel seconds late on EVERY sentence. Over
  // the WS, audio chunks arrive as they are generated: ~210-235ms to first audio.
  //
  // WHY PER-SENTENCE AND NOT PER-TURN: the handshake was measured at ~124-312ms,
  // so a cold socket still delivers first audio in ~350-550ms — close enough to
  // ElevenLabs that it is worth keeping Gujarati on the SAME per-sentence code
  // path as hi/en, inheriting the guardrail, barge-in and cancel semantics that
  // path already has. A per-turn session would amortize the handshake but would
  // put gu on the WS-turn path, which is off by default and far less exercised.
  // (Numbers from tools/staging/sarvam-ws-smoke.js — re-run it if this regresses.)
  private streamOverWs(
    text: string,
    opts: { signal?: AbortSignal; onChunk: (chunk: Buffer) => void },
  ): Promise<{ ttfbMs: number | null; bytes: number }> {
    const cfg = this.requestConfig();
    return new Promise((resolve, reject) => {
      const url = `${SARVAM_TTS_WS_URL}?model=${encodeURIComponent(cfg.model)}&send_completion_event=true`;
      const ws = new WebSocket(url, { headers: { "api-subscription-key": cfg.key } });

      let start = Date.now();
      let ttfbMs: number | null = null;
      let bytes = 0;
      let settled = false;
      let failure: string | null = null;

      const cleanup = () => {
        clearTimeout(guard);
        opts.signal?.removeEventListener("abort", onAbort);
        try {
          ws.close();
        } catch {}
      };
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        // A failure AFTER audio has been emitted cannot be retried — those bytes
        // are already on the wire to the caller — so report what we sent.
        if (failure && bytes === 0) reject(new Error(failure));
        else resolve({ ttfbMs, bytes });
      };
      const onAbort = () => {
        // Barge-in: stop generating immediately rather than paying for audio the
        // caller will never hear.
        done();
      };

      const guard = setTimeout(() => {
        failure = failure ?? `Sarvam WS timed out after ${this.timeoutMs()}ms`;
        done();
      }, this.timeoutMs());

      if (opts.signal?.aborted) {
        cleanup();
        resolve({ ttfbMs: null, bytes: 0 });
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      ws.on("open", () => {
        start = Date.now();
        try {
          ws.send(
            JSON.stringify({
              type: "config",
              data: {
                target_language_code: "gu-IN",
                speaker: cfg.speaker,
                model: cfg.model,
                // linear16 @ 8000 = raw s16le 8kHz mono = Exotel's wire format
                // exactly, so PcmReframer consumes it with no resampling.
                output_audio_codec: "linear16",
                speech_sample_rate: "8000",
                pace: cfg.pace,
                // Omit when 0 — Sarvam rejects temperature:0 (same "valid
                // dictionary" error as an out-of-range min_buffer_size); its
                // absence is the neutral baseline delivery.
                ...(cfg.temperature > 0 ? { temperature: cfg.temperature } : {}),
                enable_preprocessing: false,
                min_buffer_size: SARVAM_MIN_BUFFER_SIZE,
                max_chunk_length: SARVAM_MAX_CHUNK_LENGTH,
                // NOTE: pitch/loudness are bulbul:v2 fields — v3 replaced them
                // with `temperature` (expressiveness). Verified accepted by v3 in
                // tools/staging/sarvam-tune-simran.js.
              },
            }),
          );
          ws.send(JSON.stringify({ type: "text", data: { text } }));
          // Without an explicit flush Sarvam waits for more text that will never
          // come (we send exactly one sentence per socket) and the turn stalls.
          ws.send(JSON.stringify({ type: "flush" }));
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
          done();
        }
      });

      ws.on("message", (raw) => {
        let msg: {
          type?: string;
          event_type?: string;
          data?: { audio?: string; message?: string; event_type?: string };
        };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return; // ignore non-JSON frames
        }
        if (msg.type === "audio" && msg.data?.audio) {
          if (ttfbMs === null) ttfbMs = Date.now() - start;
          // Only the first chunk carries a WAV header; stripWavHeader passes the
          // already-raw ones straight through.
          const pcm = stripWavHeader(Buffer.from(msg.data.audio, "base64"));
          bytes += pcm.length;
          if (!opts.signal?.aborted) opts.onChunk(pcm);
        } else if (
          msg.type === "event" &&
          (msg.event_type === "final" || msg.data?.event_type === "final")
        ) {
          done();
        } else if (msg.type === "error") {
          failure = msg.data?.message ?? "Sarvam WS error";
          done();
        }
      });

      ws.on("error", (err: Error) => {
        failure = failure ?? err.message;
        done();
      });
      ws.on("close", () => done());
    });
  }

  async synthesizeStream(
    text: string,
    opts: SynthesizeOptions & { signal?: AbortSignal; onChunk: (chunk: Buffer) => void },
  ): Promise<StreamSynthesisResult> {
    const start = Date.now();
    const normalized = normalizeForTts(text, "gu");

    let lastErr: unknown;
    // Retry once, but only while nothing has been emitted — chunks already
    // forwarded to the caller cannot be unsent. Mirrors the ElevenLabs path.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { ttfbMs, bytes } = await this.streamOverWs(normalized, opts);
        const ms = Date.now() - start;
        this.logger.log(`Sarvam WS TTS complete (${ms}ms ttfb=${ttfbMs}ms) bytes=${bytes}`);
        return { ttsMs: ms, ttfbMs, bytes };
      } catch (err) {
        lastErr = err;
        if (opts.signal?.aborted) {
          return { ttsMs: Date.now() - start, ttfbMs: null, bytes: 0 };
        }
        this.logger.warn(
          `Sarvam WS TTS attempt ${attempt + 1} failed${attempt === 0 ? " — retrying" : ""}`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
      }
    }
    this.logger.error(
      "Sarvam WS TTS failed",
      lastErr instanceof Error ? lastErr.stack : String(lastErr),
    );
    throw new ServiceUnavailableException("Sarvam synthesis failed");
  }
}

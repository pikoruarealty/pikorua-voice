import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
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

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.config.get("SARVAM_API_KEY"));
  }

  private requestConfig() {
    const key = String(this.config.get("SARVAM_API_KEY") ?? "");
    if (!key) {
      throw new ServiceUnavailableException("Sarvam API key is not configured");
    }
    // Maya is a woman — the speaker MUST be female. Bulbul ships 30+ voices;
    // which one best matches her Hindi timbre is a listening decision, not a
    // code one, so it is env-driven and deliberately has no clever default.
    const speaker = String(this.config.get("SARVAM_SPEAKER") ?? "anushka");
    const model = String(this.config.get("SARVAM_MODEL") ?? "bulbul:v3");
    // Mirrors ELEVENLABS_SPEED's intent (she reads a touch brisk). Sarvam's pace
    // range is 0.5–2.0; clamped so a bad env value can't break synthesis.
    const pace = Math.min(2.0, Math.max(0.5, Number(this.config.get("SARVAM_PACE") ?? 1.0)));
    return { key, speaker, model, pace };
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

  // Streaming-shaped API so the call runtime can treat Sarvam and ElevenLabs
  // identically.
  //
  // HONEST LIMITATION: this is NOT true streaming. It awaits the full REST
  // response and then emits it as one chunk, so ttfbMs === ttsMs — the caller
  // waits for the whole sentence rather than its first bytes. That is a real
  // latency regression versus the ElevenLabs /stream path and it is why the
  // sarvam-tts-smoke spike must run before this goes near a call: if per-sentence
  // latency is too high, the fix is Sarvam's HTTP-streaming or WebSocket endpoint,
  // which needs its own implementation (and, per the docs, may cap at 24 kHz on
  // the HTTP-streaming path — which would force a resample down to 8 kHz).
  async synthesizeStream(
    text: string,
    opts: SynthesizeOptions & { signal?: AbortSignal; onChunk: (chunk: Buffer) => void },
  ): Promise<StreamSynthesisResult> {
    const start = Date.now();
    try {
      const { audio } = await this.synthesize(text, opts);
      if (opts.signal?.aborted) {
        return { ttsMs: Date.now() - start, ttfbMs: null, bytes: 0 };
      }
      const ttfbMs = Date.now() - start;
      opts.onChunk(audio);
      const ms = Date.now() - start;
      this.logger.log(`Sarvam TTS stream complete (${ms}ms ttfb=${ttfbMs}ms) bytes=${audio.length}`);
      return { ttsMs: ms, ttfbMs, bytes: audio.length };
    } catch (err) {
      if (opts.signal?.aborted) {
        return { ttsMs: Date.now() - start, ttfbMs: null, bytes: 0 };
      }
      throw err;
    }
  }
}

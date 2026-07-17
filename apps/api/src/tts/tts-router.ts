import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ElevenlabsService,
  type SynthesizeOptions,
  type StreamSynthesisResult,
} from "./elevenlabs.service";
import { SarvamService } from "./sarvam.service";

// Routes TTS by language: Gujarati → Sarvam, everything else → ElevenLabs.
//
// WHY THIS EXISTS: ElevenLabs cannot speak Gujarati in a realtime call (see the
// header of sarvam.service.ts). One vendor cannot serve all three languages, so
// the call runtime talks to this router instead of a concrete provider.
//
// hi/en ARE UNTOUCHED. Every non-gu request delegates straight through to
// ElevenlabsService with the same arguments it received before this class
// existed. The gu branch is the only new behaviour.
//
// THE KILL SWITCH: isGujaratiEnabled() is the single gate for the whole Gujarati
// feature. When Sarvam is not configured (no SARVAM_API_KEY) or SARVAM_TTS_ENABLED
// is explicitly false, the runtime falls all the way back to the LEGACY behaviour
// — gu is treated as Hindi, exactly as it was before this work. That matters:
// once the prompt speaks Gujarati, ElevenLabs has no way to voice it, so a
// half-configured deploy must not produce a broken Gujarati call. It produces
// today's (wrong-language but working) Hindi call instead.
//
// Consequence: call-runtime.service.ts asks this router whether Gujarati is
// enabled BEFORE choosing the prompt/persona, so the prompt and the voice can
// never disagree.
@Injectable()
export class TtsRouter {
  private readonly logger = new Logger("TtsRouter");
  private warnedUnconfigured = false;

  constructor(
    private readonly elevenlabs: ElevenlabsService,
    private readonly sarvam: SarvamService,
    private readonly config: ConfigService,
  ) {}

  // Single source of truth for "is the Gujarati persona live?".
  isGujaratiEnabled(): boolean {
    if (this.config.get("SARVAM_TTS_ENABLED") === false) return false;
    if (!this.sarvam.isConfigured()) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.logger.warn(
          "SARVAM_API_KEY is not set — Gujarati (gu-IN) calls fall back to the Hindi persona. " +
            "ElevenLabs cannot speak Gujarati, so this fallback is deliberate: it preserves the " +
            "pre-existing behaviour rather than producing a broken call.",
        );
      }
      return false;
    }
    return true;
  }

  // A request is Gujarati only if the resolved language code says so. The code is
  // set by ttsLanguageCode()/replyLanguageCode() in the call runtime, which pick
  // it from the REPLY's script — so if Maya answers a gu-IN call in English
  // (because the caller switched), this correctly stays on ElevenLabs.
  private isGujarati(opts?: SynthesizeOptions): boolean {
    const code = String(opts?.languageCode ?? "");
    return code.toLowerCase().startsWith("gu") && this.isGujaratiEnabled();
  }

  async synthesize(text: string, opts?: SynthesizeOptions): Promise<{ audio: Buffer; ttsMs: number }> {
    return this.isGujarati(opts)
      ? this.sarvam.synthesize(text, opts)
      : this.elevenlabs.synthesize(text, opts);
  }

  async synthesizeStream(
    text: string,
    opts: SynthesizeOptions & { signal?: AbortSignal; onChunk: (chunk: Buffer) => void },
  ): Promise<StreamSynthesisResult> {
    return this.isGujarati(opts)
      ? this.sarvam.synthesizeStream(text, opts)
      : this.elevenlabs.synthesizeStream(text, opts);
  }

  async getClip(text: string, opts?: SynthesizeOptions): Promise<Buffer | null> {
    return this.isGujarati(opts)
      ? this.sarvam.getClip(text, opts)
      : this.elevenlabs.getClip(text, opts);
  }

  prewarmClips(texts: string[], opts?: SynthesizeOptions) {
    if (this.isGujarati(opts)) {
      this.sarvam.prewarmClips(texts, opts);
      return;
    }
    this.elevenlabs.prewarmClips(texts, opts);
  }

  // WS input-streaming is an ElevenLabs-only capability — Sarvam's WebSocket API
  // is not implemented here yet. The call runtime must not open a WS session for
  // a Gujarati turn; it guards on langMode before calling this (see
  // useWsStreaming in processUtteranceStream). Delegating unconditionally is
  // therefore safe, and keeps the hi/en path byte-identical.
  openWsSession(
    opts: SynthesizeOptions & {
      onChunk: (chunk: Buffer) => void;
      onDone: () => void;
      onError: (err: string) => void;
      signal?: AbortSignal;
    },
  ): { sendText: (text: string) => void; flush: () => void; close: () => void } {
    return this.elevenlabs.openWsSession(opts);
  }
}

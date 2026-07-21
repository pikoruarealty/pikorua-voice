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
// How long Gujarati stays collapsed to Hindi after a Sarvam failure. Long enough
// that a dead account doesn't retry on every turn of every call, short enough that
// topping up credits heals it without a redeploy.
const SARVAM_BREAKER_MS = 10 * 60 * 1000;

@Injectable()
export class TtsRouter {
  private readonly logger = new Logger("TtsRouter");
  private warnedUnconfigured = false;
  // Runtime health, which is NOT the same thing as configuration. A key that is set
  // but rejected — out of credits, revoked, rate-limited — passes isConfigured() and
  // then fails on every single synthesis. That left gu calls completely SILENT:
  // strictly worse than the wrong-language fallback this class exists to guarantee.
  // Seen in production as "WS TTS error: No credits available." on every gu turn,
  // with the caller hearing nothing at all until they hung up.
  //
  // So a runtime failure trips this breaker and Gujarati collapses to the Hindi
  // persona — the same path an unconfigured Sarvam already takes, which is tested
  // and known to produce a working (if wrong-language) call.
  private sarvamUnhealthyUntil = 0;

  constructor(
    private readonly elevenlabs: ElevenlabsService,
    private readonly sarvam: SarvamService,
    private readonly config: ConfigService,
  ) {}

  // Record that Sarvam failed for real, at request time. Idempotent within a window
  // so a burst of failures on one turn logs once, not once per sentence.
  noteSarvamFailure(reason: string) {
    const alreadyOpen = Date.now() < this.sarvamUnhealthyUntil;
    this.sarvamUnhealthyUntil = Date.now() + SARVAM_BREAKER_MS;
    if (alreadyOpen) return;
    this.logger.warn(
      `Sarvam TTS failed (${reason}) — Gujarati falls back to the Hindi persona for ` +
        `${Math.round(SARVAM_BREAKER_MS / 60000)} min. Callers hear Hindi instead of silence.`,
    );
  }

  // Single source of truth for "is the Gujarati persona live?".
  isGujaratiEnabled(): boolean {
    if (this.config.get("SARVAM_TTS_ENABLED") === false) return false;
    if (Date.now() < this.sarvamUnhealthyUntil) return false;
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

  // Every Sarvam path funnels failures through the breaker and then RETRIES ON
  // ELEVENLABS, so a dead Sarvam degrades this turn to a Hindi-voiced reply rather
  // than losing it. Subsequent turns skip Sarvam entirely (isGujaratiEnabled is
  // false while the breaker is open), so the persona and voice agree again.
  async synthesize(text: string, opts?: SynthesizeOptions): Promise<{ audio: Buffer; ttsMs: number }> {
    if (!this.isGujarati(opts)) return this.elevenlabs.synthesize(text, opts);
    try {
      return await this.sarvam.synthesize(text, opts);
    } catch (err) {
      this.noteSarvamFailure(String(err));
      return this.elevenlabs.synthesize(text, opts);
    }
  }

  async synthesizeStream(
    text: string,
    opts: SynthesizeOptions & { signal?: AbortSignal; onChunk: (chunk: Buffer) => void },
  ): Promise<StreamSynthesisResult> {
    if (!this.isGujarati(opts)) return this.elevenlabs.synthesizeStream(text, opts);
    try {
      return await this.sarvam.synthesizeStream(text, opts);
    } catch (err) {
      this.noteSarvamFailure(String(err));
      return this.elevenlabs.synthesizeStream(text, opts);
    }
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

  // Turn-level WS session, routed by language: Gujarati → Sarvam (coherent
  // whole-turn synthesis, steady pitch, human pauses), everything else →
  // ElevenLabs. A gu turn ALWAYS takes this path now (see useWsStreaming in
  // processUtteranceStream) so its reply is one coherent synthesis instead of
  // per-sentence fragments. hi/en behaviour is unchanged.
  openWsSession(
    opts: SynthesizeOptions & {
      onChunk: (chunk: Buffer) => void;
      onDone: () => void;
      onError: (err: string) => void;
      signal?: AbortSignal;
    },
  ): { sendText: (text: string) => void; flush: () => void; close: () => void } {
    if (!this.isGujarati(opts)) return this.elevenlabs.openWsSession(opts);

    // Gujarati WS turn. This is the path that went silent in production: Sarvam
    // reported "No credits available.", onError only logged, and the turn emitted no
    // audio at all. Fail over instead — buffer what the runtime sends us, and if
    // Sarvam errors before delivering a single chunk, trip the breaker and replay the
    // buffered text through ElevenLabs so the caller hears the reply (in a Hindi
    // voice) rather than nothing.
    //
    // Only a failure BEFORE the first chunk can be recovered: once audio is flowing
    // we would otherwise splice two different voices mid-sentence, so a late error is
    // still surfaced to the caller's onError.
    let failedOver = false;
    let gotChunk = false;
    let closed = false;
    const buffered: string[] = [];
    let pendingFlush = false;
    let fallback: ReturnType<ElevenlabsService["openWsSession"]> | null = null;

    const sarvamSession = this.sarvam.openWsSession({
      ...opts,
      onChunk: (chunk) => {
        gotChunk = true;
        opts.onChunk(chunk);
      },
      onError: (err) => {
        this.noteSarvamFailure(err);
        if (gotChunk || failedOver || closed) {
          opts.onError(err);
          return;
        }
        failedOver = true;
        this.logger.warn(`Sarvam WS failed before any audio — replaying this turn on ElevenLabs`);
        fallback = this.elevenlabs.openWsSession(opts);
        for (const text of buffered) fallback.sendText(text);
        if (pendingFlush) fallback.flush();
      },
    });

    return {
      sendText: (text: string) => {
        if (failedOver) {
          fallback?.sendText(text);
          return;
        }
        buffered.push(text);
        sarvamSession.sendText(text);
      },
      flush: () => {
        if (failedOver) {
          fallback?.flush();
          return;
        }
        pendingFlush = true;
        sarvamSession.flush();
      },
      close: () => {
        closed = true;
        fallback?.close();
        sarvamSession.close();
      },
    };
  }
}

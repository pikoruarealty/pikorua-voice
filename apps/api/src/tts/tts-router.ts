import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ElevenlabsService,
  type SynthesizeOptions,
  type StreamSynthesisResult,
} from "./elevenlabs.service";
import { SarvamService } from "./sarvam.service";
import { ClipLibrary } from "./clip-library";

// Routes TTS: every language → Sarvam (one voice for all three; Hindi/English
// can be moved back with TTS_PROVIDER_HI=elevenlabs). ElevenLabs is the
// automatic fallback whenever Sarvam fails or isn't configured.
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
    @Optional() private readonly clips?: ClipLibrary,
  ) {}

  // A pre-recorded take of this exact line (assets/clips), or null to synthesize.
  // Only for telephony audio (the clips are 8 kHz PCM) and only while Sarvam is
  // this request's voice — the clips are in the Sarvam voice, so while ElevenLabs
  // is speaking (rollback or Sarvam breaker) they'd splice two voices into a call.
  storedClip(text: string, opts?: SynthesizeOptions): Buffer | null {
    if (opts?.outputFormat !== "pcm_8000") return null;
    const sOpts = this.sarvamOpts(opts);
    return sOpts ? (this.clips?.get(String(sOpts.languageCode), text) ?? null) : null;
  }

  // For the status dashboard: ms until Sarvam is tried again (0 = healthy).
  sarvamBreakerOpenForMs(): number {
    return Math.max(0, this.sarvamUnhealthyUntil - Date.now());
  }

  // Record that Sarvam failed for real, at request time. Idempotent within a window
  // so a burst of failures on one turn logs once, not once per sentence.
  noteSarvamFailure(reason: string) {
    const alreadyOpen = Date.now() < this.sarvamUnhealthyUntil;
    this.sarvamUnhealthyUntil = Date.now() + SARVAM_BREAKER_MS;
    if (alreadyOpen) return;
    this.logger.warn(
      `Sarvam TTS failed (${reason}) — for ${Math.round(SARVAM_BREAKER_MS / 60000)} min ` +
        `Gujarati falls back to the Hindi persona and Hindi/English to ElevenLabs. ` +
        `Callers hear a working voice instead of silence.`,
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

  // Hindi/English on Sarvam: TTS_PROVIDER_HI=sarvam (the default), and only while
  // Sarvam is configured and healthy (same breaker as Gujarati).
  private hiEnOnSarvam(): boolean {
    return (
      (this.config.get("TTS_PROVIDER_HI") ?? "sarvam") === "sarvam" &&
      this.config.get("SARVAM_TTS_ENABLED") !== false &&
      Date.now() >= this.sarvamUnhealthyUntil &&
      this.sarvam.isConfigured()
    );
  }

  // The request's options for Sarvam (with an explicit gu/hi/en languageCode), or
  // null when it goes to ElevenLabs. The code is set by ttsLanguageCode() /
  // replyLanguageCode() in the call runtime from the REPLY's script — undefined
  // means Hindi, as it does for ElevenLabs (ELEVENLABS_LANGUAGE_CODE).
  private sarvamOpts<T extends SynthesizeOptions>(opts?: T): T | null {
    const code = String(opts?.languageCode ?? "").toLowerCase();
    let languageCode: string;
    if (code.startsWith("gu")) {
      if (!this.isGujaratiEnabled()) return null;
      languageCode = "gu";
    } else {
      if (!this.hiEnOnSarvam()) return null;
      languageCode = code.startsWith("en") ? "en" : "hi";
    }
    return { ...opts, languageCode } as T;
  }

  // Every Sarvam path funnels failures through the breaker and then RETRIES ON
  // ELEVENLABS, so a dead Sarvam degrades this turn to a Hindi-voiced reply rather
  // than losing it. Subsequent turns skip Sarvam entirely (isGujaratiEnabled is
  // false while the breaker is open), so the persona and voice agree again.
  async synthesize(text: string, opts?: SynthesizeOptions): Promise<{ audio: Buffer; ttsMs: number }> {
    const stored = this.storedClip(text, opts);
    if (stored) return { audio: stored, ttsMs: 0 };
    const sOpts = this.sarvamOpts(opts);
    if (!sOpts) return this.elevenlabs.synthesize(text, opts);
    try {
      return await this.sarvam.synthesize(text, sOpts);
    } catch (err) {
      this.noteSarvamFailure(String(err));
      return this.elevenlabs.synthesize(text, opts);
    }
  }

  async synthesizeStream(
    text: string,
    opts: SynthesizeOptions & { signal?: AbortSignal; onChunk: (chunk: Buffer) => void },
  ): Promise<StreamSynthesisResult> {
    const stored = this.storedClip(text, opts);
    if (stored) {
      if (!opts.signal?.aborted) opts.onChunk(stored);
      return { ttsMs: 0, ttfbMs: 0, bytes: stored.length };
    }
    const sOpts = this.sarvamOpts(opts);
    if (!sOpts) return this.elevenlabs.synthesizeStream(text, opts);
    try {
      return await this.sarvam.synthesizeStream(text, sOpts);
    } catch (err) {
      this.noteSarvamFailure(String(err));
      return this.elevenlabs.synthesizeStream(text, opts);
    }
  }

  // NEVER REJECTS. This is the last-resort lookup the call runtime performs from
  // INSIDE its "TTS is down" catch block: it loops over fallback lines looking for a
  // pre-warmed clip. A rejection here escapes that catch, aborts the loop on the first
  // line, skips failCall(), and replaces the original TTS error with this one — and it
  // rejects precisely when it matters, because the vendor being down is the whole
  // reason we are in that catch. Returning null lets the loop try the next line.
  async getClip(text: string, opts?: SynthesizeOptions): Promise<Buffer | null> {
    const stored = this.storedClip(text, opts);
    if (stored) return stored;
    const sOpts = this.sarvamOpts(opts);
    if (sOpts) {
      try {
        return await this.sarvam.getClip(text, sOpts);
      } catch (err) {
        this.noteSarvamFailure(String(err));
        // fall through to ElevenLabs
      }
    }
    try {
      return await this.elevenlabs.getClip(text, opts);
    } catch {
      return null;
    }
  }

  // Fire-and-forget warmup. A failure here must never surface: it is an optimisation,
  // and the caller does not await it.
  prewarmClips(texts: string[], opts?: SynthesizeOptions) {
    try {
      const sOpts = this.sarvamOpts(opts);
      if (sOpts) {
        this.sarvam.prewarmClips(texts, sOpts);
        return;
      }
      this.elevenlabs.prewarmClips(texts, opts);
    } catch (err) {
      this.logger.warn(`Clip prewarm failed (non-fatal): ${String(err)}`);
    }
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
    const sOpts = this.sarvamOpts(opts);
    if (!sOpts) return this.elevenlabs.openWsSession(opts);

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
    const buffered: string[] = [];
    let pendingFlush = false;
    let fallback: ReturnType<ElevenlabsService["openWsSession"]> | null = null;

    // EVERY Sarvam callback is gated on this. A WebSocket emits 'error' and then
    // 'close' on its own schedule, so a session we have already given up on will
    // still call back afterwards — and those late callbacks are not harmless:
    // onDone resolves the turn in the runtime and emits the last-chunk marker, so a
    // dead Sarvam's onDone arriving before the ElevenLabs fallback has streamed
    // TRUNCATES the very reply this failover exists to deliver, and a stray onChunk
    // splices dead-vendor audio into it. Verified: without this gate the runtime saw
    // onDone twice, the first one early.
    let sarvamLive = true;

    const sarvamSession = this.sarvam.openWsSession({
      ...sOpts,
      onChunk: (chunk) => {
        if (!sarvamLive) return;
        gotChunk = true;
        opts.onChunk(chunk);
      },
      onDone: () => {
        if (!sarvamLive) return;
        opts.onDone();
      },
      onError: (err) => {
        if (!sarvamLive) return;
        this.noteSarvamFailure(err);
        // Audio already went out in Sarvam's voice — failing over now would splice
        // two different voices mid-reply, so surface the error instead.
        if (gotChunk) {
          opts.onError(err);
          return;
        }
        sarvamLive = false;
        failedOver = true;
        this.logger.warn(`Sarvam WS failed before any audio — replaying this turn on ElevenLabs`);
        try {
          sarvamSession?.close();
        } catch {
          // already dead; nothing to do
        }
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
        sarvamLive = false;
        fallback?.close();
        sarvamSession.close();
      },
    };
  }
}

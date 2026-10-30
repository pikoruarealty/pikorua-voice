import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DeepgramLiveService,
  type LiveSession,
  type LiveSessionCallbacks,
  type LiveSessionOptions,
} from "./deepgram-live.service";
import { SarvamSttService } from "./sarvam-stt.service";

// Picks the live STT engine per session: STT_PROVIDER=sarvam (default, cheaper)
// or deepgram (the rollback). A Sarvam session that fails mid-call is
// replaced by a Deepgram session behind the same handle, so the call keeps
// hearing the caller — one utterance at most is lost in the swap.
//
// onSpeechStart is passed to Sarvam only. Deepgram's raw VAD start fires on a
// single voiced frame of echo, so the gateways deliberately don't use it there;
// Sarvam has no partials, so its START_SPEECH is the only early barge-in signal.
@Injectable()
export class SttRouter {
  private readonly logger = new Logger("SttRouter");

  constructor(
    private readonly deepgram: DeepgramLiveService,
    private readonly sarvam: SarvamSttService,
    private readonly config: ConfigService,
  ) {}

  provider(): "sarvam" | "deepgram" {
    return (this.config.get("STT_PROVIDER") ?? "sarvam") === "sarvam" && this.sarvam.isConfigured()
      ? "sarvam"
      : "deepgram";
  }

  openSession(
    locale: string,
    sampleRate: number,
    callbacks: LiveSessionCallbacks,
    opts: LiveSessionOptions = {},
  ): LiveSession {
    const { onSpeechStart: _vad, ...deepgramCallbacks } = callbacks;
    const openDeepgram = () => this.deepgram.openSession(locale, sampleRate, deepgramCallbacks, opts);
    if (this.provider() === "deepgram") return openDeepgram();

    let failedOver = false;
    let current: LiveSession;
    const failOver = (message: string) => {
      if (failedOver) return;
      failedOver = true;
      this.logger.warn(`Sarvam STT failed (${message}) — switching this call to Deepgram`);
      current.close();
      current = openDeepgram();
    };
    try {
      current = this.sarvam.openSession(locale, sampleRate, { ...callbacks, onError: failOver });
    } catch (err) {
      this.logger.warn(`Sarvam STT unavailable (${String(err)}) — using Deepgram`);
      return openDeepgram();
    }

    return {
      sendAudio: (chunk) => current.sendAudio(chunk),
      clearBuffer: () => current.clearBuffer(),
      setEndpointing: (ms) => current.setEndpointing(ms),
      close: () => current.close(),
    };
  }
}

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DeepgramLiveService,
  type LiveSession,
  type LiveSessionCallbacks,
  type LiveSessionOptions,
} from "./deepgram-live.service";
import { FluxLiveService } from "./flux-live.service";
import { MetricsService } from "../metrics/metrics.service";
import { parseFluxLocales, resolveSttProvider } from "./stt-routing";

// Chooses the live STT provider per call and exposes the same openSession()
// signature as DeepgramLiveService, so the gateways stay provider-agnostic.
//
// Policy (see stt-routing.ts): Nova-3 is the universal default and serves every
// locale (the only path for Gujarati/Tamil/Telugu/Marathi). Flux is opt-in for
// en/hi via STT_FLUX_LOCALES, where its built-in turn detection shaves turn
// latency. Nova-3 is also the connect-time FALLBACK: if the Flux session fails
// permanently, this router transparently re-opens the call on Nova-3 so a Flux
// outage never drops the call.
//
// Rollback: set STT_FLUX_LOCALES empty ⇒ every call uses Nova-3, no code change.
@Injectable()
export class SttRouterService {
  private readonly logger = new Logger("SttRouterService");

  constructor(
    private readonly config: ConfigService,
    private readonly deepgramLive: DeepgramLiveService,
    private readonly fluxLive: FluxLiveService,
    private readonly metrics: MetricsService,
  ) {}

  private fluxLocales(): Set<string> {
    return parseFluxLocales(String(this.config.get("STT_FLUX_LOCALES") ?? ""));
  }

  openSession(
    locale: string,
    sampleRate: number,
    callbacks: LiveSessionCallbacks,
    opts: LiveSessionOptions = {},
  ): LiveSession {
    const provider = resolveSttProvider(locale, this.fluxLocales());
    this.metrics.increment("pikorua_stt_sessions_total", { provider });

    if (provider === "nova-3") {
      return this.deepgramLive.openSession(locale, sampleRate, callbacks, opts);
    }

    // Flux primary with a Nova-3 connect-time fallback. `active` points at the
    // session currently receiving audio; on permanent Flux failure we swap it for
    // a fresh Nova-3 session wired to the caller's original callbacks.
    let failedOver = false;
    const fluxCallbacks: LiveSessionCallbacks = {
      ...callbacks,
      onError: (message) => {
        if (failedOver) {
          callbacks.onError(message);
          return;
        }
        failedOver = true;
        this.metrics.increment("pikorua_stt_failover_total", { from: "flux", to: "nova-3" });
        this.logger.warn(
          `Flux STT failed for locale=${locale} (${message}) — failing over to Nova-3`,
        );
        try {
          active.close();
        } catch {}
        active = this.deepgramLive.openSession(locale, sampleRate, callbacks, opts);
      },
    };

    let active: LiveSession = this.fluxLive.openSession(locale, sampleRate, fluxCallbacks, opts);

    // Delegate every call to whichever session is currently active. After a
    // failover, `active` is the Nova-3 session — including for close().
    return {
      sendAudio: (chunk) => active.sendAudio(chunk),
      clearBuffer: () => active.clearBuffer(),
      setEndpointing: (ms) => active.setEndpointing(ms),
      close: () => active.close(),
    };
  }
}

// Shared STT provider-selection logic. Used by BOTH the SttRouterService (to
// pick which live STT to open per call) and CallRuntimeService (to label turn
// metrics with the provider). Keeping the decision in one pure function means
// the metric label can never disagree with the session that was actually opened.

export type SttProvider = "flux" | "nova-3";

// Locales Flux can actually serve for this product. Flux's multilingual set
// covers English + Hindi (and 8 others) but NOT Gujarati/Tamil/Telugu/Marathi,
// which Nova-3 handles. This is a hard guard: even if STT_FLUX_LOCALES is
// misconfigured with an unsupported locale (e.g. "gu-IN"), the router will still
// send it to Nova-3 rather than to a Flux model that cannot transcribe it.
const FLUX_ELIGIBLE = new Set(["en", "hi"]);

// The base language subtag ("en-IN" → "en"). Deepgram model routing keys off
// the language, not the region.
export function baseLang(locale: string): string {
  return locale.toLowerCase().split("-")[0];
}

// Parse STT_FLUX_LOCALES (comma-separated BCP-47 locales, e.g. "en-IN,hi-IN")
// into a set of base language subtags. Empty/unset ⇒ empty set ⇒ every locale
// uses Nova-3 — this is the instant rollback switch for the Flux experiment.
export function parseFluxLocales(raw: string | undefined | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => baseLang(s.trim()))
      .filter(Boolean),
  );
}

// Decide the STT provider for a call. Flux only when the locale is BOTH enabled
// via config AND Flux-eligible; otherwise Nova-3 (the universal default/fallback).
export function resolveSttProvider(locale: string, fluxLocales: Set<string>): SttProvider {
  const base = baseLang(locale);
  return fluxLocales.has(base) && FLUX_ELIGIBLE.has(base) ? "flux" : "nova-3";
}

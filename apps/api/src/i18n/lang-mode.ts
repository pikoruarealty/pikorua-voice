// Which language *persona* a call runs in. This is the prompt/greeting/vocabulary
// axis — NOT the same thing as the TTS `language_code` (see ttsLanguageCode in
// call-runtime.service.ts), which stays locale-driven because the two have
// genuinely different fallbacks for non-hi/en/gu locales.
//
// HISTORY: before this module, Gujarati was an *alias* for Hindi — every language
// branch in the codebase was spelled `startsWith("hi") || startsWith("gu")`. A
// gu-IN call therefore listened in Gujarati (Deepgram `gu`) but answered in
// Hindi, with the Hindi prompt, Hindi greeting, and Devanagari TTS respellings.
// Resolving a mode once, here, is what makes gu a real third language.
export type LangMode = "hi" | "en" | "gu";

// Maps a BCP-47 locale to its persona mode.
//
// The `default → "en"` arm is deliberate and load-bearing: it reproduces the
// exact semantics of the old isHinglishLocale(), which returned false for every
// locale except hi*/gu*. So ta/te/mr calls keep getting the English persona they
// get today. Do NOT "fix" this to default to hi — that would silently change
// behaviour for the regional locales dgLanguage() already routes.
export function resolveLangMode(locale: string | null | undefined): LangMode {
  const l = String(locale ?? "").toLowerCase();
  if (l.startsWith("gu")) return "gu";
  if (l.startsWith("hi")) return "hi";
  return "en";
}

// Pick one of three per-mode values. The total Record<LangMode, T> is deliberate:
// adding a fourth language becomes a compile error at every call site rather than
// a silent fallthrough to English.
export function pickByLangMode<T>(locale: string, choices: Record<LangMode, T>): T {
  return choices[resolveLangMode(locale)];
}

// Unicode block tests. A reply's script is a more reliable signal than the call
// locale for picking number-word language, because the model follows the CLIENT's
// language (see the LANGUAGE rule in the system prompt) and may answer a gu-IN
// call entirely in English if the caller switched.
const DEVANAGARI_RE = /[ऀ-ॿ]/; // hi
const GUJARATI_RE = /[઀-૿]/; // gu

export function hasDevanagari(text: string): boolean {
  return DEVANAGARI_RE.test(text);
}

export function hasGujarati(text: string): boolean {
  return GUJARATI_RE.test(text);
}

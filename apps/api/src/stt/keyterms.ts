// Local project/area proper nouns and property terms that Deepgram otherwise
// mangles or drops — most notably the "Ambli-Bopal Road" area and "bungalow".
//
// Used by DeepgramLiveService for Nova-3 Keyterm Prompting. Nova-3 keyterm takes
// terms verbatim — no `:intensifier` suffix (that was Nova-2's `keywords`) — and
// supports multi-word phrases directly.
//
// TWO SCRIPTS, ON PURPOSE. In `multi`/multilingual mode Deepgram emits Hindi
// speech in Devanagari and English-spoken words in Latin. A caller naming an
// area in English ("Vaishnodevi") produces a Latin token; the SAME area named
// inside a Hindi sentence produces a Devanagari token ("वैष्णोदेवी"). A Latin
// keyterm does NOT bias the Devanagari output, so Hindi-spoken area names were
// being dropped/mangled. We therefore list each proper noun in BOTH scripts.
// The Devanagari spellings mirror the exact forms the prompt uses in
// call-runtime.service.ts (which is what the model was trained-adjacent to emit).
// THE URL IS THE BINDING CONSTRAINT. Every keyterm is appended to the Deepgram
// WebSocket URL as its own query param (see deepgram-live.service.ts), and
// Devanagari/Gujarati characters cost ~9 bytes each once percent-encoded. Deepgram
// rejects the upgrade with HTTP 400 — killing STT for the ENTIRE call, with only a
// generic "Unexpected server response: 400" to go on — once that request line grows
// past ~4 KB, the classic 4096-byte limit.
//
// MEASURED, NOT GUESSED: a 56-term list built a 2,582-byte URL and connected fine;
// growing it to 94 terms built a 4,406-byte URL that 400'd on every attempt and every
// reconnect, and callers reached a Maya who could not hear a word. Both numbers are
// real, from this repo. Treat ~4 KB as a wall, not a guideline.
//
// So this list is ORDERED BY VALUE and then CAPPED IN CODE (see withinBudget below).
// Order matters: the cap keeps the leading terms and drops the tail, so anything
// added at the end is the first thing sacrificed. Put inventory micro-markets first
// and nice-to-haves last.
//
// EVERY INVENTORY MICRO-MARKET IS LISTED IN ITS COMMON SPOKEN VARIANTS, not just its
// canonical spelling — a keyterm only biases the form it actually spells, so
// "Sindhu Bhavan" does nothing for a caller who says "Sindhubhavan" as one word.
// Variants are limited to forms callers genuinely use; speculative respellings are
// not worth their bytes.
export const PROPER_NOUN_KEYTERMS = [
  // ── Inventory micro-markets, Latin. Ambli-Bopal is the most-named and the
  // most-often mis-heard, so it keeps every spoken form.
  "Ambli", "Bopal", "Ambli-Bopal Road", "Ambli Bopal Road", "Ambli-Bopal", "Ambli Bopal",
  "South Bopal", "Iskcon", "Iskon", "Iskcon Cross Road", "Iskcon Ambli", "Iskon Ambli",
  "Sindhu", "Bhavan", "Sindhu Bhavan", "Sindhu Bhavan Road", "Sindhubhavan", "SBR",
  "Rajpath", "Rangoli", "Rajpath Rangoli",
  "Thaltej", "Vastrapur", "Nehrunagar", "Nehru Nagar",
  "Vaishnodevi", "Vaishno Devi", "Gota",
  "Shilaj", "Nandoli", "Bodakdev", "Bodak Dev",
  "bungalow", "bungalows", "penthouse", "duplex",
  // ── Devanagari — the same names spoken inside Hindi (Hinglish callers).
  "अंबली", "बोपल", "अंबली बोपल", "अंबली-बोपल", "अंबली बोपल रोड", "अंबली-बोपल रोड",
  "सिंधु भवन", "सिंधु भवन रोड", "राजपथ", "रंगोली", "राजपथ रंगोली",
  "थलतेज", "वस्त्रापुर", "नेहरूनगर", "नेहरू नगर", "वैष्णोदेवी", "वैष्णो देवी", "गोता",
  "इस्कॉन", "बोडकदेव", "शिलज", "नंदोली", "बंगला",
  // ── LOWEST VALUE, INTENTIONALLY LAST: areas a caller may name when asked where
  // they LIVE. The prompt tells Maya to acknowledge any such area with one warm word
  // and never repeat it back, so mis-hearing one costs almost nothing — these are the
  // right terms to lose first if the budget tightens. Latin only; the Devanagari
  // spellings cost ~9 bytes/char and are not worth it for a name never spoken back.
  "Naroda", "Maninagar", "Satellite", "Chandkheda", "Prahlad Nagar",
  "Navrangpura", "Paldi", "Motera",
] as const;

// Gujarati-script spellings of the same proper nouns, for `language=gu` sessions.
//
// SAME REASONING AS THE DEVANAGARI SET, DIFFERENT SCRIPT: Deepgram's `gu` model
// emits Gujarati speech in Gujarati script, so a Latin keyterm ("Thaltej") does
// not bias the Gujarati token ("થલતેજ"). Both scripts are needed because Gujarati
// callers code-switch heavily — the area name may arrive in either script
// depending on whether it was said inside a Gujarati or an English clause.
//
// The spellings mirror the exact forms used in i18n/prompt-gu.ts and the
// GU_TTS_RESPELLINGS table in tts/elevenlabs.service.ts. Change one, change all three.
// Ordered by value, same as PROPER_NOUN_KEYTERMS — the budget cap drops the tail.
const GUJARATI_KEYTERMS = [
  "અંબલી", "બોપલ", "અંબલી બોપલ", "અંબલી-બોપલ", "અંબલી બોપલ રોડ", "અંબલી-બોપલ રોડ",
  "સિંધુ ભવન", "સિંધુ ભવન રોડ", "રાજપથ", "રંગોલી", "રાજપથ રંગોલી",
  "થલતેજ", "વસ્ત્રાપુર", "નેહરુનગર", "નેહરુ નગર", "વૈષ્ણોદેવી", "વૈષ્ણો દેવી", "ગોતા",
  "ઇસ્કોન", "બોડકદેવ", "શિલજ", "નંદોલી", "બંગલો",
  // Lowest value, intentionally last — see the note in PROPER_NOUN_KEYTERMS.
  "નરોડા", "મણિનગર", "સેટેલાઇટ", "ચાંદખેડા", "પ્રહલાદ નગર", "નવરંગપુરા",
  "પાલડી", "મોટેરા", "અમદાવાદ",
] as const;

// Latin-only subset: proper nouns + the English property terms that appear inside
// an otherwise-Gujarati sentence ("budget", "site visit", "BHK"). Nova-3's `multi`
// code-switch set does NOT include Gujarati, so a `gu` session is standalone and
// the embedded English is exactly what it is weakest on — biasing these terms is
// the main mitigation available. (See dgLanguage() in deepgram-live.service.ts.)
const GU_LATIN_KEYTERMS = [
  "Ambli", "Bopal", "Ambli-Bopal Road", "Ambli Bopal Road", "South Bopal", "Iskcon", "Iskon",
  "bungalow", "penthouse", "duplex",
  "Sindhu", "Bhavan", "Sindhu Bhavan Road", "Sindhubhavan", "SBR", "Rajpath", "Rangoli",
  "Thaltej", "Vastrapur", "Nehrunagar", "Nehru Nagar", "Vaishnodevi", "Vaishno Devi", "Gota",
  "Shilaj", "Nandoli", "Bodakdev", "Bodak Dev", "Satellite", "Prahlad Nagar",
  "BHK", "budget", "site visit", "sample apartment", "Ready to Move In",
] as const;

// Keyterms for a session, chosen by the Deepgram `language` the session opened
// with. Sending Devanagari terms to a `gu` session is dead weight — those tokens
// can never appear in its output — and vice versa.
//
// hi/en route to `multi`, which emits Hindi in Devanagari and English in Latin,
// so that path keeps the combined Latin+Devanagari list it has always used. This
// function returns the EXACT same array for multi, so hi/en behaviour is unchanged.
// Maximum keyterms we will send. This number is EMPIRICAL, not derived — Deepgram
// does not document the limit, and probing this account showed it is not a simple
// function of anything we control:
//
//   84 of these terms  -> 400        83 -> OK
//   119 single-word terms -> OK      120 -> 400
//   90 two-word terms  -> OK         91  -> 400
//   40 long Devanagari terms (a 5,044-byte URL) -> OK
//
// So byte size is NOT the limit (an earlier fix here assumed it was, and was wrong),
// and neither term count nor word count alone explains the boundary either. Since
// the safe size cannot be computed, this cap is simply set well below the smallest
// observed failure for a list of THIS shape (84), leaving room to grow without
// re-probing. It is a seatbelt, not a proof.
//
// The real protection is downstream: DeepgramLiveService drops keyterms entirely and
// reconnects if the upgrade is refused, so even a wrong number here degrades
// transcription quality instead of taking STT down. See its `keytermsDisabled` path.
const MAX_KEYTERMS = 72;

// Keep terms in order until the cap, then stop. Both lists are ordered
// most-valuable-first precisely so truncation sheds the cheapest terms — the
// residence-area names at the tail, which the prompt never repeats back anyway.
function capped(terms: readonly string[]): string[] {
  return terms.slice(0, MAX_KEYTERMS);
}

// Deduped before capping: a duplicate would consume one of the limited slots.
export function keytermsFor(dgLanguage: string): readonly string[] {
  if (dgLanguage === "gu") {
    return capped([...new Set([...GU_LATIN_KEYTERMS, ...GUJARATI_KEYTERMS])]);
  }
  return capped([...new Set(PROPER_NOUN_KEYTERMS)]);
}

// Exported for the test that pins the cap. Not used at runtime.
export const MAX_KEYTERMS_FOR_TEST = MAX_KEYTERMS;

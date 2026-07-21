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
// EVERY INVENTORY MICRO-MARKET IS LISTED IN ITS COMMON SPOKEN VARIANTS, not just
// its canonical spelling. Callers compress, respell, and mis-stress these names
// constantly ("Sindhubhavan", "SBR", "Vaishno Devi", "Bodak Dev", "Nehru Nagar"),
// and a keyterm only biases the form it actually spells — "Sindhu Bhavan" does
// nothing for a caller who says "Sindhubhavan" as one word. Variants are chosen
// from forms real callers use; this is deliberately NOT a combinatorial expansion,
// because every term is appended to the Deepgram WebSocket URL as a query param
// (see deepgram-live.service.ts) and Devanagari/Gujarati characters cost ~9 bytes
// each once percent-encoded. Keep the built URL comfortably under ~8 KB — past
// that the upgrade request risks being rejected outright and STT dies for the
// whole call. Measure before adding a large batch.
export const PROPER_NOUN_KEYTERMS = [
  // Latin — biases English-spoken proper nouns and property terms.
  // Ambli-Bopal is the most-named area and the most-often mis-heard — list it in
  // every spoken form (hyphenated, spaced, with/without "Road").
  "Ambli", "Bopal", "Ambli-Bopal Road", "Ambli Bopal Road", "Ambli-Bopal", "Ambli Bopal",
  "Ambali", "Amli", "South Bopal", "Bopal Road",
  "Iskcon", "Iskon", "Iskcon Cross Road", "Iskcon Ambli", "Iskon Ambli",
  "bungalow", "bungalows", "penthouse", "duplex",
  "Sindhu", "Bhavan", "Sindhu Bhavan", "Sindhu Bhavan Road", "Sindhubhavan", "Sindhu Bhawan", "SBR",
  "Rajpath", "Rangoli", "Rajpath Rangoli", "Rajpath Club",
  "Thaltej", "Thaltej Road", "Vastrapur", "Vastrapur Lake",
  "Nehrunagar", "Nehru Nagar", "Vaishnodevi", "Vaishno Devi", "Gota", "Gota Cross Road",
  "Shilaj", "Shilaj Circle", "Shelaj", "Nandoli", "Bodakdev", "Bodak Dev",
  // Residence areas a caller may say when asked where they live (not inventory
  // micro-markets) — most-often mis-heard, so bias them too.
  "Naroda", "Maninagar", "Satellite", "Chandkheda", "Prahlad Nagar",
  "Navrangpura", "Paldi", "Motera",
  // Devanagari — biases the same names when spoken inside Hindi (Hinglish callers).
  "वैष्णोदेवी", "वैष्णो देवी", "थलतेज", "थलतेज रोड", "वस्त्रापुर", "वस्त्रापुर लेक",
  "नेहरूनगर", "नेहरू नगर", "गोता", "गोता क्रॉस रोड",
  "सिंधु भवन", "सिंधु भवन रोड", "सिंधुभवन", "राजपथ", "रंगोली", "राजपथ रंगोली",
  "अंबली", "आंबली", "अम्बली", "बोपल", "साउथ बोपल",
  "अंबली बोपल", "अंबली-बोपल", "अंबली बोपल रोड", "अंबली-बोपल रोड",
  "इस्कॉन", "इस्कॉन क्रॉस रोड", "इस्कॉन अंबली",
  "नरोडा", "मणिनगर", "सैटेलाइट", "चांदखेड़ा", "प्रह्लाद नगर", "नवरंगपुरा",
  "बोडकदेव", "शिलज", "शीलज", "नंदोली", "बंगला",
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
const GUJARATI_KEYTERMS = [
  "થલતેજ", "થલતેજ રોડ", "વસ્ત્રાપુર", "વસ્ત્રાપુર લેક", "નેહરુનગર", "નેહરુ નગર",
  "વૈષ્ણોદેવી", "વૈષ્ણો દેવી", "ગોતા", "ગોતા ક્રોસ રોડ",
  "સિંધુ ભવન", "સિંધુ ભવન રોડ", "સિંધુભવન", "રાજપથ", "રંગોલી", "રાજપથ રંગોલી",
  "અંબલી", "આંબલી", "બોપલ", "સાઉથ બોપલ",
  "અંબલી બોપલ", "અંબલી-બોપલ", "અંબલી બોપલ રોડ", "અંબલી-બોપલ રોડ",
  "ઇસ્કોન", "ઇસ્કોન ક્રોસ રોડ", "ઇસ્કોન અંબલી",
  "બોડકદેવ", "શિલજ", "શીલજ", "નંદોલી", "બંગલો",
  // Residence areas a caller may name when asked where they live.
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
// Deduped: a repeated term is pure waste in the URL budget described above, and
// the two gu lists can legitimately overlap as they grow.
export function keytermsFor(dgLanguage: string): readonly string[] {
  if (dgLanguage === "gu") return [...new Set([...GU_LATIN_KEYTERMS, ...GUJARATI_KEYTERMS])];
  return [...new Set(PROPER_NOUN_KEYTERMS)];
}

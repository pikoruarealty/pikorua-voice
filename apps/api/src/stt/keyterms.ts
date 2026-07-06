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
export const PROPER_NOUN_KEYTERMS = [
  // Latin — biases English-spoken proper nouns and property terms.
  "Ambli", "Bopal", "Ambli-Bopal Road", "Iskcon",
  "bungalow", "bungalows", "penthouse", "duplex",
  "Sindhu", "Bhavan", "Rajpath", "Rangoli",
  "Thaltej", "Vastrapur", "Nehrunagar", "Vaishnodevi", "Gota",
  "Shilaj", "Nandoli", "Bodakdev",
  // Devanagari — biases the same names when spoken inside Hindi (Hinglish callers).
  "वैष्णोदेवी", "थलतेज", "वस्त्रापुर", "नेहरूनगर", "गोता",
  "सिंधु भवन", "राजपथ", "रंगोली", "अंबली", "बोपल",
  "बोडकदेव", "शिलज", "नंदोली", "बंगला",
] as const;

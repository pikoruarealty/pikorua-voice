// Local project/area proper nouns and property terms that Deepgram otherwise
// mangles or drops — most notably the "Ambli-Bopal Road" area and "bungalow".
//
// Shared by DeepgramLiveService (Nova-3 Keyterm Prompting) and FluxLiveService
// (multilingual biasing) so the two boost lists never drift. Nova-3 keyterm
// takes terms verbatim — no `:intensifier` suffix (that was Nova-2's `keywords`)
// — and supports multi-word phrases directly.
//
// Terms are Latin-scripted. In `multi`/multilingual mode Hindi is emitted in
// Devanagari, but English words / proper nouns spoken in English stay Latin, so
// the Latin keyterms bias correctly. Whether area names spoken *in Hindi* also
// need Devanagari keyterms is a live-A/B question (see deepgram-keyword-ab.js);
// add them only once confirmed to match the model's exact output tokens.
export const PROPER_NOUN_KEYTERMS = [
  "Ambli", "Bopal", "Ambli-Bopal Road", "Iskcon",
  "bungalow", "bungalows", "penthouse", "duplex",
  "Sindhu", "Bhavan", "Rajpath", "Rangoli",
  "Thaltej", "Vastrapur", "Nehrunagar", "Vaishnodevi", "Gota",
  "Shilaj", "Nandoli", "Bodakdev",
] as const;

/**
 * TTS text normalization tests.
 * Run with: pnpm build && node --test tools/tests/tts-normalization.test.js
 *
 * Behaviour these tests pin (see normalizeForTts in elevenlabs.service.ts):
 *  - BHK counts are ALWAYS spoken in English number words ("5 BHK" -> "five BHK"),
 *    even in Hindi mode — the property type "BHK" is English and a Hindi numeral
 *    against it sounds unnatural. (Matches the system-prompt BHK rule.)
 *  - Area figures (square feet / square yards) ALWAYS speak the NUMBER in English
 *    words, even in Hindi mode ("4,800 square feet" -> "four thousand eight
 *    hundred ..."), for the same reason as BHK. In Hindi mode the *unit* is still
 *    respelled to Devanagari ("स्क्वेयर फीट") for correct pronunciation.
 *  - CLOCK TIMES NEVER MIX LANGUAGES. A spoken time is either fully local or fully
 *    English — never "eleven बजे" and never "ग्यारह AM":
 *      Hinglish/Gujarati -> "ग्यारह बजे" / "અગિયાર વાગ્યે"  (number AND unit local)
 *      English           -> "eleven AM"                      (number AND unit English)
 *    A WHOLE hour is a scheduling time and takes the local बजे/વાગ્યે form (so
 *    "4 PM" -> "चार बजे" in Hinglish). A time WITH minutes is a precise clock
 *    reading (answering "what time is it now?") and reads in English words
 *    ("11:30 AM" -> "eleven thirty AM") — still unmixed. In English mode a stray
 *    "baje" becomes "o'clock" so it can never produce "two baje".
 *  - Distances always speak the number AND unit in English, in both modes
 *    ("3 km" -> "three kilometers") — the Hindi engine mangles "km" and reads the
 *    number in Hindi.
 *  - The "see you at N" sign-off speaks an English number in both modes
 *    ("see you at 4" -> "see you at four").
 */
const assert = require("node:assert/strict");
const test = require("node:test");

test("area measurements: English number + Devanagari unit in Hindi-mode TTS", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // BHK count -> English words; area figure -> English words; unit -> Devanagari.
  assert.equal(
    normalizeForTts("5BHK approx 7,600 square feet", "hi"),
    "five BHK approx seven thousand six hundred स्क्वेयर फीट",
  );
  assert.equal(
    normalizeForTts("4BHK approx 5,700 sq ft", "hi-IN"),
    "four BHK approx five thousand seven hundred स्क्वेयर फीट",
  );
  assert.equal(
    normalizeForTts("The carpet is 5700 sq. feet.", "hi-IN"),
    "The carpet is five thousand seven hundred स्क्वेयर फीट.",
  );
  // A two-number range keeps the Hindi connector but both figures go English.
  assert.equal(
    normalizeForTts("approx 5,500 से 11,000 square feet", "hi"),
    "approx five thousand five hundred से eleven thousand स्क्वेयर फीट",
  );
});

test("area measurements use English number words outside Hindi-mode TTS", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // English mode: BHK and area both spoken in English words.
  assert.equal(
    normalizeForTts("5BHK approx 7,600 square feet", "en"),
    "five BHK approx seven thousand six hundred square feet",
  );
  // Square yards range in English mode.
  assert.equal(
    normalizeForTts("700 to 2,100 square yards", "en"),
    "seven hundred to two thousand one hundred square yards",
  );
});

test("romanized Hindi fragments are normalized in Hindi-mode TTS", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // The time NUMBER is spoken in English even in the local "N बजे" form
  // ("3 बजे" -> "three बजे"); only the digit is Englished, the unit word stays.
  assert.equal(
    normalizeForTts("बिल्कुल, 3 बजे। Jo clients interest dikhate hain.", "hi-IN"),
    "बिल्कुल, तीन बजे। जो clients interest दिखाते हैं.",
  );
  assert.equal(
    normalizeForTts("Aaj 2 baje convenient rahega?", "hi-IN"),
    "आज दो बजे convenient रहेगा?",
  );
  // English mode must never emit the MIXED "two baje" — the local time-unit word
  // becomes "o'clock" so the whole time reads in one language.
  assert.equal(
    normalizeForTts("Aaj 2 baje convenient rahega?", "en-IN"),
    "Aaj two o'clock convenient rahega?",
  );
});

test("English-mode clock times read as English words (Eleven AM)", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // Spelled out rather than left as digits, so it always reads "nine AM" and is
  // never at the engine's mercy.
  assert.equal(
    normalizeForTts("Our office is open 9 AM to 6 PM", "en"),
    "Our office is open nine AM to six PM",
  );
  assert.equal(normalizeForTts("Call me at 9AM", "en"), "Call me at nine AM");
  // A number that merely precedes a word starting with "am" is NOT a time.
  assert.equal(normalizeForTts("9 American homes", "en"), "nine American homes");
});

test("distances speak the number + unit in English in both modes", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // Hindi mode: the engine mangles "km" and reads the number in Hindi, so the
  // whole distance is spelled in English ("3 km" -> "three kilometers").
  assert.equal(
    normalizeForTts("शिलज Circle से सिर्फ 3 km, Ready to Move In।", "hi"),
    "शिलज Circle से सिर्फ three kilometers, Ready to Move In।",
  );
  // Singular unit for exactly 1 km.
  assert.equal(normalizeForTts("सिर्फ 1 km दूर।", "hi"), "सिर्फ one kilometer दूर।");
  // One-decimal distance.
  assert.equal(
    normalizeForTts("करीब 3.5 km दूर।", "hi"),
    "करीब three point five kilometers दूर।",
  );
  // Hyphenated range.
  assert.equal(
    normalizeForTts("nearest is Thaltej (~7-8 km)", "hi"),
    "nearest is Thaltej (~seven to eight kilometers)",
  );
  // English mode: same English rendering.
  assert.equal(
    normalizeForTts("just 3 km from Shilaj Circle", "en"),
    "just three kilometers from Shilaj Circle",
  );
});

test("dates speak the day number in English in both modes", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // "20 July" -> "twenty July" (not the Hindi "बीस July"); the बजे time number is
  // English too ("11 बजे" -> "eleven बजे").
  assert.equal(
    normalizeForTts("5 July, 11 बजे सुबह — confirm कर रही हूँ।", "hi"),
    "five July, ग्यारह बजे सुबह — confirm कर रही हूँ।",
  );
  assert.equal(normalizeForTts("आपकी visit July 20 को है।", "hi"), "आपकी visit July twenty को है।");
  // Ordinal suffix drops to a cardinal ("5th July" -> "five July").
  assert.equal(
    normalizeForTts("5th July at 11 in the morning.", "en"),
    "five July at eleven in the morning.",
  );
  // A 4-digit year is left as digits, not treated as a day.
  assert.equal(normalizeForTts("possession July 2026 में है।", "hi"), "possession July 2026 में है।");
});

test("durations in minutes speak the number in English in both modes", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // "30 minutes" reads "thirty minutes" — not the Hindi "तीस minutes".
  assert.equal(
    normalizeForTts("visit करीब 30 minutes की होती है।", "hi"),
    "visit करीब thirty minutes की होती है।",
  );
  assert.equal(
    normalizeForTts("the visit takes about 30 minutes.", "en"),
    "the visit takes about thirty minutes.",
  );
  // Singular, and the Devanagari unit form both fold to English.
  assert.equal(normalizeForTts("bas 1 minute।", "hi"), "bas one minute।");
  assert.equal(normalizeForTts("करीब 30 मिनट।", "hi"), "करीब thirty minutes।");
});

test("clock times never mix languages — fully local in Hinglish, fully English in English", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // A time WITH minutes is a precise clock reading (answering "what time is it
  // now?") and reads in English words — unmixed. Minutes 1-9 read "oh N".
  assert.equal(
    normalizeForTts("अभी 3:02 PM हो रहा है।", "hi"),
    "अभी three oh two PM हो रहा है।",
  );
  assert.equal(
    normalizeForTts("अभी 11:30 AM हो रहा है।", "hi"),
    "अभी eleven thirty AM हो रहा है।",
  );
  // A WHOLE hour is a scheduling time → fully Hindi "N बजे", never "three PM".
  assert.equal(normalizeForTts("आपका 3:00 PM का slot।", "hi"), "आपका तीन बजे का slot।");
  assert.equal(normalizeForTts("4 PM ठीक रहेगा।", "hi"), "चार बजे ठीक रहेगा।");
  // English mode: the same time is fully English.
  assert.equal(
    normalizeForTts("It is 3:02 PM right now.", "en"),
    "It is three oh two PM right now.",
  );
  // The scheduling "N बजे" form is fully Hindi — number AND unit word. It must
  // never become the mixed "eleven बजे".
  assert.equal(
    normalizeForTts("बिल्कुल, 11 बजे सुबह convenient रहेगा?", "hi"),
    "बिल्कुल, ग्यारह बजे सुबह convenient रहेगा?",
  );
});

test("Gujarati appointment times are FULLY Gujarati — number and unit word", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // Never the mixed "eleven વાગ્યે" — the figure reads in Gujarati too.
  assert.equal(
    normalizeForTts("11 વાગ્યે સવારે કે 5 વાગ્યે સાંજે?", "gu"),
    "અગિયાર વાગ્યે સવારે કે પાંચ વાગ્યે સાંજે?",
  );
  // The "see you at N" sign-off stays an English number by design (it is an
  // English phrase, so it is unmixed English).
  assert.equal(
    normalizeForTts("4 વાગ્યાની appointment — see you at 4.", "gu"),
    "ચાર વાગ્યાની appointment — see you at four.",
  );
});

test("'see you at N' sign-off uses an English number in both modes", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // Even inside a Hindi-context sign-off, "see you at 4" reads in English.
  assert.equal(
    normalizeForTts("Rahul Sir, see you at 4. Thank you.", "hi"),
    "Rahul Sir, see you at four. Thank you.",
  );
  assert.equal(
    normalizeForTts("ठीक है, see you at 11. Thank you.", "hi"),
    "ठीक है, see you at eleven. Thank you.",
  );
  // A colon/AM-PM form after "see you at" is left to the clock rules.
  assert.equal(
    normalizeForTts("see you at 4:30 PM. Thank you.", "hi"),
    "see you at four thirty PM. Thank you.",
  );
});

test("crore normalizes to the correctly-voiced form in every mode", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // GUJARATI: Bulbul mis-voices the Gujarati word કરોડ as "કરોધ" but reads the LATIN
  // "crore" correctly (chosen by ear). The gu prompt writes anchors as "કરોડ", so
  // the script word AND the "Cr" abbreviation must both land on Latin "crore".
  assert.equal(normalizeForTts("3 કરોડ", "gu"), "ત્રણ crore");
  assert.equal(
    normalizeForTts("5 કરોડ, 10 કરોડ, 15 કરોડ", "gu"),
    "પાંચ crore, દસ crore, પંદર crore",
  );
  assert.equal(normalizeForTts("કરોડો", "gu"), "crore");
  assert.equal(normalizeForTts("around 5 Cr", "gu"), "around પાંચ crore");
  assert.equal(normalizeForTts("2 CR", "gu"), "બે crore");
  // gu must NEVER emit the mis-voiced Gujarati કરોડ back out.
  assert.ok(!normalizeForTts("3 કરોડ", "gu").includes("કરોડ"));
  assert.ok(!normalizeForTts("5 Cr", "gu").includes("કરોડ"));

  // HINDI keeps the Devanagari word (ElevenLabs voices करोड़ fine) — unchanged.
  assert.equal(normalizeForTts("5 Cr", "hi"), "पाँच करोड़");
  assert.equal(normalizeForTts("3 करोड़", "hi"), "तीन करोड़");
  // ENGLISH reads the word natively.
  assert.equal(normalizeForTts("5 Cr", "en"), "five crore");

  // The full word and the abbreviation must land on the SAME spoken form.
  assert.equal(normalizeForTts("5 Cr", "gu"), normalizeForTts("5 crore", "gu"));
  assert.equal(normalizeForTts("5 Cr", "hi"), normalizeForTts("5 crore", "hi"));
  // Must NOT fire inside ordinary words that merely start with "cr".
  assert.equal(normalizeForTts("Cricket", "gu"), "Cricket");
  assert.equal(normalizeForTts("describe the microwave", "gu"), "describe the microwave");
});

test("the rupee sign is dropped from spoken amounts in every mode", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // "₹" has no spoken form; the unit word carries the meaning. The engine otherwise
  // voices "rupee" mid-figure or glitches on the symbol.
  assert.equal(normalizeForTts("₹2 Cr", "gu"), "બે crore");
  assert.equal(normalizeForTts("₹2 Cr", "hi"), "दो करोड़");
  assert.equal(normalizeForTts("₹5 crore", "en"), "five crore");
  assert.equal(normalizeForTts("₹ 3 crore", "gu"), "ત્રણ crore");
});

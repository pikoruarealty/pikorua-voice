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
 *  - Standalone numbers in a Hindi-context reply (e.g. a "X बजे" time) are spoken
 *    in Hindi words ("3 बजे" -> "तीन बजे") — speaking a scheduling time aloud in
 *    Hindi is the natural reading for a Hindi call.
 *  - Distances always speak the number AND unit in English, in both modes
 *    ("3 km" -> "three kilometers") — the Hindi engine mangles "km" and reads the
 *    number in Hindi.
 *  - Clock times (H:MM / with AM/PM) speak in English WORDS in Hindi mode
 *    ("3:02 PM" -> "three oh two PM") so the Hindi engine doesn't read the digits
 *    in Hindi; in English mode they stay as digits ("9 AM" -> "9 AM", read in
 *    English natively). This is distinct from the "N बजे" scheduling form above.
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

  // Hindi-context times are spoken in Hindi number words ("3 बजे" -> "तीन बजे").
  assert.equal(
    normalizeForTts("बिल्कुल, 3 बजे। Jo clients interest dikhate hain.", "hi-IN"),
    "बिल्कुल, तीन बजे। जो clients interest दिखाते हैं.",
  );
  assert.equal(
    normalizeForTts("Aaj 2 baje convenient rahega?", "hi-IN"),
    "आज दो बजे convenient रहेगा?",
  );
  // English mode leaves romanized Hindi alone but still words English numbers.
  assert.equal(
    normalizeForTts("Aaj 2 baje convenient rahega?", "en-IN"),
    "Aaj two baje convenient rahega?",
  );
});

test("clock times with AM/PM stay as digits (spaced and unspaced)", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // The model emits the spaced form "9 AM"; it must not become "nine AM".
  assert.equal(
    normalizeForTts("Our office is open 9 AM to 6 PM", "en"),
    "Our office is open 9 AM to 6 PM",
  );
  assert.equal(normalizeForTts("Call me at 9AM", "en"), "Call me at 9AM");
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

  // "20 July" -> "twenty July" (not the Hindi "बीस July"); बजे time stays Hindi.
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

test("clock times speak in English words in Hindi mode, digits in English mode", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // Hindi mode: the engine reads bare digits in Hindi, so a clock time is spelled
  // out in English words. Minutes 1-9 read "oh N"; :00 drops the minute.
  assert.equal(
    normalizeForTts("अभी 3:02 PM हो रहा है।", "hi"),
    "अभी three oh two PM हो रहा है।",
  );
  assert.equal(
    normalizeForTts("अभी 11:30 AM हो रहा है।", "hi"),
    "अभी eleven thirty AM हो रहा है।",
  );
  assert.equal(normalizeForTts("आपका 3:00 PM का slot।", "hi"), "आपका three PM का slot।");
  assert.equal(normalizeForTts("4 PM ठीक रहेगा।", "hi"), "four PM ठीक रहेगा।");
  // English mode: clock times stay as digits (the engine reads them in English).
  assert.equal(normalizeForTts("It is 3:02 PM right now.", "en"), "It is 3:02 PM right now.");
  // The scheduling "N बजे" form is NOT a clock time — it stays in Hindi words.
  assert.equal(
    normalizeForTts("बिल्कुल, 11 बजे सुबह convenient रहेगा?", "hi"),
    "बिल्कुल, ग्यारह बजे सुबह convenient रहेगा?",
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

test("crore abbreviation 'Cr'/'CR' expands to the spoken word in every mode", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // The script writes budgets as "5 Cr". Left in Latin the engine mis-voices the
  // letters — on Gujarati calls this was heard as "કરોધ". It must read as the crore
  // word: करोड़ (hi) / કરોડ (gu) / "crore" (en).
  assert.equal(normalizeForTts("around 5 Cr", "gu"), "around પાંચ કરોડ");
  assert.equal(normalizeForTts("2 CR", "gu"), "બે કરોડ");
  assert.equal(normalizeForTts("5 Cr", "hi"), "पाँच करोड़");
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
  assert.equal(normalizeForTts("₹2 Cr", "gu"), "બે કરોડ");
  assert.equal(normalizeForTts("₹2 Cr", "hi"), "दो करोड़");
  assert.equal(normalizeForTts("₹5 crore", "en"), "five crore");
  assert.equal(normalizeForTts("₹ 3 crore", "gu"), "ત્રણ કરોડ");
});

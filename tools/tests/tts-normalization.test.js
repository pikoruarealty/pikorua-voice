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
 *    in Hindi words ("3 बजे" -> "तीन बजे") — speaking a clock time aloud in Hindi
 *    is the natural reading for a Hindi call.
 *  - Clock times written with AM/PM stay as digits ("9 AM" -> "9 AM").
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
    normalizeForTts("The unit is 7600 sqft.", "gu-IN"),
    "The unit is seven thousand six hundred स्क्वेयर फीट.",
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

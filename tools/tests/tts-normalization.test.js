/**
 * TTS text normalization tests.
 * Run with: pnpm build && node --test tools/tests/tts-normalization.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");

test("area measurements are pronounced cleanly in Hindi-mode TTS", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  assert.equal(
    normalizeForTts("5BHK approx 7,600 square feet", "hi"),
    "5BHK approx सात हज़ार छह सौ स्क्वेयर फीट",
  );
  assert.equal(
    normalizeForTts("4BHK approx 5,700 sq ft", "hi-IN"),
    "4BHK approx पाँच हज़ार सात सौ स्क्वेयर फीट",
  );
  assert.equal(
    normalizeForTts("The unit is 7600 sqft.", "gu-IN"),
    "The unit is सात हज़ार छह सौ स्क्वेयर फीट.",
  );
  assert.equal(
    normalizeForTts("The carpet is 5700 sq. feet.", "hi-IN"),
    "The carpet is पाँच हज़ार सात सौ स्क्वेयर फीट.",
  );
});

test("area measurements use English number words outside Hindi-mode TTS", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  assert.equal(
    normalizeForTts("5BHK approx 7,600 square feet", "en"),
    "5BHK approx seven thousand six hundred square feet",
  );
});

test("romanized Hindi fragments are normalized in Hindi-mode TTS", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  assert.equal(
    normalizeForTts("बिल्कुल, 3 बजे। Jo clients interest dikhate hain.", "hi-IN"),
    "बिल्कुल, 3 बजे। जो clients interest दिखाते हैं.",
  );
  assert.equal(
    normalizeForTts("Aaj 2 baje convenient rahega?", "hi-IN"),
    "आज 2 बजे convenient रहेगा?",
  );
  assert.equal(
    normalizeForTts("Aaj 2 baje convenient rahega?", "en-IN"),
    "Aaj 2 baje convenient rahega?",
  );
});

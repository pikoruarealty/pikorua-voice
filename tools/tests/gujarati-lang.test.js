/**
 * Gujarati language-mode tests.
 * Run with: pnpm build && node --test tools/tests/gujarati-lang.test.js
 *
 * WHY THIS FILE EXISTS: Gujarati used to be an ALIAS for Hindi. Every language
 * branch was spelled `startsWith("hi") || startsWith("gu")`, so a gu-IN call
 * listened in Gujarati (Deepgram `gu`) but answered in Hindi, with the Hindi
 * prompt and Devanagari TTS respellings. These tests pin the de-aliasing so it
 * cannot silently regress:
 *
 *  1. resolveLangMode maps gu → "gu", hi → "hi", and — load-bearing — every
 *     OTHER locale (en/ta/te/mr) → "en", reproducing the old isHinglishLocale()
 *     semantics exactly so the regional locales keep the persona they have today.
 *  2. normalizeForTts in gu mode NEVER emits Devanagari. This is the one that
 *     matters most: the old isHindiMode() returned true for gu and ran the
 *     Devanagari tables over Gujarati text, mixing two scripts in one sentence.
 *  3. The rules that force ENGLISH on every call (BHK, areas, distances,
 *     durations, dates, clock times) apply identically in gu mode.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const DEVANAGARI = /[ऀ-ॿ]/;
const GUJARATI = /[઀-૿]/;

test("resolveLangMode: gu is its own mode, not a Hindi alias", () => {
  const { resolveLangMode } = require("../../apps/api/dist/i18n/lang-mode");

  assert.equal(resolveLangMode("gu-IN"), "gu");
  assert.equal(resolveLangMode("gu"), "gu");
  assert.equal(resolveLangMode("GU-in"), "gu");
  assert.equal(resolveLangMode("hi-IN"), "hi");
  assert.equal(resolveLangMode("en-IN"), "en");
});

test("resolveLangMode: non-hi/gu locales resolve to en (preserves old isHinglishLocale)", () => {
  const { resolveLangMode } = require("../../apps/api/dist/i18n/lang-mode");

  // The old isHinglishLocale() returned false for these, so they got the ENGLISH
  // persona. That must not change just because a third mode was added.
  for (const locale of ["ta-IN", "te-IN", "mr-IN", "bn-IN", "", null, undefined]) {
    assert.equal(resolveLangMode(locale), "en", `locale ${locale} should map to en`);
  }
});

test("script detection distinguishes Gujarati from Devanagari", () => {
  const { hasGujarati, hasDevanagari } = require("../../apps/api/dist/i18n/lang-mode");

  assert.equal(hasGujarati("તમારું budget કેટલું છે?"), true);
  assert.equal(hasDevanagari("તમારું budget કેટલું છે?"), false);
  assert.equal(hasDevanagari("आपका budget कितना है?"), true);
  assert.equal(hasGujarati("आपका budget कितना है?"), false);
  assert.equal(hasGujarati("Plain English only"), false);
  assert.equal(hasDevanagari("Plain English only"), false);
});

test("gu-mode TTS never emits Devanagari", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // The regression that motivated all of this: gu used to hit the Devanagari path.
  const out = normalizeForTts("5 crore, 3 lakh, bungalow in Ambli, Ahmedabad", "gu-IN");
  assert.ok(!DEVANAGARI.test(out), `gu output must not contain Devanagari: ${out}`);
  assert.ok(GUJARATI.test(out), `gu output should contain Gujarati script: ${out}`);
  assert.match(out, /કરોડ/);
  assert.match(out, /લાખ/);
  assert.match(out, /બંગલો/);
  assert.match(out, /અંબલી/);
  assert.match(out, /અમદાવાદ/);
});

test("gu-mode respells area units in Gujarati, not Devanagari", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  const out = normalizeForTts("The unit is 7600 sqft.", "gu-IN");
  // Area FIGURE stays English (same rule as Hindi mode); the UNIT is Gujarati.
  assert.equal(out, "The unit is seven thousand six hundred સ્ક્વેર ફીટ.");
  assert.ok(!DEVANAGARI.test(out));
});

test("gu-mode keeps BHK/areas/distances/durations/dates in English words", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // Identical expectations to Hindi mode — these rules are language-independent.
  assert.equal(
    normalizeForTts("5BHK approx 7,600 square feet", "gu-IN"),
    "five BHK approx seven thousand six hundred સ્ક્વેર ફીટ",
  );
  assert.match(normalizeForTts("3 km દૂર", "gu-IN"), /three kilometers/);
  assert.match(normalizeForTts("visit 30 minutes ની છે", "gu-IN"), /thirty minutes/);
  assert.match(normalizeForTts("20 July", "gu-IN"), /twenty July/);
  // Clock times go to English words in gu mode, exactly as in Hindi mode.
  assert.match(normalizeForTts("3:02 PM", "gu-IN"), /three oh two PM/);
  assert.match(normalizeForTts("see you at 4", "gu-IN"), /see you at four/);
});

test("gu-mode speaks a scheduling hour in Gujarati words", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // The "N વાગ્યે" scheduling form reads naturally as a Gujarati word, mirroring
  // Hindi's "तीन बजे". This is the one place gu uses native number words.
  const out = normalizeForTts("3 વાગ્યે", "gu-IN");
  assert.equal(out, "ત્રણ વાગ્યે");
  assert.ok(!DEVANAGARI.test(out));
});

test("hi mode is unchanged by the gu split (no regression)", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // Hindi must behave exactly as before: Devanagari respellings, Hindi numbers.
  assert.equal(
    normalizeForTts("5BHK approx 7,600 square feet", "hi"),
    "five BHK approx seven thousand six hundred स्क्वेयर फीट",
  );
  assert.equal(normalizeForTts("3 बजे", "hi"), "तीन बजे");
  assert.match(normalizeForTts("5 crore bungalow", "hi"), /करोड़/);
  assert.ok(!GUJARATI.test(normalizeForTts("5 crore bungalow", "hi")));
});

test("en mode is unchanged by the gu split (no regression)", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  const out = normalizeForTts("5BHK approx 7,600 square feet", "en");
  assert.equal(out, "five BHK approx seven thousand six hundred square feet");
  assert.ok(!DEVANAGARI.test(out));
  assert.ok(!GUJARATI.test(out));
  // The "take care" hard-block still applies outside Hindi mode.
  assert.match(normalizeForTts("Take care!", "en"), /Thank you\./);
});

test("the internal-pricing backstop is script-independent (fires on Gujarati text)", () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");
  const svc = new GuardrailService({ get: () => undefined });

  // This is what actually protects prices on a gu call. The pricing_claim rule is
  // English-phrase-based, but the ₹<digit> / [internal] backstop matches on shape,
  // not language — so Gujarati inherits the real mechanical protection unchanged.
  const leaks = [
    "આ residence ની કિંમત ₹5 કરોડ છે.",
    "સિંધુ ભવન રોડ: 4 BHK, ₹3+ Cr [internal]",
    "કિંમત ₹ 8 કરોડ",
  ];
  for (const leak of leaks) {
    const r = svc.checkHard(leak);
    assert.equal(r.triggered, true, `should catch leak: ${leak}`);
    assert.equal(r.rule, "internal_pricing_leak");
  }

  // A legitimate Gujarati reply that names spoken budget tiers must NOT trigger —
  // no ₹ sign, no marker. This is the false-positive guard.
  const safe = svc.checkHard(
    "તમે roughly કયા budget માં comfortable છો? જેમ કે 3 કરોડ, 5 કરોડ, કે 10 કરોડ.",
  );
  assert.equal(safe.triggered, false, "spoken tiers must not trigger the backstop");
});

// Builds a minimal WAV around `pcm`, optionally with an extra chunk before
// `data` — which real encoders emit and a naive 44-byte slice would corrupt.
function makeWav(pcm, { extraChunk = false } = {}) {
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(8000, 12);
  fmt.writeUInt32LE(16000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);

  const chunks = [fmt];
  if (extraChunk) {
    const list = Buffer.alloc(8 + 10);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(10, 4);
    chunks.push(list);
  }
  const dataHdr = Buffer.alloc(8);
  dataHdr.write("data", 0, "ascii");
  dataHdr.writeUInt32LE(pcm.length, 4);
  chunks.push(dataHdr, pcm);

  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, body]);
}

test("stripWavHeader yields exactly the PCM samples Exotel expects", () => {
  const { stripWavHeader } = require("../../apps/api/dist/tts/sarvam.service");

  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff, 0xfe]);

  // A 44-byte header fed to PcmReframer is audible noise, not silence — so the
  // strip must be exact, not approximate.
  assert.deepEqual(stripWavHeader(makeWav(pcm)), pcm);

  // Walks the chunk table rather than assuming 44 bytes: a LIST chunk before
  // `data` would defeat a fixed offset.
  assert.deepEqual(stripWavHeader(makeWav(pcm, { extraChunk: true })), pcm);

  // Already-raw PCM must pass through untouched (the streaming path may not wrap).
  assert.deepEqual(stripWavHeader(pcm), pcm);

  // Degenerate input must not throw — a dropped call is worse than bad audio.
  assert.doesNotThrow(() => stripWavHeader(Buffer.alloc(0)));
  assert.doesNotThrow(() => stripWavHeader(Buffer.from([0x52, 0x49])));
});

test("take care is hard-blocked in every mode including gu", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  for (const code of ["hi", "en", "gu"]) {
    assert.match(
      normalizeForTts("Okay, take care.", code),
      /Thank you\./,
      `take care must be blocked in ${code} mode`,
    );
  }
});

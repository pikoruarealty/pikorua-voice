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
const fs = require("node:fs");
const path = require("node:path");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8");

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
  // crore is the deliberate EXCEPTION: Bulbul mis-voices the Gujarati કરોડ as
  // "કરોધ", so gu mode keeps the LATIN word "crore" (chosen by ear) and must never
  // respell it to Gujarati. Every OTHER Indian word below IS respelled to Gujarati.
  assert.match(out, /\bcrore\b/);
  assert.ok(!out.includes("કરોડ"), `crore must stay Latin in gu mode: ${out}`);
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
  // The sign-off keeps an English DIGIT in every language, gu included.
  assert.equal(normalizeForTts("see you at 4", "gu-IN"), "see you at 4");
});

test("gu-mode appointment hour is FULLY Gujarati — number and unit word", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // A spoken time must never mix languages: "3 વાગ્યે" -> "ત્રણ વાગ્યે", never the
  // mixed "three વાગ્યે". (English mode gets the fully-English "three PM" instead.)
  const out = normalizeForTts("3 વાગ્યે", "gu-IN");
  assert.equal(out, "ત્રણ વાગ્યે");
  assert.ok(!DEVANAGARI.test(out));
});

test("hi mode is unchanged by the gu split (no regression)", () => {
  const { normalizeForTts } = require("../../apps/api/dist/tts/elevenlabs.service");

  // Hindi respellings/number-wording behave as before (Devanagari respellings,
  // Hindi number words for general figures).
  assert.equal(
    normalizeForTts("5BHK approx 7,600 square feet", "hi"),
    "five BHK approx seven thousand six hundred स्क्वेयर फीट",
  );
  // Appointment-hour rule applies in hi too, fully local: "3 बजे" -> "तीन बजे",
  // never the mixed "three बजे".
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

// ─── TTS routing ─────────────────────────────────────────────────────────────

test("TtsRouter and both providers are registered in CallRuntimeModule", () => {
  // A missing provider here is a boot-time DI failure that no unit test catches.
  const src = read("apps/api/src/call-runtime/call-runtime.module.ts");
  for (const provider of ["TtsRouter", "SarvamService", "ElevenlabsService"]) {
    assert.match(src, new RegExp(`\\b${provider}\\b`), `${provider} must be a provider`);
  }
});

test("nothing injects a concrete TTS provider directly — all go through TtsRouter", () => {
  // The router is only load-bearing if every consumer actually uses it. An
  // injection of ElevenlabsService would silently bypass Gujarati routing.
  for (const file of [
    "apps/api/src/call-runtime/call-runtime.service.ts",
    "apps/api/src/call-runtime/exotel-voicebot.gateway.ts",
    "apps/api/src/call-runtime/demo-voice.gateway.ts",
  ]) {
    const src = read(file);
    assert.match(src, /tts:\s*TtsRouter/, `${file} must inject TtsRouter`);
    assert.doesNotMatch(
      src,
      /tts:\s*(ElevenlabsService|SarvamService)/,
      `${file} must not inject a concrete TTS provider`,
    );
  }
});

test("Gujarati turns always use the WS-turn path, routed to Sarvam (not ElevenLabs)", () => {
  // Gujarati now uses a turn-level WS session for ONE coherent synthesis (steady
  // pitch, human pauses). Two invariants keep it correct:
  //  1. the runtime forces the WS path for gu (not gated on TTS_WS_STREAMING_ENABLED);
  //  2. TtsRouter.openWsSession routes gu to SARVAM — ElevenLabs cannot speak it.
  const runtime = read("apps/api/src/call-runtime/call-runtime.service.ts");
  assert.match(
    runtime,
    /useWsStreaming\s*=\s*[\s\S]{0,120}?langMode\(locale\)\s*===\s*"gu"/,
    "useWsStreaming must be forced on for gu",
  );

  const router = read("apps/api/src/tts/tts-router.ts");
  // Assert the ROUTING INVARIANT, not one particular expression shape: non-gu leaves
  // immediately for ElevenLabs, and the gu path opens a Sarvam session. (The gu branch
  // wraps that session to fail over if Sarvam dies — see the breaker — so this is
  // deliberately not pinned to a ternary.)
  const wsBody = router.match(/openWsSession\([\s\S]*?\n {2}\}/);
  assert.ok(wsBody, "could not locate TtsRouter.openWsSession");
  assert.match(
    wsBody[0],
    /if\s*\(!this\.isGujarati\(opts\)\)\s*return this\.elevenlabs\.openWsSession/,
    "non-Gujarati must go straight to ElevenLabs",
  );
  assert.match(
    wsBody[0],
    /this\.sarvam\.openWsSession\(/,
    "TtsRouter.openWsSession must route gu to Sarvam",
  );
});

test("SarvamService exposes a turn-level openWsSession", () => {
  const src = read("apps/api/src/tts/sarvam.service.ts");
  assert.match(src, /openWsSession\(/, "Sarvam must implement openWsSession");
  // It must feed multiple text frames into one socket (sendText) and finalise
  // with flush — that is what makes the whole reply one coherent synthesis.
  assert.match(src, /sendText:/);
  assert.match(src, /flush:/);
  assert.match(src, /type:\s*"flush"/);
});

function makeRouter(env = {}) {
  const { TtsRouter } = require("../../apps/api/dist/tts/tts-router");
  const calls = { elevenlabs: [], sarvam: [] };
  const fakeEleven = {
    synthesize: async (t) => (calls.elevenlabs.push(t), { audio: Buffer.alloc(2), ttsMs: 1 }),
    synthesizeStream: async (t) => (calls.elevenlabs.push(t), { ttsMs: 1, ttfbMs: 1, bytes: 2 }),
    getClip: async (t) => (calls.elevenlabs.push(t), Buffer.alloc(2)),
    prewarmClips: (ts) => calls.elevenlabs.push(...ts),
  };
  const fakeSarvam = {
    isConfigured: () => Boolean(env.SARVAM_API_KEY),
    synthesize: async (t) => (calls.sarvam.push(t), { audio: Buffer.alloc(2), ttsMs: 1 }),
    synthesizeStream: async (t) => (calls.sarvam.push(t), { ttsMs: 1, ttfbMs: 1, bytes: 2 }),
    getClip: async (t) => (calls.sarvam.push(t), Buffer.alloc(2)),
    prewarmClips: (ts) => calls.sarvam.push(...ts),
  };
  const config = { get: (k) => env[k] };
  return { router: new TtsRouter(fakeEleven, fakeSarvam, config), calls };
}

test("router sends Gujarati to Sarvam and everything else to ElevenLabs", async () => {
  const { router, calls } = makeRouter({ SARVAM_API_KEY: "sk-test" });

  await router.synthesize("ગુજરાતી", { languageCode: "gu" });
  await router.synthesize("हिंदी", { languageCode: undefined });
  await router.synthesize("English", { languageCode: "en" });

  assert.deepEqual(calls.sarvam, ["ગુજરાતી"]);
  assert.deepEqual(calls.elevenlabs, ["हिंदी", "English"]);
});

test("router: an English reply on a gu call still goes to ElevenLabs", async () => {
  // replyLanguageCode picks the code from the REPLY's script, so if the caller
  // switches to English mid-call Maya's English answer must not go to the
  // Gujarati engine.
  const { router, calls } = makeRouter({ SARVAM_API_KEY: "sk-test" });
  await router.synthesize("Certainly, which budget?", { languageCode: "en" });
  assert.deepEqual(calls.sarvam, []);
  assert.equal(calls.elevenlabs.length, 1);
});

test("BREAKER: a Sarvam that FAILS falls back to Hindi instead of going silent", async () => {
  // Configuration is not health. A key that is set but rejected — out of credits,
  // revoked, rate-limited — passes isConfigured() and then fails every synthesis.
  // Observed in production as "WS TTS error: No credits available." on every gu turn,
  // with the caller hearing NOTHING until they hung up. That is strictly worse than
  // the wrong-language fallback this router exists to guarantee, so a runtime failure
  // must collapse gu to the Hindi persona just like a missing key does.
  const { TtsRouter } = require("../../apps/api/dist/tts/tts-router");
  const calls = { elevenlabs: [], sarvam: [] };
  const fakeEleven = {
    synthesize: async (t) => (calls.elevenlabs.push(t), { audio: Buffer.alloc(2), ttsMs: 1 }),
    synthesizeStream: async (t) => (calls.elevenlabs.push(t), { ttsMs: 1, ttfbMs: 1, bytes: 2 }),
    getClip: async (t) => (calls.elevenlabs.push(t), Buffer.alloc(2)),
    prewarmClips: (ts) => calls.elevenlabs.push(...ts),
    openWsSession: () => ({ sendText() {}, flush() {}, close() {} }),
  };
  const fakeSarvam = {
    isConfigured: () => true, // key IS set — it just doesn't work
    synthesize: async (t) => {
      calls.sarvam.push(t);
      throw new Error("No credits available.");
    },
    synthesizeStream: async () => { throw new Error("No credits available."); },
    getClip: async () => null,
    prewarmClips: () => {},
    openWsSession: () => ({ sendText() {}, flush() {}, close() {} }),
  };
  const router = new TtsRouter(fakeEleven, fakeSarvam, { get: () => undefined });

  assert.equal(router.isGujaratiEnabled(), true, "healthy Sarvam starts enabled");

  // The failing turn is not lost — it comes back voiced by ElevenLabs.
  const out = await router.synthesize("ગુજરાતી લખાણ", { languageCode: "gu" });
  assert.ok(out.audio.length > 0, "a Sarvam failure must still produce audio");
  assert.equal(calls.sarvam.length, 1, "Sarvam was attempted");
  assert.equal(calls.elevenlabs.length, 1, "and ElevenLabs covered for it");

  // And the breaker is now open, so the persona collapses to Hindi for later turns
  // rather than re-attempting a vendor known to be down.
  assert.equal(router.isGujaratiEnabled(), false, "a failure must trip the breaker");
  await router.synthesize("ગુજરાતી ફરી", { languageCode: "gu" });
  assert.equal(calls.sarvam.length, 1, "must not retry a Sarvam known to be failing");
  assert.equal(calls.elevenlabs.length, 2);
});

test("KILL SWITCH: no SARVAM_API_KEY disables Gujarati entirely", async () => {
  // The deploy-safety property. With no key, ElevenLabs cannot voice Gujarati —
  // so the whole persona must collapse back to the legacy Hindi alias rather
  // than send an unsupported language_code and break the call.
  const { router, calls } = makeRouter({});

  assert.equal(router.isGujaratiEnabled(), false);

  // Even an explicit gu request must NOT reach Sarvam (it isn't configured) and
  // must fall through to ElevenLabs.
  await router.synthesize("ગુજરાતી", { languageCode: "gu" });
  assert.deepEqual(calls.sarvam, [], "must not call an unconfigured Sarvam");
  assert.equal(calls.elevenlabs.length, 1);
});

test("KILL SWITCH: SARVAM_TTS_ENABLED=false disables Gujarati even with a key", async () => {
  const { router, calls } = makeRouter({ SARVAM_API_KEY: "sk-test", SARVAM_TTS_ENABLED: false });

  assert.equal(router.isGujaratiEnabled(), false);
  await router.synthesize("ગુજરાતી", { languageCode: "gu" });
  assert.deepEqual(calls.sarvam, []);
  assert.equal(calls.elevenlabs.length, 1);
});

test("router: Gujarati enabled only when key present and not disabled", () => {
  assert.equal(makeRouter({ SARVAM_API_KEY: "sk-test" }).router.isGujaratiEnabled(), true);
  assert.equal(
    makeRouter({ SARVAM_API_KEY: "sk-test", SARVAM_TTS_ENABLED: true }).router.isGujaratiEnabled(),
    true,
  );
  assert.equal(makeRouter({}).router.isGujaratiEnabled(), false);
});

test("router routes clips and prewarm by language too", async () => {
  const { router, calls } = makeRouter({ SARVAM_API_KEY: "sk-test" });

  await router.getClip("સમજી ગઈ.", { languageCode: "gu" });
  await router.getClip("Perfect.", { languageCode: "en" });
  router.prewarmClips(["હા, બિલકુલ."], { languageCode: "gu" });
  router.prewarmClips(["Certainly."], { languageCode: "en" });

  assert.deepEqual(calls.sarvam, ["સમજી ગઈ.", "હા, બિલકુલ."]);
  assert.deepEqual(calls.elevenlabs, ["Perfect.", "Certainly."]);
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

test("pcmToWav wraps PCM in a valid 8kHz mono 16-bit header (browser demo path)", () => {
  const { pcmToWav, stripWavHeader } = require("../../apps/api/dist/tts/sarvam.service");

  const pcm = Buffer.alloc(1000, 0x11);
  const wav = pcmToWav(pcm);

  // A browser <audio>/decodeAudioData needs this container — raw PCM stays silent.
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 8000, "8kHz");
  assert.equal(wav.readUInt16LE(34), 16, "16-bit");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data chunk size matches PCM");
  assert.equal(wav.length, 44 + pcm.length);

  // The header the demo adds is exactly what stripWavHeader removes — so the
  // telephony path (which strips) and the browser path (which wraps) are inverses.
  assert.deepEqual(stripWavHeader(wav), pcm);
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

// Maya-gu is a GUJARATI-ONLY persona. She used to carry the shared "match the
// client's language" rule, so an English-speaking caller got an English reply —
// read out by Sarvam/Simran, the only voice a gu call has. That is the "Gujarati
// Maya speaking Hinglish" bug. Language changes are handled one level up now
// (gateway detects → adoptLocaleSwitch hands over to the hi/en persona + Gargi),
// so this prompt must never tell her to follow the caller into another language.
test("the Gujarati persona never switches language itself", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const gu = fs.readFileSync(
    path.resolve(__dirname, "../../apps/api/src/i18n/prompt-gu.ts"),
    "utf8",
  );

  // The old switch-away instructions must be gone.
  assert.ok(
    !/બાકીના આખા call માટે સંપૂર્ણપણે English માં જવાબ આપો/.test(gu),
    "prompt-gu must not tell Maya to answer entirely in English",
  );
  assert.ok(
    !/જો તેઓ Hindi બોલે, તો Hindi માં જ જવાબ આપો/.test(gu),
    "prompt-gu must not tell Maya to answer in Hindi",
  );
  // ...and replaced by an explicit Gujarati-only rule.
  assert.match(gu, /તમે ફક્ત Gujarati માં જ વાત કરો છો/);
  assert.match(gu, /જાતે ભાષા ન બદલો/);
});

// The mirror invariant: ElevenLabs/Gargi CANNOT speak Gujarati, so the hi/en
// persona must never be told to follow a caller into Gujarati — that would emit
// Gujarati script into a voice physically unable to say it.
test("the hi/en persona is fenced off from Gujarati", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const runtime = fs.readFileSync(
    path.resolve(__dirname, "../../apps/api/src/call-runtime/call-runtime.service.ts"),
    "utf8",
  );
  assert.match(
    runtime,
    /GUJARATI IS NOT YOURS: never reply in Gujarati/,
    "the hi/en prompt must explicitly forbid replying in Gujarati",
  );
});

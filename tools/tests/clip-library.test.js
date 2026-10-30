/**
 * Pre-recorded clip library (assets/clips) invariants.
 *
 * Run with: pnpm build && node --test tools/tests/clip-library.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ClipLibrary } = require("../../apps/api/dist/tts/clip-library");
const { pcmToWav } = require("../../apps/api/dist/tts/sarvam.service");

const library = (dir) => new ClipLibrary({ get: (k) => (k === "CLIPS_DIR" ? dir : undefined) });
const realLibrary = () => new ClipLibrary({ get: () => undefined });

// Render a greeting from the real code, without booting Nest.
function greeting(locale, scriptRef = "default") {
  const { CallRuntimeService } = require("../../apps/api/dist/call-runtime/call-runtime.service");
  const svc = Object.create(CallRuntimeService.prototype);
  svc.config = { get: () => undefined };
  svc.tts = { isGujaratiEnabled: () => true };
  return svc.greetingText({ locale, scriptRef, apptWhen: null });
}

test("every greeting the code speaks has a recorded take (wording in sync)", () => {
  const lib = realLibrary();
  for (const [lang, locale] of [["hi", "hi-IN"], ["gu", "gu-IN"], ["en", "en-IN"]]) {
    for (const scriptRef of ["default", "feedback", "reconfirm"]) {
      assert.ok(
        lib.get(lang, greeting(locale, scriptRef)),
        `${lang}/${scriptRef}: no clip matches the greeting text in code — regenerate it`,
      );
    }
  }
});

test("greeting takes rotate: never the same take twice in a row", () => {
  const lib = realLibrary();
  const text = greeting("hi-IN");
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < 200; i++) {
    const take = lib.get("hi", text);
    assert.notEqual(take, prev, "same take on consecutive calls");
    seen.add(take);
    prev = take;
  }
  assert.ok(seen.size >= 2, "several takes are in rotation");
});

test("unknown text or the wrong language is never served from a clip", () => {
  const lib = realLibrary();
  assert.equal(lib.get("hi", "कोई और वाक्य जो रिकॉर्ड नहीं है।"), null);
  assert.equal(lib.get("en", greeting("hi-IN")), null, "a Hindi line is not an English clip");
});

test("deleted takes and malformed WAVs are skipped; a missing folder is fine", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clips-"));
  const pcm = Buffer.alloc(1600, 1);
  fs.writeFileSync(path.join(dir, "hi_x_1.wav"), pcmToWav(pcm, 8000));
  fs.writeFileSync(path.join(dir, "hi_x_2.wav"), pcmToWav(pcm, 16000)); // wrong rate
  fs.writeFileSync(
    path.join(dir, "clips.json"),
    JSON.stringify({ hi_x_1: "जी।", hi_x_2: "जी।", hi_x_3: "जी।" }), // _3 was deleted
  );
  const lib = library(dir);
  for (let i = 0; i < 10; i++) assert.deepEqual(lib.get("hi", "जी।"), pcm);
  assert.equal(library(path.join(dir, "nope")).get("hi", "जी।"), null);
});

test("the router serves a clip only for telephony audio while Sarvam is the voice", async () => {
  const { TtsRouter } = require("../../apps/api/dist/tts/tts-router");
  const pcm = Buffer.alloc(320, 7);
  const clips = { get: (lang, text) => (lang === "hi" && text === "जी।" ? pcm : null) };
  let sarvamCalls = 0;
  const sarvam = {
    isConfigured: () => true,
    synthesizeStream: async () => (sarvamCalls++, { ttsMs: 1, ttfbMs: 1, bytes: 0 }),
  };
  const eleven = { synthesizeStream: async () => ({ ttsMs: 1, ttfbMs: 1, bytes: 0 }) };
  const make = (env) => new TtsRouter(eleven, sarvam, { get: (k) => env[k] }, clips);

  const router = make({ SARVAM_API_KEY: "sk" });
  const got = [];
  const res = await router.synthesizeStream("जी।", { outputFormat: "pcm_8000", onChunk: (c) => got.push(c) });
  assert.deepEqual(got, [pcm]);
  assert.equal(res.ttsMs, 0);
  assert.equal(sarvamCalls, 0, "no TTS request for a recorded line");

  assert.equal(router.storedClip("जी।", {}), null, "browser demo (non-telephony) stays live");
  assert.equal(
    make({ SARVAM_API_KEY: "sk", TTS_PROVIDER_HI: "elevenlabs" }).storedClip("जी।", { outputFormat: "pcm_8000" }),
    null,
    "while ElevenLabs is the voice, Sarvam-voiced clips must not be mixed in",
  );
});

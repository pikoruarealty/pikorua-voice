/**
 * SttRouter invariants: provider choice, mid-call failover to Deepgram, and the
 * Sarvam-only VAD barge-in callback.
 *
 * Run with: pnpm build && node --test tools/tests/stt-router.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");

function setup(env) {
  const { SttRouter } = require("../../apps/api/dist/stt/stt-router");
  const log = [];
  const session = (name) => ({
    sendAudio: () => log.push(`${name}:audio`),
    clearBuffer() {},
    setEndpointing() {},
    close: () => log.push(`${name}:close`),
  });
  const opened = {};
  const deepgram = {
    openSession: (_l, _r, cb) => ((opened.deepgram = cb), session("deepgram")),
  };
  const sarvam = {
    isConfigured: () => Boolean(env.SARVAM_API_KEY),
    openSession: (_l, _r, cb) => ((opened.sarvam = cb), session("sarvam")),
  };
  const router = new SttRouter(deepgram, sarvam, { get: (k) => env[k] });
  const callbacks = {
    onPartial() {},
    onUtterance() {},
    onError: (m) => log.push(`error:${m}`),
    onSpeechStart() {},
  };
  return { router, log, opened, callbacks };
}

test("defaults to Sarvam when its key is set", () => {
  const { router, opened, callbacks } = setup({ SARVAM_API_KEY: "sk" });
  assert.equal(router.provider(), "sarvam");
  router.openSession("hi-IN", 8000, callbacks);
  assert.ok(opened.sarvam);
  assert.equal(opened.deepgram, undefined, "Deepgram is fallback-only");
});

test("STT_PROVIDER=deepgram (rollback) never hands Deepgram the raw-VAD barge-in callback", () => {
  const { router, opened, callbacks } = setup({ SARVAM_API_KEY: "sk", STT_PROVIDER: "deepgram" });
  assert.equal(router.provider(), "deepgram");
  router.openSession("hi-IN", 8000, callbacks);
  assert.ok(opened.deepgram);
  assert.equal(opened.deepgram.onSpeechStart, undefined);
});

test("without a Sarvam key, STT stays on Deepgram", () => {
  const { router } = setup({});
  assert.equal(router.provider(), "deepgram");
});

test("a Sarvam failure mid-call moves the same session to Deepgram", () => {
  const { router, log, opened, callbacks } = setup({ STT_PROVIDER: "sarvam", SARVAM_API_KEY: "sk" });
  const s = router.openSession("hi-IN", 8000, callbacks);
  assert.equal(typeof opened.sarvam.onSpeechStart, "function", "Sarvam gets the VAD callback");

  s.sendAudio(Buffer.alloc(320));
  opened.sarvam.onError("socket closed (1006)");
  s.sendAudio(Buffer.alloc(320));
  opened.sarvam.onError("late duplicate"); // a dead socket's late callbacks are ignored
  s.close();

  assert.deepEqual(log, ["sarvam:audio", "sarvam:close", "deepgram:audio", "deepgram:close"]);
  assert.equal(opened.deepgram.onSpeechStart, undefined);
});

test("Sarvam STT language: Gujarati alone, Hindi and English share one code-mixed session", () => {
  const { SarvamSttService } = require("../../apps/api/dist/stt/sarvam-stt.service");
  assert.deepEqual(SarvamSttService.sessionLanguage("gu-IN"), { code: "gu-IN", mode: "transcribe" });
  assert.deepEqual(SarvamSttService.sessionLanguage("hi-IN"), { code: "hi-IN", mode: "codemix" });
  assert.deepEqual(SarvamSttService.sessionLanguage("en-IN"), { code: "hi-IN", mode: "codemix" });
});

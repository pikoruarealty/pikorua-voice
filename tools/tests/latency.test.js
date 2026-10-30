/**
 * Latency invariants (Batch 5): fragment release, slow-reply fillers, first frame.
 *
 * Run with: pnpm build && node --test tools/tests/latency.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const GATEWAY = "apps/api/src/call-runtime/exotel-voicebot.gateway.ts";

function runtimeWithState(locale = "hi-IN") {
  const { CallRuntimeService } = require("../../apps/api/dist/call-runtime/call-runtime.service");
  const svc = Object.create(CallRuntimeService.prototype);
  const state = { callId: "c1", locale, pendingFragment: null, silenceStrikes: 0, history: [] };
  svc.calls = new Map([["c1", state]]);
  svc.logger = { log() {}, warn() {} };
  svc.config = { get: () => undefined };
  svc.tts = { isGujaratiEnabled: () => true };
  svc.adoptLocaleSwitch = async () => {};
  return { svc, state };
}

test("a held fragment can be taken back and answered without being held again", async () => {
  const { svc } = runtimeWithState();
  const held = await svc.prepareUtterance("c1", "mujhe 4 BHK chahiye aur", "hi-IN");
  assert.equal(held.hold, true, "a sentence trailing off on 'aur' is held");
  assert.equal(svc.hasPendingFragment("c1"), true);

  const fragment = svc.takePendingFragment("c1");
  assert.equal(fragment, "mujhe 4 BHK chahiye aur");
  assert.equal(svc.hasPendingFragment("c1"), false, "taking it clears it");

  const answered = await svc.prepareUtterance("c1", fragment, "hi-IN", true);
  assert.equal(answered.hold, false, "noHold answers it instead of holding again");
  assert.equal(answered.utterance, fragment);
});

test("a caller who DOES continue still gets the fragment merged (no early release)", async () => {
  const { svc } = runtimeWithState();
  await svc.prepareUtterance("c1", "mujhe 4 BHK chahiye aur", "hi-IN");
  const merged = await svc.prepareUtterance("c1", "5 BHK bhi dekhna hai", "hi-IN");
  assert.equal(merged.hold, false);
  assert.equal(merged.utterance, "mujhe 4 BHK chahiye aur 5 BHK bhi dekhna hai");
  assert.equal(svc.takePendingFragment("c1"), null, "nothing left for the timer to release");
});

test("the gateway releases a held fragment after a pause, through the turn queue", () => {
  const src = fs.readFileSync(GATEWAY, "utf8");
  assert.match(src, /STT_FRAGMENT_WAIT_MS, 800\)/, "fragment wait defaults to 800 ms");
  assert.match(src, /this\.runtime\.hasPendingFragment\(state\.callId\)/);
  assert.match(
    src,
    /takePendingFragment\(state\.callId\)[\s\S]{0,400}runTurn\(client, state, fragment, \{ noHold: true \}\)/,
    "the released fragment is answered with noHold",
  );
});

test("every slow-reply filler the gateway can play has a recorded clip", () => {
  const { TURN_FILLERS } = require("../../apps/api/dist/call-runtime/exotel-voicebot.gateway");
  const { ClipLibrary } = require("../../apps/api/dist/tts/clip-library");
  const lib = new ClipLibrary({ get: () => undefined });
  for (const [lang, texts] of Object.entries(TURN_FILLERS)) {
    for (const text of texts) assert.ok(lib.get(lang, text), `${lang} filler "${text}" has no clip`);
  }
});

test("/api/metrics reports event-loop lag (audio-stutter early warning)", () => {
  const { MetricsService } = require("../../apps/api/dist/metrics/metrics.service");
  const out = new MetricsService().renderPrometheus();
  for (const q of ["p50", "p99", "max"]) {
    assert.match(out, new RegExp(`pikorua_event_loop_lag_ms\\{quantile="${q}"\\} \\d+(\\.\\d)?`));
  }
});

test("the first audio frame of a reply is 40 ms, then 100 ms frames", () => {
  const { PcmReframer } = require("../../apps/api/dist/call-runtime/exotel-voicebot.gateway");
  const sizes = [];
  const r = new PcmReframer((f) => sizes.push(f.length));
  r.push(Buffer.alloc(8000));
  r.flush();
  assert.deepEqual(sizes, [1280, 3200, 3200, 320]);
  assert.ok(sizes.every((n) => n % 320 === 0), "every frame is a 320-byte multiple (Exotel)");
});

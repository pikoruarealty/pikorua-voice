/**
 * Outbound dial invariants (Exotel connect.json).
 *
 * These guard a failure mode with NO visible symptom: a misdirected call still
 * returns 200, gets a Sid, bills, and records — it just never rings the callee.
 * Nothing in the logs, the DB, or the call row says anything is wrong.
 *
 * Run with: node --test tools/tests/dial-exotel.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");
const DIAL = "apps/worker/src/dial/dial.service.ts";

// Slice the connect.json request construction so these assertions can't be
// satisfied by unrelated code elsewhere in the service.
function connectRegion(src) {
  const start = src.indexOf("Calls/connect.json");
  assert.ok(start !== -1, "the dial service must POST to Calls/connect.json");
  const end = src.indexOf("axios.post", start);
  assert.ok(end !== -1 && end > start, "axios.post must follow the param construction");
  return src.slice(start, end);
}

// Exotel dials `From` FIRST — it is the party we want to reach, not the number we
// call from. Handing it the exophone (call.fromNumber) makes Exotel ring its own
// virtual number and connect that to the applet: Maya delivers the entire pitch to
// a dead leg while the callee's phone stays silent. The call still reports
// completed with a recording, so this reads as success everywhere.
test("Exotel `From` is the callee, not the exophone", () => {
  const region = connectRegion(read(DIAL));

  assert.match(
    region,
    /From:\s*call\.toNumber/,
    "From must be the callee (call.toNumber) — the exophone belongs in CallerId",
  );
  assert.ok(
    !/From:\s*call\.fromNumber/.test(region),
    "From: call.fromNumber rings the exophone itself and never reaches the callee",
  );
  assert.match(region, /CallerId:\s*String\(this\.config\.get\("EXOTEL_CALLER_ID"\)/);
});

// With a flow/applet the app IS the second leg, so `To` must be omitted. Sending
// the callee as `To` alongside the applet double-books the destination.
test("no `To` is sent when the applet is the second leg", () => {
  const region = connectRegion(read(DIAL));
  assert.ok(
    !/\bTo:\s/.test(region),
    "connect.json must not send `To` — the Voicebot applet is the second leg",
  );
});

// connect.json rejects `AppId` outright ("Invalid 'To' specified") — that param
// expects a real destination. The applet must be passed as an ExoML flow Url, or
// every outbound dial 400s and no call is placed at all.
test("the Voicebot applet is passed as an ExoML flow Url, not AppId", () => {
  const region = connectRegion(read(DIAL));

  assert.match(
    region,
    /params\.set\(\s*"Url"\s*,[\s\S]*?exoml\/start_voice\//,
    "the applet must be routed via an exoml/start_voice flow Url",
  );
  assert.ok(
    !/params\.set\(\s*"AppId"/.test(region),
    'AppId is rejected by connect.json with "Invalid \'To\' specified"',
  );
});

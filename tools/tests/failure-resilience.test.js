/**
 * Failure-path resilience.
 * Run with: pnpm build && node --test tools/tests/failure-resilience.test.js
 *
 * These all pin the same principle: in a live voice service, a dependency failing is
 * NORMAL, and the only unacceptable outcome is losing the call (or the process). Each
 * test below corresponds to a defect that was actually present in this repo, not a
 * hypothetical.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRouter({ sarvam, eleven }) {
  const { TtsRouter } = require("../../apps/api/dist/tts/tts-router");
  return new TtsRouter(eleven, sarvam, { get: () => undefined });
}

// ── TTS WS failover ─────────────────────────────────────────────────────────────
// A WebSocket emits 'error' and then 'close' on its own schedule, so a session we
// have already abandoned still calls back afterwards. Those late callbacks are not
// harmless: onDone resolves the turn in the call runtime and emits the last-chunk
// marker, so a dead Sarvam's onDone arriving before the ElevenLabs fallback has
// streamed TRUNCATES the very reply the failover exists to deliver.
test("a dead Sarvam's late callbacks cannot truncate the ElevenLabs fallback", async () => {
  const seen = [];
  const router = makeRouter({
    sarvam: {
      isConfigured: () => true,
      openWsSession: (o) => {
        o.onError("No credits available."); // rejected at handshake
        // ...and the socket closes on its own a moment later, as ws does.
        setTimeout(() => {
          o.onChunk(Buffer.from([7]));
          o.onDone();
        }, 10);
        return { sendText() {}, flush() {}, close() {} };
      },
    },
    eleven: {
      openWsSession: (o) => ({
        sendText() {},
        flush() {
          setTimeout(() => {
            o.onChunk(Buffer.from([1]));
            o.onDone();
          }, 40);
        },
        close() {},
      }),
    },
  });

  const s = router.openWsSession({
    languageCode: "gu",
    onChunk: () => seen.push("chunk"),
    onDone: () => seen.push("done"),
    onError: (e) => seen.push("error:" + e),
  });
  s.sendText("નમસ્તે");
  s.flush();
  await wait(120);

  assert.equal(
    seen.filter((e) => e === "done").length,
    1,
    `onDone must fire exactly once — got ${JSON.stringify(seen)}`,
  );
  assert.equal(
    seen.filter((e) => e === "chunk").length,
    1,
    "the dead vendor's stray audio must not be spliced into the reply",
  );
});

test("a healthy Sarvam is passed straight through, with no failover", async () => {
  const seen = [];
  let elevenOpened = false;
  const router = makeRouter({
    sarvam: {
      isConfigured: () => true,
      openWsSession: (o) => ({
        sendText() {},
        flush() {
          o.onChunk(Buffer.from([5]));
          o.onDone();
        },
        close() {},
      }),
    },
    eleven: {
      openWsSession: () => {
        elevenOpened = true;
        return { sendText() {}, flush() {}, close() {} };
      },
    },
  });

  const s = router.openWsSession({
    languageCode: "gu",
    onChunk: () => seen.push("chunk"),
    onDone: () => seen.push("done"),
    onError: () => seen.push("error"),
  });
  s.flush();
  await wait(20);

  assert.deepEqual(seen, ["chunk", "done"]);
  assert.equal(elevenOpened, false, "a working Sarvam must not be second-guessed");
});

// ── Fallback clip lookup ────────────────────────────────────────────────────────
// getClip is called from INSIDE the runtime's "TTS is down" catch block, looping over
// fallback lines. A rejection there escapes that catch, aborts the loop on the first
// line, skips failCall(), and masks the original error — and it rejects precisely when
// it matters, because the vendor being down is why we are in that catch at all.
test("getClip never rejects, even when every vendor is down", async () => {
  const bothDown = makeRouter({
    sarvam: {
      isConfigured: () => true,
      getClip: async () => { throw new Error("No credits available."); },
    },
    eleven: {
      getClip: async () => { throw new Error("elevenlabs 500"); },
    },
  });
  assert.equal(await bothDown.getClip("नमस्ते", { languageCode: "gu" }), null);

  // And a Sarvam failure still yields the ElevenLabs clip rather than nothing.
  const sarvamDown = makeRouter({
    sarvam: {
      isConfigured: () => true,
      getClip: async () => { throw new Error("No credits available."); },
    },
    eleven: { getClip: async () => Buffer.from([1, 2, 3]) },
  });
  const clip = await sarvamDown.getClip("નમસ્તે", { languageCode: "gu" });
  assert.ok(clip && clip.length === 3, "must fall back to an ElevenLabs clip");
});

// ── Worker scheduler ────────────────────────────────────────────────────────────
// repair() is driven by `setInterval(() => void this.repair(), …)`. `void` discards
// the promise, so a rejection is an unhandled rejection — which Node terminates the
// process for. Both of its awaits are network calls (Postgres, Redis), so a single
// blip would have crash-looped the worker every 60s.
test("dial repair never rejects, so a DB or Redis blip cannot kill the worker", async () => {
  const {
    DialRepairScheduler,
  } = require("../../apps/worker/dist/dial/dial-repair.scheduler");

  const scheduler = Object.create(DialRepairScheduler.prototype);
  scheduler.logger = { warn() {}, log() {} };
  scheduler.queue = { add: async () => {} };
  scheduler.targetRepo = {
    findRepairableDials: async () => {
      throw new Error("ECONNRESET: neon went away");
    },
  };

  await assert.doesNotReject(
    () => scheduler.repair(),
    "repair() must swallow failures — the next tick retries and it is idempotent",
  );

  // A Redis failure mid-loop must be swallowed too.
  scheduler.targetRepo = {
    findRepairableDials: async () => [{ id: "t1" }],
    updateDialStatus: async () => {},
  };
  scheduler.queue = { add: async () => { throw new Error("upstash rate limit"); } };
  await assert.doesNotReject(() => scheduler.repair());
});

// ── Process-level nets ──────────────────────────────────────────────────────────
test("the per-call turn queue can never take the process down", () => {
  const src = fs.readFileSync("apps/api/src/call-runtime/exotel-voicebot.gateway.ts", "utf8");
  // Every `state.queue = state.queue…` statement must terminate in a .catch. Without
  // one, a single rejected link poisons the chain for the rest of the call AND
  // surfaces as an unhandled rejection, which drops every concurrent call.
  //
  // Check for the .catch itself, not for a particular formatting of the .then — the
  // first version of this test matched the one-line form and reported two guarded
  // chains as unguarded.
  const marker = "state.queue = state.queue";
  const starts = [];
  for (let i = src.indexOf(marker); i !== -1; i = src.indexOf(marker, i + 1)) starts.push(i);
  assert.equal(starts.length, 3, `expected 3 queue chains, found ${starts.length}`);

  starts.forEach((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : start + 2000;
    const statement = src.slice(start, end);
    assert.ok(
      statement.includes(".catch("),
      `queue chain #${n + 1} (at char ${start}) has no .catch() — a rejection there ends every live call`,
    );
  });
});

test("both services log unhandled rejections instead of dying", () => {
  for (const main of ["apps/api/src/main.ts", "apps/worker/src/main.ts"]) {
    const src = fs.readFileSync(main, "utf8");
    assert.match(
      src,
      /process\.on\("unhandledRejection"/,
      `${main} must not let a stray rejection terminate a service holding live calls`,
    );
    // uncaughtException must NOT be swallowed — after one, process state is
    // untrustworthy and a clean restart is correct.
    assert.doesNotMatch(
      src,
      /process\.on\("uncaughtException"/,
      `${main} must not swallow uncaughtException`,
    );
  }
});

/**
 * Voice-path timing invariants.
 *
 * These guard COUPLINGS between constants that live in different files and have no
 * compile-time link — the kind that silently break a live call and never fail a
 * type-check. Each test states the invariant and the failure it prevents.
 *
 * Run with: node --test tools/tests/voice-timing.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");

const GATEWAY = "apps/api/src/call-runtime/exotel-voicebot.gateway.ts";
const DEEPGRAM = "apps/api/src/stt/deepgram-live.service.ts";
const LLM = "apps/api/src/llm/llm.service.ts";
const ENV = "apps/api/src/config/env.ts";
const RUNTIME = "apps/api/src/call-runtime/call-runtime.service.ts";

// Slice out the generateGreetingStream method body so assertions about the opening
// can't be satisfied by unrelated code elsewhere in the (very large) service.
function greetingStreamRegion(src) {
  const start = src.indexOf("async generateGreetingStream");
  assert.ok(start !== -1, "generateGreetingStream must exist");
  // The next method after it in source order.
  const end = src.indexOf("private allFallbackLines", start);
  assert.ok(end !== -1 && end > start, "allFallbackLines must follow generateGreetingStream");
  return src.slice(start, end);
}

// Pull the numeric default out of `agcNumber(process.env.NAME, <default>)`.
const agcDefault = (src, name) => {
  const m = src.match(new RegExp(`agcNumber\\(process\\.env\\.${name},\\s*([\\d.]+)\\)`));
  assert.ok(m, `${name} must be read via agcNumber() with a numeric default`);
  return Number(m[1]);
};

// Pull the numeric default out of `NAME: z.coerce.number()....default(<n>)`.
const envDefault = (src, name) => {
  const m = src.match(new RegExp(`${name}:[^\\n]*\\.default\\((\\d+)\\)`));
  assert.ok(m, `${name} must have a numeric .default() in the env schema`);
  return Number(m[1]);
};

// The near-end gate is consulted when the FINAL transcript lands, not when the
// caller actually spoke. Deepgram finalizes either via speech_final (fast) or, when
// speech_final never fires — noisy lines, exactly when this gate matters most — via
// the UtteranceEnd fallback at utterance_end_ms. If the hold expires before that
// fallback arrives, a REAL caller utterance carries no "near-end" flag, enqueueTurn
// classifies it as echo, and drops it: Maya goes deaf mid-call.
test("near-end hold outlasts Deepgram's utterance_end_ms fallback boundary", () => {
  const holdMs = agcDefault(read(GATEWAY), "STT_NEAR_END_HOLD_MS");

  const dg = read(DEEPGRAM);
  const m = dg.match(/utterance_end_ms:\s*"(\d+)"/);
  assert.ok(m, "deepgram-live must set utterance_end_ms");
  const utteranceEndMs = Number(m[1]);

  assert.ok(
    holdMs > utteranceEndMs,
    `NEAR_END_HOLD_MS (${holdMs}) must exceed utterance_end_ms (${utteranceEndMs}), ` +
      `or an UtteranceEnd-finalized utterance is dropped as echo while Maya is audible`,
  );
});

// The echo gate must reject on ENERGY, never on the transcript text: echo is real
// words, so any text-based filter passes it straight through.
test("echo rejection is gated on near-end energy while Maya is audible", () => {
  const src = read(GATEWAY);
  // Energy is measured on the RAW frame — the boost must not inflate it.
  assert.match(src, /this\.updateNearEnd\(state,\s*frameRms\(pcm\)\)/);
  assert.match(
    src,
    /this\.isMayaAudible\(state\)\s*&&\s*!this\.nearEndSpeaking\(state\)/,
    "enqueueTurn must drop transcripts with no near-end energy while Maya is audible",
  );
  // Barge-in requires near-end too, else her own amplified echo stops her.
  assert.match(src, /this\.nearEndSpeaking\(state\)\s*&&/);
});

// The callee can reject/hang up DURING the outbound greeting hold. The stream ends
// while the socket can still be OPEN, so the readyState guard alone lets the timer
// fire: it greets a dead call and opens an STT session nothing owns (billed, closed
// only whenever the socket eventually closes).
test("outbound greeting hold is cancelled on stop and on disconnect", () => {
  const src = read(GATEWAY);

  assert.match(
    src,
    /state\.greetingTimer\s*=\s*setTimeout\(startConversation/,
    "the greeting hold timer must be tracked on the session, not fire-and-forget",
  );
  assert.match(src, /private clearGreetingTimer\(state: SessionState\)/);

  // Cancelled on the stream's `stop` event...
  const stopCase = src.slice(src.indexOf('case "stop":'), src.indexOf('case "stop":') + 400);
  assert.match(stopCase, /this\.clearGreetingTimer\(state\)/, "`stop` must cancel the hold");

  // ...and on socket teardown.
  const disconnect = src.slice(
    src.indexOf("handleDisconnect(client: WebSocket)"),
    src.indexOf("handleDisconnect(client: WebSocket)") + 400,
  );
  assert.match(disconnect, /this\.clearGreetingTimer\(state\)/, "disconnect must cancel the hold");
});

// Only OUTBOUND calls are held — an inbound caller is already on the line, so any
// hold there is pure dead air on the one path where the human speaks first.
test("greeting hold applies to outbound calls only", () => {
  const src = read(GATEWAY);
  assert.match(src, /state\.isOutbound\s*&&\s*OUTBOUND_GREETING_DELAY_MS\s*>\s*0/);
  assert.match(
    src,
    /state\.isOutbound\s*=\s*true/,
    "outbound must be flagged from the start event",
  );
  assert.match(
    src,
    /state\.isOutbound\s*=\s*call\.direction\s*===\s*"outbound"/,
    "a callSid-resolved row must take direction from the DB row",
  );
});

// generateStream runs its attempts SERIALLY, all inside one turn watchdog. If the
// per-request cap exceeds TURN_TIMEOUT_MS / attempts, the watchdog kills the turn
// before the fallback model is ever tried — the chain stops being a fallback chain
// exactly when the primary is already failing.
test("LLM attempt chain fits inside the turn watchdog", () => {
  const llm = read(LLM);
  const env = read(ENV);

  const attempts = (llm.match(/attempts\.push\(/g) ?? []).length;
  assert.ok(attempts >= 2, "expected a multi-attempt fallback chain");

  const perRequestMs = envDefault(env, "OPENROUTER_TIMEOUT_MS");
  const turnMs = envDefault(env, "TURN_TIMEOUT_MS");

  assert.ok(
    attempts * perRequestMs <= turnMs,
    `${attempts} attempts × OPENROUTER_TIMEOUT_MS (${perRequestMs}) = ${attempts * perRequestMs}ms ` +
      `exceeds TURN_TIMEOUT_MS (${turnMs}) — the fallback model would never be reached`,
  );
});

// The env schema's .default() ALWAYS supplies a value, so a differing `?? N`
// literal in the service is unreachable — a lie that reads as the real default.
test("LLM timeout fallback literal matches the env schema default", () => {
  const llm = read(LLM);
  const env = read(ENV);

  const m = llm.match(/this\.config\.get\("OPENROUTER_TIMEOUT_MS"\)\s*\?\?\s*(\d+)/);
  assert.ok(m, "openRouterTimeoutMs must read OPENROUTER_TIMEOUT_MS with a numeric guard");

  assert.equal(
    Number(m[1]),
    envDefault(env, "OPENROUTER_TIMEOUT_MS"),
    "the ?? literal is unreachable (zod .default() always fills the value) — " +
      "keep it equal to the schema default so it can't misrepresent it",
  );
});

// The opening line is a fixed template — it must NEVER reach the LLM. A regression
// that reintroduced an LLM call for the greeting would put a 1.5-2.5s round-trip
// before Maya's very first word, the exact latency this design removed.
test("the greeting is templated — no LLM call before Maya's first word", () => {
  const region = greetingStreamRegion(read(RUNTIME));
  assert.ok(
    !/this\.llm\./.test(region),
    "generateGreetingStream must not call this.llm.* — the opening is a fixed template",
  );
  // It resolves the wording from the template, not a model.
  assert.match(region, /this\.greetingText\(state\)/);
});

// The Gujarati greeting streams through the SAME turn-level WS session the live
// turns use, and is synthesized FRESH every call. This is deliberate: Sarvam's
// temperature gives each synthesis natural variation, so the opening sounds spoken.
// Caching the audio and replaying one frozen take made every call identical, which
// read as "robotic" — so the greeting must NOT be served from a stored buffer.
test("the Gujarati greeting streams fresh through the turn-level WS session", () => {
  const region = greetingStreamRegion(read(RUNTIME));

  // gu takes the openWsSession path (one coherent synthesis, ~200ms first audio).
  assert.match(
    region,
    /this\.tts\.openWsSession\(/,
    "the Gujarati greeting must stream through openWsSession like live turns",
  );
  assert.match(region, /session\.sendText\(reply\)/, "the whole greeting is sent as one text frame");
  assert.match(region, /session\.flush\(\)/, "flush finalises the synthesis so it doesn't stall");

  // No frozen-take cache: the greeting is never served from a stored audio buffer.
  assert.ok(
    !/greetingAudioCache/.test(region),
    "the greeting must be synthesized fresh, not replayed from a cached buffer " +
      "(a frozen take reads as robotic)",
  );
});

// Outbound Exotel calls bridge the callee's media leg a beat after the voicebot
// `start`, so Maya's greeting is held until the callee is fully connected. The
// hold was raised to 10s for all languages so no intro is clipped.
test("outbound greeting hold defaults to 10s", () => {
  const src = read(GATEWAY);
  const m = src.match(/OUTBOUND_GREETING_DELAY_MS[\s\S]*?:\s*(\d+);/);
  assert.ok(m, "OUTBOUND_GREETING_DELAY_MS must have a numeric fallback");
  assert.equal(Number(m[1]), 10000, "outbound greeting hold should default to 10000ms");
});

// Exotel's voicebot stream call_sid frequently differs from the Sid returned by
// /Calls/connect.json (stored as providerCallSid), so an outbound call's locale
// (e.g. gu-IN) would be lost to CALL_LOCALE_DEFAULT. The gateway must recover the
// just-dialed outbound call instead of defaulting.
test("outbound call locale is recovered when Exotel's call_sid doesn't match", () => {
  const src = read(GATEWAY);
  assert.match(
    src,
    /findRecentOutboundAwaitingStream\(/,
    "the gateway must adopt the recent outbound call when findByProviderCallSid misses",
  );
  // The recovered call is relinked to the real stream call_sid.
  assert.match(src, /providerCallSid:\s*callSid/);
});

// A gu-IN call must never be auto-switched to hi/en by the caller-language
// detector: gu is entered deliberately (campaign/dial), Deepgram can't cleanly
// detect Gujarati, and a code-switched word would otherwise flip Maya out of
// Gujarati on the first utterance.
test("a Gujarati call is never auto-switched to hi/en mid-call", () => {
  const src = read(GATEWAY);
  assert.match(
    src,
    /isGuCall\s*\?\s*null\s*:\s*detectSpokenLanguage\(/,
    "detectSpokenLanguage must be skipped when the session locale is already gu",
  );
});

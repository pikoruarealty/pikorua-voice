/**
 * LLM circuit-breaker invariants.
 *
 * Run with: node --test tools/tests/llm-breaker.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");
const LLM = "apps/api/src/llm/llm.service.ts";

function catchRegion(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `expected to find ${marker}`);
  const end = src.indexOf("recordFailure", start);
  assert.ok(end !== -1, "recordFailure must follow the marker");
  return src.slice(start, end);
}

// Barge-in aborts the turn, which surfaces as an axios CanceledError on the
// in-flight LLM request. That is US cancelling, not the provider failing. Counting
// it means an interrupt-happy caller trips the breaker: after BREAKER_THRESHOLD
// consecutive barge-ins the next REAL turn gets "No LLM provider available" and
// the caller hears dead air. Observed in production on a live Gujarati call.
test("an aborted turn does not count against the LLM circuit breaker", () => {
  const src = read(LLM);

  const streaming = catchRegion(src, "private async streamOpenRouter");
  assert.match(
    streaming,
    /if \(opts\.signal\?\.aborted\)\s*\{[\s\S]*?throw err;/,
    "streamOpenRouter must rethrow an aborted turn before recordFailure",
  );

  const nonStreaming = catchRegion(src, "private async tryOpenRouter");
  assert.match(
    nonStreaming,
    /if \(opts\?\.signal\?\.aborted\) return null;/,
    "tryOpenRouter must bail on an aborted turn before recordFailure",
  );
});

// The breaker must still open on genuine provider faults (timeouts, 5xx) — the
// abort guard above must not be widened into "never record a streaming failure".
test("genuine provider failures still open the breaker", () => {
  const src = read(LLM);
  assert.match(src, /this\.recordFailure\(breakerKey\)/, "streaming path must still record faults");
  assert.match(src, /this\.recordFailure\("openrouter"\)/, "non-streaming path must still record");
  assert.match(src, /Circuit open for LLM provider=/);
});

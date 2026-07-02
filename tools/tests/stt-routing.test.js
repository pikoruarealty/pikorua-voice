/**
 * Unit tests for STT provider routing (stt-routing.ts). Pure logic, no network:
 * verifies that Flux is used only for enabled AND eligible locales, that
 * Gujarati/Tamil/Telugu/Marathi can never be sent to Flux (which can't transcribe
 * them), and that an empty STT_FLUX_LOCALES routes everything to Nova-3 — the
 * experiment's rollback switch.
 *
 * Run with: pnpm build && node --test tools/tests/stt-routing.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  baseLang,
  parseFluxLocales,
  resolveSttProvider,
} = require("../../apps/api/dist/stt/stt-routing");

test("baseLang strips region and lowercases", () => {
  assert.equal(baseLang("en-IN"), "en");
  assert.equal(baseLang("HI-in"), "hi");
  assert.equal(baseLang("gu"), "gu");
});

test("parseFluxLocales parses, trims, lowercases, and dedupes to base subtags", () => {
  const set = parseFluxLocales(" EN-IN , hi-IN , en ");
  assert.deepEqual([...set].sort(), ["en", "hi"]);
});

test("parseFluxLocales returns empty set for empty/unset (rollback)", () => {
  assert.equal(parseFluxLocales("").size, 0);
  assert.equal(parseFluxLocales(undefined).size, 0);
  assert.equal(parseFluxLocales(null).size, 0);
});

test("enabled + eligible locales route to Flux", () => {
  const flux = parseFluxLocales("en-IN,hi-IN");
  assert.equal(resolveSttProvider("hi-IN", flux), "flux");
  assert.equal(resolveSttProvider("en-IN", flux), "flux");
});

test("eligible locale NOT in config stays on Nova-3", () => {
  const flux = parseFluxLocales("en-IN"); // only English enabled
  assert.equal(resolveSttProvider("hi-IN", flux), "nova-3");
});

test("hard guard: Gujarati/Tamil/Telugu/Marathi never route to Flux even if misconfigured", () => {
  // Someone wrongly enables gu/ta for Flux — router must still pick Nova-3.
  const flux = parseFluxLocales("gu-IN,ta-IN,te-IN,mr-IN");
  assert.equal(resolveSttProvider("gu-IN", flux), "nova-3");
  assert.equal(resolveSttProvider("ta-IN", flux), "nova-3");
  assert.equal(resolveSttProvider("te-IN", flux), "nova-3");
  assert.equal(resolveSttProvider("mr-IN", flux), "nova-3");
});

test("empty config routes every locale to Nova-3 (rollback)", () => {
  const none = parseFluxLocales("");
  for (const loc of ["en-IN", "hi-IN", "gu-IN", "ta-IN", "te-IN", "mr-IN"]) {
    assert.equal(resolveSttProvider(loc, none), "nova-3");
  }
});

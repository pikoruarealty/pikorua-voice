/**
 * Deepgram keyterm URL budget.
 * Run with: pnpm build && node --test tools/tests/keyterm-budget.test.js
 *
 * WHY THIS EXISTS — a real outage, not a hypothetical. Every keyterm is appended to
 * the Deepgram WebSocket URL as its own query param, and Devanagari/Gujarati
 * characters cost ~9 bytes each once percent-encoded. Growing the list from 56 to 94
 * terms took the URL from 2,582 to 4,406 bytes, past the ~4 KB request-line limit.
 * Deepgram answered every connect AND every reconnect with a bare
 * "Unexpected server response: 400", STT never came up, and callers reached a Maya
 * who could not hear a single word — while TTS, the LLM and the call itself all
 * looked perfectly healthy in the logs.
 *
 * The lesson encoded here: the failure is total and silent-ish, so the limit is
 * enforced in code (withinBudget) rather than trusted to a comment, and pinned here
 * rather than trusted to code review.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

// The real params from DeepgramLiveService.open() — the keyterms are appended on top
// of these, so the budget has to leave room for them.
const BASE_PARAMS = {
  model: "nova-3",
  language: "multi",
  encoding: "linear16",
  sample_rate: "8000",
  channels: "1",
  punctuate: "true",
  smart_format: "true",
  interim_results: "true",
  endpointing: "250",
  utterance_end_ms: "1000",
  vad_events: "true",
};

// The wall. 4096 is the classic HTTP request-line limit and the observed failure
// point; stay meaningfully below it rather than creeping up to it.
const HARD_LIMIT = 4096;
const SAFE_CEILING = 3500;

function buildUrl(terms, lang) {
  const p = new URLSearchParams({ ...BASE_PARAMS, language: lang });
  for (const term of terms) p.append("keyterm", term);
  return `wss://api.deepgram.com/v1/listen?${p.toString()}`;
}

test("the built Deepgram URL stays well under the ~4 KB request-line limit", () => {
  const { keytermsFor } = require("../../apps/api/dist/stt/keyterms");

  for (const lang of ["multi", "gu"]) {
    const bytes = Buffer.byteLength(buildUrl(keytermsFor(lang), lang));
    assert.ok(
      bytes < SAFE_CEILING,
      `${lang}: URL is ${bytes} bytes, over the ${SAFE_CEILING} safe ceiling ` +
        `(hard limit ${HARD_LIMIT} — past it Deepgram 400s and STT dies for the whole call)`,
    );
  }
});

test("the budget cap truncates instead of letting the URL grow unbounded", () => {
  const { keytermsFor, KEYTERM_BUDGET_FOR_TEST } = require("../../apps/api/dist/stt/keyterms");

  // Cost model must match withinBudget: "&keyterm=" + the percent-encoded term.
  const cost = (t) => 9 + encodeURIComponent(t).length;
  for (const lang of ["multi", "gu"]) {
    const total = keytermsFor(lang).reduce((n, t) => n + cost(t), 0);
    assert.ok(
      total <= KEYTERM_BUDGET_FOR_TEST,
      `${lang}: keyterms cost ${total} bytes, over the ${KEYTERM_BUDGET_FOR_TEST} budget`,
    );
  }
});

test("no keyterm is emitted twice — duplicates are wasted budget", () => {
  const { keytermsFor } = require("../../apps/api/dist/stt/keyterms");

  for (const lang of ["multi", "gu"]) {
    const terms = keytermsFor(lang);
    assert.equal(new Set(terms).size, terms.length, `${lang}: duplicate keyterms present`);
  }
});

test("the micro-markets that drive the pitch survive the budget", () => {
  const { keytermsFor } = require("../../apps/api/dist/stt/keyterms");

  // These are ordered first in the list precisely so truncation can never reach
  // them. If this fails, the budget got too tight or the ordering was disturbed —
  // the residence-area names at the tail are what should be sacrificed instead.
  const multi = new Set(keytermsFor("multi"));
  for (const term of [
    "Ambli-Bopal Road", "Ambli Bopal", "Sindhu Bhavan Road", "Sindhubhavan", "SBR",
    "Rajpath Rangoli", "Thaltej", "Vastrapur", "Vaishnodevi", "Nehru Nagar",
    "Gota", "Shilaj", "Nandoli", "bungalow",
    "अंबली-बोपल रोड", "सिंधु भवन रोड", "थलतेज", "वैष्णोदेवी",
  ]) {
    assert.ok(multi.has(term), `multi: dropped a load-bearing keyterm: ${term}`);
  }

  const gu = new Set(keytermsFor("gu"));
  for (const term of ["અંબલી-બોપલ રોડ", "સિંધુ ભવન રોડ", "થલતેજ", "વૈષ્ણોદેવી", "ગોતા"]) {
    assert.ok(gu.has(term), `gu: dropped a load-bearing keyterm: ${term}`);
  }
});

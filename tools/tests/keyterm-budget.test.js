/**
 * Deepgram keyterm cap.
 * Run with: pnpm build && node --test tools/tests/keyterm-budget.test.js
 *
 * WHY THIS EXISTS — a real outage. Shipping an expanded keyterm list (56 -> 94 terms)
 * made Deepgram refuse the WebSocket upgrade with HTTP 400 on the connect AND on all
 * three reconnects. STT never came up, so Maya delivered her greeting and then could
 * not hear a single word, while TTS, the LLM and the call all looked healthy in the
 * logs. The only clue was a bare "Unexpected server response: 400".
 *
 * WHAT THE LIMIT ACTUALLY IS: unknown, and deliberately not modelled here. Probing
 * the live account gave:
 *     84 of our terms -> 400,  83 -> OK
 *     120 single-word terms -> 400,  119 -> OK
 *     91 two-word terms -> 400,  90 -> OK
 *     40 long Devanagari terms (5,044-byte URL) -> OK
 * i.e. it is NOT bytes (a 5 KB URL connects fine — an earlier fix assumed bytes and
 * was wrong), and not plain term or word count either. So the cap is set below the
 * smallest observed failure for our list shape rather than computed, and the real
 * safety net is DeepgramLiveService dropping keyterms on a 4xx and reconnecting.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

test("we never send more keyterms than the empirical cap", () => {
  const { keytermsFor, MAX_KEYTERMS_FOR_TEST } = require("../../apps/api/dist/stt/keyterms");

  // 84 is the smallest count observed to fail for a list of this shape. The cap must
  // stay meaningfully below it — if someone raises MAX_KEYTERMS toward that number,
  // this fails and sends them back to the probe rather than to production.
  const SMALLEST_OBSERVED_FAILURE = 84;
  assert.ok(
    MAX_KEYTERMS_FOR_TEST < SMALLEST_OBSERVED_FAILURE - 8,
    `cap ${MAX_KEYTERMS_FOR_TEST} is too close to the observed failure at ${SMALLEST_OBSERVED_FAILURE}`,
  );

  for (const lang of ["multi", "gu"]) {
    const terms = keytermsFor(lang);
    assert.ok(
      terms.length <= MAX_KEYTERMS_FOR_TEST,
      `${lang}: ${terms.length} keyterms exceeds the ${MAX_KEYTERMS_FOR_TEST} cap`,
    );
    assert.ok(
      terms.length < SMALLEST_OBSERVED_FAILURE,
      `${lang}: ${terms.length} keyterms is at or past the size that 400s`,
    );
  }
});

test("no keyterm is emitted twice — a duplicate wastes a limited slot", () => {
  const { keytermsFor } = require("../../apps/api/dist/stt/keyterms");

  for (const lang of ["multi", "gu"]) {
    const terms = keytermsFor(lang);
    assert.equal(new Set(terms).size, terms.length, `${lang}: duplicate keyterms present`);
  }
});

test("the micro-markets that drive the pitch survive the cap", () => {
  const { keytermsFor } = require("../../apps/api/dist/stt/keyterms");

  // These sit at the head of the lists precisely so truncation can never reach them.
  // If this fails the ordering was disturbed — the residence-area names at the tail
  // are what should be sacrificed instead.
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

test("a rejected upgrade retries WITHOUT keyterms instead of replaying the same URL", () => {
  // The cap above is a guess; this is the guarantee. Pin that the service actually
  // has the downgrade path, so a future keyterm mistake degrades transcript quality
  // rather than leaving Maya deaf for the whole call.
  const fs = require("node:fs");
  const src = fs.readFileSync("apps/api/src/stt/deepgram-live.service.ts", "utf8");

  assert.match(src, /unexpected-response/, "must handle the refused-upgrade event");
  assert.match(src, /keytermsDisabled = true/, "a 4xx must disable keyterms for the retry");
  assert.match(
    src,
    /buildUrl\(\)/,
    "the URL must be rebuilt per attempt, or the retry replays the rejected one",
  );
});

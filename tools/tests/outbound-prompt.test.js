/**
 * Outbound-call prompt branching.
 * Run with: pnpm build && node --test tools/tests/outbound-prompt.test.js
 *
 * Behaviour these tests pin (see buildSystemPrompt in call-runtime.service.ts and
 * buildSystemPromptGu in i18n/prompt-gu.ts):
 *  - On an OUTBOUND call (we dialed a lead we already hold details for) Maya never
 *    asks for the name (step 6) or the profession / area of residence (step 8) —
 *    the agreed time goes straight to the confirmation.
 *  - On an INBOUND call the caller is a stranger, so both steps stay as they were.
 *  - All THREE personas (hi / en / gu) branch the same way; they drift easily
 *    because the Gujarati prompt lives in a separate file.
 *
 * WHY THIS EXISTS: steps 6 and 8 are interpolated into three long template
 * literals. A bad edit can leave the ORIGINAL step text in place with the
 * interpolation appended after it — which still compiles, still renders, and
 * silently tells Maya both to ask and to skip. Only reading the rendered prompt
 * catches that, so these tests assert on the rendered output, not the source.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

// The affirmative step text — present ONLY when Maya should actually ask.
// Deliberately NOT matching on the question itself ("आपका नाम क्या है"), because
// the outbound branch quotes that same question inside its prohibition.
const ASK_NAME = {
  hi: /^6\. NAME: Once they confirm a time, immediately ask for their name/m,
  en: /^6\. NAME: Once they confirm a time, immediately ask for their name/m,
  gu: /^6\. NAME: તેઓ time confirm કરે કે તરત તેમનું નામ પૂછો/m,
};
const ASK_KNOW_THEM = {
  hi: /^8\. KNOW THEM \(after confirmation/m,
  en: /^8\. KNOW THEM \(after confirmation/m,
  gu: /^8\. KNOW THEM \(confirmation પછી/m,
};
const SKIP_NAME = /^6\. NAME (?:—|-) (?:इस call पर SKIP|SKIP IT ON THIS CALL|આ call પર SKIP)/m;
const SKIP_KNOW_THEM = /^8\. KNOW THEM (?:—|-) (?:इस call पर SKIP|SKIP IT ON THIS CALL|આ call પર SKIP)/m;

// Render a prompt without booting Nest: buildSystemPrompt only touches the two
// repositories and the logger, so a bare prototype instance with stubs is enough.
async function renderPrompt(locale, { isOutbound, fullName }) {
  const {
    CallRuntimeService,
  } = require("../../apps/api/dist/call-runtime/call-runtime.service");
  const svc = Object.create(CallRuntimeService.prototype);
  svc.campaignRepo = { findById: async () => ({ name: "Test Campaign", notes: "" }) };
  svc.targetRepo = { findById: async () => (fullName ? { fullName } : null) };
  svc.logger = { warn() {}, log() {} };
  svc.config = { get: () => undefined };
  // langMode() collapses gu -> hi when the Gujarati kill switch is off (no
  // SARVAM_API_KEY), which would silently make the gu cases assert the Hindi
  // prompt. Force it on so "gu" really renders the Gujarati persona.
  svc.tts = { isGujaratiEnabled: () => true };
  return svc.buildSystemPrompt(locale, "campaign-1", "target-1", isOutbound);
}

const LOCALES = [
  ["hi", "hi-IN"],
  ["en", "en-IN"],
  ["gu", "gu-IN"],
];

test("outbound calls never ask for the name or the know-them questions", async () => {
  for (const [mode, locale] of LOCALES) {
    const prompt = await renderPrompt(locale, { isOutbound: true, fullName: "Rahul Shah" });

    assert.match(prompt, SKIP_NAME, `${mode}: step 6 should be the SKIP variant`);
    assert.match(prompt, SKIP_KNOW_THEM, `${mode}: step 8 should be the SKIP variant`);
    // The originals must be GONE, not merely followed by the skip instruction —
    // that is the exact corruption this file exists to catch.
    assert.doesNotMatch(prompt, ASK_NAME[mode], `${mode}: the ask-for-name step must not remain`);
    assert.doesNotMatch(
      prompt,
      ASK_KNOW_THEM[mode],
      `${mode}: the know-them step must not remain`,
    );
  }
});

test("outbound prompts carry the known lead name into the confirmation", async () => {
  for (const [mode, locale] of LOCALES) {
    const withName = await renderPrompt(locale, { isOutbound: true, fullName: "Rahul Shah" });
    assert.ok(
      /Rahul Shah/.test(withName.match(/^6\. NAME[^\n]*/m)[0]),
      `${mode}: step 6 should hand Maya the name she already has`,
    );

    // No name on file: confirm without one, and still never ask.
    const noName = await renderPrompt(locale, { isOutbound: true, fullName: null });
    const step6 = noName.match(/^6\. NAME[^\n]*/m)[0];
    assert.ok(!/Rahul Shah/.test(step6), `${mode}: no name should be invented`);
    assert.match(noName, SKIP_NAME, `${mode}: still the SKIP variant without a name`);
  }
});

test("inbound calls keep asking for the name and the know-them questions", async () => {
  for (const [mode, locale] of LOCALES) {
    const prompt = await renderPrompt(locale, { isOutbound: false, fullName: null });

    assert.match(prompt, ASK_NAME[mode], `${mode}: inbound must still ask for the name`);
    assert.match(prompt, ASK_KNOW_THEM[mode], `${mode}: inbound must keep the know-them step`);
    assert.doesNotMatch(prompt, SKIP_NAME, `${mode}: inbound must not skip step 6`);
    assert.doesNotMatch(prompt, SKIP_KNOW_THEM, `${mode}: inbound must not skip step 8`);
  }
});

// A real inbound call re-opened a settled booking: after the 2 PM / 16 Aug slot was
// confirmed, the step-8 "where do you live?" answer ("I live in London") re-fired the
// OUT OF TOWN branch — Maya re-asked the return date and tried to re-schedule, throwing
// the confirmed slot away. The fix is a governing discipline at the top of CALL FLOW.
// It is an English-header block quoted verbatim into all THREE personas, so a drift in
// any one language is what this test exists to catch.
test("every persona carries the frozen-booking / conversation-memory discipline", async () => {
  const MARKERS = [
    "MEMORY & A FIXED BOOKING",
    "ONCE A VISIT DAY + TIME IS CONFIRMED, IT IS FROZEN",
    "STEP 8 IS SMALL TALK, NOT SCHEDULING",
  ];
  for (const [mode, locale] of LOCALES) {
    const prompt = await renderPrompt(locale, { isOutbound: false, fullName: null });
    for (const marker of MARKERS) {
      assert.ok(
        prompt.includes(marker),
        `${mode}: the "${marker}" rule is missing — a confirmed slot can be re-opened`,
      );
    }
  }
});

test("the budget ladder offers 3, 5, 8, 10, 15, 25 Cr in every language", async () => {
  const ladders = {
    "hi-IN": /3 करोड़, 5 करोड़, 8 करोड़, 10 करोड़, 15 करोड़, 25 करोड़/,
    "en-IN": /3 Crore, 5 Crore, 8 Crore, 10 Crore, 15 Crore, 25 Crore/,
    "gu-IN": /3 કરોડ, 5 કરોડ, 8 કરોડ, 10 કરોડ, 15 કરોડ, 25 કરોડ/,
  };
  for (const [locale, ladder] of Object.entries(ladders)) {
    const prompt = await renderPrompt(locale, { isOutbound: true, fullName: "Rahul Shah" });
    assert.match(prompt, ladder, `${locale}: budget tiers must include the 8 Cr step`);
    // The pre-8-Cr ladder must be gone everywhere, not just in step 2.
    assert.doesNotMatch(
      prompt,
      /5 (?:करोड़|Crore|કરોડ), 10 /,
      `${locale}: a stale ladder without 8 Cr survives`,
    );
  }
});

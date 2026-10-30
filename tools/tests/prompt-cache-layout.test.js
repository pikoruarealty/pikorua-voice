/**
 * Prompt cache layout invariants.
 *
 * The per-call details (lead name, campaign, briefing, outbound name note) were
 * moved from the TOP of the system prompt to a short tail after
 * PROMPT_CACHE_SPLIT, so the big body is identical for every call and one cached
 * copy is shared across calls. These tests prove that move:
 *   1. changed no words — the prompt's word multiset is byte-identical to the
 *      pre-change prompt (pinned as a sha256 per language × direction);
 *   2. left nothing per-call in the shared body;
 *   3. reaches the model as two cached system parts, with the marker stripped.
 *
 * If you change the prompt ON PURPOSE, test 1 will fail: re-pin the hashes.
 *
 * Run with: pnpm build && node --test tools/tests/prompt-cache-layout.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");

const { PROMPT_CACHE_SPLIT } = require("../../apps/api/dist/llm/prompt-cache");

async function renderPrompt(locale, isOutbound, { lead = "LEAD_X", campaign = "CAMPAIGN_X", notes = "" } = {}) {
  const { CallRuntimeService } = require("../../apps/api/dist/call-runtime/call-runtime.service");
  const svc = Object.create(CallRuntimeService.prototype);
  svc.campaignRepo = { findById: async () => ({ name: campaign, notes }) };
  svc.targetRepo = { findById: async () => ({ fullName: lead }) };
  svc.logger = { warn() {}, log() {} };
  svc.config = { get: () => undefined };
  svc.tts = { isGujaratiEnabled: () => true };
  return svc.buildSystemPrompt(locale, "campaign-1", "target-1", isOutbound);
}

const wordHash = (text) =>
  crypto
    .createHash("sha256")
    .update(text.split(/\s+/).filter(Boolean).sort().join("\n"))
    .digest("hex");

// sha256 of the sorted words of each prompt BEFORE the cache-layout change
// (rendered with lead "LEAD_X", campaign "CAMPAIGN_X", no notes).
const PRE_CHANGE_WORD_HASH = {
  "hi-IN-in": "f9a8352fcc051e30316fc731289f0748323c7c26f5a3cf5dada621cc57ac4857",
  "hi-IN-out": "d78c82a0a58514ee7c9092db55f113c7f3fdcd215abe16d4aa4c1a482d6f6fe1",
  "en-IN-in": "d43c04acf44757d2133165b2e8470786d3515f033a2dd73aab15e4f5a3e3f068",
  "en-IN-out": "d4642dbc51555ab246f79915d84c447831816723399febbb78704e8131076942",
  "gu-IN-in": "027c49262f69ec44d9bacf087c6e84df60ac47e221a6c3b18a17714a5ff9c626",
  "gu-IN-out": "2bad27bb2051bfb6120073fe7144bfc0425550946303177ef233bcc2a626fae7",
};

const VARIANTS = ["hi-IN", "en-IN", "gu-IN"].flatMap((locale) => [
  [locale, false],
  [locale, true],
]);

test("the cache layout changed no words of any prompt", async () => {
  for (const [locale, isOutbound] of VARIANTS) {
    const key = `${locale}-${isOutbound ? "out" : "in"}`;
    const prompt = await renderPrompt(locale, isOutbound);
    assert.equal(
      wordHash(prompt.split(PROMPT_CACHE_SPLIT).join("\n")),
      PRE_CHANGE_WORD_HASH[key],
      `${key}: the prompt's words differ from the pre-change prompt`,
    );
  }
});

test("the shared body is identical across calls and holds no per-call detail", async () => {
  for (const [locale, isOutbound] of VARIANTS) {
    const a = await renderPrompt(locale, isOutbound, {
      lead: "Rahul Shah",
      campaign: "Campaign One",
      notes: "Briefing one",
    });
    const b = await renderPrompt(locale, isOutbound, {
      lead: "Priya Mehta",
      campaign: "Campaign Two",
      notes: "",
    });
    const [bodyA, tailA, ...restA] = a.split(PROMPT_CACHE_SPLIT);
    const [bodyB] = b.split(PROMPT_CACHE_SPLIT);
    assert.equal(restA.length, 0, `${locale}: exactly one split marker`);
    assert.equal(bodyA, bodyB, `${locale}/${isOutbound}: body must not vary per call`);
    for (const perCall of ["Rahul Shah", "Campaign One", "Briefing one"]) {
      assert.ok(!bodyA.includes(perCall), `${locale}: "${perCall}" leaked into the shared body`);
      assert.ok(tailA.includes(perCall), `${locale}: "${perCall}" missing from the call tail`);
    }
  }
});

test("the model gets two cached system parts and never sees the marker", () => {
  const { LlmService } = require("../../apps/api/dist/llm/llm.service");
  const svc = new LlmService({ get: () => undefined });
  const prompt = `BODY${PROMPT_CACHE_SPLIT}TAIL`;

  const [claude] = svc.buildOrMessages([], prompt, "anthropic/claude-haiku-4-5");
  assert.deepEqual(
    claude.content.map((p) => [p.text, p.cache_control?.type]),
    [
      ["BODY", "ephemeral"],
      ["TAIL", "ephemeral"],
    ],
  );

  const [plain] = svc.buildOrMessages([], prompt, "meta-llama/llama-3.3-70b-instruct:free");
  assert.equal(plain.content, "BODY\n\nTAIL");
});

/**
 * CRM `lead` block — the flat contact card the CRM renders directly.
 *
 * Agreed shape: { name, phone, company, profession, city, budget, requirements }.
 *
 * Before this existed, the payload carried no top-level name or phone at all, so
 * every lead card read "Unknown" with a mangled number — while the voice path and
 * the sync log both looked perfectly healthy.
 *
 * Run with: node --test tools/tests/crm-lead-block.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const { buildCallResultPayload } = require(
  path.resolve(__dirname, "../../apps/worker/dist/postcall/crm-payload.js"),
);

const baseScore = {
  value: 70,
  label: "warm",
  rationale: "…",
  timeline: "short_term",
  positive: [],
  negative: [],
  source: "llm",
  scoredAt: "2026-07-21T06:00:00.000Z",
  breakdown: null,
};

const build = (over = {}) =>
  buildCallResultPayload({
    call: {
      id: "call-1",
      direction: "outbound",
      fromNumber: "07948501161",
      toNumber: "+919427620852",
      status: "completed",
      locale: "gu-IN",
      ...(over.call ?? {}),
    },
    turns: [],
    campaign: null,
    events: [],
    score: { ...baseScore, ...(over.score ?? {}) },
    target: over.target,
  });

const LEAD_KEYS = ["name", "phone", "company", "profession", "city", "budget", "requirements"];

test("the lead block has exactly the agreed keys", () => {
  const { lead } = build();
  assert.deepEqual(Object.keys(lead).sort(), [...LEAD_KEYS].sort());
});

// from/to SWAP by direction. Sending both and letting the CRM guess is what
// produced broken lead cards — the ExoPhone must never land in `lead.phone`.
test("lead.phone is the caller's number on BOTH directions, never the ExoPhone", () => {
  assert.equal(build().lead.phone, "+919427620852", "outbound: the callee");

  const inbound = build({
    call: { direction: "inbound", fromNumber: "09427620852", toNumber: "07948501161" },
  });
  assert.equal(inbound.lead.phone, "+919427620852", "inbound: the caller");
});

// Exotel returns "09427620852" / "9427620852" / "+919427620852" interchangeably.
// The leading 0 is a domestic trunk prefix; pasting a country code in front of it
// yields "+0 94276 20852", which is what the CRM was displaying.
test("phone numbers are normalized to E.164, dropping the trunk prefix", () => {
  const cases = [
    ["09427620852", "+919427620852"],
    ["9427620852", "+919427620852"],
    ["+919427620852", "+919427620852"],
    ["919427620852", "+919427620852"],
    ["+91 94276 20852", "+919427620852"],
  ];
  for (const [raw, want] of cases) {
    assert.equal(build({ call: { toNumber: raw } }).lead.phone, want, `input ${raw}`);
  }
});

// A human-entered dial-list name beats the scorer's extraction: STT mangles spoken
// names, a campaign upload does not.
test("the campaign target's fullName wins over the scorer's extracted name", () => {
  const scored = build({ score: { breakdown: { name: "Nikhilé" } } });
  assert.equal(scored.lead.name, "Nikhilé", "falls back to the scorer when no target");

  const withTarget = build({
    score: { breakdown: { name: "Nikhilé" } },
    target: { fullName: "Nikhil Trivedi" },
  });
  assert.equal(withTarget.lead.name, "Nikhil Trivedi");
});

// Models emit "", "unknown", "N/A" for facts that were never disclosed. Passing
// those through puts the literal word "unknown" on a lead card, which reads as a
// real answer rather than a gap.
test("placeholder values are nulled, not shown as answers", () => {
  const { lead } = build({
    score: {
      breakdown: {
        name: "",
        company: "unknown",
        profession: "N/A",
        location: "  ",
        budget: "not stated",
        requirements: "5 BHK",
      },
    },
  });
  assert.equal(lead.name, null);
  assert.equal(lead.company, null);
  assert.equal(lead.profession, null);
  assert.equal(lead.city, null);
  assert.equal(lead.budget, null);
  assert.equal(lead.requirements, "5 BHK", "a real value still comes through");
});

// The nested copies stay: the CRM reads `lead`, but score.breakdown is the
// existing contract and dropping it would break whatever already consumes it.
test("lead does not replace score.breakdown", () => {
  const payload = build({ score: { breakdown: { profession: "Director" } } });
  assert.equal(payload.lead.profession, "Director");
  assert.equal(payload.score.breakdown.profession, "Director");
});

// A call with no scorer output at all must still produce a well-formed block —
// the heuristic fallback path has no breakdown.
test("a null breakdown yields nulls, not a crash", () => {
  const { lead } = build({ score: { breakdown: null } });
  for (const key of LEAD_KEYS) {
    if (key === "phone") continue;
    assert.equal(lead[key], null, `${key} must be null`);
  }
  assert.equal(lead.phone, "+919427620852", "phone comes from the call row, not the score");
});

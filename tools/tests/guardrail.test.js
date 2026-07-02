/**
 * Guardrail service tests — hard rules and semantic check structure.
 * Run with: node --test tools/tests/guardrail.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

test("GuardrailService has checkHard, checkSemantic, and check methods", () => {
  const src = read("apps/api/src/llm/guardrail.service.ts");
  assert.match(src, /checkHard\(/, "checkHard method must exist");
  assert.match(src, /checkSemantic\(/, "checkSemantic method must exist");
  assert.match(src, /async check\(/, "async check method must exist");
});

test("hard guardrail catches exact pricing language synchronously", () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");
  const svc = new GuardrailService({ get: () => undefined });

  const hit = svc.checkHard("The property costs ₹85 lakhs after discount.");
  assert.equal(hit.triggered, true);
  assert.equal(hit.rule, "pricing_claim");
  assert.ok(hit.replacement, "replacement must be set");
});

test("hard guardrail catches ROI guarantee language", () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");
  const svc = new GuardrailService({ get: () => undefined });

  const hit = svc.checkHard("This project will definitely appreciate 30% in 2 years.");
  assert.equal(hit.triggered, true);
  assert.equal(hit.rule, "roi_guarantee");
});

test("hard guardrail catches fabricated inventory language", () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");
  const svc = new GuardrailService({ get: () => undefined });

  const hit = svc.checkHard("Only 3 units left — inventory is limited!");
  assert.equal(hit.triggered, true);
  assert.equal(hit.rule, "fabricated_inventory");
});

test("hard guardrail catches an internal price-sheet leak (₹ figure or [internal] marker)", () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");
  const svc = new GuardrailService({ get: () => undefined });

  // A prompt-extraction / regression leak of the internal inventory pricing.
  const leak = svc.checkHard("At Sindhu Bhavan Road the 4 BHK is ₹3+ Cr [internal].");
  assert.equal(leak.triggered, true);
  assert.equal(leak.rule, "internal_pricing_leak");
  assert.ok(leak.replacement, "a safe deflection must replace the leaked price");

  // The "[internal]" table marker alone is also a leak signal.
  const marker = svc.checkHard("Nehrunagar 4 BHK ₹3+ Cr [internal], Pre-Launch.");
  assert.equal(marker.triggered, true);
  assert.equal(marker.rule, "internal_pricing_leak");
});

test("hard guardrail does NOT flag Maya's legitimate spoken budget tiers", () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");
  const svc = new GuardrailService({ get: () => undefined });

  // Maya offers budget tiers in spoken Hindi — no ₹ symbol, no [internal] marker.
  // This must stay clean, otherwise the budget step breaks on every vague answer.
  const tiers = svc.checkHard(
    "कोई बात नहीं — 3 करोड़, 5 करोड़, 10 करोड़, 15 करोड़, या 25 करोड़ — इनमें से कौन-सा comfortable रहेगा?",
  );
  assert.equal(tiers.triggered, false);
  assert.equal(tiers.rule, null);
});

test("hard guardrail passes clean concierge response", () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");
  const svc = new GuardrailService({ get: () => undefined });

  const result = svc.checkHard(
    "Thank you for your interest! Could you tell me more about your budget range so I can connect you with the right consultant?",
  );
  assert.equal(result.triggered, false);
  assert.equal(result.rule, null);
});

test("semantic check returns clean when no LLM key is configured (graceful degradation)", async () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");
  const svc = new GuardrailService({ get: () => undefined });

  // Without any API keys the semantic check must degrade gracefully
  const result = await svc.checkSemantic("This property has great views.");
  assert.equal(result.triggered, false);
});

test("semantic check parses valid LLM violation JSON correctly", () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");
  const svc = new GuardrailService({ get: () => undefined });

  // Access private method through prototype for unit testing
  const parse = svc["parseSemanticResult"].bind(svc);

  const violation = parse(
    JSON.stringify({ violated: true, rule: "roi_guarantee", safeSummary: "I cannot make guarantees." }),
    "test",
  );
  assert.equal(violation.triggered, true);
  assert.equal(violation.rule, "roi_guarantee");
  assert.equal(violation.replacement, "I cannot make guarantees.");
});

test("semantic check strips markdown code fences from LLM response", () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");
  const svc = new GuardrailService({ get: () => undefined });

  const parse = svc["parseSemanticResult"].bind(svc);

  const fenced = parse(
    "```json\n" + JSON.stringify({ violated: false, rule: null, safeSummary: null }) + "\n```",
    "test",
  );
  assert.equal(fenced.triggered, false);
});

test("check() runs hard rules first and short-circuits before semantic call", async () => {
  const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");

  let semanticCalled = false;
  const svc = new GuardrailService({ get: () => undefined });
  // Patch checkSemantic so we can detect if it was called
  svc.checkSemantic = async () => {
    semanticCalled = true;
    return { triggered: false, rule: null, replacement: null };
  };

  await svc.check("The property costs ₹85 lakhs after discount.");

  assert.equal(semanticCalled, false, "checkSemantic must not be called when hard rule triggers");
});

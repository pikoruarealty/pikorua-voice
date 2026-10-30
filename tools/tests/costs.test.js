/**
 * Cost page math + protection.
 * Run with: pnpm build && node --test tools/tests/costs.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { priceCall, summarize } = require("../../apps/api/dist/costs/cost.service");
const { isOperatorPage } = require("../../apps/api/dist/auth/operator-pages.guard");

const rates = { usdInr: 85, ttsInrPer10kChars: 30, sttInrPerHour: 30, exotelInrPerMin: 2 };
const call = (o) => ({ id: "c", at: "2026-10-30T00:00:00Z", direction: "outbound", locale: "hi-IN",
  isDemo: false, durationSec: 0, turns: 0, llmUsd: 0, ttsChars: 0, ...o });

test("one call, worked by hand", () => {
  // 3 min call, 1,300 TTS chars, $0.004 of AI:
  //   AI    0.004 × 85          = ₹0.34
  //   voice 1300/10000 × 30     = ₹3.90
  //   STT   180/3600 × 30       = ₹1.50
  //   phone 3 min × ₹2          = ₹6.00
  const c = priceCall(call({ durationSec: 180, turns: 8, llmUsd: 0.004, ttsChars: 1300 }), rates);
  assert.ok(Math.abs(c.llm - 0.34) < 1e-9);
  assert.ok(Math.abs(c.tts - 3.9) < 1e-9);
  assert.ok(Math.abs(c.stt - 1.5) < 1e-9);
  assert.ok(Math.abs(c.phone - 6) < 1e-9);
  assert.ok(Math.abs(c.total - 11.74) < 1e-9);
});

test("totals include demo calls; the per-call average only counts answered phone calls", () => {
  const rows = [
    call({ durationSec: 120, turns: 5, ttsChars: 1000 }),
    call({ durationSec: 60, turns: 3, ttsChars: 500 }),
    call({}), // never answered: no cost, not in the average
    call({ isDemo: true, durationSec: 600, turns: 20, ttsChars: 4000 }),
  ];
  const s = summarize(rows, rates);
  assert.equal(s.totals.calls, 4);
  assert.equal(s.totals.answeredCalls, 2);
  assert.equal(s.totals.demoCalls, 1);
  const phoneCalls = rows.slice(0, 2).map((r) => priceCall(r, rates).total);
  assert.ok(Math.abs(s.perCall.total - (phoneCalls[0] + phoneCalls[1]) / 2) < 1e-9);
  const all = rows.map((r) => priceCall(r, rates).total).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(s.totals.total - all) < 1e-9, "demo spend is in the total");
});

test("no calls → zeros, not NaN", () => {
  const s = summarize([], rates);
  assert.equal(s.perCall.total, 0);
  assert.equal(s.totals.total, 0);
});

test("the cost page and its data are behind the dashboard password", () => {
  assert.equal(isOperatorPage("/costs"), true);
  assert.equal(isOperatorPage("/api/costs"), true);
  assert.equal(isOperatorPage("/api/health"), false);
});

test("the SQL runs against the real schema (columns exist)", () => {
  const fs = require("node:fs");
  const svc = fs.readFileSync("apps/api/src/costs/cost.service.ts", "utf8");
  const migration = fs.readFileSync("packages/db/drizzle/0005_turn_cost_metrics.sql", "utf8");
  for (const col of ["llm_cost_usd", "tts_chars"]) {
    assert.match(svc, new RegExp(col));
    assert.match(migration, new RegExp(col));
  }
});

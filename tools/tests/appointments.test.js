const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");

// Pure scheduling / date logic for the site-visit reconfirmation (#2) and
// post-visit feedback (#4) features. These run against the compiled worker dist,
// so `pnpm build` (or the root `pnpm test`) must have run first.

const {
  dueReminder,
  dueFeedback,
  T24_WINDOW_MS,
  T2_WINDOW_MS,
  MIN_REMINDER_LEAD_MS,
} = require("../../apps/worker/dist/appointments/appointment-window");
const { resolveVisitDate, formatIstWhen } = require("../../apps/worker/dist/appointments/visit-date");
const { LeadScoreLlmSchema } = require("../../apps/worker/dist/postcall/lead-score.schema");

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-07-13T06:00:00.000Z"); // 11:30 AM IST

// ─── dueReminder ─────────────────────────────────────────────────────────────

test("dueReminder: a visit ~20h out fires the T-24h reminder once", () => {
  const scheduledAt = new Date(now.getTime() + 20 * HOUR);
  assert.equal(dueReminder(scheduledAt, now, false, false), "t24");
  // Already sent → does not fire again.
  assert.equal(dueReminder(scheduledAt, now, true, false), null);
});

test("dueReminder: a visit ~90min out fires the T-2h reminder (never T-24h)", () => {
  const scheduledAt = new Date(now.getTime() + 90 * 60 * 1000);
  assert.equal(dueReminder(scheduledAt, now, false, false), "t2");
  assert.equal(dueReminder(scheduledAt, now, false, true), null);
});

test("dueReminder: more than 24h out is not due yet", () => {
  const scheduledAt = new Date(now.getTime() + 30 * HOUR);
  assert.equal(dueReminder(scheduledAt, now, false, false), null);
});

test("dueReminder: within the min lead (or past) never fires", () => {
  assert.equal(dueReminder(new Date(now.getTime() + 5 * 60 * 1000), now, false, false), null);
  assert.equal(dueReminder(new Date(now.getTime() - HOUR), now, false, false), null);
});

test("dueReminder: the two windows are mutually exclusive and each fires once", () => {
  // Just inside 24h → t24; just inside 2h → t2.
  assert.equal(dueReminder(now.getTime() + T24_WINDOW_MS - 1000, now, false, false), "t24");
  assert.equal(dueReminder(now.getTime() + T2_WINDOW_MS - 1000, now, false, false), "t2");
  assert.equal(dueReminder(now.getTime() + MIN_REMINDER_LEAD_MS - 1000, now, false, false), null);
});

// ─── dueFeedback ─────────────────────────────────────────────────────────────

test("dueFeedback: fires only once the visit + delay has passed", () => {
  const scheduledAt = new Date(now.getTime() - 4 * HOUR); // visit was 4h ago
  assert.equal(dueFeedback(scheduledAt, now, 3 * HOUR, false), true); // 4h ago, 3h delay → due
  assert.equal(dueFeedback(scheduledAt, now, 6 * HOUR, false), false); // 6h delay → not yet
  assert.equal(dueFeedback(scheduledAt, now, 3 * HOUR, true), false); // already sent
});

// ─── resolveVisitDate ────────────────────────────────────────────────────────

test("resolveVisitDate: gapDays lands on the default 11:00 IST slot", () => {
  const d = resolveVisitDate(now, 3);
  assert.ok(d instanceof Date);
  // 11:00 IST == 05:30 UTC.
  assert.equal(d.getUTCHours(), 5);
  assert.equal(d.getUTCMinutes(), 30);
  // 3 days ahead of 2026-07-13 (IST) → 2026-07-16.
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 6); // July (0-indexed)
  assert.equal(d.getUTCDate(), 16);
  assert.ok(d.getTime() > now.getTime());
});

test("resolveVisitDate: returns null for missing / negative / absurd / past gaps", () => {
  assert.equal(resolveVisitDate(now, null), null);
  assert.equal(resolveVisitDate(now, undefined), null);
  assert.equal(resolveVisitDate(now, -1), null);
  assert.equal(resolveVisitDate(now, 999), null);
  // gapDays 0 after 11:00 IST → the slot already passed today → null.
  const afternoon = new Date("2026-07-13T09:00:00.000Z"); // 2:30 PM IST
  assert.equal(resolveVisitDate(afternoon, 0), null);
});

test("formatIstWhen renders a readable IST time", () => {
  const d = resolveVisitDate(now, 3);
  const s = formatIstWhen(d);
  assert.match(s, /11:00\s*AM/i);
  assert.match(s, /July/);
});

// ─── objection extraction (#4 schema) ────────────────────────────────────────

test("lead score schema parses objections and defaults to [] when absent", () => {
  const withObjections = LeadScoreLlmSchema.parse({
    score: 40,
    label: "cold",
    rationale: "Visited but hesitant on price.",
    timeline: "exploring",
    breakdown: {
      objections: [
        { category: "price", detail: "budget thoda tight hai" },
        { category: "possession_timeline", detail: "wants ready-to-move" },
      ],
    },
  });
  assert.equal(withObjections.breakdown.objections.length, 2);
  assert.equal(withObjections.breakdown.objections[0].category, "price");

  const noBreakdown = LeadScoreLlmSchema.parse({
    score: 60,
    label: "warm",
    rationale: "Interested.",
    timeline: "short_term",
  });
  assert.deepEqual(noBreakdown.breakdown.objections, []);
});

test("an unknown objection category coerces to 'other' instead of failing the parse", () => {
  const parsed = LeadScoreLlmSchema.parse({
    score: 30,
    label: "cold",
    rationale: "x",
    timeline: "unknown",
    breakdown: { objections: [{ category: "vastu", detail: "direction wrong" }] },
  });
  assert.equal(parsed.breakdown.objections[0].category, "other");
  assert.equal(parsed.breakdown.objections[0].detail, "direction wrong");
});

// ─── wiring guards (source-level regression checks) ──────────────────────────

test("call runtime selects a reconfirm/feedback script variant, default untouched", () => {
  const src = read("apps/api/src/call-runtime/call-runtime.service.ts");
  // The variant branch is chosen by scriptRef; the default flow still calls the
  // big buildSystemPrompt.
  assert.match(src, /scriptRef === "reconfirm" \|\| scriptRef === "feedback"/);
  assert.match(src, /buildScriptPrompt\(/);
  assert.match(src, /this\.buildSystemPrompt\(/);
  // The greeting is scriptRef-aware.
  assert.match(src, /state\.scriptRef === "reconfirm"/);
  assert.match(src, /state\.scriptRef === "feedback"/);
});

test("appointment scheduler is gated behind APPOINTMENTS_OUTBOUND_ENABLED and honors do_not_call", () => {
  const src = read("apps/worker/src/appointments/appointment.scheduler.ts");
  assert.match(src, /APPOINTMENTS_OUTBOUND_ENABLED/);
  // Opt-in gate: it returns early from onModuleInit when disabled.
  assert.match(src, /if \(!this\.enabled\(\)\)/);
  // DNC honored before any reminder/feedback dial.
  assert.match(src, /isPhoneDoNotCall\(appt\.phone\)/);
  // Reminder bookkeeping is marked before enqueue (at-most-once).
  assert.match(src, /markReminder\(appt\.id/);
});

test("reconfirm/feedback scripts use simple spoken Hinglish, not literary Hindi", () => {
  const src = read("apps/api/src/call-runtime/call-runtime.service.ts");
  // Everything Maya SPEAKS (greetings) and the script instructions must stay in
  // everyday spoken Hinglish. These literary/formal words sound wrong on a call.
  // NOTE: they may still appear inside the "never say this" instruction itself,
  // so we check only the greeting + script-body template literals.
  const scriptRegion = src.slice(
    src.indexOf("private greetingText"),
    src.indexOf("private async buildSystemPrompt"),
  );
  const banned = ["हाल ही में", "स्थिति", "प्रतीक्षा", "आवश्यकता", "अवसर", "गर्मजोशी", "धन्यवाद"];
  for (const word of banned) {
    // Allowed exactly once inside the plain-language rule that FORBIDS them.
    const hits = scriptRegion.split(word).length - 1;
    const inBanList = scriptRegion.includes(`कठिन या किताबी Hindi कभी मत बोलिए`);
    assert.ok(
      hits === 0 || (inBanList && hits === 1),
      `"${word}" should not be spoken by Maya (found ${hits}x outside the ban-list rule)`,
    );
  }
  // The plain-language rule itself must be present.
  assert.match(scriptRegion, /कठिन या किताबी Hindi कभी मत बोलिए/);
});

test("objections are surfaced to the CRM payload", () => {
  const src = read("apps/worker/src/postcall/crm-payload.ts");
  assert.match(src, /objections:\s*score\.breakdown\?\.objections/);
});

test("appointments API validates a concrete scheduledAt and resets reminders on reschedule", () => {
  const dto = read("apps/api/src/appointments/dto/appointment.dto.ts");
  assert.match(dto, /scheduledAt:\s*z\.string\(\)\.datetime\(\{ offset: true \}\)/);
  const svc = read("apps/api/src/appointments/appointment.service.ts");
  // A confirmed/rescheduled time clears the reminder flags so they re-fire.
  assert.match(svc, /reminderT24At:\s*null/);
  assert.match(svc, /reminderT2At:\s*null/);
});

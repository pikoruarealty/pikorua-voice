/**
 * Regression test for CallRuntimeService.isMissingCallRow — the detector that
 * decides whether a failed `call_turns` insert is a missing-parent FK violation
 * (SQLSTATE 23503). On a true FK miss, persistence is disabled for that call
 * (unpersistableCalls) so it doesn't re-log a full stack on every single turn.
 *
 * drizzle-orm 0.44.x wraps the driver error in a DrizzleQueryError whose OWN
 * message is just "Failed query: insert into ..." (no FK text) and whose `.code`
 * is undefined — the real postgres.js error, carrying code 23503, is nested in
 * `.cause`. A detector that only inspects the top-level error misses it, the
 * guard never arms, and every turn re-logs a stack trace (observed in prod on
 * 2026-07-04, callId 3b247d1c…). This pins the cause-chain walk.
 *
 * Run with: pnpm build && node --test tools/tests/persist-fk-detection.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const { CallRuntimeService } = require("../../apps/api/dist/call-runtime/call-runtime.service");

function buildRuntime() {
  // isMissingCallRow touches no dependencies, so bare mocks suffice. The
  // constructor only arms an unref'd eviction timer.
  const noopRepo = {
    async findById() {
      return null;
    },
    async update() {},
    async create(t) {
      return t;
    },
  };
  const config = { get: () => undefined };
  const metrics = { increment() {}, observe() {} };
  return new CallRuntimeService(
    /* stt */ {},
    /* llm */ {},
    /* tts */ {},
    /* guardrail */ {},
    /* turnRepo */ noopRepo,
    /* callRepo */ noopRepo,
    /* campaignRepo */ noopRepo,
    /* targetRepo */ noopRepo,
    config,
    metrics,
    /* redis */ null,
  );
}

test("isMissingCallRow detects a Drizzle-wrapped FK violation (code nested in cause)", () => {
  const runtime = buildRuntime();

  // The exact shape drizzle-orm 0.44.7 throws: a top-level "Failed query…" error
  // with no code and no FK text; the real pg error (code 23503) is in `.cause`.
  const pgErr = Object.assign(
    new Error(
      'insert or update on table "call_turns" violates foreign key constraint "call_turns_call_id_calls_id_fk"',
    ),
    { code: "23503", constraint: "call_turns_call_id_calls_id_fk" },
  );
  const drizzleErr = Object.assign(
    new Error('Failed query: insert into "call_turns" (...)\nparams: abc,0,caller,Hello.,hi-IN'),
    { cause: pgErr },
  );

  assert.equal(
    runtime.isMissingCallRow(drizzleErr),
    true,
    "must unwrap .cause to find SQLSTATE 23503",
  );
});

test("isMissingCallRow detects a top-level 23503 (unwrapped driver error)", () => {
  const runtime = buildRuntime();
  const err = Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
  assert.equal(runtime.isMissingCallRow(err), true);
});

test("isMissingCallRow returns false for a transient error (must keep logging it)", () => {
  const runtime = buildRuntime();
  // A connection blip wrapped the same way — NOT an FK miss. Swallowing it as
  // unpersistable would silently stop persisting a call whose row does exist.
  const transient = Object.assign(
    new Error('Failed query: insert into "call_turns" (...)\nparams: ...'),
    { cause: Object.assign(new Error("connection terminated unexpectedly"), { code: "08006" }) },
  );
  assert.equal(runtime.isMissingCallRow(transient), false);
});

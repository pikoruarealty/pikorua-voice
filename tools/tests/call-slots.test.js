/**
 * Call-slot gate invariants (2 calls at a time). Runs the real Lua scripts against
 * ioredis-mock, which executes them in an embedded Lua VM.
 *
 * Run with: pnpm build && node --test tools/tests/call-slots.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const RedisMock = require("ioredis-mock");
const { CallSlots, CALL_SLOT_STALE_MS } = require("../../packages/shared/dist");

async function fresh(max = 2, maxOutbound = 1) {
  const redis = new RedisMock();
  await redis.flushall();
  return new CallSlots(redis, max, maxOutbound);
}

test("a third call is denied while two slots are held", async () => {
  const slots = await fresh(2, 2);
  assert.equal(await slots.acquire("a", "inbound"), true);
  assert.equal(await slots.acquire("b", "inbound"), true);
  assert.equal(await slots.acquire("c", "inbound"), false);
});

test("outbound over its cap is denied while inbound still gets the reserved line", async () => {
  const slots = await fresh(2, 1);
  assert.equal(await slots.acquire("dial:1", "outbound"), true);
  assert.equal(await slots.acquire("dial:2", "outbound"), false);
  assert.equal(await slots.acquire("in:1", "inbound"), true);
});

test("a stale slot (no heartbeat) is reaped", async () => {
  const slots = await fresh(1, 1);
  const t0 = 1_000_000;
  assert.equal(await slots.acquire("crashed", "inbound", { now: t0 }), true);
  assert.equal(await slots.acquire("next", "inbound", { now: t0 + 1000 }), false);
  assert.equal(
    await slots.acquire("next", "inbound", { now: t0 + CALL_SLOT_STALE_MS + 1 }),
    true,
  );
});

test("a heartbeat keeps a held slot alive past the stale window", async () => {
  const slots = await fresh(1, 1);
  const t0 = 1_000_000;
  await slots.acquire("live", "inbound", { now: t0 });
  // Heartbeat = re-acquire by the holder; it never counts against the cap.
  assert.equal(await slots.acquire("live", "inbound", { now: t0 + 60_000 }), true);
  assert.equal(
    await slots.acquire("other", "inbound", { now: t0 + CALL_SLOT_STALE_MS + 1 }),
    false,
  );
});

test("release is idempotent and frees the slot", async () => {
  const slots = await fresh(1, 1);
  await slots.acquire("a", "outbound");
  await slots.release("a");
  await slots.release("a");
  assert.equal(await slots.acquire("b", "outbound"), true);
});

test("rename moves a dial slot to the callId without freeing it", async () => {
  const slots = await fresh(1, 1);
  await slots.acquire("dial:t1", "outbound");
  await slots.rename("dial:t1", "call-1");
  assert.equal(await slots.acquire("x", "inbound"), false, "slot must stay held");
  await slots.release("call-1");
  assert.equal(await slots.acquire("x", "inbound"), true, "renamed member owns the slot");
});

test("a forced acquire (answered outbound call) is never refused", async () => {
  const slots = await fresh(1, 1);
  await slots.acquire("a", "inbound");
  assert.equal(await slots.acquire("call-2", "outbound", { force: true }), true);
});

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.resolve(__dirname, "../../", rel), "utf8");

// The API wakes the spun-down free-tier worker whenever it queues work, so a call's
// post-call job (and outbound dials) get processed instead of waiting in Redis.

test("post-call and dial enqueues both wake the worker", () => {
  const pcq = read("apps/api/src/postcall/postcall.queue.ts");
  assert.match(pcq, /this\.waker\.wake\("post-call"\)/, "post-call enqueue must wake the worker");

  const dq = read("apps/api/src/campaign/dial-queue.service.ts");
  assert.match(dq, /this\.waker\.wake\("dial"\)/, "dial enqueue must wake the worker");
});

test("WorkerWaker is a global module (one shared instance across producers)", () => {
  const mod = read("apps/api/src/worker-waker/worker-waker.module.ts");
  assert.match(mod, /@Global\(\)/);
  assert.match(mod, /exports:\s*\[WorkerWaker\]/);
});

test("WorkerWaker no-ops (no ping, no throw) when the URL is unset or local", () => {
  const { WorkerWaker } = require("../../apps/api/dist/worker-waker/worker-waker.service");

  // Unset → nothing to wake.
  const unset = new WorkerWaker({ get: () => undefined });
  assert.doesNotThrow(() => unset.wake("test"));
  assert.equal(unset.isConfigured(), false);

  // Local dev → the worker runs alongside the API, so there is no spin-down to wake.
  const local = new WorkerWaker({ get: () => "http://localhost:5000/health" });
  assert.doesNotThrow(() => local.wake("test"));
  assert.equal(local.isConfigured(), false);
  // A second call is also safe (throttle + no-op paths).
  assert.doesNotThrow(() => local.wake("test"));

  // A real remote URL is considered configured.
  const remote = new WorkerWaker({ get: () => "https://worker.example.com/health" });
  assert.equal(remote.isConfigured(), true);
});

test("keep-alive window is evaluated in IST", () => {
  const {
    istHour,
    inKeepaliveWindowIst,
  } = require("../../apps/api/dist/worker-waker/worker-availability.scheduler");

  // 06:00 UTC == 11:30 AM IST.
  assert.equal(istHour(new Date("2026-07-13T06:00:00Z")), 11);
  assert.equal(inKeepaliveWindowIst(new Date("2026-07-13T06:00:00Z"), 10, 18), true);
  // 03:30 UTC == 9:00 AM IST → before the window.
  assert.equal(inKeepaliveWindowIst(new Date("2026-07-13T03:30:00Z"), 10, 18), false);
  // 14:30 UTC == 8:00 PM IST → after the window.
  assert.equal(inKeepaliveWindowIst(new Date("2026-07-13T14:30:00Z"), 10, 18), false);
  // End is exclusive: 12:30 UTC == 6:00 PM IST → out.
  assert.equal(inKeepaliveWindowIst(new Date("2026-07-13T12:30:00Z"), 10, 18), false);
});

test("availability scheduler does wake-ahead AND business-hours keep-alive", () => {
  const src = read("apps/api/src/worker-waker/worker-availability.scheduler.ts");
  assert.match(src, /countImminentReminders\(/, "must query for imminent reminders (wake-ahead)");
  assert.match(src, /this\.waker\.wake\("reminder-ahead"\)/);
  assert.match(src, /inKeepaliveWindowIst\(/, "must gate keep-alive on the IST window");
  assert.match(src, /this\.waker\.wake\("keep-alive"\)/);
  // Idle when there is no worker URL to ping.
  assert.match(src, /this\.waker\.isConfigured\(\)/);
});

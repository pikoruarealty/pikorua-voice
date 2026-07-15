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

  // Local dev → the worker runs alongside the API, so there is no spin-down to wake.
  const local = new WorkerWaker({ get: () => "http://localhost:5000/health" });
  assert.doesNotThrow(() => local.wake("test"));
  // A second call is also safe (throttle + no-op paths).
  assert.doesNotThrow(() => local.wake("test"));
});

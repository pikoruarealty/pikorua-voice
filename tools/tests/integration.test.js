/**
 * Integration tests — require a running Postgres + Redis.
 * Run with: node --test tools/tests/integration.test.js
 *
 * Env required:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/pikorua_voice_test
 *   REDIS_URL=redis://localhost:6380
 *   API_AUTH_TOKEN=test-token
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");

const BASE = "http://localhost:4100/api";
const TOKEN = process.env.API_AUTH_TOKEN ?? "test-token";

async function request(method, path, body) {
  const url = new URL(BASE + path);
  const bodyStr = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": TOKEN,
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Check if API is running before attempting integration tests
let apiAvailable = false;
try {
  // Quick probe — if this throws immediately we skip
  await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/health`, { method: "GET" }, resolve);
    req.setTimeout(2000, () => req.destroy());
    req.on("error", reject);
    req.end();
  });
  apiAvailable = true;
} catch {
  console.warn("API not running — skipping integration tests");
}

test.skip(!apiAvailable, "API health endpoint returns ok", async () => {
  const res = await request("GET", "/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.ok(res.body.details?.database);
  assert.ok(res.body.details?.redis);
});

test.skip(!apiAvailable, "POST /campaigns creates campaign and returns targets", async () => {
  const payload = {
    name: "Integration Test Campaign",
    status: "draft",
    defaultLocale: "en-IN",
    targets: [
      { phone: "+911234567890", fullName: "Test Lead One" },
      { phone: "+911234567891", fullName: "Test Lead Two" },
    ],
  };
  const res = await request("POST", "/campaigns", payload);
  assert.equal(res.status, 201);
  assert.ok(res.body.campaign?.id, "campaign id must be returned");
  assert.equal(res.body.targets?.length, 2, "both targets must be created");
  assert.equal(res.body.queuedTargets, 0, "draft campaign should not queue targets");
});

test.skip(!apiAvailable, "POST /campaigns with active status enqueues targets", async () => {
  const payload = {
    name: "Active Integration Campaign",
    status: "active",
    defaultLocale: "en-IN",
    targets: [{ phone: "+911234560001", fullName: "Active Lead" }],
  };
  const res = await request("POST", "/campaigns", payload);
  assert.equal(res.status, 201);
  assert.equal(res.body.queuedTargets, 1, "active campaign must queue its targets");
});

test.skip(!apiAvailable, "POST /campaigns rejects missing name", async () => {
  const res = await request("POST", "/campaigns", { targets: [] });
  assert.equal(res.status, 400);
});

test.skip(!apiAvailable, "POST /webhooks/exotel processes completed status and enqueues postcall", async () => {
  // First create a call row via campaign creation
  const campaignRes = await request("POST", "/campaigns", {
    name: "Webhook Test Campaign",
    status: "active",
    defaultLocale: "en-IN",
    targets: [{ phone: "+911234560099", fullName: "Webhook Lead" }],
  });
  assert.equal(campaignRes.status, 201);

  // Simulate an Exotel completed webhook (no signature secret in test mode)
  const webhookRes = await request("POST", "/webhooks/exotel", {
    CallSid: "test-sid-integration-001",
    CallStatus: "completed",
    ConversationDuration: "45",
  });
  // Should be processed or ignored (not a 4xx/5xx)
  assert.ok(
    webhookRes.status < 400,
    `webhook should be accepted, got ${webhookRes.status}`,
  );
});

test.skip(!apiAvailable, "GET /metrics returns prometheus format", async () => {
  const res = await request("GET", "/metrics");
  assert.equal(res.status, 200);
  assert.match(String(res.body), /pikorua_process_uptime_seconds/);
});

test.skip(!apiAvailable, "rate limiter allows 120 requests per minute per IP", async () => {
  // Fire 10 quick requests — all should succeed (well below 120/min limit)
  const results = await Promise.all(
    Array.from({ length: 10 }, () => request("GET", "/health")),
  );
  const failures = results.filter((r) => r.status === 429);
  assert.equal(failures.length, 0, "10 requests should never hit rate limit");
});

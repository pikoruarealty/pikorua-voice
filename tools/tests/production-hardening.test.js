const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("production env requires internal API token", () => {
  const { validateEnv } = require("../../apps/api/dist/config/env");

  assert.throws(
    () =>
      validateEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/pikorua_voice",
        REDIS_URL: "redis://localhost:6380",
        EXOTEL_WEBHOOK_SECRET: "secret",
        DEEPGRAM_API_KEY: "deepgram",
        ELEVENLABS_API_KEY: "eleven",
        ANTHROPIC_API_KEY: "anthropic",
      }),
    /API_AUTH_TOKEN/,
  );
});

test("HTTP controllers do not double-prefix api routes", () => {
  const files = [
    "apps/api/src/campaign/campaign.controller.ts",
    "apps/api/src/call-runtime/call-runtime.controller.ts",
    "apps/api/src/webhooks/webhook.controller.ts",
  ];

  for (const file of files) {
    assert.doesNotMatch(read(file), /@Controller\("api/);
  }
  assert.match(read("apps/api/src/main.ts"), /setGlobalPrefix\("api"\)/);
});

test("webhook signatures and event keys are stable", () => {
  const { WebhookService } = require("../../apps/api/dist/webhooks/webhook.service");
  const service = new WebhookService({ get: () => undefined }, {}, {}, {}, {}, {}, {});

  const rawBody = JSON.stringify({ CallSid: "sid-1", CallStatus: "completed" });
  const signature = crypto.createHmac("sha256", "secret").update(rawBody).digest("hex");
  assert.equal(service.verifySignature("secret", rawBody, signature), true);
  assert.equal(service.verifySignature("secret", rawBody, `sha256=${signature}`), true);
  assert.equal(service.verifySignature("secret", rawBody, "bad"), false);

  const keyA = service.buildEventKey("sid-1", "completed", "completed", {
    CallSid: "sid-1",
    CallStatus: "completed",
  });
  const keyB = service.buildEventKey("sid-1", "completed", "completed", {
    CallStatus: "completed",
    CallSid: "sid-1",
  });
  assert.equal(keyA, keyB);

  const malformedA = service.buildEventKey("", "unknown", undefined, { CallStatus: "completed" });
  const malformedB = service.buildEventKey("", "unknown", undefined, { CallStatus: "busy" });
  assert.notEqual(malformedA, malformedB);
  assert.match(malformedA, /^exotel:payload:/);
});

test("active campaign creation enqueues targets and marks them queued", async () => {
  const { CampaignService } = require("../../apps/api/dist/campaign/campaign.service");

  const campaign = {
    id: "campaign-1",
    status: "active",
    defaultLocale: "en-IN",
    maxAttempts: 3,
  };
  const targets = [{ id: "target-1" }, { id: "target-2" }];
  const enqueued = [];
  const statuses = [];

  const service = new CampaignService(
    { create: async () => campaign },
    {
      createMany: async () => targets,
      updateDialStatus: async (id, status) => statuses.push({ id, status }),
    },
    { enqueueTarget: async (id) => enqueued.push(id) },
  );

  const result = await service.create({
    name: "Campaign",
    status: "active",
    targets: [{ phone: "+911234567890" }, { phone: "+911234567891" }],
  });

  assert.deepEqual(enqueued, ["target-1", "target-2"]);
  assert.deepEqual(statuses, [
    { id: "target-1", status: "queued" },
    { id: "target-2", status: "queued" },
  ]);
  assert.equal(result.queuedTargets, 2);
});

test("post-call scoring prefers caller turns over assistant turns", async () => {
  const { PostCallProcessingService } = require("../../apps/worker/dist/postcall/postcall.service");

  let savedLead;
  let crmLog;

  const service = new PostCallProcessingService(
    { upsert: async (lead) => (savedLead = lead) },
    {
      createOrGetByIdempotencyKey: async (log) => {
        crmLog = log;
        return { id: "crm-log-1", status: "pending", attempts: 0 };
      },
      updateStatus: async () => undefined,
    },
    { create: async () => undefined },
    {
      findById: async () => ({
        id: "call-1",
        campaignId: "campaign-1",
        crmLeadId: "lead-1",
        locale: "en-IN",
      }),
    },
    {
      findByCallId: async () => [
        { role: "assistant", content: "No, not interested." },
        { role: "caller", content: "Yes, schedule a demo today." },
      ],
    },
    { evaluate: async () => null },
    { get: () => "" },
  );

  await service.processCall("call-1");

  assert.equal(savedLead.label, "hot");
  assert.equal(savedLead.signals.source, "heuristic");
  assert.match(crmLog.idempotencyKey, /^pikorua:create_lead:call-1$/);
});

test("CRM retry worker uses retryable failed/pending logs and idempotency headers", () => {
  assert.match(read("apps/worker/src/postcall/crm-retry.worker.ts"), /findRetryable\(25, 5\)/);
  assert.match(read("apps/worker/src/postcall/crm-retry.worker.ts"), /Idempotency-Key/);
  assert.match(read("packages/db/src/repositories/crm-sync-log.repository.ts"), /findRetryable/);
});

test("WebSocket auth accepts bearer, x-api-key, and token query string", () => {
  const { isWebSocketAuthorized } = require("../../apps/api/dist/auth/ws-auth");
  const config = { get: (key) => (key === "API_AUTH_TOKEN" ? "secret" : "production") };

  assert.equal(
    isWebSocketAuthorized(config, { headers: { authorization: "Bearer secret" }, url: "/" }),
    true,
  );
  assert.equal(
    isWebSocketAuthorized(config, { headers: { "x-api-key": "secret" }, url: "/" }),
    true,
  );
  assert.equal(
    isWebSocketAuthorized(config, { headers: {}, url: "/media-ingress?token=secret" }),
    true,
  );
  assert.equal(isWebSocketAuthorized(config, { headers: {}, url: "/" }), false);
});

test("dial windows defer calls outside local campaign window", () => {
  const { nextDialWindowAt } = require("../../apps/worker/dist/dial/dial-window");
  const campaign = {
    dialWindowStart: "09:30",
    dialWindowEnd: "18:00",
  };

  assert.equal(nextDialWindowAt(campaign, new Date("2026-06-08T10:00:00+05:30")), null);
  assert.equal(
    nextDialWindowAt(campaign, new Date("2026-06-08T08:00:00+05:30")).toISOString(),
    new Date("2026-06-08T09:30:00+05:30").toISOString(),
  );
  assert.equal(
    nextDialWindowAt(campaign, new Date("2026-06-08T20:00:00+05:30")).toISOString(),
    new Date("2026-06-09T09:30:00+05:30").toISOString(),
  );
});

test("metrics endpoint exists and is protected by the global auth guard", () => {
  assert.match(read("apps/api/src/app.module.ts"), /MetricsModule/);
  assert.match(read("apps/api/src/metrics/metrics.controller.ts"), /@Controller\("metrics"\)/);
  assert.doesNotMatch(read("apps/api/src/metrics/metrics.controller.ts"), /@Public/);
  assert.match(read("apps/api/src/main.ts"), /pikorua_http_requests_total/);
});

test("provider staging smoke script is explicit opt-in for live calls", () => {
  const script = read("tools/staging/provider-smoke.js");
  assert.match(script, /RUN_LIVE_PROVIDER_SMOKE/);
  assert.match(script, /Deepgram auth ok/);
  assert.match(script, /ElevenLabs auth ok/);
});

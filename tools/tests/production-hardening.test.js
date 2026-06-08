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

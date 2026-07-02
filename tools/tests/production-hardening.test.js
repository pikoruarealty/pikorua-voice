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
        OPENROUTER_API_KEY: "sk-or-test",
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
  const service = new WebhookService({ get: () => undefined }, {}, {}, {}, {}, {}, {}, null);

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
    { findById: async () => null }, // campaignRepo (best-effort campaign name for CRM payload)
    { evaluate: async () => null },
    { get: () => "" },
  );

  await service.processCall("call-1");

  // The whole point: only the CALLER turn ("schedule a demo today") is scored.
  // The assistant turn ("not interested") must NOT drag the label down — if both
  // roles were scored the negative phrase would push this to "cold". One positive
  // caller keyword on the base heuristic lands at "warm"; the negative is ignored.
  assert.equal(savedLead.label, "warm");
  assert.deepEqual(savedLead.signals.matchedPos, ["schedule"]);
  assert.deepEqual(savedLead.signals.matchedNeg, []);
  assert.equal(savedLead.signals.source, "heuristic");
  assert.match(crmLog.idempotencyKey, /^pikorua:create_lead:call-1$/);
});

test("CRM retry worker uses retryable failed/pending logs and idempotency headers", () => {
  assert.match(read("apps/worker/src/postcall/crm-retry.worker.ts"), /findRetryable\(25, 5\)/);
  // Idempotency now flows through the shared CRM client/signing helper: the retry
  // worker passes the stored idempotencyKey, and crm-signing emits the header.
  assert.match(read("apps/worker/src/postcall/crm-retry.worker.ts"), /idempotencyKey/);
  assert.match(read("apps/worker/src/postcall/crm-signing.ts"), /Idempotency-Key/);
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

test("metrics endpoint exists and is publicly scrapeable by Prometheus", () => {
  assert.match(read("apps/api/src/app.module.ts"), /MetricsModule/);
  assert.match(read("apps/api/src/metrics/metrics.controller.ts"), /@Controller\("metrics"\)/);
  // @Public() is intentional — Prometheus scrapers can't send bearer tokens.
  // The endpoint only exposes aggregate counters/histograms, no PII.
  assert.match(read("apps/api/src/metrics/metrics.controller.ts"), /@Public/);
  assert.match(read("apps/api/src/main.ts"), /pikorua_http_requests_total/);
});

test("provider staging smoke script is explicit opt-in for live calls", () => {
  const script = read("tools/staging/provider-smoke.js");
  assert.match(script, /RUN_LIVE_PROVIDER_SMOKE/);
  assert.match(script, /Deepgram auth ok/);
  assert.match(script, /ElevenLabs auth ok/);
});

test("rate limiter is wired in AppModule", () => {
  const src = read("apps/api/src/app.module.ts");
  assert.match(src, /ThrottlerModule/, "ThrottlerModule must be imported");
  assert.match(src, /ThrottlerGuard/, "ThrottlerGuard must be registered as APP_GUARD");
});

test("LlmService accepts message array and system prompt options", () => {
  const src = read("apps/api/src/llm/llm.service.ts");
  assert.match(src, /LlmMessage\[\]/, "generate() must accept LlmMessage array");
  assert.match(src, /systemPrompt/, "systemPrompt option must exist");
  assert.match(src, /promptTokens/, "promptTokens must be returned");
  assert.match(src, /completionTokens/, "completionTokens must be returned");
});

test("guardrails are semantic (LLM-based) with hard-rule fallback", () => {
  const src = read("apps/api/src/llm/guardrail.service.ts");
  assert.match(src, /checkSemantic/, "semantic check must exist");
  assert.match(src, /checkHard/, "hard-rule check must exist");
  assert.match(src, /async check\(/, "check() must be async");
  // Hard rules use specific multi-word patterns, not single keywords
  assert.match(src, /exact price|costs ₹/, "hard rules must use specific phrases, not single words");
});

test("Dockerfiles exist for both apps", () => {
  assert.ok(
    fs.existsSync(path.join(root, "apps/api/Dockerfile")),
    "apps/api/Dockerfile must exist",
  );
  assert.ok(
    fs.existsSync(path.join(root, "apps/worker/Dockerfile")),
    "apps/worker/Dockerfile must exist",
  );
});

test("GitHub Actions CI workflow exists", () => {
  assert.ok(
    fs.existsSync(path.join(root, ".github/workflows/ci.yml")),
    ".github/workflows/ci.yml must exist",
  );
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /unit-tests/, "CI must include unit test job");
  assert.match(ci, /integration-tests/, "CI must include integration test job");
  assert.match(ci, /docker-build/, "CI must include docker build check");
});

test("LeadScoreLlmService strips code fences before JSON.parse", () => {
  const src = read("apps/worker/src/postcall/lead-score-llm.service.ts");
  assert.match(src, /stripFences/, "stripFences method must exist");
  assert.match(src, /stripFences\(raw\)/, "raw LLM response must be fence-stripped before JSON.parse");
});

test("calls schema uses partial unique index for nullable providerCallSid", () => {
  const src = read("packages/db/src/schema.ts");
  // The unique index on providerCallSid must include a WHERE IS NOT NULL filter
  assert.match(
    src,
    /calls_provider_call_sid_uq[\s\S]*?IS NOT NULL/,
    "calls providerCallSid unique index must be partial (WHERE IS NOT NULL)",
  );
});

test("dial window times are interpreted in IST not server local TZ", () => {
  const src = read("apps/worker/src/dial/dial-window.ts");
  assert.match(src, /IST_OFFSET_MINUTES/, "IST offset constant must be defined");
  assert.match(src, /nowInIst/, "IST-aware time helper must exist");
  assert.match(src, /getUTCHours/, "must use UTC methods, not local TZ getHours");
  assert.doesNotMatch(src, /\.getHours\(\)/, "must not use getHours() which reads local TZ");
});

test("BullMQ Queue Redis connection has maxRetriesPerRequest null", () => {
  const src = read("apps/worker/src/dial/dial.service.ts");
  // Both connections should have maxRetriesPerRequest: null
  const matches = [...src.matchAll(/maxRetriesPerRequest: null/g)];
  assert.ok(matches.length >= 2, "both queueRedis and workerRedis must set maxRetriesPerRequest: null");
});

test("call-runtime separates spoken reply from history entry to preserve LLM coherence", () => {
  const src = read("apps/api/src/call-runtime/call-runtime.service.ts");
  assert.match(src, /spokenReply/, "spokenReply variable must separate TTS text from history");
  assert.match(src, /content: reply/, "raw LLM reply (not replacement) must be stored in history");
  // TTS is fed spokenReply (the safe/guardrailed text), not the raw history reply.
  // Synthesis goes through synthesizeWithFallback(spokenReply, ...) on the buffered
  // path and streamSentence(... dispatchedText/replacement ...) on the streaming path.
  assert.match(
    src,
    /synthesizeWithFallback\(\s*spokenReply/,
    "TTS must synthesize spokenReply, not the raw history reply",
  );
});

test("call-runtime totalMs uses real elapsed durations from captured timestamps", () => {
  const src = read("apps/api/src/call-runtime/call-runtime.service.ts");
  assert.match(src, /sttEnd = Date\.now\(\)/, "sttEnd timestamp must be captured after STT completes");
  assert.match(src, /llmEnd = Date\.now\(\)/, "llmEnd timestamp must be captured after LLM completes");
  assert.match(src, /sttEnd - sttStart/, "sttElapsed must use sttEnd - sttStart");
  assert.match(src, /llmEnd - llmStart/, "llmElapsed must use llmEnd - llmStart");
});

// NOTE: the legacy buffered "deepgram-realtime.service.ts" was removed when the
// project moved to the persistent Deepgram Live streaming session
// (deepgram-live.service.ts). Its failure-handling test was deleted with it.
// Live-session reconnect/error behaviour is covered by the gateway integration
// tests; see deepgram-live.service.ts onError -> callbacks.onError.

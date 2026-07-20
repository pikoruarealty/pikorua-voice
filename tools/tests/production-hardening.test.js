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
    // leadRepo: findByCallId → undefined means "not yet scored", so the
    // idempotency guard lets processing proceed and upsert records the score.
    { findByCallId: async () => undefined, upsert: async (lead) => (savedLead = lead) },
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
    { findById: async () => undefined }, // targetRepo (appointment link lookup)
    { findActiveNear: async () => undefined, create: async () => ({ id: "appt-1" }) }, // appointmentRepo
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

test("post-call is idempotent: an already-scored call is skipped (no duplicate HOT alert / CRM sync)", async () => {
  // Both the Exotel `completed` webhook AND the gateway drive post-call so every
  // call reaches CRM. leadRepo.upsert and CRM sync are idempotent, but the
  // HOT-alert insert is not — so a second run for an already-scored call MUST be
  // a no-op. Guard: if findByCallId returns a score, processCall returns early.
  const { PostCallProcessingService } = require("../../apps/worker/dist/postcall/postcall.service");

  let upsertCalled = false;
  let crmLogCalled = false;
  let hotAlertCalled = false;

  const service = new PostCallProcessingService(
    // leadRepo: this call was ALREADY scored on a prior run.
    {
      findByCallId: async () => ({ id: "score-1", callId: "call-1", score: 90, label: "hot" }),
      upsert: async () => {
        upsertCalled = true;
      },
    },
    {
      createOrGetByIdempotencyKey: async () => {
        crmLogCalled = true;
        return { id: "crm-log-1", status: "pending", attempts: 0 };
      },
      updateStatus: async () => undefined,
    },
    // eventRepo: a second HOT alert here would be the duplicate we must avoid.
    {
      create: async () => {
        hotAlertCalled = true;
      },
    },
    { findById: async () => ({ id: "call-1", campaignId: null, locale: "en-IN" }) },
    {
      findByCallId: async () => {
        throw new Error("turns must not be fetched once we know the call is already scored");
      },
    },
    { findById: async () => null },
    { findById: async () => undefined }, // targetRepo
    { findActiveNear: async () => undefined, create: async () => ({ id: "appt-1" }) }, // appointmentRepo
    {
      evaluate: async () => {
        throw new Error("scorer must not run for an already-scored call");
      },
    },
    { get: () => "" },
  );

  await service.processCall("call-1");

  assert.equal(upsertCalled, false, "must not re-upsert the lead score");
  assert.equal(crmLogCalled, false, "must not re-sync to CRM");
  assert.equal(hotAlertCalled, false, "must not emit a duplicate HOT alert");
});

test("post-call carries the LLM score breakdown into the lead score and CRM payload", async () => {
  // The per-criterion breakdown (profession, budget, location, site-visit gap …)
  // is what the CRM shows to explain WHY a lead scored as it did. It must survive
  // the trip from the scorer → lead_scores.signals → the /call-results payload.
  const { PostCallProcessingService } = require("../../apps/worker/dist/postcall/postcall.service");

  let savedLead;
  let crmLog;

  const breakdown = {
    professionCategory: "end_user",
    profession: "doctor",
    budget: "5 crore",
    requirements: "4 BHK",
    location: "SBR",
    currentResidence: "Bodakdev",
    siteVisit: { intent: true, when: "this Sunday", gapDays: 3 },
    sampleHouseInterest: true,
  };

  const service = new PostCallProcessingService(
    { findByCallId: async () => undefined, upsert: async (lead) => (savedLead = lead) },
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
        campaignId: null,
        crmLeadId: "lead-1",
        locale: "en-IN",
      }),
    },
    { findByCallId: async () => [{ role: "caller", content: "I'm a doctor, budget 5 crore." }] },
    { findById: async () => null },
    { findById: async () => undefined }, // targetRepo
    { findActiveNear: async () => undefined, create: async () => ({ id: "appt-1" }) }, // appointmentRepo
    // LLM scorer returns a full result including the structured breakdown.
    {
      evaluate: async () => ({
        score: 82,
        label: "hot",
        rationale: "Specific budget, clear config, near-term visit.",
        timeline: "short_term",
        matchedPos: ["5 crore", "this Sunday"],
        matchedNeg: [],
        breakdown,
      }),
    },
    { get: () => "" },
  );

  await service.processCall("call-1");

  // Stored on the lead score row for the agent UI / analytics.
  assert.equal(savedLead.signals.source, "llm");
  assert.deepEqual(savedLead.signals.breakdown, breakdown);
  // And forwarded in the structured /call-results payload sent to the CRM.
  assert.deepEqual(crmLog.requestPayload.score.breakdown, breakdown);
});

test("post-call heuristic fallback forces score 0 when the caller self-IDs as a broker", async () => {
  // The LLM scorer's "broker → 0" hard override must still hold on the keyword
  // fallback (scorer unavailable), so a broker never slips through as a warm lead.
  const { PostCallProcessingService } = require("../../apps/worker/dist/postcall/postcall.service");

  let savedLead;
  let crmLog;

  const service = new PostCallProcessingService(
    { findByCallId: async () => undefined, upsert: async (lead) => (savedLead = lead) },
    {
      createOrGetByIdempotencyKey: async (log) => {
        crmLog = log;
        return { id: "crm-log-1", status: "pending", attempts: 0 };
      },
      updateStatus: async () => undefined,
    },
    { create: async () => undefined },
    { findById: async () => ({ id: "call-1", campaignId: null, crmLeadId: "lead-1", locale: "en-IN" }) },
    // A broker would otherwise trip the positive keyword "site visit" → warm.
    {
      findByCallId: async () => [
        { role: "caller", content: "I'm a property dealer, I can arrange a site visit for buyers." },
      ],
    },
    { findById: async () => null },
    { findById: async () => undefined }, // targetRepo
    { findActiveNear: async () => undefined, create: async () => ({ id: "appt-1" }) }, // appointmentRepo
    { evaluate: async () => null }, // LLM scorer unavailable → heuristic path
    { get: () => "" },
  );

  await service.processCall("call-1");

  assert.equal(savedLead.score, 0, "broker self-ID must force score 0");
  assert.equal(savedLead.label, "cold");
  assert.equal(savedLead.signals.source, "heuristic");
  assert.deepEqual(savedLead.signals.matchedBroker, ["property dealer"]);
  // The minimal breakdown reaches the CRM so it shows profession = broker.
  assert.equal(crmLog.requestPayload.score.breakdown.professionCategory, "broker");
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

// A single malformed field from the scoring model must not discard the entire
// LLM result. `.default()` only fills an ABSENT key — an explicit `null` (or a
// junk enum) still throws and fails the whole parse, which silently drops
// post-call scoring to the crude keyword heuristic and loses the structured
// breakdown the CRM shows agents as "why". This is the exact payload that threw
// in production (worker log 2026-07-19): label "invalid" + siteVisit.intent null.
test("lead score survives a malformed field instead of binning the whole result", () => {
  const { LeadScoreLlmSchema } = require("../../apps/worker/dist/postcall/lead-score.schema");

  const parsed = LeadScoreLlmSchema.parse({
    score: 82,
    label: "invalid", // not in the enum — was fatal
    rationale: "Serious buyer, 10 crore budget.",
    timeline: "short_term",
    breakdown: {
      professionCategory: "end_user",
      budget: "10 crore",
      location: "Bapunagar",
      siteVisit: { intent: null, when: "tomorrow 3pm", gapDays: 1 }, // null — was fatal
    },
  });

  // The valuable content survives — that's the point of the guard.
  assert.equal(parsed.score, 82);
  assert.equal(parsed.breakdown.budget, "10 crore");
  assert.equal(parsed.breakdown.location, "Bapunagar");
  assert.equal(parsed.breakdown.siteVisit.intent, false); // coerced, not thrown
  assert.equal(parsed.breakdown.siteVisit.when, "tomorrow 3pm");

  // Nulled containers and junk enums are all survivable too.
  for (const payload of [
    { score: 50, label: "warm", rationale: "x", timeline: "unknown", breakdown: null },
    { score: 50, label: "warm", rationale: "x", timeline: "bogus", breakdown: { siteVisit: null } },
    { score: 50, label: "hot", rationale: null, timeline: "unknown" },
    { score: 50, label: "hot", rationale: "x", timeline: "unknown", matchedPos: null },
    {
      score: 50,
      label: "hot",
      rationale: "x",
      timeline: "unknown",
      breakdown: { professionCategory: "astronaut" },
    },
  ]) {
    assert.ok(
      LeadScoreLlmSchema.safeParse(payload).success,
      `malformed payload must still parse: ${JSON.stringify(payload)}`,
    );
  }

  // `score` stays strict on purpose — there is no safe fallback for it, so the
  // caller's heuristic should take over rather than us inventing a number.
  assert.ok(
    !LeadScoreLlmSchema.safeParse({ label: "hot", rationale: "x", timeline: "unknown" }).success,
    "a result with no usable score must fail so the heuristic fallback takes over",
  );
});

// Exotel does NOT sign status callbacks — there is no documented signature
// header — so requiring an HMAC rejected every genuine callback with a 401.
// Call-lifecycle updates and post-call processing silently never ran while the
// voice path looked perfectly healthy. The secret now rides in the callback URL
// (the only channel Exotel gives us) and the HMAC path is still accepted.
test("Exotel webhook authenticates by URL token as well as HMAC", () => {
  const svc = read("apps/api/src/webhooks/webhook.service.ts");
  const ctl = read("apps/api/src/webhooks/webhook.controller.ts");
  const dial = read("apps/worker/src/dial/dial.service.ts");

  // Rejection requires BOTH factors to fail — a valid token alone is enough.
  assert.match(
    svc,
    /if \(secret && !signatureValid && !tokenValid\)/,
    "a valid URL token must authenticate the callback on its own",
  );
  // The token is compared in constant time, like the HMAC.
  assert.match(svc, /timingSafeEqual\(a, b\)/);
  // The controller actually reads it off the query string.
  assert.match(ctl, /req\.query\?\.token/);
  // ...and the worker registers a callback URL that carries it, or Exotel would
  // call an endpoint it can never authenticate against.
  assert.match(
    dial,
    /webhooks\/exotel\?token=\$\{encodeURIComponent\(webhookSecret\)\}/,
    "the worker must append the shared secret to the StatusCallback URL",
  );
  // The audit column records "was it authenticated", not "did the HMAC match".
  assert.match(svc, /signatureValid: signatureValid \|\| tokenValid/);
});

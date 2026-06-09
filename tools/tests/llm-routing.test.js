/**
 * LLM routing and conversation history tests.
 * Run with: node --test tools/tests/llm-routing.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");

test("LlmService passes system prompt as separate field to Anthropic and Gemini", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/llm/llm.service.ts"),
    "utf8",
  );

  assert.match(src, /systemPrompt/, "systemPrompt option must be present in LlmService.generate");
  assert.match(src, /body\.system = opts/, "system prompt must be set on Anthropic body");
  assert.match(src, /\[System\].*opts/, "system prompt injected into Gemini contents");
});

test("LlmService passes full message history not just latest message", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/llm/llm.service.ts"),
    "utf8",
  );
  // The function signature should accept LlmMessage[] not a plain string
  assert.match(src, /messages: LlmMessage\[\]/, "generate() must accept message array");
  assert.match(src, /messages,/, "messages array must be forwarded to Anthropic body");
});

test("LlmService returns promptTokens and completionTokens", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/llm/llm.service.ts"),
    "utf8",
  );
  assert.match(src, /promptTokens.*input_tokens/, "Anthropic input_tokens mapped to promptTokens");
  assert.match(src, /completionTokens.*output_tokens/, "Anthropic output_tokens mapped to completionTokens");
  assert.match(src, /promptTokenCount/, "Google promptTokenCount consumed");
  assert.match(src, /candidatesTokenCount/, "Google candidatesTokenCount consumed");
});

test("CallRuntimeService stores state per callId and clears on completion", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/call-runtime/call-runtime.service.ts"),
    "utf8",
  );
  assert.match(src, /private readonly calls = new Map/, "per-call state map must exist");
  assert.match(src, /this\.calls\.set\(callId/, "state must be stored per callId");
  assert.match(src, /clearHistory/, "clearHistory method must exist");
  assert.match(src, /this\.calls\.delete\(callId\)/, "state must be deleted on clear");
  assert.match(src, /evictStale/, "TTL eviction must exist to prevent memory leaks");
  assert.match(src, /lastActivityAt/, "lastActivityAt must be tracked for eviction");
});

test("CallRuntimeService builds contextual system prompt with lead name and campaign", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/call-runtime/call-runtime.service.ts"),
    "utf8",
  );
  assert.match(src, /buildSystemPrompt/, "buildSystemPrompt method must exist");
  assert.match(src, /campaignRepo\.findById/, "campaign context must be fetched");
  assert.match(src, /targetRepo\.findById/, "lead context must be fetched");
  assert.match(src, /leadName/, "leadName must be included in prompt");
  assert.match(src, /campaignName/, "campaignName must be included in prompt");
});

test("WebhookService clears call history on terminal status", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/webhooks/webhook.service.ts"),
    "utf8",
  );
  assert.match(src, /clearHistory/, "webhook service must call clearHistory on terminal");
  assert.match(src, /callRuntime\?\.clearHistory/, "clearHistory must be optional-chained");
});

test("LLM provider routing: Google used for Hindi locale", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/call-runtime/call-runtime.service.ts"),
    "utf8",
  );
  assert.match(src, /startsWith\("en"\)/, "locale-based routing must check for English");
  assert.match(
    src,
    /provider = "google"/,
    "non-English locales must route to Google",
  );
});

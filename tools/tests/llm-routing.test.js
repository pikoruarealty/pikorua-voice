/**
 * LLM routing and conversation history tests.
 * Run with: node --test tools/tests/llm-routing.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");

test("LlmService passes the system prompt to OpenRouter as a system-role message", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/llm/llm.service.ts"),
    "utf8",
  );

  assert.match(src, /systemPrompt/, "systemPrompt option must be present in LlmService.generate");
  // Built in buildOrMessages(): a system-role message whose content is the
  // systemPrompt — either a plain string, or a cached content-part (text: systemPrompt).
  assert.match(src, /role:\s*"system"/, "system prompt must be sent as a system-role message");
  assert.match(
    src,
    /content:\s*systemPrompt|text:\s*systemPrompt/,
    "the systemPrompt must be the system message content",
  );
});

test("LlmService passes full message history not just latest message", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/llm/llm.service.ts"),
    "utf8",
  );
  assert.match(src, /messages: LlmMessage\[\]/, "generate() must accept message array");
  assert.match(src, /for \(const m of messages\)/, "messages array must be iterated for providers");
});

test("LlmService returns promptTokens and completionTokens from OpenRouter usage", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/llm/llm.service.ts"),
    "utf8",
  );
  // Usage parsing is centralized in readUsage() and consumed by both request paths.
  assert.match(src, /prompt_tokens\?:/, "OpenRouter prompt_tokens consumed");
  assert.match(src, /completion_tokens\?:/, "OpenRouter completion_tokens consumed");
  assert.match(src, /this\.readUsage\(/, "both request paths normalize usage via readUsage");
});

test("LlmService caches the system prompt with an Anthropic cache_control breakpoint", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/llm/llm.service.ts"),
    "utf8",
  );
  // The static system prefix carries an ephemeral cache breakpoint (latency + cost win).
  assert.match(src, /cache_control:\s*\{\s*type:\s*"ephemeral"\s*\}/, "system prompt is cached");
  // Cache-control is Anthropic-specific — only attach it for Claude models.
  assert.match(src, /anthropic\|claude/i, "caching gated to Claude models");
  // Streaming path requests usage so cache hits are observable in logs.
  assert.match(src, /stream_options:\s*\{\s*include_usage:\s*true\s*\}/, "usage requested on stream");
  // Cache-read token count is surfaced (OpenAI-shaped or Anthropic-native).
  assert.match(src, /cached_tokens|cache_read_input_tokens/, "cache-read tokens parsed");
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

test("LLM provider routing: OpenRouter primary with retry + optional fallback model", () => {
  const src = require("fs").readFileSync(
    require("path").join(process.cwd(), "apps/api/src/llm/llm.service.ts"),
    "utf8",
  );
  assert.match(src, /provider === "openrouter" \|\| provider === "auto"/, "OpenRouter must be tried for the auto provider");
  assert.match(src, /tryOpenRouter/, "tryOpenRouter helper must exist");
  assert.match(src, /streamOpenRouter/, "streamOpenRouter helper must exist");
  assert.match(src, /OPENROUTER_FALLBACK_MODEL/, "an optional OpenRouter fallback model must be supported");
  // Providers are reached only through OpenRouter — no direct vendor SDKs/endpoints.
  assert.doesNotMatch(src, /streamGemini|generativelanguage\.googleapis\.com/, "Gemini must not be called directly");
  assert.doesNotMatch(src, /anthropic\.com\/v1\/messages/, "direct Anthropic API must not be called");
});

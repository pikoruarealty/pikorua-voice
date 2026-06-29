/**
 * Integration test for the hard-guardrail replacement path inside
 * CallRuntimeService.processUtteranceStream — the streaming turn pipeline used by
 * live telephony. This path is concurrency-sensitive: when a streamed sentence
 * trips a hard rule we must (1) stop generation, (2) tell the transport to drop
 * any queued audio (onCancel), (3) speak the safe replacement instead, and
 * (4) persist the turn flagged as guardrailed. It runs fully offline — the LLM
 * and TTS are mocked, the guardrail is the REAL service (hard rules are sync regex).
 *
 * Run with: pnpm build && node --test tools/tests/guardrail-streaming.test.js
 */
const assert = require("node:assert/strict");
const test = require("node:test");

const { CallRuntimeService } = require("../../apps/api/dist/call-runtime/call-runtime.service");
const { GuardrailService } = require("../../apps/api/dist/llm/guardrail.service");

function buildRuntime({ onAssistantTurn } = {}) {
  // A sentence that trips the roi_guarantee hard rule.
  const BAD_REPLY = "This will definitely appreciate next year.";

  const llm = {
    // The streaming turn calls generateStream(history, opts, onDelta).
    async generateStream(_history, _opts, onDelta) {
      onDelta(BAD_REPLY + " ");
      return { text: BAD_REPLY, llmMs: 10, model: "mock", promptTokens: 1, completionTokens: 1 };
    },
    async generate() {
      return { text: BAD_REPLY, llmMs: 10, model: "mock", promptTokens: 1, completionTokens: 1 };
    },
  };

  const tts = {
    // Streaming synth: emit one audio frame then report completion.
    async synthesizeStream(_text, opts) {
      opts.onChunk(Buffer.from([1, 2, 3]));
      return { ttsMs: 5, ttfbMs: 1, bytes: 3 };
    },
  };

  const guardrail = new GuardrailService({ get: () => undefined });

  const turnRepo = {
    created: [],
    async create(turn) {
      turnRepo.created.push(turn);
      if (turn.role === "assistant" && onAssistantTurn) onAssistantTurn(turn);
      return turn;
    },
  };
  const callRepo = { async findById() { return null; }, async update() {} };
  const campaignRepo = { async findById() { return null; } };
  const targetRepo = { async findById() { return null; } };
  const config = { get: () => undefined };
  const metrics = { increment() {}, observe() {} };

  const runtime = new CallRuntimeService(
    /* stt */ {},
    llm,
    tts,
    guardrail,
    turnRepo,
    callRepo,
    campaignRepo,
    targetRepo,
    config,
    metrics,
    /* redis */ null,
  );
  return { runtime, turnRepo, BAD_REPLY };
}

test("streaming hard-guardrail hit cancels queued audio and speaks the safe replacement", async () => {
  let assistantTurn;
  const { runtime } = buildRuntime({ onAssistantTurn: (t) => (assistantTurn = t) });

  const events = [];
  const controller = new AbortController();
  const audioChunks = [];

  const result = await runtime.processUtteranceStream(
    "call-guardrail-1",
    0,
    "Tell me, will this property appreciate over time.",
    { locale: "en-IN" },
    {
      signal: controller.signal,
      onReplyDelta: () => events.push("delta"),
      onAudioChunk: (chunk, info) => {
        events.push(info.last ? "audio-last" : "audio");
        if (chunk.length > 0) audioChunks.push(chunk);
      },
      onCancel: () => events.push("cancel"),
    },
  );

  // The spoken reply must be the guardrail's safe replacement, NOT the raw LLM text.
  assert.equal(
    result.reply,
    "I can't promise specific returns — real estate values depend on many factors. Our consultant can share market data.",
  );
  assert.equal(result.canceled, false, "a guardrail replacement is not a barge-in cancel of the turn");

  // The transport was told to drop queued audio before the replacement played.
  assert.ok(events.includes("cancel"), "onCancel must fire so queued audio is dropped");
  assert.equal(events.indexOf("cancel") < events.lastIndexOf("audio"), true, "cancel precedes replacement audio");
  assert.ok(audioChunks.length > 0, "replacement audio must be streamed");

  // The persisted turn is flagged as guardrailed with the matched rule.
  assert.ok(assistantTurn, "assistant turn must be persisted");
  assert.equal(assistantTurn.guardrailTriggered, true);
  assert.equal(assistantTurn.guardrailRule, "roi_guarantee");
  assert.equal(assistantTurn.fallbackUsed, true);
  // The audit content is what the caller HEARD (the safe text), not the raw reply.
  assert.equal(assistantTurn.content, result.reply);
});

test("streaming turn with a clean reply does not trigger the guardrail", async () => {
  // Swap the LLM to emit a clean, compliant reply.
  let assistantTurn;
  const { runtime } = buildRuntime({ onAssistantTurn: (t) => (assistantTurn = t) });
  runtime["llm"].generateStream = async (_h, _o, onDelta) => {
    const clean = "Certainly. What time would be convenient — 11 in the morning or 5 in the evening?";
    onDelta(clean + " ");
    return { text: clean, llmMs: 8, model: "mock", promptTokens: 1, completionTokens: 1 };
  };

  const result = await runtime.processUtteranceStream(
    "call-guardrail-2",
    0,
    "Yes, let's set up a visit please.",
    { locale: "en-IN" },
    { signal: new AbortController().signal, onAudioChunk: () => {}, onCancel: () => {} },
  );

  assert.match(result.reply, /11 in the morning or 5 in the evening/);
  assert.equal(assistantTurn.guardrailTriggered, false);
  assert.equal(assistantTurn.guardrailRule, null);
});

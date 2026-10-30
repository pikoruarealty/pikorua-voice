-- Per-turn cost + latency metrics, so the cost per call can be measured and every
-- cost change verified against real traffic. Additive only; all columns nullable.
--   cache_read_tokens / cache_write_tokens — prompt-cache hits vs writes (OpenRouter usage)
--   llm_cost_usd — OpenRouter's billed cost for this turn's LLM request
--   tts_chars    — characters sent to TTS for this reply (TTS is billed per char)
--   ttfa_ms      — caller stops talking → Maya's first audio byte
ALTER TABLE call_turns
    ADD COLUMN IF NOT EXISTS cache_read_tokens integer,
    ADD COLUMN IF NOT EXISTS cache_write_tokens integer,
    ADD COLUMN IF NOT EXISTS llm_cost_usd numeric(12, 8),
    ADD COLUMN IF NOT EXISTS tts_chars integer,
    ADD COLUMN IF NOT EXISTS ttfa_ms integer;

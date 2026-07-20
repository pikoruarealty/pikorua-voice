# Pikorua Voice

Inbound + outbound AI voice concierge for ultra-luxury real estate. The system **places and answers** calls via Exotel, runs a real-time STT → LLM → TTS pipeline, and books site-visit appointments — without a human agent in the loop. Every call, in either direction, is scored and pushed to the CRM.

> **Standalone repository.** This service owns its PostgreSQL and Redis instances. All CRM communication is over REST — it never touches the CRM database directly.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    apps/api  (port 4100)                        │
│                                                                 │
│  ExotelVoicebotGateway  ── WS  /exotel-stream                   │
│  DemoVoiceGateway       ── WS  /demo-voice                      │
│  CallRuntimeController  ── POST /api/calls/:id/turns            │
│  CampaignController     ── POST /api/campaigns                  │
│  WebhookController      ── POST /api/webhooks/exotel            │
│  HealthController       ── GET  /api/health                     │
│  MetricsController      ── GET  /api/metrics                    │
│                                                                 │
│  ┌─ CallRuntimeService ─────────────────────────────────────┐   │
│  │  getOrCreateState → buildSystemPrompt (DB + inventory)   │   │
│  │  processUtteranceStream → LLM stream → sentence split    │   │
│  │            └→ TTS stream (per sentence or WS session)    │   │
│  │  generateGreetingStream → Maya speaks first              │   │
│  │  speculateTurn → pre-warm LLM on confident partials      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  STT:   DeepgramLiveService  (WS, VAD endpointing, live path)   │
│         DeepgramService      (HTTP buffer, REST path only)      │
│  LLM:   LlmService → OpenRouter  (streaming SSE + CB)          │
│  TTS:   ElevenlabsService    (HTTP stream per sentence / WS)    │
│  Guard: GuardrailService     (hard regex + optional LLM check)  │
└─────────────────────────────────────────────────────────────────┘
         │ BullMQ (Redis)                    │ BullMQ (Redis)
         │ postcall queue                    │ dial queue
         ▼                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                      apps/worker                                │
│                                                                 │
│  DialService          ── places outbound calls via Exotel API   │
│  DialRepairScheduler  ── re-queues stuck pending targets/60 s   │
│  PostCallWorker       ── scores leads, extracts objections, CRM │
│  CrmRetryWorker       ── retries failed CRM syncs (5 min cron)  │
│  AppointmentScheduler ── site-visit reminders + feedback calls  │
└─────────────────────────────────────────────────────────────────┘
         │ Drizzle ORM
         ▼
┌─────────────┐   ┌───────────────────────────┐
│  PostgreSQL  │   │  Redis (BullMQ + L2 state) │
│  (Neon)      │   │  call_state:<id>  3h TTL   │
└─────────────┘   └───────────────────────────┘
```

---

## Tech stack

| Layer     | Technology                                       |
| --------- | ------------------------------------------------ |
| Runtime   | Node.js 20, TypeScript 5                         |
| Framework | NestJS 10                                        |
| Monorepo  | Turborepo + pnpm workspaces                      |
| Database  | PostgreSQL via Neon (serverless)                 |
| ORM       | Drizzle ORM                                      |
| Queue     | BullMQ on Redis (Upstash)                        |
| STT       | Deepgram Nova-3 (WebSocket live streaming)       |
| LLM       | OpenRouter → Claude Haiku 4-5 (streaming SSE)    |
| TTS       | ElevenLabs Turbo v2.5 (HTTP stream or WebSocket) |
| Telephony | Exotel Voicebot WebSocket                        |

---

## Repository layout

```
pikorua-voice/
├── apps/
│   ├── api/                        # Voice API process
│   │   └── src/
│   │       ├── auth/               # API token guard + WS auth
│   │       ├── call-runtime/       # Core turn pipeline + gateways
│   │       │   ├── call-runtime.service.ts     # LLM/TTS orchestration
│   │       │   ├── exotel-voicebot.gateway.ts  # Exotel WS handler
│   │       │   └── demo-voice.gateway.ts       # Browser demo WS
│   │       ├── campaign/           # Campaign CRUD + dial queue
│   │       ├── config/             # Zod env schema
│   │       ├── demo/               # Browser demo session endpoint
│   │       ├── health/             # DB + Redis health probe
│   │       ├── ivr/                # DTMF digit → locale mapping
│   │       ├── llm/                # OpenRouter client + guardrails
│   │       ├── metrics/            # In-process Prometheus metrics
│   │       ├── postcall/           # BullMQ producer (postcall queue)
│   │       ├── redis/              # Shared Redis client module
│   │       ├── stt/                # Deepgram clients
│   │       ├── tts/                # ElevenLabs client + TTS normalizer
│   │       └── webhooks/           # Exotel status callbacks
│   └── worker/                     # Async worker process
│       └── src/
│           ├── config/             # Worker Zod env schema
│           ├── dial/               # Dial queue worker + window enforcement
│           └── postcall/           # Lead scoring + CRM sync
└── packages/
    ├── db/                         # Drizzle schema + repositories
    └── shared/                     # Shared constants (SERVICE names)
```

---

## Local setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy env and fill in values
cp .env.example .env

# 3. Start local PostgreSQL + Redis (or use Neon + Upstash URLs in .env)
docker compose up -d

# 4. Apply DB migrations (also runs automatically on API start)
pnpm db:migrate

# 5. Start both processes
pnpm dev
```

`pnpm dev` starts the API on `:4100` and the worker in watch mode.
The browser demo UI is served at `http://localhost:4100/`.

Verify the API:

```bash
curl http://localhost:4100/api/health
# → { "status": "ok", "details": { "uptimeMs": ..., "database": "ok", "redis": "ok" } }
```

---

## Scripts

```bash
pnpm dev              # run api + worker in watch mode (Turborepo)
pnpm build            # build all packages + apps
pnpm type-check       # typecheck the whole workspace
pnpm format           # prettier --write
pnpm db:generate      # generate Drizzle migration SQL
pnpm db:migrate       # apply pending migrations
pnpm db:studio        # open Drizzle Studio
```

---

## Call flow

```
1. Campaign created → POST /api/campaigns  (status: "active" enqueues targets)
2. DialService places outbound call → Exotel API
3. Exotel connects call, opens WebSocket to /exotel-stream
4. Gateway generates Maya's opening greeting (LLM + TTS, streamed)
5. Deepgram Live streams caller audio → onPartial / onUtterance callbacks
6. onPartial  → barge-in detection: abort active turn + send Exotel "clear"
7. onUtterance → enqueueTurn → runTurn
     └→ processUtteranceStream:
          ├── noise/filler guard (isNoisyTranscript)
          ├── fragment-merge (mid-thought detection)
          ├── LLM generateStream (OpenRouter, 3 retries + fallback)
          ├── feedDelta: sentence boundary split → dispatchSentence
          ├── dispatchSentence: hard guardrail check → TTS stream
          ├── PcmReframer: pad to 320-byte Exotel frame boundary
          └── semantic guardrail concurrent with TTS drain
8. Call ends → PostCallWorker, enqueued by whichever fires first:
     the Exotel "completed" webhook, OR the gateway on socket close
     (for gateway-owned inbound calls); a shared jobId dedupes the two
     └→ LLM lead scoring → CRM sync (idempotent)
```

**Inbound calls** join this pipeline from step 3: Exotel opens `/exotel-stream`, the
gateway creates a `calls` row on the fly (capturing the caller's number for the CRM),
and on hang-up it finalizes the call and drives post-call itself. So every call —
inbound or outbound — is scored and synced.

---

## Audio pipeline (Exotel ↔ ElevenLabs)

Exotel speaks and listens in **raw 16-bit linear PCM, 8 kHz, mono, little-endian** in both directions. ElevenLabs `pcm_8000` output format produces exactly this — no transcoding step needed.

Exotel requires frames to be a **multiple of 320 bytes** (20 ms per frame at 8 kHz). The `PcmReframer` class accumulates ElevenLabs HTTP chunks and emits 3200-byte frames (100 ms), zero-padding the final frame if needed.

---

## STT — Deepgram Live

`DeepgramLiveService` opens a persistent WebSocket to Deepgram **Nova-3** per call.

**Language routing** (`dgLanguage`): Hindi and English callers code-switch (Hinglish), so both use Nova-3's `language=multi` code-switching model — mixed Hindi+English is transcribed in one stream. Gujarati, Tamil, Telugu, and Marathi are standalone Nova-3 languages (not in the `multi` set) and use their own language code. Proper-noun boosting uses Nova-3 **Keyterm Prompting** (`keyterm`), which replaces Nova-2's `keyword:intensifier` mechanism (no intensifier suffix; multi-word phrases supported).

| Parameter          | Value   | Purpose                                                                  |
| ------------------ | ------- | ------------------------------------------------------------------------ |
| `endpointing`      | 250 ms  | VAD sensitivity (silence threshold) — set once on connect, never changed |
| `utterance_end_ms` | 1000 ms | Hard utterance boundary; 400 ms after short acks                         |

After a short acknowledgment ("haan", "ok") `utterance_end_ms` is tightened to **400 ms** via a Deepgram `Configure` message, making the bot respond faster. It restores to 1000 ms on the next full utterance.

The session reconnects up to 3 times with exponential backoff (300 → 600 → 1200 ms) on unexpected close. Audio buffers during reconnect (up to 200 chunks / ~20 s).

**Inbound AGC** (telephony path only): on the Exotel gateway a soft-spoken caller arrives as low-amplitude PCM, which degrades Deepgram's VAD and ASR (missed/dropped words). `InboundAgc` lifts each inbound frame toward `STT_INBOUND_AGC_TARGET_RMS` **before** the audio reaches STT — boost-only, noise-gated (`STT_INBOUND_AGC_NOISE_GATE_RMS`), and peak-limited (`STT_INBOUND_AGC_PEAK_CEILING`) so the boosted signal can never clip. It is applied **at all times**, including while Maya speaks: gating it on her silence left a soft caller unheard during her turn and its tail, so the loudest thing on the line won. Disable with `STT_INBOUND_AGC=0`.

**Near-end (double-talk) detection**: amplifying at all times means her own echo (the line has no carrier echo-cancellation) and room background get boosted too, so echo must be rejected on **energy**, not text — echo is real words, so no text filter can catch it. Each raw frame's RMS (measured **before** the boost) is compared against the line's own adaptive noise floor: the floor falls fast toward the quiet baseline and rises slowly toward sustained background, so a real caller — even a soft one — stands `STT_NEAR_END_MARGIN`× above it while echo and steady chatter sit at it. `STT_NEAR_END_MIN_RMS` is an absolute guard so a near-silent line's tiny floor can't accept hiss. While Maya is audible, both barge-in and turn acceptance require near-end speech; while she is silent nothing is rejected, so that path stays fully sensitive.

> `STT_NEAR_END_HOLD_MS` (1500) **must stay above** `utterance_end_ms` (1000). The gate is consulted when the **final transcript lands**, not when the caller spoke, and Deepgram falls back to `UtteranceEnd` at 1000 ms whenever `speech_final` never fires (noisy lines — exactly when the gate matters). A shorter hold makes a genuine utterance look like echo and drops it: Maya goes deaf mid-call. Guarded by `tools/tests/voice-timing.test.js`.

---

## LLM — OpenRouter

`LlmService.generateStream` sends streaming SSE to OpenRouter:

1. Up to **2 attempts** on the primary model (`OPENROUTER_MODEL`, default `anthropic/claude-haiku-4-5`)
2. One attempt on `OPENROUTER_FALLBACK_MODEL` if configured
3. Circuit breaker: after 3 consecutive failures a provider is skipped for 10 s

A per-turn watchdog (`TURN_TIMEOUT_MS`, default 12 s) aborts in-flight provider calls if the whole turn overruns.

> **Invariant:** attempts × `OPENROUTER_TIMEOUT_MS` ≤ `TURN_TIMEOUT_MS`. The attempts run **serially inside one watchdog**, so a per-request cap above `TURN_TIMEOUT_MS / 3` means the watchdog kills the turn before the fallback model is ever tried — the chain stops being a fallback chain exactly when the primary is already failing. Defaults (4000 × 3 = 12 s) and prod (5000 × 3 = 15 s < 18 s) both hold. Raise `OPENROUTER_TIMEOUT_MS` only alongside `TURN_TIMEOUT_MS`. Guarded by `tools/tests/voice-timing.test.js`.

**Prompt caching**: the static system prompt (Maya persona + full inventory, ~15k tokens) is marked with an Anthropic `cache_control` ephemeral breakpoint (via OpenRouter, Claude models only), so Anthropic reuses the already-processed prefix on later turns within its ~5-min TTL — cutting time-to-first-token and ~90% of the input-token cost. The breakpoint sits **only** on the static prefix; conversation history follows it and stays uncached. The stream logs `cachedRead=…` so cache hits are visible in production.

**Per-turn time note** (`withNowNote`): every turn's latest user message is prefixed with a fresh `[Now in Ahmedabad: <IST time>. SAME-DAY SLOTS: …]` note. The current time is re-read on **every** turn (never frozen at call start) and the offerable same-day visit slots are precomputed in code, so Maya schedules from the real current moment without doing clock arithmetic. Crucially the note lives in the **uncached suffix** — putting it in the system prompt would both freeze the time and invalidate the cache on every turn.

**Speculative generation** (demo gateway only): the LLM is pre-warmed on a confident partial transcript (≥ 4 words) before VAD fires. If the final utterance matches, the pre-collected deltas are replayed — saving 200–400 ms of turn latency.

---

## TTS — ElevenLabs

Two modes, controlled by `TTS_WS_STREAMING_ENABLED`:

| Mode           | How                                                               | Characteristic                                                 |
| -------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| HTTP (default) | One `/stream` request per sentence                                | ~200–400 ms to first byte per sentence                         |
| WS streaming   | One persistent WS session per turn; sentences sent as text frames | True pipelining — next sentence generates while previous plays |

`normalizeForTts` runs on every reply before synthesis:

- Devanagari respellings for Indian proper nouns (`crore` → `करोड़`, `ISKCON` → `इस्कॉन`)
- Romanized Hindi → Devanagari (`aapko` → `आपको`, `bilkul` → `बिल्कुल`)
- BHK expansion: `4BHK` → `four BHK` (BHK count is always spoken in English number words, even in Hindi mode — a Hindi numeral against the English "BHK" sounds unnatural)
- Distances & durations in English words in **both** modes (`3 km` → `three kilometers`, `30 minutes` → `thirty minutes`) — the Hindi engine otherwise mangles the unit
- Property sizes with the figure in English words even in Hindi mode (`4,800 square feet` → `four thousand eight hundred square feet`; unit still respelled to Devanagari)
- Clock times → English words in Hindi mode (`3:02 PM` → `three oh two PM`); the `see you at N` sign-off time is spoken as an English number in both modes
- Number-to-words with Indian grouping (lakh/crore), skipping years/times/percentages
- Hard-block: `"take care"` → `"Thank you."`

---

## Guardrails

Two independent layers, both per sentence:

**Hard rules** (synchronous, zero API cost — always on):

| Rule                   | Pattern                                           | Replacement                 |
| ---------------------- | ------------------------------------------------- | --------------------------- |
| `pricing_claim`        | "exact price", "costs ₹", "quote you"             | Refer to consultant         |
| `roi_guarantee`        | "guaranteed return", "will definitely appreciate" | No return promises          |
| `legal_advice`         | "you should consult a lawyer", "your legal right" | Refer to legal professional |
| `tax_advice`           | "you can save tax", "under section 80"            | Refer to tax advisor        |
| `fabricated_inventory` | "only N units left", "almost sold out"            | Refer to consultant         |

**Semantic guardrail** (`GUARDRAIL_SEMANTIC_ENABLED=true`, default): concurrent LLM check using Claude Haiku (max 150 tokens). Catches paraphrased violations the regex misses. If triggered, audio already playing is dropped via `onCancel` and a safe replacement is synthesized.

---

## Maya persona

Maya is PIKORUA GROUP's AI relationship manager. Key invariants:

- **Feminine Hindi verb forms only** — `बोल रही हूँ` not `बोल रहा हूँ`
- **All Hindi in Devanagari** — never romanized in prompt output
- **NEVER disclose prices** — pricing is for internal budget-matching only (prompt + synchronous hard guardrail are leak-proof; the semantic guardrail is a concurrent best-effort backstop for paraphrases — see Guardrails)
- **"PIKORUA GROUP" pronounced "पिकोरा GROUP"** — the U is silent
- **Sign-off is exactly "Thank you."** — never "take care", "have a nice day"
- **One question per turn**, short spoken sentences
- **9-step call flow**: intro → BHK preference → budget → location → possession timeline → recommend project + invite → collect name → confirm appointment → know-them → close

The property inventory (14 rows, 5 Ahmedabad micro-markets) is embedded in the system prompt. Internal prices are marked `[internal]` and used only for budget-matching (±1 Cr tolerance) — they are never spoken.

**Sub-₹2 Cr callers**: Maya collects all details without inviting for a site visit, then closes with "Our team will personally reach out to you." The reason is never revealed.

---

## Barge-in

Server-authoritative barge-in: when `onPartial` fires with ≥ `BARGE_IN_MIN_CHARS` (3) characters **and** the near-end detector confirms genuine caller energy while the bot is speaking:

1. `state.active.controller.abort()` — cancels in-flight LLM/TTS
2. `send({ event: "clear" })` — tells Exotel to drop its audio queue
3. `state.speaking = false` — resets the flag

The 3-char floor filters 1–2 char noise blips while still catching short interjections (`हाँ`, `रुको`, `stop`, `नहीं`). The near-end requirement is what makes the always-on inbound boost safe: Maya's amplified echo produces real transcripts but carries no near-end energy, so it can neither stop her nor queue a phantom turn. A fully-formed utterance also triggers a commit-path barge-in even when no partial did, and `isMayaAudible` includes the paced-sender tail so a late interruption during audio playout is not missed.

**Outbound greeting hold**: Exotel bridges the callee's media leg a beat *after* the Voicebot `start` fires, so greeting audio sent in that gap is dropped and the callee hears only the tail of Maya's intro. Outbound calls therefore hold the greeting **and** STT for `OUTBOUND_GREETING_DELAY_MS` (5 s); inbound calls — where the caller is already on the line — are never held. The hold is cancelled on `stop`/disconnect, so a callee who rejects inside the window is never greeted into a dead stream (which would also leak a billed STT session).

The `finally` block of every `runTurn`/`processUtteranceStream` path unconditionally resets `state.speaking = false`, so a failed or interrupted turn never leaves the flag permanently armed.

---

## Call state — two-level cache

```
L1: Map<callId, CallState>       in-process, zero-latency reads
L2: Redis key call_state:<id>    cross-instance, crash recovery (3-hour TTL)
```

`persistState` writes to Redis fire-and-forget after every turn. On L1 miss the service loads from Redis before rebuilding cold from DB. `clearHistory` deletes both when a webhook signals a terminal call status.

---

## Dial window

Campaigns can restrict dialing to a time window (`dialWindowStart` / `dialWindowEnd` in HH:MM, **IST**). `nextDialWindowAt` returns the next window-open timestamp in UTC. The IST calendar date is derived independently of the UTC date so calls are deferred correctly during the 18:30–23:59 UTC window (IST midnight to 05:29 AM).

---

## Database schema

| Table              | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `campaigns`        | Dial batch — name, status, locale, dial window, max attempts  |
| `campaign_targets` | Dial list — phone, locale, dial status, attempt count         |
| `calls`            | One row per call attempt — provider SID, status, timestamps   |
| `call_turns`       | Per-turn transcript + latency (STT/LLM/TTS ms) + token usage  |
| `lead_scores`      | Post-call score (0–100), label (hot/warm/cold), timeline      |
| `crm_sync_log`     | Every CRM REST sync attempt with idempotency key              |
| `call_events`      | Operational events: HOT alerts, guardrail blocks, escalations |
| `webhook_events`   | Raw Exotel webhooks with HMAC signature verification status   |
| `appointments`     | Booked site visits — time, status, reminder/feedback bookkeeping |

Turn row convention: caller turns use `turnIndex * 2`, assistant turns use `turnIndex * 2 + 1` — adjacent and ordered correctly.

---

## Environment variables

### apps/api

| Variable                      | Default                      | Description                                                 |
| ----------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `NODE_ENV`                    | `development`                |                                                             |
| `API_PORT`                    | `4100`                       | HTTP listen port                                            |
| `API_AUTH_TOKEN`              | —                            | Bearer token for REST + WS auth; required in production     |
| `DATABASE_URL`                | required                     | PostgreSQL connection string                                |
| `REDIS_URL`                   | required                     | Redis connection string                                     |
| `EXOTEL_SID`                  | —                            | Exotel account SID                                          |
| `EXOTEL_API_KEY`              | —                            | Exotel API key                                              |
| `EXOTEL_API_TOKEN`            | —                            | Exotel API token                                            |
| `EXOTEL_SUBDOMAIN`            | `api.exotel.com`             |                                                             |
| `EXOTEL_CALLER_ID`            | —                            | ExoPhone (virtual number)                                   |
| `EXOTEL_APP_ID`               | —                            | Voicebot App ID from Exotel dashboard                       |
| `EXOTEL_WEBHOOK_SECRET`       | required (prod)              | HMAC secret for webhook signature verification              |
| `EXOTEL_STREAM_SECRET`        | —                            | Optional shared secret for `/exotel-stream` WS endpoint     |
| `PUBLIC_BASE_URL`             | `http://localhost:4100`      | Used for Exotel status callback URL                         |
| `WORKER_WAKE_URL`             | —                            | Worker's URL; API pings it on call start / enqueue to wake a spun-down worker |
| `WORKER_KEEPALIVE_START_HOUR_IST` | `10`                     | Business-hours keep-alive window start (IST) for the worker                 |
| `WORKER_KEEPALIVE_END_HOUR_IST`   | `18`                     | Window end (IST); set start ≥ end to disable (wake-ahead still runs)         |
| `CALL_LOCALE_DEFAULT`         | `hi-IN`                      | Fallback locale when none is set on the call                |
| `LLM_PROVIDER_OVERRIDE`       | —                            | `openrouter` or `auto` (leave blank for auto)               |
| `GUARDRAIL_SEMANTIC_ENABLED`  | `true`                       | Enable LLM semantic guardrail (set `false` for local demos) |
| `STT_STREAMING_ENABLED`       | `false`                      | Use low-latency buffered STT in REST turn path              |
| `TTS_WS_STREAMING_ENABLED`    | `false`                      | Use ElevenLabs WS streaming instead of HTTP per sentence    |
| `OPENROUTER_TIMEOUT_MS`       | `4000`                       | Per-OpenRouter-request timeout (the active LLM cap)         |
| `TTS_TIMEOUT_MS`              | `8000`                       | ElevenLabs request timeout                                  |
| `TURN_TIMEOUT_MS`             | `12000`                      | Per-turn watchdog; aborts LLM+TTS on overrun                |
| `CALL_MAX_DURATION_MS`        | `900000`                     | Hard call length cap (15 min); `0` = disabled               |
| `SILENCE_END_THRESHOLD`       | `3`                          | Consecutive silent/noise turns (45 s window) before hangup  |
| `LLM_HISTORY_MAX_MESSAGES`    | `20`                         | Sliding-window history cap                                  |
| `DEEPGRAM_API_KEY`            | required (prod)              |                                                             |
| `STT_INBOUND_AGC`             | `1`                          | Inbound gain control on the Exotel path; `0` disables       |
| `STT_INBOUND_AGC_TARGET_RMS`  | `4000`                       | Target RMS the AGC boosts soft callers toward               |
| `STT_INBOUND_AGC_MAX_GAIN`    | `12`                         | Max boost factor (caps amplification of a near-silent line) |
| `STT_INBOUND_AGC_PEAK_CEILING`| `29000`                      | Peak the boosted signal must never exceed (no-clip limit)   |
| `STT_INBOUND_AGC_NOISE_GATE_RMS` | `55`                      | Frames quieter than this RMS are held near 1× (hiss gate)   |
| `STT_NEAR_END_MARGIN`         | `2.2`                        | How far above the noise floor (×) counts as caller speech   |
| `STT_NEAR_END_MIN_RMS`        | `70`                         | Absolute near-end guard (stops hiss on a near-silent line)  |
| `STT_NEAR_END_HOLD_MS`        | `1500`                       | Near-end hold; **must exceed** `utterance_end_ms` (1000)    |
| `OUTBOUND_GREETING_DELAY_MS`  | `5000`                       | Outbound-only greeting hold; `0` disables                   |
| `ELEVENLABS_API_KEY`          | required (prod)              |                                                             |
| `ELEVENLABS_VOICE_ID`         | required (prod)              | Indian multilingual voice ID                                |
| `ELEVENLABS_STABILITY`        | `0.55`                       | Voice stability (0–1)                                       |
| `ELEVENLABS_SIMILARITY_BOOST` | `0.9`                        | Voice similarity boost (0–1)                                |
| `ELEVENLABS_STYLE`            | `0.45`                       | Style/"smile" dial (0–1); >0.5 gets theatrical              |
| `ELEVENLABS_SPEED`            | `1.1`                        | Playback speed (clamped 0.7–1.2)                            |
| `ELEVENLABS_MODEL`            | `eleven_turbo_v2_5`          |                                                             |
| `ELEVENLABS_LANGUAGE_CODE`    | `hi`                         | Forces Hindi phonetics for romanized Hindi                  |
| `OPENROUTER_API_KEY`          | required (prod)              |                                                             |
| `OPENROUTER_MODEL`            | `anthropic/claude-haiku-4-5` | Primary LLM model                                           |
| `OPENROUTER_FALLBACK_MODEL`   | —                            | Optional second model if primary fails                      |
| `CRM_API_BASE_URL`            | `http://localhost:4000`      |                                                             |
| `CRM_API_TOKEN`               | —                            |                                                             |

### apps/worker

| Variable                        | Default    | Description                                                                 |
| ------------------------------- | ---------- | --------------------------------------------------------------------------- |
| `LLM_SCORING_PROVIDER`          | `auto`     | `openrouter` or `auto`                                                      |
| `LLM_SCORING_MODEL`             | —          | Override model for lead scoring (defaults to `OPENROUTER_MODEL`)            |
| `WORKER_KEEPALIVE_ENABLED`      | `false`    | Self-ping every 13 min to stop free-tier idle spin-down                     |
| `WORKER_PUBLIC_URL`             | —          | This worker's own URL (required when keep-alive is on)                      |
| `APPOINTMENTS_OUTBOUND_ENABLED` | `false`    | **Opt-in**: place real reconfirmation / feedback calls. Off = no dialing    |
| `APPOINTMENT_FEEDBACK_DELAY_MS` | `10800000` | How long after the visit the feedback call fires (default 3 h)              |

Worker inherits all Exotel, Redis, DB, and OpenRouter vars from the shared `.env`.

---

## API reference

### Campaigns

```
POST /api/campaigns
Authorization: Bearer <API_AUTH_TOKEN>
Content-Type: application/json

{
  "name": "Ahmedabad Launch — June 2026",
  "status": "active",
  "defaultLocale": "hi-IN",
  "dialWindowStart": "09:00",
  "dialWindowEnd": "18:00",
  "targets": [
    { "phone": "+919876543210", "fullName": "Ravi Shah", "locale": "hi-IN" }
  ]
}
```

Setting `status: "active"` immediately enqueues all targets for dialing.

### Appointments

```
POST /api/appointments
Authorization: Bearer <API_AUTH_TOKEN>

{
  "phone": "+919876543210",
  "scheduledAt": "2026-07-20T11:00:00+05:30",   // concrete ISO-8601 instant
  "locale": "hi-IN",
  "fullName": "Ravi Shah",
  "crmLeadId": "lead-123"
}

GET   /api/appointments/:id
PATCH /api/appointments/:id   { "scheduledAt"? , "status"? , "outcome"? }
```

`POST` is authoritative: it upgrades a nearby provisional (auto) row instead of
duplicating. A `PATCH` that moves `scheduledAt` clears the reminder flags so the
T-24h / T-2h calls fire again for the new time. `status` ∈ `scheduled` | `confirmed` |
`rescheduled` | `cancelled` | `completed` | `no_show`.

### REST turn API (non-telephony path)

```
POST /api/calls/:callId/turns
Authorization: Bearer <API_AUTH_TOKEN>
Content-Type: application/json

{ "turnIndex": 0, "audioBase64": "<base64 WAV>" }

→ { "audioBase64": "...", "transcript": "...", "reply": "...", "endCall": false }
```

### Health

```
GET /api/health
→ { "status": "ok", "details": { "uptimeMs": ..., "database": "ok", "redis": "ok" } }
```

Returns HTTP 503 when either dependency is unhealthy.

### Metrics

```
GET /api/metrics
Authorization: Bearer <API_AUTH_TOKEN>
→ Prometheus text format
```

Key metrics: `pikorua_turns_total{result}`, `pikorua_turn_stt_ms`, `pikorua_turn_llm_ms`, `pikorua_turn_tts_ms`, `pikorua_turn_ttfa_ms` (time-to-first-audio), `pikorua_turn_total_ms`.

---

## WebSocket protocols

### Exotel Voicebot — `/exotel-stream`

Exotel opens this socket when a call connects.

**Inbound (Exotel → server)**

| Event       | Key fields                                                         |
| ----------- | ------------------------------------------------------------------ |
| `connected` | Handshake                                                          |
| `start`     | `call_sid`, `custom_parameters.callId`, `custom_parameters.locale` |
| `media`     | `payload` (base64 PCM 8 kHz)                                       |
| `dtmf`      | `digit` ("1" / "2" / "3")                                          |
| `stop`      | Call ended                                                         |

**Outbound (server → Exotel)**

| Event   | Key fields                                            |
| ------- | ----------------------------------------------------- |
| `media` | `payload` (base64 PCM 8 kHz, 320-byte-aligned frames) |
| `mark`  | `name` ("s0", "s1", … sentence boundaries)            |
| `clear` | Drop queued audio (barge-in)                          |

### Browser demo — `/demo-voice`

**Client → server control frames (JSON)**

| `type`          | Additional fields                                     | Purpose                       |
| --------------- | ----------------------------------------------------- | ----------------------------- |
| `start`         | `callId`, `language`, `sampleRate`, `streaming: true` | Begin session                 |
| `playback-done` | —                                                     | Client finished playing audio |
| `stop`          | —                                                     | End session                   |
| Binary frame    | Raw PCM16 audio at `sampleRate` Hz                    | Caller audio                  |

**Server → client frames (JSON)**

| `type`         | Key fields                                   | When                             |
| -------------- | -------------------------------------------- | -------------------------------- |
| `turn-start`   | `transcript`                                 | Utterance received, LLM starting |
| `partial`      | `transcript`                                 | Deepgram interim result          |
| `reply-chunk`  | `text`                                       | LLM streaming delta              |
| `audio-chunk`  | `audioBase64`, `sentenceIndex`, `last`       | TTS audio fragment               |
| `cancel`       | —                                            | Barge-in: drop queued audio      |
| `reply-end`    | `transcript`, `reply`, `endCall`, `canceled` | Turn complete                    |
| `holding`      | `transcript`                                 | Fragment held (mid-thought)      |
| `greeting-end` | `reply`, `canceled`                          | Opening greeting complete        |
| `error`        | `message`                                    | Processing error                 |

---

## Post-call processing

When Exotel fires a `completed` webhook:

1. `PostCallQueueService.enqueue(callId)` adds a BullMQ job
2. `PostCallWorker` picks it up → `PostCallProcessingService.processCall`
3. **Lead scoring**: `LeadScoreLlmService.evaluate` asks OpenRouter for a score (0–100), label (`hot`/`warm`/`cold`), and timeline. Falls back to keyword heuristics if LLM unavailable:
   - Positive: `interested`, `site visit`, `book`, `appointment`, `buy`, `purchase`, `schedule`, `when can`, `call me`, `contact me`
   - Negative: `not interested`, `don't call`, `do not call`, `stop`, `unsubscribe`, `no thanks`
4. Score ≥ 75 → **HOT alert** written to `call_events`
5. **CRM sync**: POST a structured call-result payload to `CRM_API_BASE_URL/call-results`, signed with a `Bearer` token + `X-Signature` (HMAC-SHA256 over the raw body) + `X-Timestamp`, and deduped by an `Idempotency-Key`. Failures retried by `CrmRetryWorker` every 5 minutes (up to 5 attempts)

---

## Site-visit appointments — reconfirmation & post-visit feedback

Two outbound flows built on one `appointments` row, driven by `AppointmentScheduler`
(worker, 60 s tick).

**How a visit gets booked** — two paths that converge on one row:

| Path | Source | When |
| ---- | ------ | ---- |
| **Auto** (provisional) | `source="auto"` | Post-call, when the scorer reports `siteVisit.intent` **and** a resolvable `gapDays`. `resolveVisitDate` uses the caller's agreed time (`parseVisitTime` on `when`, incl. Hindi "N बजे"), falling back to the 11:00 IST slot; no reliable date → no row. |
| **API** (authoritative) | `source="api"` | `POST /api/appointments` with a concrete `scheduledAt`. Upgrades a nearby provisional row in place (±12 h) rather than duplicating — **the API always wins**. |

**Reconfirmation (#2)** — a **T-24h** and a **T-2h** call before each visit. `dueReminder`
decides which window is due (mutually exclusive; each fires at most once, tracked by
`reminderT24At` / `reminderT2At`). Maya confirms the slot, **reschedules on the spot**
using the qualifying slots from the per-turn time note, or bows out gracefully on a
cancel. Post-call writes the result back (`confirmed` / `cancelled`).

**Post-visit feedback (#4)** — `APPOINTMENT_FEEDBACK_DELAY_MS` (default 3 h) after the
visit, Maya asks how it went and — gently, once, without pressure — what's holding them
back. The post-call scorer extracts a structured `objections[]` array
(`price`, `possession_timeline`, `location`, `family_decision`, `loan_finance`,
`comparison`, `layout_size`, `amenities`, `other` + the caller's own words), stored on
the lead score and surfaced to the CRM at `score.objections`. Objections are captured on
**every** call, not just feedback ones. An unknown category coerces to `other` rather
than failing the score parse.

**Script variants.** These calls reuse the whole voice pipeline but swap the prompt:
`campaigns.scriptRef` (`default` | `reconfirm` | `feedback`) selects both the system
prompt (`buildScriptPrompt` — short, single-objective, no inventory, no pricing) and the
opening line (`greetingText`). The `default` concierge flow is untouched. An outbound
call resolves its variant via `providerCallSid → call → campaign.scriptRef`; appointment
context (the human-readable visit time) rides on the dial target's `metadata`.

**Safety rails.**

- **Outbound dialing is opt-in**: `APPOINTMENTS_OUTBOUND_ENABLED=false` by default. When
  off, appointments and objection capture still work — only the real calls are gated, so
  a deploy never surprise-dials anyone.
- **`do_not_call` is always honored** — checked against the phone before every reminder /
  feedback dial.
- **Exactly-once, race-safe**: each window is claimed with an atomic conditional update
  (`SET reminder_t2h_at = now WHERE … IS NULL RETURNING`) — only the caller that flips the
  still-null timestamp dials, so two ticks (or worker instances) can't double-call.
- **Feedback only chases confirmed visits** — a bare provisional (`scheduled`) row whose
  guessed date was never confirmed is skipped, so we never ask "how was your visit?" about
  a visit that may not have happened.
- Each dial gets its own single-target system campaign (`source="appt:<id>:<tag>"`), so
  the `(campaign_id, phone)` unique index never collides across a lead's repeat visits.

> **Open items before scaling outbound:** a full TRAI/DNC-list gate (beyond the existing
> per-lead `do_not_call` opt-out) is **not** implemented, and Maya's prompt still asserts
> she is not an AI. Both are acceptable at demo volume and for warm leads who booked a
> visit; both need a decision before high-volume or white-label use.

---

## Security

- **REST + WS auth**: both check `Authorization: Bearer <token>` and the `x-api-key` header (constant-time compared). The `?token=` query param is accepted by the **WebSocket** path only (`isWebSocketAuthorized`), since browsers can't set headers on a WS upgrade; the REST guard (`ApiAuthGuard`) does **not** read the query param. Skipped in development when `API_AUTH_TOKEN` is unset.
- **Webhook auth**: `EXOTEL_WEBHOOK_SECRET` authenticates the public `/api/webhooks/exotel` endpoint, accepted **either** as a URL token (`?token=<secret>`) **or** as an HMAC-SHA256 `x-exotel-signature` over the raw body. **Exotel does not sign its status callbacks** — there is no documented signature header — so the worker registers the StatusCallback URL *with the token* (`dial.service`), and that is the path real Exotel traffic takes. The HMAC path is retained for signed/self-originated callers. Requiring the HMAC alone previously 401'd every genuine callback, silently killing call-lifecycle updates and post-call processing while the voice path looked healthy. **Required in production** — the env schema rejects a prod boot without it, so this endpoint can never run unauthenticated. In development, if no secret is set the webhook is accepted and flagged `signatureValid: false`. Note the trade-off: a URL-borne secret can leak into access logs, so rotate it if the URL is exposed.
- **Rate limiting**: 120 requests / 60 s per IP via `ThrottlerModule` (global).
- **Price protection**: three layers — LLM prompt constraint + synchronous hard-regex guardrail (incl. an `₹<digit>` / `[internal]` leak backstop) + a semantic LLM guardrail. The first two are leak-proof: the hard regex runs on every sentence _before_ it is sent to TTS. The semantic layer catches paraphrases the regex misses but runs **concurrently with playback**, so a paraphrased figure (e.g. spelled-out "five crore", no `₹`) can be partially spoken before `onCancel` drops the audio and the safe replacement is synthesized.

---

## IVR locale selection

When Exotel reports DTMF digits **via the status webhook**, the digit is mapped to a locale and written to the call row:

| Digit | Locale  |
| ----- | ------- |
| `1`   | `en-IN` |
| `2`   | `hi-IN` |
| `3`   | `gu-IN` |
| other | `hi-IN` |

> **Note:** this resolves locale at call setup (from `custom_parameters.locale` / the call row). A DTMF press arriving _mid-stream_ on the `/exotel-stream` socket is logged but does **not** hot-swap the running conversation's language — the system prompt and Deepgram language are pinned when the stream starts. Use the IVR keypad step before the voicebot applet connects.

---

## Deployment (Render)

The project ships a `render.yaml` for one-click deployment. Both services build from **Docker images** (`env: docker`), not Buildpacks:

- **API service** (`type: web`, port 4100): root `Dockerfile` → `node apps/api/dist/main.js`, health check `/api/health`.
- **Worker service** (`type: web`): `apps/worker/Dockerfile` → `node apps/worker/dist/main.js`, health check `/health`. Deployed as a `web` service (not `worker`) because Render's free tier has no Background Worker plan — a bare `/health` endpoint satisfies the platform check. An optional 13-min self-ping keep-alive (`WORKER_KEEPALIVE_ENABLED`, off by default) prevents free-tier idle spin-down; switch to `type: worker` once on a paid plan.

Both services read from the same Render environment group. Set `PUBLIC_BASE_URL` to the deployed API service URL so Exotel can reach the webhook endpoint at `PUBLIC_BASE_URL/api/webhooks/exotel`.

**Waking the worker on demand.** A BullMQ job in Redis cannot wake a spun-down free-tier worker — only an inbound HTTP request does. Set the API's `WORKER_WAKE_URL` to the worker's URL and the always-on API pings it (throttled, fire-and-forget) whenever the worker is needed:

- **Event-driven** (`WorkerWaker`): a **call starts** (inbound or outbound), **post-call is enqueued** after any call, or an **outbound dial** is enqueued → wake the worker so it drains the queue instead of the job waiting.
- **Time-driven** (`WorkerAvailabilityScheduler`, for the reminder/feedback scheduler): because that scheduler is a `setInterval` *inside* the worker, it only ticks while the worker is awake. So the API (a) **wakes the worker ~5–8 min before any reminder/feedback is due** — at any hour, covering a 9 AM T-2h or 9 PM feedback — and (b) keeps it **warm during business hours** (`WORKER_KEEPALIVE_START_HOUR_IST`–`WORKER_KEEPALIVE_END_HOUR_IST`, default 10–18 IST, one ping ~every 12 min). Outside those hours with nothing imminent, the worker sleeps.

> Note: the keep-alive **must** be API-driven, not the worker's own `WORKER_KEEPALIVE_ENABLED` self-ping — a self-ping can't revive a worker that has already slept (e.g. at 10 AM after an overnight idle). All of this is a no-op when `WORKER_WAKE_URL` is unset or local.

---

## Ports (local — distinct from CRM / ai-leads repos)

| Service    | Host port |
| ---------- | --------- |
| API        | 4100      |
| PostgreSQL | 5433      |
| Redis      | 6380      |

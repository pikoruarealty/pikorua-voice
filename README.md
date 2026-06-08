# Pikorua Voice

Standalone outbound voice-concierge service for Pikorua Realty. It places campaign calls over Exotel, runs a Deepgram → LLM → ElevenLabs conversation loop, scores each lead, and syncs results back to the Pikorua CRM over REST.

> **Standalone repository.** This service owns its PostgreSQL database and Redis
> instance and never touches the CRM database directly — all CRM communication
> is over REST.

## Stack

| Layer          | Technology                                            |
| -------------- | ----------------------------------------------------- |
| Runtime        | Node.js 20, TypeScript 5.7                            |
| API            | NestJS 10 (`apps/api`)                                |
| Worker         | NestJS standalone context + BullMQ (`apps/worker`)    |
| Database       | PostgreSQL 16 + Drizzle ORM 0.44 (`packages/db`)      |
| Queue / Cache  | Redis 7 + BullMQ                                      |
| Validation     | Zod (`packages/shared`)                               |
| Telephony      | Exotel                                                |
| Speech-to-Text | Deepgram                                              |
| Text-to-Speech | ElevenLabs                                            |
| LLM            | Anthropic (primary) · Google Generative AI (fallback) |
| Monorepo       | pnpm workspaces + Turborepo                           |

## Language & Routing

- Primary language mix: Hindi primary (~60%), English (~25%), Gujarati (~15%).
- Current implemented voice stack:
  - STT: Deepgram buffered or realtime helper.
  - LLM: Anthropic first when configured, Google Generative AI fallback.
  - TTS: ElevenLabs.
- IVR mapping: Press 1 = English, Press 2 = Hindi, Press 3 = Gujarati. Default/no press = Hindi.

## Call volume assumptions & billing

- Expected total calls: 5,000/month = 1,000 inbound + 4,000 outbound.
- Outbound answer rate ~50% → ~2,000 no-answers (no AI cost). Expected AI-billed connected calls ≈ 3,000.
- Budget: ₹30,000/month (locked). Estimated monthly cost after language/traffic split ≈ ₹26,000–28,500.

## Config / ENV additions

- `GEMINI_LANGUAGE_DEFAULT` — default language sent to Gemini when call locale absent (default `hi-IN`).
- `ENGLISH_ANTHROPIC_PERCENT` — percentage (0-100) of English turns routed to Anthropic before falling back to Google.

## Production notes

- Public HTTP routes are mounted under `/api`; for example Exotel posts to `/api/webhooks/exotel`.
- Internal HTTP routes require `Authorization: Bearer API_AUTH_TOKEN` or `x-api-key` when `API_AUTH_TOKEN` is configured; production requires it.
- WebSocket endpoints (`/media-ingress`, `/realtime-stt`) use the same token model via `Authorization`, `x-api-key`, or `?token=...`.
- Exotel outbound calls include `StatusCallback` pointing at `PUBLIC_BASE_URL/api/webhooks/exotel`.
- Webhooks, CRM syncs, and dial jobs use deterministic idempotency keys.
- Dialing windows are enforced by the worker before provider calls are created; outside-window targets are deferred.
- Health returns HTTP 503 when PostgreSQL or Redis is unhealthy.
- `/api/metrics` exposes process and HTTP request counters and is protected by API auth.
- In production, provider secrets required for the active voice path are validated at boot.
- Post-call scoring prefers caller transcript turns and falls back to the full transcript only for legacy data.

## Layout

```
pikorua-voice/
├─ apps/
│  ├─ api/         NestJS HTTP service (webhooks, runtime, REST)   → :4100
│  └─ worker/      BullMQ dial worker (outbound calling)
├─ packages/
│  ├─ db/          Drizzle schema + client + migrations
│  └─ shared/      Zod schemas + shared TypeScript types
├─ docker-compose.yml   postgres:16 (:5433) + redis:7 (:6380)
├─ pnpm-workspace.yaml
├─ turbo.json
└─ .env.example
```

## Ports (distinct from the CRM / ai-leads repos so all three run together)

| Service    | Host port |
| ---------- | --------- |
| API        | 4100      |
| PostgreSQL | 5433      |
| Redis      | 6380      |

## Getting started

```bash
cp .env.example .env        # adjust values as needed
docker compose up -d        # start PostgreSQL + Redis
pnpm install                # install workspace dependencies
pnpm build                  # build packages + apps in dependency order
pnpm dev                    # run api + worker in watch mode
```

Verify the API is up:

```bash
curl http://localhost:4100/api
# → { "status": "ok", "service": "pikorua-voice-api", "timestamp": "..." }
```

## Scripts (repo root)

```bash
pnpm dev           # run all apps (turbo)
pnpm build         # build all packages + apps
pnpm type-check    # type-check the whole workspace
pnpm test          # build + production hardening regression tests
pnpm format        # prettier --write
pnpm db:generate   # generate Drizzle migration SQL (from Step 3)
pnpm db:migrate    # apply pending migrations
pnpm staging:providers # validate provider credentials; set RUN_LIVE_PROVIDER_SMOKE=true for live auth checks
pnpm db:studio     # open Drizzle Studio
```

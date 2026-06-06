# Pikorua Voice

Standalone outbound voice-concierge service for Pikorua Realty. It places
campaign calls over Exotel, runs a live Speech-to-Text → LLM → Text-to-Speech
conversation loop, scores each lead, and syncs results back to the Pikorua CRM
over REST.

> **Standalone repository.** This service owns its PostgreSQL database and Redis
> instance and never touches the CRM database directly — all CRM communication
> is over REST.

## Stack

| Layer          | Technology                                            |
| -------------- | ----------------------------------------------------- |
| Runtime        | Node.js 20, TypeScript 5.7                             |
| API            | NestJS 10 (`apps/api`)                                 |
| Worker         | NestJS standalone context + BullMQ (`apps/worker`)    |
| Database       | PostgreSQL 16 + Drizzle ORM 0.44 (`packages/db`)       |
| Queue / Cache  | Redis 7 + BullMQ                                       |
| Validation     | Zod (`packages/shared`)                                |
| Telephony      | Exotel                                                 |
| Speech-to-Text | Deepgram                                               |
| Text-to-Speech | ElevenLabs                                             |
| LLM            | Anthropic (primary) · Google Generative AI (fallback) |
| Monorepo       | pnpm workspaces + Turborepo                            |

## Language & Routing (updated)

- Primary language mix: Hindi primary (~60%), English (~25%), Gujarati (~15%).
- Voice pipeline split:
	- English calls route to the Vapi.ai path (Deepgram + Cartesia + Claude) — configured to handle ~25% of total calls.
	- Hindi + Gujarati calls route to the Gemini Live path (Google Generative AI) — ~75% of total calls.
- IVR mapping (new): Press 1 = English (Vapi path), Press 2 = Hindi (Gemini), Press 3 = Gujarati (Gemini). Default (no press) = Hindi.

## Call volume assumptions & billing

- Expected total calls: 5,000/month = 1,000 inbound + 4,000 outbound.
- Outbound answer rate ~50% → ~2,000 no-answers (no AI cost). Expected AI-billed connected calls ≈ 3,000.
- Budget: ₹30,000/month (locked). Estimated monthly cost after language/traffic split ≈ ₹26,000–28,500.

## Config / ENV additions

- `GEMINI_LANGUAGE_DEFAULT` — default language sent to Gemini when call locale absent (default `hi-IN`).
- `VAPI_PERCENT` — percentage (0-100) of English calls routed to the Vapi.ai path (default 25).

## Tech stack version notes (requested updates)

- NestJS: 11.x (was 10.x)
- TypeScript: 5.8 (was 5.7)
- Queue library: BullMQ 5.x + @nestjs/bullmq (was Bull 4 + @nestjs/bull)
- Google AI SDK: @google/genai (unified) (was @google/generative-ai)
- LLM model strings: update to latest dev assignments (claude-sonnet-4-6, etc.)

These updates are reflected in the PRD and environment defaults; package upgrades may be scheduled as a follow-up to avoid large breaking changes during this phase.

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
pnpm format        # prettier --write
pnpm db:generate   # generate Drizzle migration SQL (from Step 3)
pnpm db:migrate    # apply pending migrations
pnpm db:studio     # open Drizzle Studio
```

## Build sequence

Implementation proceeds strictly in order; each step is verified before the next
begins.

1. **Scaffold project** ✅ _(current)_
2. Database layer
3. Migrations
4. Health module
5. Campaign module
6. Dial worker
7. Exotel webhook
8. Call runtime (STT → LLM → TTS)
9. Post-call processing (scoring, CRM sync, HOT-lead notifications)
10. End-to-end testing

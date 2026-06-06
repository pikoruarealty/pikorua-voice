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

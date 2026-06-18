# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc* ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/worker/ apps/worker/

RUN pnpm --filter @pikorua/shared build
RUN pnpm --filter @pikorua/db build
RUN pnpm --filter @pikorua/worker build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc* ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /repo/packages/db/dist packages/db/dist
COPY --from=builder /repo/packages/shared/dist packages/shared/dist
COPY --from=builder /repo/apps/worker/dist apps/worker/dist

ENV NODE_ENV=production

CMD ["node", "apps/worker/dist/main.js"]

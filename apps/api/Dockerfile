# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /repo

# Install pnpm
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# Copy workspace manifests first for better layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc* ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/

# Build shared packages then the API
RUN pnpm --filter @pikorua/shared build
RUN pnpm --filter @pikorua/db build
RUN pnpm --filter @pikorua/api build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# Copy workspace structure (needed so workspace: references resolve)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc* ./
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/

RUN pnpm install --frozen-lockfile --production

# Copy compiled outputs
COPY --from=builder /repo/packages/db/dist packages/db/dist
COPY --from=builder /repo/packages/shared/dist packages/shared/dist
COPY --from=builder /repo/apps/api/dist apps/api/dist

# Copy migration script + SQL files so preDeployCommand can run them
COPY --from=builder /repo/packages/db/scripts packages/db/scripts
COPY --from=builder /repo/packages/db/drizzle packages/db/drizzle

ENV NODE_ENV=production
EXPOSE 4100

CMD ["node", "apps/api/dist/main.js"]

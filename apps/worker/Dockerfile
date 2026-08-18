# Build context must be the monorepo root:
#   docker build -f apps/worker/Dockerfile -t modelforge-worker .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/ml/package.json packages/ml/
RUN pnpm install --frozen-lockfile --filter @modelforge/worker...

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/ml/node_modules ./packages/ml/node_modules
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ml ./packages/ml
COPY apps/worker ./apps/worker
WORKDIR /app/apps/worker
CMD ["pnpm", "start"]

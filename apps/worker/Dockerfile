# Build context must be the monorepo root:
#   docker build -f apps/worker/Dockerfile -t modelforge-worker .
#
# build:  install everything the worker needs (incl. workspace packages and
#         dev tooling), compile src -> dist with tsup. @modelforge/ml is
#         bundled into dist, so the runtime image does not need it.
# runner: production dependencies only, plus dist. Runs plain node.
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/ml/package.json packages/ml/
RUN pnpm install --frozen-lockfile --filter @modelforge/worker...
COPY packages/ml ./packages/ml
COPY apps/worker ./apps/worker
RUN pnpm --filter @modelforge/worker build

FROM base AS runner
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
# The lockfile lists every workspace project; keep their manifests so
# --frozen-lockfile resolves, even though only the worker is installed.
COPY apps/web/package.json apps/web/
COPY packages/ml/package.json packages/ml/
RUN pnpm install --frozen-lockfile --prod --filter @modelforge/worker
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
WORKDIR /app/apps/worker
USER node
CMD ["node", "dist/index.js"]

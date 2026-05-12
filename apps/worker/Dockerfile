# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
RUN apk add --no-cache python3 make g++ libc6-compat tini \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ms/shared build \
 && pnpm --filter @ms/db build \
 && pnpm --filter @ms/domain build \
 && pnpm --filter @ms/worker build

FROM base AS runtime
WORKDIR /repo
COPY --from=build /repo /repo
ENV NODE_ENV=production
WORKDIR /repo/apps/worker
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

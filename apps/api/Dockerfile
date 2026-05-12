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
COPY apps/api apps/api
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ms/shared build \
 && pnpm --filter @ms/db build \
 && pnpm --filter @ms/domain build \
 && pnpm --filter @ms/api build

FROM base AS runtime
WORKDIR /repo
COPY --from=build /repo /repo
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
WORKDIR /repo/apps/api
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

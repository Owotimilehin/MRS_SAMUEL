# syntax=docker/dockerfile:1.7
# Runs `pnpm --filter @ms/db migrate && pnpm --filter @ms/db seed` once and exits.
FROM node:20-alpine
RUN apk add --no-cache python3 make g++ libc6-compat \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY menu.json ./menu.json
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ms/db build
CMD ["sh", "-c", "pnpm --filter @ms/db migrate && pnpm --filter @ms/db seed"]

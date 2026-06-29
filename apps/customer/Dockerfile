# syntax=docker/dockerfile:1.7
# Customer storefront — TanStack Start SSR app. Built with the Nitro
# node-server preset, which emits a standalone bundle at .output/ (no
# node_modules needed at runtime). Served by Node, not nginx.
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat tini \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY apps/customer apps/customer
RUN pnpm install --frozen-lockfile
# Build the @ms/shared workspace dep first — the customer app now imports it
# (delivery-schedule engine) and vite resolves it to its built dist output.
RUN pnpm --filter @ms/shared build \
 && pnpm --filter @ms/customer build

FROM base AS runtime
WORKDIR /repo/apps/customer
# Nitro's node-server output is self-contained — copy only .output.
COPY --from=build /repo/apps/customer/.output ./.output
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", ".output/server/index.mjs"]

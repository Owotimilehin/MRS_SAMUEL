# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /repo

FROM base AS build
# Address of the shop's admin app, for links out of the suite. Optional.
ARG VITE_ADMIN_URL=""
ENV VITE_ADMIN_URL=$VITE_ADMIN_URL
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages packages
# The suite reuses the inbox screens from the admin app's source, so both are needed.
COPY apps/admin apps/admin
COPY apps/suite apps/suite
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ms/shared build \
 && pnpm --filter @ms/suite build

FROM nginx:1.27-alpine AS runtime
COPY apps/suite/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/suite/dist /usr/share/nginx/html
EXPOSE 80

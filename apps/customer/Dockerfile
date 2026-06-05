# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY apps/customer apps/customer
RUN pnpm install --frozen-lockfile
# Vite inlines VITE_* at build time, so they must be present here (passed as
# build args from docker-compose). Blank is fine — features degrade gracefully.
ARG VITE_TURNSTILE_SITEKEY=""
ARG VITE_MAPBOX_TOKEN=""
ENV VITE_TURNSTILE_SITEKEY=$VITE_TURNSTILE_SITEKEY
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
RUN pnpm --filter @ms/shared build \
 && pnpm --filter @ms/customer build

FROM nginx:1.27-alpine AS runtime
COPY apps/customer/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/customer/dist /usr/share/nginx/html
EXPOSE 80

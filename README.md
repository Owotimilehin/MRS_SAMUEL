# Mrs. Samuel Fruit Juice — Admin

Monorepo for the admin web app, customer site, API, and background worker.

## Quick start

Prerequisites: Node 20+, pnpm 9+, Docker Desktop.

```bash
pnpm install
cp .env.example .env

# bring up Postgres + Redis (Docker)
pnpm db:up

# apply migrations
pnpm --filter @ms/db migrate

# seed the owner user
pnpm --filter @ms/db seed

# in one terminal:
pnpm dev:api

# in another:
pnpm dev:admin
```

Visit http://localhost:3000/login.

Default owner credentials (dev only):
- email: `owner@example.com`
- password: `ChangeMe!Owner-1234`

## Repository layout

```
apps/
  admin/         React + Vite admin PWA (owner + factory + branch)
  api/           Node + Hono HTTP service
  worker/        BullMQ background worker

packages/
  shared/        Zod schemas, error codes, env keys
  domain/        (Phase 1+) business rules: state machines, calculators
  db/            Drizzle schema, migrations, seed
```

## Useful commands

| Command | What it does |
| --- | --- |
| `pnpm lint` | Run ESLint across all packages |
| `pnpm typecheck` | `tsc -b` across all packages |
| `pnpm test` | Run vitest in every package that has tests |
| `pnpm build` | Build all packages |
| `pnpm db:up` / `pnpm db:down` | Start/stop Postgres + Redis containers |
| `pnpm --filter @ms/db generate` | Generate a new migration from schema changes |
| `pnpm --filter @ms/db migrate` | Apply pending migrations |
| `pnpm --filter @ms/db seed` | Seed the owner user |

## Architecture and plan

- Architecture spec: `../docs/2026-05-10-admin-architecture-design.md`
- Implementation plan: `../docs/2026-05-10-implementation-plan.md`
- BRD: `../docs/BRD.md`

Both docs live in the parent folder so the brand assets and the landing page share the same project root.

## Phases

| Phase | Focus | Status |
| --- | --- | --- |
| 0 | Foundation: repo, CI, auth, audit, idempotency | complete |
| 1 | Catalog, Factory, Stock Transfers | pending UX checkpoint |
| 2 | Branch PWA, Offline Sync, Walk-up & Aggregator Sales | pending |
| 3 | Online Channel + Payaza | pending |
| 4 | Returns & Refunds | pending |
| 5 | Daily Close & Reporting | pending |
| 6 | Polish, Runbook, Handover | pending |

**UX + visual design** is scheduled between Phase 0 and Phase 1 (see project memory).

## Notes for contributors

- Schema files in `packages/db/src/schema/*.ts` are auto-discovered by drizzle-kit via the glob in `drizzle.config.ts`.
- Hand-written SQL migrations require manual entries in `packages/db/migrations/meta/_journal.json` (drizzle-kit only writes journal entries for schema-derived migrations).
- API source uses `.js` extensions on relative imports for Node ESM runtime compatibility. DB schema files do not (drizzle-kit reads them differently).
- `env.ts` and `logger.ts` in `apps/api` use Proxy-based lazy init so tests can import middleware without all env vars being present.
- Rate limiter can be disabled in tests by setting `RATE_LIMIT_DISABLED=1` (already done in the testcontainers helper).

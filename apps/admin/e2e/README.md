# Admin E2E

Playwright runs against the locally-running stack.

## Prereqs (one-time)

```bash
docker compose up -d postgres redis
pnpm --filter @ms/db migrate
pnpm --filter @ms/db seed                 # creates owner@example.com / ChangeMe!Owner-1234
```

Then in two terminals:

```bash
# Terminal A
pnpm --filter @ms/api dev                 # :3001

# Terminal B
pnpm --filter @ms/admin dev               # :3000
```

## Run

```bash
pnpm --filter @ms/admin exec playwright install chromium   # once
pnpm --filter @ms/admin test:e2e
```

## Layout sanity (`layout-sanity.spec.ts`)

Walks every registered admin route at three viewports (390, 1024, 1440 wide)
and asserts:

| Check | Catches |
|---|---|
| `.app-side` bounding box height ≥ viewport height, background not transparent | Sidebar not covering full viewport (e.g. overflow misconfigured) |
| Every `.is-active` element has a non-transparent computed background | Invisible active-state buttons (e.g. size-toggle `var(--undefined)` regression) |
| `page.toHaveScreenshot()` against a baseline | Any visual drift — colour, spacing, font, missing element |
| `@axe-core/playwright` at WCAG 2 AA | Low-contrast text, missing aria-label, button names |

### First run: generate baselines

```bash
pnpm --filter @ms/admin exec playwright test layout-sanity --update-snapshots
```

This captures `*.png` files under
`apps/admin/e2e/layout-sanity.spec.ts-snapshots/`. Commit those — they are
the reference set CI compares against.

### Subsequent runs

```bash
pnpm --filter @ms/admin exec playwright test layout-sanity
```

Any deviation > 2 % pixel ratio fails the test. Open
`apps/admin/playwright-report/` to see the side-by-side diff.

### Intentionally update baselines

When you change a screen on purpose, re-run with `--update-snapshots`,
review the new `*.png` files in `git diff`, and commit them with the code
change.

## Smoke (`smoke.spec.ts`)

Basic login flow + products page render. Cheap, runs in seconds. Keep it
green at all times.

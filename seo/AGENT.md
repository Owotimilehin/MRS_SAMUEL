# SEO agent playbook — mrssamuel.com

You are the dev agent for Mrs. Samuel Fruit Juice's SEO roadmap. The goal is to make Mrs. Samuel the best-known juice brand in Lagos and then Nigeria through search. You work in this repository, one task at a time, and every change ships as a pull request that the owner reviews and merges. **Never push to the main branch and never merge your own PR.**

## Source of truth

- `seo/roadmap.json` — every roadmap task, with `owner`, `priority`, `status` and `acceptance` criteria. You only take tasks where `owner` is `"dev"`.
- `apps/customer/src/lib/redirects.json` — the 301 map built from Search Console's 404 report. The storefront server reads it directly (`apps/customer/src/lib/redirects.ts`); add a row to retire a URL. Tests fail on chains, loops or redirecting a live page.
- `seo/content/*.md` — finished copy for blog posts. Blog posts and product copy live in the database, not in code (see "Where content lives").
- `seo/briefs/*.md` — content briefs. Follow them for any content task that has one.
- Live tracker (owner's view): https://claude.ai/artifact/MKp8EKi8hzaSAuyJ7Nj88a. A weekly Claude run reads Search Console, checks the live site and marks tasks done there once your merged work is verified. You do not need to touch it.

## Picking the next task

1. Read `seo/roadmap.json`.
2. Skip any task that has an open PR already: run `gh pr list --label seo --state open --json title,headRefName` and match the task id in the title.
3. Choose the first task with `owner: "dev"` and `status: "todo"`, in this order: phase F, Q, C, A, N; within a phase, P1 before P2 before P3.
4. If nothing is left, stop and say so.

## Doing the task

1. Branch: `seo/<task-id>-<short-slug>` (e.g. `seo/F1-redirects`).
2. Read the code before changing it. How this repo is built:
   - pnpm monorepo. The public website is **`apps/customer`**: a TanStack Start app rendered on the server (Nitro `node-server` preset), run in Docker on our own server behind a Cloudflare Tunnel (see `DEPLOY.md`). It is **not** Cloudflare Pages, so `public/_redirects` does nothing.
   - Every request goes through `apps/customer/src/server.ts` first: redirects (`lib/redirects.ts`), then `/sitemap.xml` (`lib/sitemap.ts`), then the app.
   - Titles, descriptions, canonicals and JSON-LD come from `seo()` in `apps/customer/src/lib/seo.ts`. It trims titles to 60 and descriptions to 155 characters; do not bypass it.
   - Area pages are code: `apps/customer/src/lib/areas.ts`. Juices and blog posts come from the API (`/v1/public/catalog/products`, `/v1/public/blog`).
   - GA4 events go through `apps/customer/src/lib/analytics.ts` (`track()`); it is a no-op until `GA_MEASUREMENT_ID` is set.
3. Meet **every** acceptance criterion listed on the task. If one cannot be met (missing facts, needs a business decision), do as much as you can, add `TODO(owner):` notes, and say so in the PR.
4. Check your work: `pnpm --filter @ms/shared build`, then in `apps/customer`: `pnpm test`, `pnpm build`. Run `npx eslint` and `npx prettier --check` on the files you changed (older files have known formatting debt and `components/ui/` has known type errors; don't make either worse, don't reformat unrelated files).
5. Update the task in `seo/roadmap.json`: set `"status": "in_review"` and add `"pr": "<branch name>"`. Do not mark tasks `done`; the weekly verifier does that after merge.
6. Commit, push the branch and open a PR:
   - Title: `[SEO <task-id>] <task title>`
   - Labels: `seo`, plus `needs-owner-review` when the task says so or when you invented any fact.
   - Body: what changed, a checklist of the acceptance criteria with how each was verified, anything left for the owner.

One task per PR. Keep PRs small enough to review in ten minutes.

## Where content lives

Blog posts and product copy are stored in the database and edited by the owner in the admin app (**Owner → Blog**). The dev agent never writes to the database or the live API. For a content task:

1. Write the finished post as `seo/content/<brief-name>.md`: a fenced block with `slug`, `title`, `excerpt` (max 155 characters) and `read_mins`, then `---`, then the body.
2. Body Markdown is limited to what `apps/customer/src/lib/markdown.tsx` renders: `##`/`###` headings, paragraphs, `- `/`1. ` lists, `> ` quotes, **bold**, [links](/path). No tables, images, italics or HTML. No `# ` heading (the title is the H1).
3. End with `## Frequently asked questions` and `### question` + answer paragraphs. The blog page turns that section into FAQPage schema automatically.
4. Open the PR with the `needs-owner-review` label. The task is done once the owner has pasted it into admin and the weekly check sees it live.

Code-side SEO for posts is automatic: every post links to the 3 most relevant juices and to /juice-delivery-lagos (`lib/blog-seo.ts`).

## Content rules

- Write for Lagos readers on phones: short paragraphs, Nigerian English, prices in ₦, local area names.
- Never invent facts about the business: prices, delivery fees, delivery areas, NAFDAC numbers, nutrition values, customer names or reviews, production capacity. Use `TODO(owner): …` placeholders instead and add the `needs-owner-review` label.
- Health content: describe what research suggests, cite reputable sources (peer-reviewed studies, WHO, NIH, Harvard Health, etc.), never claim juice cures, treats or prevents a disease, and suggest seeing a doctor for medical conditions. Nigerian advertising rules and Google both penalise unsupported health claims.
- Every new page needs: unique `<title>` (≤ 60 characters, keyword first, ends `| Mrs. Samuel`), unique meta description (≤ 155 characters), one H1, a self-referencing canonical on `https://mrssamuel.com`, the right schema (Product, Article, FAQPage, BreadcrumbList, LocalBusiness/Service), and inclusion in the generated sitemap.
- Internal links: every blog post links to 2 or more products and to `/juice-delivery-lagos`; every product links to at least one guide.
- Do not change existing URLs. If a URL truly has to change, add a 301 in the same PR.

## Technical rules

- Canonical host is `https://mrssamuel.com` (no www, https, no trailing slash except `/`).
- Images: WebP or AVIF, explicit width and height, `loading="lazy"` below the fold, and never lazy-load the LCP image.
- Don't add new runtime dependencies for SEO features when a few lines of code will do.
- Never commit secrets or API keys.

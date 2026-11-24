# SEO roadmap kit

Keeps mrssamuel.com's SEO roadmap moving: a list of tasks, rules for the agent that does the code work, and finished copy for the owner to paste in.

| File | What it is |
|---|---|
| `roadmap.json` | All 33 roadmap tasks with owner (`dev`, `you`, `claude`), priority, status and acceptance criteria |
| `AGENT.md` | Rules the dev agent follows. Read this before any SEO work |
| `briefs/*.md` | Content briefs |
| `content/*.md` | Finished blog copy, ready to paste into admin (Owner → Blog) |
| `../apps/customer/src/lib/redirects.json` | The 301 map from Search Console's 404 report |
| `../.claude/commands/seo-next.md` | `/seo-next [task]`: do the next dev task and open a PR |
| `../.claude/commands/seo-audit.md` | `/seo-audit`: read-only audit of the built site |
| `../.github/workflows/seo-agent.yml` | Runs `/seo-next` from GitHub Actions. Manual only for now |

Status flow: `todo` → `in_review` (PR open) → `done` (merged, deployed and checked live).

Live tracker: https://claude.ai/artifact/MKp8EKi8hzaSAuyJ7Nj88a

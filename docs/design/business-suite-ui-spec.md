# Business Suite UI/UX spec

**Source of truth:** [`docs/mockups/dashboard-v2-mrs-samuel.html`](../mockups/dashboard-v2-mrs-samuel.html), chosen by the owner on 21 Nov 2026.
**Applies to:** the Business Suite only (`apps/suite`, suite.mrssamuel.com). The shop admin and the till have their own design ([`business-suite-dashboard.html`](../mockups/business-suite-dashboard.html)) and must not change.
**Where it lives in code:** `apps/suite/src/suite.css` (tokens, frame, design rules), `apps/suite/src/SuiteShell.tsx` (the frame). Suite styles are scoped to `.suite-shell` because the suite also loads the admin stylesheet.

Every suite screen, new or changed, follows this document. If a screen needs something this spec doesn't cover, add the pattern here first, then build it.

---

## 1. Principles

1. **Warm, calm, professional.** Cream page, white panels, one accent colour (orange). The juice brand shows through colour and fruit swatches, not through animation or decoration.
2. **One accent, used sparingly.** Orange marks what is chosen, what is new, or the main action. Green means good, amber means "needs attention", red means wrong. Nothing else is coloured.
3. **Lead with the answer.** Every page opens with its title and the most important thing to do or know. Numbers come before lists, lists before detail.
4. **Flat and light.** Hairline borders and a barely-there shadow. No gradients on controls, no glass, no glows (the only gradients are the "brief" panel and progress bars).
5. **Serif for titles only.** Page titles are serif (Fraunces). Everything else, including card titles, is sans (Plus Jakarta Sans).
6. **Plain English.** Labels say what things are ("Waiting for a reply", "Missed call"). No codes, no jargon, sentence case.
7. **Real data or nothing.** A number, badge or chart is only shown if it comes from real data. No decorative figures.

---

## 2. Design tokens

### Colour (light)

| Token | Value | Use |
|---|---|---|
| `--bg` page | `#fbf7f1` | Page background (cream) |
| `--panel` | `#ffffff` | Cards, sidebar, inputs |
| `--panel-2` | `#fdf9f3` | Soft fills: table heads, switcher, small cards inside cards |
| `--border` | `#efe6da` | Every hairline |
| `--border-strong` | `#e2d6c6` | Input borders, hover borders, bar tracks |
| `--text` | `#1d1712` | Body text, titles, numbers |
| `--muted` | `#6b5f53` | Secondary text, nav items, labels (5.8:1 on cream) |
| `--faint` | `#9a8d7f` | Timestamps, crumbs, section labels, placeholders only (never body text) |
| `--accent` | `#e85d1c` | Accent fills: primary button, badges, bars, dots |
| `--accent-soft` | `#fdecd2` | Chosen tab/nav item, chip backgrounds, brief panel |
| `--accent-ink` | `#b8460f` | Orange text on `--accent-soft` (4.6:1) |
| `--green` / `--green-soft` | `#1f7a44` / `#e4f3e9` | Good, up, answered, live |
| `--amber` / `--amber-soft` | `#c98a12` / `#fdf2d9` | Waiting, needs attention |
| `--red` / `--red-soft` | `#d03a3a` / `#fbe5e5` | Down, missed, failed |
| `--pink` / `--pink-soft` | `#e8536a` / `#fbe0e3` | Second data series, strawberry flavours |

In code: `--surface-sunken` = bg, `--shell` = panel, `--surface-soft` = panel-2, `--line` / `--line-strong` = border / border-strong, `--ink` / `--ink-soft` / `--ink-faint` = text / muted / faint, `--accent-fill` = accent, `--accent` = `#c84b14` (a shade deeper, used where orange carries text so it passes WCAG AA).

**Dark mode** exists in the mockup (`#120e0b` page, `#1a1511` panel, `#ff7a3d` accent). It is **not built yet**; light is the only theme.

### Type

| Role | Font | Size / weight | Example |
|---|---|---|---|
| Page title (h1) | Fraunces | 30px / 600, line-height 1.15 (25px on phone) | "Good afternoon, Mrs. Samuel" |
| Brand name | Fraunces | 16px / 600 | "Mrs. Samuel" in the sidebar |
| Card title (h3) | Plus Jakarta Sans | 15px / 700 | "Sales, last 14 days" |
| Body | Plus Jakarta Sans | 14px / 400, line-height 1.45 | |
| Big number | Plus Jakarta Sans | 27px / 700, letter-spacing −0.02em, tabular figures | "₦336,000" |
| Secondary | Plus Jakarta Sans | 12.5–13px / 500 | card subtitles, footnotes |
| Section label | Plus Jakarta Sans | 11px / 600, UPPERCASE, letter-spacing 0.07em, faint | "SELL", "MONEY" |
| Small / meta | Plus Jakarta Sans | 12px | timestamps, table secondary line |

All numbers use tabular figures (`font-feature-settings: "tnum"`, class `tabular-nums`).

### Space, shape, depth

- Spacing steps: 4, 6, 8, 10, 12, 14, 16, 18, 22, 26, 28px. Grid gaps are 16px. Content padding is 26px top, 28px sides (18px / 16px on phone).
- Corner radius: **14px** cards and panels; **10px** buttons, inputs, search, segmented control; **9px** nav items; **7px** chips and tags; **999px** status pills and badges.
- Shadow (cards only): `0 1px 2px rgba(60,40,20,.04), 0 2px 6px rgba(60,40,20,.03)`. Nothing else casts a shadow.
- Borders: 1px `--border` on every card, input, button, table row.
- Content max width 1440px.

### Icons

Lucide, 17px in navigation, 16px in buttons, 1.9 stroke. Channel marks (WhatsApp, Instagram, Facebook) use their brand colour; everything else inherits text colour.

---

## 3. The frame (every page)

```
┌────────────┬──────────────────────────────────────────────────────────────┐
│ Brand      │ Crumbs                          [Search ⌘K] [🔔] [+ Action] │ ← top bar, sticky
│ Switcher   ├──────────────────────────────────────────────────────────────┤
│            │ Page title (serif 30)                       [seg] [buttons] │ ← page head
│ SECTION    │ subtitle                                                     │
│  Nav item  │                                                              │
│  Nav item 7│  page content                                                │
│ SECTION    │                                                              │
│  …         │                                                              │
│ [Card]     │                                                              │
│ (MS) You   │                                                              │
└────────────┴──────────────────────────────────────────────────────────────┘
   252px                               1fr
```

### Sidebar (252px, white, right hairline, padding 16px 12px, gap 18px, scrolls as one)

1. **Brand**: 36px orange rounded square (radius 11) with the white logo; "Mrs. Samuel" (Fraunces 16/600) over "Fruit Juice · Business Suite" (11.5px faint).
2. **Switcher card**: radius 10, `--panel-2`, border; green status dot with a soft ring; two lines; up-down chevron on the right. In the suite it opens the shop admin.
3. **Navigation**: groups, each with an UPPERCASE section label. Items are 13.5px/500 muted, padding 7px 10px, radius 9, icon 17px, gap 10px.
   - Hover: `--panel-2` background, text colour.
   - **Current page: `--accent-soft` background, `--accent-ink` text, 600 weight.** No bar, no outline.
   - Count badge on the right: orange pill (`--accent`, white 11px/600, padding 0 7px). A quiet count uses `--panel-2` with a border and muted text.
4. **Card near the foot**: radius 14, `--panel-2`, border, padding 14; a bold 13px title, a 12.5px muted line, optional progress bar (7px, orange on `--border`). It must show real figures.
5. **You**: 32px round avatar with initials (green), name 13px bold, role 12px faint, sign-out icon button.

Suite menu groups: **Conversations** (Inbox, Calls, Comments, Contacts) · **Selling** (Catalogue) · **Marketing** (Posts, Leads, Ads) · **Insight** (Insights, Reports) · **Set-up** (Channels, Templates and forms, Settings).

### Top bar (sticky, padding 12px 28px, cream at 85% with an 8px blur, bottom hairline)

- **Crumbs** (13px faint): `Mrs. Samuel / <b>Page</b>`, current page in text colour 600.
- **Search** (pushed right, 340px, radius 10, white, border): search icon, placeholder "Search chats, contacts, posts…", key hint `⌘K` (Mac) / `Ctrl K` (others) in a small bordered box. The shortcut focuses the box.
- **Icon button** 36×36 radius 10 with a 7px orange dot when there is something new (bell → unread chats).
- **Primary action** (orange button with a plus): the most common "create" action. Hidden on the page that already shows it.

### Page head (in the content, margin-bottom 22px)

- Title, serif 30px. Optional subtitle 14px muted, 4px below.
- Actions on the right (wrap under on small screens): a **segmented control** for periods or views, then plain buttons ("Export"). At most one primary button.

---

## 4. Components

| Component | Spec | Code |
|---|---|---|
| **Button** | 38px high (32px small), padding 0 14px, radius 10, 13px/600, white with border. Hover `--panel-2`. | `.btn`, `.btn--sm` |
| **Primary button** | `--accent` fill, white text, no border, no shadow. One per view. | `.btn--primary` |
| **Danger button** | `--red` fill, white. Only for deleting. | `.btn--danger` |
| **Icon button** | 36×36, radius 10, white, border, muted icon. | `.btn--icon`, `.suite-icon-btn` |
| **Segmented control** | One bordered strip (radius 10, white, padding 3, gap 2). Options 12.5px/500 muted, padding 5px 11px, radius 7. **Chosen: `--accent-soft`, `--accent-ink`, 600.** Used for every set of tabs, periods and views. | `.ibx-tabs`, `.po-tabs`, `.cmt-tabs`, `.tpl-tabs`, `.cs-tabs` |
| **Card** | White, 1px border, radius 14, card shadow, overflow hidden. | `.card` |
| **Card header** | padding 16px 18px 0; title 15px/700; subtitle 12.5px faint; actions on the right. | `.card__head` |
| **KPI card** | padding 16px 18px. Row 1: 26px rounded icon square (soft colour bg, strong colour icon), 13px/500 muted label, change chip on the right. Row 2: big number 27px/700 (margin 10px 0 4px). Row 3: 12.5px faint footnote with the comparison. Four across on desktop, two on laptop, one on phone. | `.stat-card` (to be aligned) |
| **Change chip** | 12px/600, radius 7, padding 2px 7px. Up = green on green-soft with ↑; down = red on red-soft with ↓; waiting = amber on amber-soft; neutral = accent-ink on accent-soft. | `.stat-card__delta--up/--down` |
| **Brief ("at a glance")** | Card with `linear-gradient(100deg, --accent-soft, --panel 65%)`; 34px orange icon square; bold 14px title; bullet list (5px orange dots) of up to 3 plain-English sentences with the key fact in bold; one button on the right ("Review all"). One per page, at the top, only when there is something to act on. | `.juice-hero` (restyled) |
| **Status pill** | 12.5px/600, radius 999, padding 3px 10px, 6px dot in the text colour. Good = green, waiting = amber, bad = red, info = accent. Sentence case. | `.pill--success/--warning/--danger/--accent` |
| **Tag** | 12px/500, 1px border, radius 7, padding 2px 8px, muted. Chosen filter tag: `--accent-soft` / `--accent-ink`. | `.ct-chip`, `.cat-chip` |
| **Table** | Head: 12px/600 faint, padding 9px 18px, `--panel-2` band with top and bottom hairlines, sentence case. Rows: 13.5px, padding 11px 18px, hairline between, no zebra. Numbers right-aligned and tabular. Two-line cells put the detail in 12px faint below. Person cells start with a 28px initials avatar. | `.table` |
| **List row / feed item** | 30–36px rounded icon square, a 13–13.5px line with the subject in bold, a 12px faint time line, hairline between items. | |
| **Progress bar** | 6–7px, radius 99, track `--border`, fill orange (or the item's own colour). Label above: name left, value right in faint. | |
| **Swatch** | 34px rounded square in the item's soft colour, a small coloured bottle shape inside (flavours, channels). | |
| **Inputs** | 38–40px high, radius 10, 1px `--border-strong`, white; focus = accent border + 3px accent ring at 22%. Labels 12.5–13px/600 above. Placeholder faint. | `.input`, `.select` |
| **Empty state** | A plain white card (no dashed edge): bold 14px title, 13px muted line, one button if there is something to do. | `.empty` |
| **Notice** | Soft-colour banner, radius 14, 13–14px: amber for "connect something", red for a problem. One sentence and a link. | |
| **Charts** | Orange first series, green second, pink third. Dashed `--border` gridlines, 11px faint axis text, no chart border. Legend above (10px rounded squares) with the total on the right. Today's bar lighter. | |

---

## 5. Page templates

**Overview (home).** Page head with greeting and date ("Good afternoon, {name}") and a period control. Brief panel. A row of 4 KPI cards. Main chart (wide) beside a ranked list (narrow), ratio 1.75 : 1. Then a table (1.6) beside an activity feed (1). Then three smaller cards. *The suite does not have this page yet.*

**List page** (Contacts, Leads, Posts, Calls log). Page head with actions. Optional notice. Segmented control for the main split (status or view) on the left, filters on the right or below. A table card. Empty state inside the card.

**Three-pane workspace** (Inbox). Page head with actions. Three cards side by side: list (fixed width), conversation (flex), details (fixed). The list's own tabs use the segmented control at full width.

**Detail page** (one contact, one post, one advert). Crumb includes the parent ("Mrs. Samuel / Contacts / Tolu A."). Title is the item's name. A main column of cards and a side column of facts.

**Settings page.** Page head. A segmented control for the sections. Each section is a card with a 15px title, a one-line explanation, then fields. Save button bottom-right of the card.

**Report / metrics page** (Insights, Reports, Calls metrics). Period segmented control in the page head. KPI row first, then charts in cards, then breakdown tables. Every figure has a footnote saying what it counts.

---

## 6. Behaviour

- **Hover:** background moves to `--panel-2` or the border to `--border-strong`. No lift, no scale, no shadow change.
- **Focus:** visible on every control: accent border plus a 3px ring at 22% opacity. Never remove outlines without a replacement.
- **Motion:** none, except a 120–200ms colour/border transition and loading spinners. No floating, bouncing or looping animation inside the suite.
- **Loading:** keep the layout; show the card with a quiet "Loading…" or skeleton bars in `--panel-2`. Never a full-page spinner after the first load.
- **Errors:** red notice in plain English saying what happened and what to do. Form errors under the field.
- **Counts and badges** refresh on their own (every minute, or live where the inbox stream already pushes).
- **Times** are Lagos time, written like people talk: "2 min ago", "Today 14:05", "Fri 20 Nov".
- **Money** is naira with no decimals: "₦336,000"; large values "₦3.12M".

---

## 7. Responsive

| Width | Layout |
|---|---|
| ≥ 1280px | Full sidebar (252px). KPI row 4 across. Two-column rows. |
| 1024–1279px | Sidebar becomes an icon rail (76px); labels show on hover; the switcher, foot card and name hide. KPI row 2 across. Two-column rows stack. |
| < 1024px | Sidebar is a drawer behind a menu button. Top bar: menu · search (fills) · bell · round "+" button. Crumbs and key hint hide. Page title 25px. |
| < 640px | Everything single column. Tables scroll sideways inside their card. The top bar stays one row. |

---

## 8. Accessibility

- Text contrast at least 4.5:1: body `--text`, secondary `--muted`. `--faint` only for decoration-level text (timestamps next to readable content, placeholders).
- Small white text sits on `#c84b14` or darker (the code's `--accent`); the bright `#e85d1c` (`--accent-fill`) is for badges, bars and dots, and for the primary button only where its label is 13px/600 or larger.
- Every icon-only button has an `aria-label`. Tabs use `role="tab"` and `aria-selected`. Counts have a spoken label ("12 unread messages").
- Inputs on phones are at least 16px so iPhones don't zoom.
- `prefers-reduced-motion` turns off any transition longer than 200ms.

---

## 9. Checklist for any suite screen

- [ ] Sits inside the suite frame; title in the page head, not in the top bar.
- [ ] One primary (orange) action at most.
- [ ] Every set of options is a segmented control; every status is a dotted pill.
- [ ] Card titles are 15px bold sans; only the page title is serif.
- [ ] Cards: white, 14px corners, hairline, light shadow. No dashed borders, glass or gradients (except the brief and bars).
- [ ] Numbers tabular, money in naira, times in Lagos.
- [ ] Empty, loading and error states designed.
- [ ] Checked at 1440, 1280, 1024 and 390px wide.
- [ ] Shop admin and till unchanged.

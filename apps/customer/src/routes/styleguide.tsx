import { useState } from "react";
import { Button, Eyebrow, SectionHeader, SizeToggle, StatusPill, type Status } from "../components/ui/index.js";
import { MENU, bottleFor, type Size } from "../data/menu.js";
import { ngn } from "../lib/api.js";

/* Visual contract for the Mrs. Samuel design system. Anyone building a new
 * screen should open /styleguide first, find the patterns and components
 * they need, and copy/import them directly — no re-implementing styles. */

const SWATCHES = [
  { name: "--ink",         value: "#14181F", note: "Primary text, headings" },
  { name: "--ink-soft",    value: "#6B7280", note: "Secondary text, sub-copy" },
  { name: "--line",        value: "#EEF0F3", note: "Card borders, dividers" },
  { name: "--surface-soft",value: "#F5F6F8", note: "Pill bg, secondary chips" },
  { name: "--accent",      value: "#F15A24", note: "Brand orange · CTA · links" },
  { name: "--accent-2",    value: "#E63946", note: "Cart badge · flagged" },
  { name: "--accent-3",    value: "#FCBF49", note: "Sunrise gradient stop" },
  { name: "--success",     value: "#10B981", note: "Approved · delivered" },
  { name: "--warning",     value: "#F59E0B", note: "Pending · low stock · stars" },
  { name: "--danger",      value: "#DC2626", note: "Errors · cancelled" },
];

const STATUSES: Status[] = ["pending", "confirmed", "paid", "out_for_delivery", "delivered", "cancelled", "rejected", "flagged", "requires_review"];

export function StyleguidePage(): JSX.Element {
  const [size, setSize] = useState<Size>(650);
  const sampleItem = MENU[0]!;

  return (
    <div style={{ padding: "32px clamp(20px, 4vw, 56px)", maxWidth: 1140, margin: "0 auto" }}>
      {/* ── Header ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 48 }}>
        <Eyebrow>Design system</Eyebrow>
        <h1 className="ms-h1" style={{ fontSize: "clamp(36px, 4vw, 52px)", marginTop: 8 }}>
          Mrs. Samuel <span className="text-grad">style guide</span>
        </h1>
        <p className="ms-section-sub">
          Canonical reference for every visual primitive. Open this before designing any new screen.
          Copy class names + component imports. Don't re-implement.
        </p>
      </div>

      {/* ── Colors ────────────────────────────────────────────────── */}
      <Section title="Colors" eyebrow="01 · Tokens">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14 }}>
          {SWATCHES.map((s) => (
            <div key={s.name} style={{ border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden" }}>
              <div style={{ height: 72, background: s.value }} />
              <div style={{ padding: 12 }}>
                <code style={{ fontSize: 12, fontWeight: 700 }}>{s.name}</code>
                <div style={{ fontSize: 11, color: "var(--ink-soft)", margin: "2px 0 4px" }}>{s.value}</div>
                <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>{s.note}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ height: 72, borderRadius: 14, background: "var(--grad)", marginTop: 16, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, letterSpacing: "-0.02em" }}>
          --grad · sunrise gradient · use on .btn--primary, brand mark, KPI numerals
        </div>
      </Section>

      {/* ── Typography ────────────────────────────────────────────── */}
      <Section title="Typography" eyebrow="02 · Tokens">
        <Demo label="ms-h1 (hero headline)">
          <h1 className="ms-h1">Juice to make your day <span className="text-grad">fresh.</span></h1>
        </Demo>
        <Demo label="ms-section-title">
          <h2 className="ms-section-title">17 cold-pressed juices</h2>
        </Demo>
        <Demo label="ms-section-sub">
          <p className="ms-section-sub" style={{ margin: 0 }}>
            Bottled fresh every morning · No sugar · No preservatives
          </p>
        </Demo>
        <Demo label="ms-label.eyebrow (via Eyebrow component)">
          <Eyebrow>Loved across Lagos</Eyebrow>
        </Demo>
        <Demo label=".text-grad (utility — sunrise gradient text fill)">
          <span className="text-grad" style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.025em" }}>
            ₦3,500
          </span>
        </Demo>
      </Section>

      {/* ── Buttons ───────────────────────────────────────────────── */}
      <Section title="Buttons" eyebrow="03 · Components">
        <Demo label="<Button variant='primary'> — sunrise gradient (LOCKED IN MEMORY: always grad, never solid)">
          <Button variant="primary">Add to cart</Button>
        </Demo>
        <Demo label="<Button variant='ghost'>">
          <Button variant="ghost">View menu</Button>
        </Demo>
        <Demo label="Icon button (.ms-iconbtn)">
          <button className="ms-iconbtn" aria-label="Cart"><CartIcon /></button>
          <button className="ms-iconbtn" aria-label="Cart with badge">
            <CartIcon />
            <span className="badge">3</span>
          </button>
        </Demo>
      </Section>

      {/* ── Form controls ─────────────────────────────────────────── */}
      <Section title="Form controls" eyebrow="04 · Components">
        <Demo label="<SizeToggle> — segmented size selector (used in hero details + every menu card)">
          <SizeToggle size={size} onChange={setSize} />
          <span style={{ marginLeft: 14, color: "var(--ink-soft)", fontSize: 13 }}>
            Selected: <strong>{size}ml</strong> → {ngn(size === 650 ? 3500 : 2500)}
          </span>
        </Demo>
        <Demo label="Input (.ms-news__form input style)">
          <input
            type="email"
            placeholder="your@email.com"
            style={{ height: 48, padding: "0 16px", borderRadius: 999, border: "1px solid var(--line)", background: "var(--shell)", fontSize: 14, fontFamily: "inherit", width: 280 }}
          />
        </Demo>
        <Demo label="Pill nav (.ms-full__tabs)">
          <div className="ms-full__tabs" style={{ margin: 0 }}>
            <button className="is-active">All 17</button>
            <button>Regulars</button>
            <button>Specials</button>
            <button>Punch</button>
          </div>
        </Demo>
      </Section>

      {/* ── Status pills ──────────────────────────────────────────── */}
      <Section title="Status pills" eyebrow="05 · Badges">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {STATUSES.map((s) => <StatusPill key={s} status={s} />)}
        </div>
      </Section>

      {/* ── Cards ─────────────────────────────────────────────────── */}
      <Section title="Cards" eyebrow="06 · Components">
        <Demo label=".menu-card (product grid card)">
          <div style={{ maxWidth: 360 }}>
            <article className="menu-card">
              <div className="menu-card__media">
                <img src={bottleFor(sampleItem)} alt={sampleItem.name} />
              </div>
              <div className="menu-card__body">
                <div className="menu-card__head">
                  <h3 className="menu-card__name">{sampleItem.name}</h3>
                  <span className="menu-card__price">{ngn(3500)}</span>
                </div>
                <p className="menu-card__ings">{sampleItem.ingredients.join(" · ")}</p>
                <div className="menu-card__foot">
                  <SizeToggle size={size} onChange={setSize} />
                  <button className="menu-card__add"><CartIcon size={14} /> Add</button>
                </div>
              </div>
            </article>
          </div>
        </Demo>
        <Demo label=".ms-stat (KPI tile)">
          <div style={{ width: 200 }}>
            <div className="ms-stat">
              <div className="ms-stat__n text-grad">17</div>
              <div className="ms-stat__label">Juice flavours</div>
            </div>
          </div>
        </Demo>
        <Demo label=".ms-how__step (process step)">
          <div style={{ maxWidth: 340 }}>
            <div className="ms-how__step">
              <div className="ms-how__num">1</div>
              <h3 className="ms-how__title">Pick your juice</h3>
              <p className="ms-how__body">Browse 17 cold-pressed flavours. Mix sizes, mix bottles.</p>
            </div>
          </div>
        </Demo>
        <Demo label=".ms-test__card (testimonial)">
          <div style={{ maxWidth: 280 }}>
            <figure className="ms-test__card">
              <div className="ms-test__stars">★★★★★</div>
              <blockquote>"Best Sunrise Blend I've ever had. Order every Friday now."</blockquote>
              <figcaption><strong>Adaeze O.</strong> · Ikoyi</figcaption>
            </figure>
          </div>
        </Demo>
      </Section>

      {/* ── Section header pattern ────────────────────────────────── */}
      <Section title="Section header" eyebrow="07 · Patterns">
        <Demo label="<SectionHeader> — used at the top of every content section">
          <div style={{ background: "var(--surface-sunken)", padding: 32, borderRadius: 18 }}>
            <SectionHeader
              eyebrow="How it works"
              title="From our kitchen to your door, the same day."
              sub="Real fruit washed, peeled, and pressed before sunrise in Ajao Estate."
            />
          </div>
        </Demo>
      </Section>

      {/* ── Layout primitives ─────────────────────────────────────── */}
      <Section title="Layout" eyebrow="08 · Patterns">
        <Demo label="Container (.ms-container) — Bootstrap-style responsive max-width + 12px padding-x">
          <code style={{ fontSize: 12, background: "var(--surface-soft)", padding: "8px 12px", borderRadius: 8, display: "inline-block" }}>
            sm 540 · md 720 · lg 960 · xl 1140 · xxl 1320
          </code>
        </Demo>
        <Demo label="Card hover pattern">
          <p className="ms-section-sub" style={{ margin: 0 }}>
            All cards (.menu-card, .ms-stat, .ms-how__step, .ms-test__card) use:
            <code style={{ display: "block", marginTop: 8, padding: "8px 12px", background: "var(--surface-soft)", borderRadius: 8, fontSize: 12 }}>
              hover: translateY(-2px), shadow-card, border-color: transparent
            </code>
          </p>
        </Demo>
        <Demo label="Radii reference">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {[
              ["pill", 999],
              ["card", 22],
              ["shell", 28],
              ["input", 12],
            ].map(([name, r]) => (
              <div key={name as string} style={{ textAlign: "center" }}>
                <div style={{ width: 60, height: 60, background: "var(--surface-soft)", border: "1px solid var(--line)", borderRadius: r as number }} />
                <code style={{ fontSize: 11, color: "var(--ink-soft)" }}>{name}</code>
              </div>
            ))}
          </div>
        </Demo>
      </Section>

      {/* ── Animations ────────────────────────────────────────────── */}
      <Section title="Animations" eyebrow="09 · Motion">
        <Demo label="Ambient float (used on hero fruits + bottle + glow)">
          <p className="ms-section-sub" style={{ margin: 0 }}>
            Hero elements use continuous ease-in-out keyframes with staggered delays so they
            never bob in unison. Hover pauses the animation. Reduced-motion users get a static scene.
          </p>
        </Demo>
        <Demo label="Slide-in (on flavour carousel change)">
          <p className="ms-section-sub" style={{ margin: 0 }}>
            <code style={{ fontSize: 11 }}>opacity 0 → 1, translateY(10px → 0), scale(0.95 → 1) over 420ms ease</code>
          </p>
        </Demo>
      </Section>

      <footer style={{ marginTop: 64, padding: 24, borderTop: "1px solid var(--line)", textAlign: "center", color: "var(--ink-soft)", fontSize: 13 }}>
        Edit <code>src/routes/styleguide.tsx</code> to extend this reference. Every new screen should compose from these primitives.
      </footer>
    </div>
  );
}

/* Small helper for clean section + demo layout in this page only */
function Section({ title, eyebrow, children }: { title: string; eyebrow: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <section style={{ paddingBlock: 32, borderTop: "1px dashed var(--line)" }}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="ms-section-title" style={{ marginTop: 6, marginBottom: 22 }}>{title}</h2>
      <div style={{ display: "grid", gap: 18 }}>{children}</div>
    </section>
  );
}

function Demo({ label, children }: { label: string; children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-soft)", marginBottom: 10 }}>{label}</div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>{children}</div>
    </div>
  );
}

/* Inline cart icon for the styleguide examples (kept local so styleguide doesn't
 * depend on menu.tsx's icon registry). */
function CartIcon({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
    </svg>
  );
}

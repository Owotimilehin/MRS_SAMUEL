import type { CSSProperties } from "react";
import { getFlavourVisual } from "../lib/flavour-visuals.js";

export interface StatChip {
  label: string;
  value: string | number;
  tone?: "default" | "good" | "warn" | "danger";
}

export interface StatHeroProps {
  eyebrow: string;
  title: string;
  sub: string;
  chips?: StatChip[];
  bottleSlug?: string;
  loading?: boolean;
}

export function StatHero({
  eyebrow,
  title,
  sub,
  chips,
  bottleSlug,
  loading = false,
}: StatHeroProps): JSX.Element {
  const showChips = chips && chips.length > 0;
  return (
    <section className="juice-hero ed-rise">
      <div className="juice-hero__body">
        <div className="juice-hero__eyebrow">{eyebrow}</div>
        <h1 className="juice-hero__title">{title}</h1>
        <p className="juice-hero__sub">{sub}</p>
      </div>
      {showChips ? (
        <div className="juice-hero__aside">
          {// Chip labels are unique within a hero, so they make stable keys.
          chips.map((c) => (
            <div
              key={c.label}
              className={`hero-chip${c.tone && c.tone !== "default" ? ` hero-chip--${c.tone}` : ""}${
                loading ? " is-loading" : ""
              }`}
              style={{ ["--chip-c" as string]: chipColor(c.tone) } as CSSProperties}
            >
              <b>{loading ? "—" : c.value}</b>
              <span>{c.label}</span>
            </div>
          ))}
        </div>
      ) : bottleSlug ? (
        <img
          className="juice-hero__bottle"
          src={getFlavourVisual({ slug: bottleSlug }).bottle}
          alt=""
          aria-hidden="true"
          style={{ height: 188 }}
        />
      ) : null}
    </section>
  );
}

function chipColor(tone: StatChip["tone"]): string {
  if (tone === "danger") return "#ff6b6b";
  if (tone === "warn") return "#f6b545";
  if (tone === "good") return "#7ee0a6";
  return "#ffffff";
}

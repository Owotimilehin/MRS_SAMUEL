import type { CSSProperties, ReactNode } from "react";

interface StatProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad" | "accent";
  /** Optional delta badge, e.g. "+12%". Positive renders green, negative red. */
  delta?: string;
  /** Optional slot below the value (e.g. a sparkline). */
  children?: ReactNode;
}

export function Stat({ label, value, hint, tone = "default", delta, children }: StatProps): JSX.Element {
  // Use the AA-on-white "ink" shades — the base status hues fail WCAG contrast
  // as the small bold label text.
  const labelColor =
    tone === "good"
      ? "var(--success-ink)"
      : tone === "warn"
        ? "var(--warning-ink)"
        : tone === "bad"
          ? "var(--danger-ink)"
          : tone === "accent"
            ? "var(--accent)"
            : "var(--ink-soft)";
  // Tone-matched colour for the liquid edge + droplet watermark (--c).
  const edge =
    tone === "good"
      ? "#1f9e74"
      : tone === "warn"
        ? "#e8951c"
        : tone === "bad"
          ? "#dc2626"
          : "var(--accent)";
  const deltaDown = delta?.trim().startsWith("-");
  return (
    <div className="stat-card" style={{ ["--c" as string]: edge } as CSSProperties}>
      <div className="stat-card__label" style={{ color: labelColor }}>
        {label}
      </div>
      <div className="stat-card__value">{value}</div>
      {delta && (
        <div className={`stat-card__delta ${deltaDown ? "stat-card__delta--down" : "stat-card__delta--up"}`}>
          {deltaDown ? "▼" : "▲"} {delta.replace(/^[-+]/, "")}
        </div>
      )}
      {children}
      {hint && <div className="stat-card__hint">{hint}</div>}
    </div>
  );
}

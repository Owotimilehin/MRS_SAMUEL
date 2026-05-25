interface StatProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad" | "accent";
}

export function Stat({ label, value, hint, tone = "default" }: StatProps): JSX.Element {
  const labelColor =
    tone === "good"
      ? "var(--success)"
      : tone === "warn"
        ? "var(--warning)"
        : tone === "bad"
          ? "var(--danger)"
          : tone === "accent"
            ? "var(--accent)"
            : "var(--ink-soft)";
  return (
    <div className="stat-card">
      <div className="stat-card__label" style={{ color: labelColor }}>
        {label}
      </div>
      <div className="stat-card__value">{value}</div>
      {hint && <div className="stat-card__hint">{hint}</div>}
    </div>
  );
}

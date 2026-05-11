interface StatProps {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
}

export function Stat({ label, value, hint, tone = "default" }: StatProps): JSX.Element {
  const accent =
    tone === "good"
      ? "var(--ms-green-500)"
      : tone === "warn"
        ? "#e8a414"
        : tone === "bad"
          ? "var(--ms-danger)"
          : "var(--ms-ink-3)";
  return (
    <div
      className="p-5 rounded-xl flex flex-col gap-1"
      style={{ background: "var(--ms-surface)", border: "1px solid var(--ms-border)" }}
    >
      <div
        className="text-xs uppercase tracking-wide font-semibold"
        style={{ color: accent }}
      >
        {label}
      </div>
      <div className="font-display text-2xl font-bold tabular-nums">{value}</div>
      {hint && (
        <div className="text-xs" style={{ color: "var(--ms-ink-3)" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

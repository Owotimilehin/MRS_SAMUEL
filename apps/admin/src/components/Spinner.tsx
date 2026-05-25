import { useEffect, useState, type CSSProperties } from "react";

interface SpinnerProps {
  /** Visual size category. `xs` is a ring (for inline buttons); the others
   *  use the fruit bounce animation. */
  size?: "xs" | "sm" | "md" | "lg";
  /** Optional caption rendered below the animation. */
  label?: string;
  /** Extra inline styles for positioning. */
  style?: CSSProperties;
}

const SIZE_PX: Record<NonNullable<SpinnerProps["size"]>, number> = {
  xs: 18,
  sm: 28,
  md: 40,
  lg: 56,
};

/**
 * Branded loading indicator. Two visual modes:
 *
 *   `xs`        → A small sunrise-gradient ring (used inside buttons).
 *   sm/md/lg    → Three real fruit cutouts (orange, lemon, strawberry) wave-
 *                 bouncing in a row, with the brand logo softly pulsing under
 *                 them. Reinforces the "real cold-pressed juice" identity
 *                 every time someone has to wait.
 *
 * Respects `prefers-reduced-motion`: animations slow to a near-static state
 * via the global rule in index.css.
 */
export function Spinner({
  size = "md",
  label,
  style,
}: SpinnerProps): JSX.Element {
  if (size === "xs") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="ms-spinner ms-spinner--xs"
        style={{ width: SIZE_PX.xs, height: SIZE_PX.xs, ...style }}
      >
        <div className="ms-spinner__ring" aria-hidden />
        <span style={{ position: "absolute", left: -9999 }}>{label ?? "Loading"}</span>
      </div>
    );
  }

  const px = SIZE_PX[size];
  return (
    <div
      role="status"
      aria-live="polite"
      className="ms-fruitloader"
      style={{ ...style }}
    >
      <div
        className="ms-fruitloader__row"
        style={{ height: px, ["--fl-size" as string]: `${px}px` }}
        aria-hidden
      >
        <img src="/orange.png" alt="" className="ms-fruitloader__fruit ms-fruitloader__fruit--1" />
        <img src="/lemon.png" alt="" className="ms-fruitloader__fruit ms-fruitloader__fruit--2" />
        <img src="/strawberry.png" alt="" className="ms-fruitloader__fruit ms-fruitloader__fruit--3" />
      </div>
      {label && <span className="ms-fruitloader__label">{label}</span>}
      <span style={{ position: "absolute", left: -9999 }}>{label ?? "Loading"}</span>
    </div>
  );
}

/**
 * Full-screen loader, used for route-level transitions and initial auth
 * checks. Centers the fruit loader on a soft surface.
 */
export function PageLoader({ label = "Loading…" }: { label?: string }): JSX.Element {
  const [showSlow, setShowSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShowSlow(true), 4000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--surface-sunken)",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <Spinner size="lg" label={label} />
        {showSlow && (
          <p
            style={{
              marginTop: 14,
              fontSize: 12,
              color: "var(--ink-soft)",
              maxWidth: 280,
              marginInline: "auto",
            }}
          >
            Still loading… if this hangs for more than a minute, check your
            connection.
          </p>
        )}
      </div>
    </main>
  );
}

/**
 * Inline section loader — use inside card / table containers.
 */
export function InlineLoader({ label = "Loading…" }: { label?: string }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 16px",
      }}
    >
      <Spinner size="md" label={label} />
    </div>
  );
}

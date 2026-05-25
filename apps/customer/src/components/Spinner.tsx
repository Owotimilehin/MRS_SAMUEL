import { useEffect, useState, type CSSProperties } from "react";

interface SpinnerProps {
  size?: "xs" | "sm" | "md" | "lg";
  label?: string;
  style?: CSSProperties;
}

const SIZE_PX: Record<NonNullable<SpinnerProps["size"]>, number> = {
  xs: 18,
  sm: 28,
  md: 40,
  lg: 56,
};

/**
 * Customer-side branded loader. Three real fruit cutouts wave-bouncing in a
 * row — orange, lemon, strawberry. Reinforces the brand identity (no
 * preservatives, real fruit) every time the user has to wait.
 *
 * The `xs` variant is a small sunrise-gradient ring for inline button use.
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
    <div role="status" aria-live="polite" className="ms-fruitloader" style={style}>
      <div
        className="ms-fruitloader__row"
        style={{ height: px, ["--fl-size" as string]: `${px}px` }}
        aria-hidden
      >
        <img
          src="/assets/fruits/orange-cutout.png"
          alt=""
          className="ms-fruitloader__fruit ms-fruitloader__fruit--1"
        />
        <img
          src="/assets/fruits/lemon-cutout.png"
          alt=""
          className="ms-fruitloader__fruit ms-fruitloader__fruit--2"
        />
        <img
          src="/assets/fruits/strawberry-cutout.png"
          alt=""
          className="ms-fruitloader__fruit ms-fruitloader__fruit--3"
        />
      </div>
      {label && <span className="ms-fruitloader__label">{label}</span>}
      <span style={{ position: "absolute", left: -9999 }}>{label ?? "Loading"}</span>
    </div>
  );
}

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
        background: "var(--shell)",
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
            Still loading… if this hangs for more than a minute, refresh.
          </p>
        )}
      </div>
    </main>
  );
}

export function InlineLoader({ label = "Loading…" }: { label?: string }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "60px 16px",
      }}
    >
      <Spinner size="md" label={label} />
    </div>
  );
}

import type { OrderJourney as Journey } from "../lib/order-journey.js";

/**
 * Compact vertical timeline for the order-detail Status card. Reads a derived
 * OrderJourney (see lib/order-journey.ts) and renders done / current / upcoming
 * steps. Purely presentational — all status logic lives in the helper.
 */
export function OrderJourney({ journey }: { journey: Journey }): JSX.Element {
  const cancelled = journey.special === "cancelled";
  return (
    <ol
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gap: 0,
      }}
    >
      {journey.steps.map((step, i) => {
        const isLast = i === journey.steps.length - 1;
        const done = step.state === "done";
        const current = step.state === "current";

        const dotColor = cancelled
          ? "var(--ink-soft)"
          : done
            ? "var(--success, #2e7d32)"
            : current
              ? "var(--accent)"
              : "var(--line, #d8dae0)";
        const fill = done || current;

        return (
          <li key={step.key} style={{ display: "grid", gridTemplateColumns: "20px 1fr", columnGap: 10 }}>
            {/* Rail: dot + connector */}
            <div style={{ display: "grid", justifyItems: "center", rowGap: 0 }}>
              <span
                aria-hidden
                style={{
                  width: current ? 14 : 11,
                  height: current ? 14 : 11,
                  borderRadius: "50%",
                  marginTop: 3,
                  background: fill ? dotColor : "transparent",
                  border: `2px solid ${dotColor}`,
                  boxShadow: current ? `0 0 0 4px color-mix(in srgb, ${dotColor} 22%, transparent)` : "none",
                  flexShrink: 0,
                }}
              />
              {!isLast && (
                <span
                  aria-hidden
                  style={{
                    width: 2,
                    flex: 1,
                    minHeight: 18,
                    background: done ? "var(--success, #2e7d32)" : "var(--line, #d8dae0)",
                    marginTop: 2,
                    marginBottom: 2,
                  }}
                />
              )}
            </div>
            {/* Label */}
            <div style={{ paddingBottom: isLast ? 0 : 10 }}>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: current ? 700 : 600,
                  color: cancelled
                    ? "var(--ink-soft)"
                    : current
                      ? "var(--ink)"
                      : done
                        ? "var(--ink)"
                        : "var(--ink-soft)",
                  textDecoration: cancelled ? "line-through" : "none",
                }}
              >
                {step.label}
              </span>
              {current && !cancelled && (
                <span style={{ fontSize: 12, color: "var(--accent)", marginLeft: 8, fontWeight: 600 }}>
                  now
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

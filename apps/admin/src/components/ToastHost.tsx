import { useEffect, useState } from "react";
import { subscribeToasts, dismissToast, type Toast } from "../lib/toast.js";

/**
 * Renders the toast stack in the top-right corner. Mounted once at the app root.
 * Errors persist ~6s, successes ~3.5s (see lib/toast.ts), and any toast can be
 * dismissed early by clicking the ×.
 */
export function ToastHost(): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        maxWidth: "min(92vw, 380px)",
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }): JSX.Element {
  const tone =
    toast.kind === "error"
      ? { bg: "#fef2f2", border: "rgba(220,38,38,0.35)", fg: "var(--danger)", icon: "⚠" }
      : toast.kind === "success"
        ? { bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.35)", fg: "var(--success)", icon: "✓" }
        : { bg: "var(--surface-soft)", border: "var(--line)", fg: "var(--ink)", icon: "ℹ" };

  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      className="card ed-rise"
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "12px 14px",
        background: tone.bg,
        borderColor: tone.border,
        boxShadow: "var(--shadow-float)",
      }}
    >
      <span style={{ color: tone.fg, fontWeight: 800, lineHeight: 1.3 }}>{tone.icon}</span>
      <span style={{ flex: 1, fontSize: 13.5, color: tone.fg, lineHeight: 1.4 }}>{toast.message}</span>
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss"
        style={{
          background: "transparent",
          border: 0,
          cursor: "pointer",
          color: tone.fg,
          opacity: 0.7,
          fontSize: 16,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}

import type { ReactNode } from "react";
import { InlineLoader } from "./Spinner.js";
import { humanizeError } from "../lib/api.js";

/**
 * One pattern for every page that loads data on mount: loading → error+retry →
 * empty → content. Keeps a failed GET from leaving a blank screen, and gives the
 * user a one-click retry instead of a dead end.
 */
export function DataState({
  loading,
  error,
  isEmpty = false,
  emptyTitle = "Nothing to show",
  emptyHint = "There's nothing here yet.",
  onRetry,
  children,
}: {
  loading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  onRetry: () => void;
  children: ReactNode;
}): JSX.Element {
  if (loading) return <InlineLoader />;
  if (error) {
    return (
      <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
        <div className="empty__title">We couldn't load this</div>
        <div style={{ color: "var(--ink-soft)", maxWidth: 420, textAlign: "center" }}>{humanizeError(error)}</div>
        <button type="button" className="btn btn--primary btn--sm" onClick={onRetry}>Try again</button>
      </div>
    );
  }
  if (isEmpty) {
    return (
      <div className="empty">
        <div className="empty__title">{emptyTitle}</div>
        {emptyHint}
      </div>
    );
  }
  return <>{children}</>;
}

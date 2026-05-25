import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[admin] unhandled render error", error, info);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <main
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            padding: 24,
            background: "var(--surface-sunken)",
            color: "var(--ink)",
            textAlign: "center",
          }}
        >
          <div style={{ maxWidth: 480 }}>
            <div className="t-eyebrow" style={{ marginBottom: 12 }}>Error</div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 12px" }}>
              Something broke.
            </h1>
            <p style={{ color: "var(--ink-soft)", margin: "0 0 16px" }}>
              An unexpected error stopped the app. Reload to try again. If this keeps
              happening, contact support with the time and what you were doing.
            </p>
            <pre
              style={{
                background: "var(--surface-soft)",
                padding: 12,
                borderRadius: 12,
                fontSize: 12,
                textAlign: "left",
                overflow: "auto",
                marginBottom: 16,
              }}
            >
              {this.state.error.message}
            </pre>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

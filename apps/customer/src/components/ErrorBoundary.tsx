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
    console.error("[customer] unhandled render error", error, info);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <main
          style={{
            maxWidth: 480,
            margin: "6rem auto",
            padding: "0 1.5rem",
            fontFamily: "system-ui, sans-serif",
            textAlign: "center",
            color: "var(--ms-ink, #1e1b16)",
          }}
        >
          <h1 style={{ fontSize: "2rem", marginBottom: 12 }}>Something broke.</h1>
          <p style={{ color: "var(--ms-ink-3, #8a8576)", marginBottom: 24 }}>
            We hit an unexpected error. Reload to try again — your cart is saved.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "0.75rem 1.5rem",
              borderRadius: 999,
              background: "var(--ms-ink, #1e1b16)",
              color: "white",
              fontWeight: 700,
              border: "none",
              cursor: "pointer",
            }}
          >
            Reload page
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}

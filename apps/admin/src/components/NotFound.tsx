export function NotFound(): JSX.Element {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        textAlign: "center",
        padding: 24,
        background: "var(--surface-sunken)",
        color: "var(--ink)",
      }}
    >
      <div style={{ maxWidth: 420 }}>
        <div className="t-eyebrow" style={{ marginBottom: 12 }}>404</div>
        <h1 style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 10px" }}>
          Page not found
        </h1>
        <p style={{ color: "var(--ink-soft)", margin: "0 0 24px" }}>
          The page you're looking for doesn't exist.
        </p>
        <a href="/" className="btn btn--primary">
          Go home
        </a>
      </div>
    </main>
  );
}

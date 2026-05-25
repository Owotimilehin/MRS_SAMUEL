import { Link } from "@tanstack/react-router";

export function NotFound(): JSX.Element {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <div className="t-label eyebrow mb-2">404</div>
        <h1 className="t-display-md mb-3">That page isn't on the menu.</h1>
        <p className="t-body-md mb-6" style={{ color: "var(--ink-soft)" }}>
          The link may be old or mistyped. Head back to the menu and pick a bottle.
        </p>
        <Link to="/" className="btn btn--primary">See the menu</Link>
      </div>
    </main>
  );
}

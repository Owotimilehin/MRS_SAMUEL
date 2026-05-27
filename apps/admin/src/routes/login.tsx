import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api.js";
import { Spinner } from "../components/Spinner.js";

interface LoginResponse {
  data: {
    user: {
      id: string;
      email: string;
      role: "owner" | "manager" | "staff" | "factory";
      branch_id: string | null;
    };
  };
}

function defaultDestination(role: string, branchId: string | null): string {
  if (role === "owner") return "/owner/dashboard";
  if (role === "factory") return "/factory/production-runs";
  if (role === "manager" || role === "staff" || branchId) return "/branch";
  return "/owner/dashboard";
}

export function LoginPage(): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next");
      const dest = next ?? defaultDestination(res.data.user.role, res.data.user.branch_id);
      window.location.replace(dest);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Could not sign in. Try again.");
      }
      setSubmitting(false);
    }
  }

  return (
    <main className="login">
      {/* ───── Brand hero ───── */}
      <aside className="login__hero">
        {/* Floating decorative fruit + bottle */}
        <img src="/orange.png" alt="" aria-hidden className="login__deco login__deco--orange" />
        <img src="/lemon.png" alt="" aria-hidden className="login__deco login__deco--lemon" />
        <img src="/bottle-hero.png" alt="" aria-hidden className="login__deco--bottle" />

        <div className="login__hero-top">
          <div className="login__hero-logo">
            <img src="/brand-logo.png" alt="" />
          </div>
          <div>
            <div className="login__hero-brand">Mrs. Samuel</div>
            <div className="login__hero-tag">Admin · Operations</div>
          </div>
        </div>

        <div className="login__hero-body">
          <div className="login__hero-eyebrow">For the team</div>
          <h1 className="login__hero-title">
            Run the day from one place.
          </h1>
          <p className="login__hero-sub">
            Production, transfers, branch sales, daily closes — every Mrs. Samuel
            operation lives here, cold-pressed fresh every morning.
          </p>
          <div className="login__pills">
            <span className="login__pill">
              <span className="login__pill-dot" />
              17 cold-pressed flavours
            </span>
            <span className="login__pill">
              <span className="login__pill-dot" />
              Same-day delivery
            </span>
            <span className="login__pill">
              <span className="login__pill-dot" />
              Lagos, Nigeria
            </span>
          </div>
        </div>

        <div className="login__hero-foot">
          © Mrs. Samuel Fruit Juice · Internal staff portal
        </div>
      </aside>

      {/* ───── Form ───── */}
      <section className="login__form">
        <div className="login__form-inner">
          <div className="login__form-logo">
            <img src="/brand-logo.png" alt="" />
          </div>
          <div className="t-eyebrow" style={{ marginBottom: 12 }}>Sign in</div>
          <h2 className="login__form-title">Welcome back.</h2>
          <p className="login__form-sub">
            Use the email and password your owner gave you. If this is your
            first time, change your password right after signing in.
          </p>

          <form onSubmit={handleSubmit} noValidate>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field__label" htmlFor="email">Email</label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@mrssamuel.ng"
                disabled={submitting}
              />
            </div>
            <div className="field" style={{ marginBottom: 18 }}>
              <label className="field__label" htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={submitting}
              />
            </div>

            {error && (
              <div role="alert" className="login__error">
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn btn--primary btn--block btn--lg"
              disabled={submitting || !email || !password}
            >
              {submitting ? (
                <>
                  <Spinner size="xs" style={{ marginRight: 8 }} />
                  Signing in…
                </>
              ) : (
                "Sign in →"
              )}
            </button>

            <p className="login__hint">
              Forgot your password? Ask your owner to reset it from the
              Admin users page.
            </p>
          </form>

          <div className="login__footer">
            Built in Lagos
          </div>
        </div>
      </section>
    </main>
  );
}

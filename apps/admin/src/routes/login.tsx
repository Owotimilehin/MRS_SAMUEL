import { useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api.js";
import { Spinner } from "../components/Spinner.js";

interface LoginResponse {
  data: {
    user: {
      id: string;
      email: string;
      role: "owner" | "admin" | "manager" | "branch_staff";
      branch_id: string | null;
    };
  };
}

function defaultDestination(role: string, branchId: string | null): string {
  if (role === "owner" || role === "admin") return "/owner/dashboard";
  if (role === "manager" || role === "branch_staff" || branchId) return "/branch";
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
      {/* ───── Left: brand statement ───── */}
      <aside className="login__brand">
        <img
          src="/orange.png"
          alt=""
          aria-hidden
          className="login__deco login__deco--orange"
        />

        <div className="login__brand-top">
          <div className="login__brand-mark">
            <img src="/brand-logo.png" alt="" />
          </div>
          <div className="login__wordmark">
            Mrs.<span className="login__wordmark-accent">Samuel</span>
          </div>
        </div>

        <div className="login__brand-body">
          <h1 className="login__brand-headline">
            Run your day, sunrise to shelf.
          </h1>
          <p className="login__brand-sub">
            Internal staff portal · Lagos
          </p>
        </div>
      </aside>

      {/* ───── Right: form card ───── */}
      <section className="login__stage">
        <div className="login__card">
          <div className="login__card-mark">
            <img src="/brand-logo.png" alt="" />
          </div>
          <div className="login__card-eyebrow">Sign in</div>
          <h2 className="login__card-title">Welcome back.</h2>
          <p className="login__card-sub">
            Email and password from your owner.
          </p>

          <form onSubmit={handleSubmit} noValidate>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field__label" htmlFor="email">Email</label>
              <input
                id="email"
                className="input login__input"
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
                className="input login__input"
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
              className="btn btn--primary btn--block btn--lg login__submit"
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
              Lost your password? Ping your owner from the Admin users page.
            </p>
          </form>
        </div>
      </section>
    </main>
  );
}

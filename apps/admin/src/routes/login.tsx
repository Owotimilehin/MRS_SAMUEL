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
    <main className="login-cinematic">
      {/* ───── Brand composition (left) ───── */}
      <div className="login-cinematic__scene">
        <div className="login-cinematic__brand">
          <h1 className="login-cinematic__wordmark">
            Mrs.<span className="login-cinematic__wordmark-accent">Samuel</span>
          </h1>
          <p className="login-cinematic__headline">
            Run your day, sunrise to shelf.
          </p>
        </div>

        <div className="login-cinematic__tagline">Internal portal · Lagos</div>
      </div>

      {/* ───── Decorative fruits + bottle ───── */}
      <img
        src="/orange.png"
        alt=""
        aria-hidden="true"
        className="login-cinematic__fruit login-cinematic__fruit--orange"
      />
      <img
        src="/lemon.png"
        alt=""
        aria-hidden="true"
        className="login-cinematic__fruit login-cinematic__fruit--lemon"
      />
      <img
        src="/pineapple.png"
        alt=""
        aria-hidden="true"
        className="login-cinematic__fruit login-cinematic__fruit--pineapple"
      />
      <img
        src="/strawberry.png"
        alt=""
        aria-hidden="true"
        className="login-cinematic__fruit login-cinematic__fruit--strawberry"
      />
      <img
        src="/bottle-hero.png"
        alt=""
        aria-hidden="true"
        className="login-cinematic__bottle"
      />

      {/* ───── Form card (right) ───── */}
      <section className="login-cinematic__stage">
        <div className="login-cinematic__card">
          <div className="login-cinematic__eyebrow">Sign in</div>
          <h2 className="login-cinematic__title">Welcome back.</h2>
          <p className="login-cinematic__sub">
            Email and password from your owner.
          </p>

          <form onSubmit={handleSubmit} noValidate>
            <div className="login-cinematic__field">
              <label className="login-cinematic__label" htmlFor="email">Email</label>
              <input
                id="email"
                className="login-cinematic__input"
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
            <div className="login-cinematic__field" style={{ marginBottom: 18 }}>
              <label className="login-cinematic__label" htmlFor="password">Password</label>
              <input
                id="password"
                className="login-cinematic__input"
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
              <div role="alert" className="login-cinematic__error">
                {error}
              </div>
            )}

            <button
              type="submit"
              className="login-cinematic__submit"
              disabled={submitting || !email || !password}
            >
              {submitting ? (
                <>
                  <Spinner size="xs" style={{ marginRight: 8 }} />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in <span className="login-cinematic__submit-arrow">→</span>
                </>
              )}
            </button>

            <p className="login-cinematic__hint">
              Lost your password? Ping your owner from the Admin users page.
            </p>
          </form>
        </div>
      </section>
    </main>
  );
}

import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
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

function greetingForHour(h: number): string {
  if (h < 5) return "Burning the midnight oil";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

// Lagos time, formatted once so the panel reads as a live console rather than a static page.
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos",
  weekday: "long",
  day: "numeric",
  month: "long",
});

export function LoginPage(): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capsOn, setCapsOn] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const greeting = useMemo(() => greetingForHour(new Date().getHours()), []);
  const clock = timeFmt.format(now);
  const today = useMemo(() => dateFmt.format(now), [now]);

  // Tick the console clock every 10s — enough to feel alive, cheap enough to ignore.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  function trackCaps(e: KeyboardEvent<HTMLInputElement>): void {
    setCapsOn(e.getModifierState?.("CapsLock") ?? false);
  }

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
      // Brief success beat before the redirect so the state change is felt.
      setDone(true);
      window.setTimeout(() => window.location.replace(dest), 520);
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
      {/* ─────────── Left · the Orchard Ledger ─────────── */}
      <aside className="login__brand">
        <div className="login__rules" aria-hidden="true" />
        <div className="login__sun" aria-hidden="true" />
        <div className="login__grain" aria-hidden="true" />

        <header className="login__brandtop">
          <img src="/brand-logo.png" alt="Mrs. Samuel" className="login__mark" />
          <span className="login__portal">Operations&nbsp;Portal</span>
        </header>

        <div className="login__statement">
          <span className="login__eyebrow">{greeting}</span>
          <h1 className="login__display">
            <span className="login__line" style={{ animationDelay: "260ms" }}>
              Sunrise
            </span>
            <span className="login__line" style={{ animationDelay: "360ms" }}>
              to <em>shelf.</em>
            </span>
          </h1>
          <p className="login__lede">
            One console for the whole operation — pressing floor to branch till, every
            bottle traceable to the morning it was made.
          </p>
        </div>

        <footer className="login__meta" aria-hidden="true">
          <span className="login__status">
            <i className="login__pulse" /> System online
          </span>
          <span className="login__metasep" />
          <span className="login__clock">{clock} · WAT</span>
          <span className="login__metasep" />
          <span className="login__date">{today}</span>
        </footer>
      </aside>

      {/* ─────────── Right · sign-in stage ─────────── */}
      <section className="login__stage">
        <div className={`login__card${done ? " is-done" : ""}`}>
          <span className="login__chip">
            <i className="login__chipdot" /> Secure sign in
          </span>
          <h2 className="login__title">Welcome back.</h2>
          <p className="login__subtitle">
            Sign in with the email and password issued by your owner.
          </p>

          <form onSubmit={handleSubmit} noValidate className="login__form">
            <div className="login__field">
              <input
                id="email"
                className="login__input"
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder=" "
                disabled={submitting}
              />
              <label className="login__floatlabel" htmlFor="email">
                Email address
              </label>
              <svg className="login__fieldicon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="1.6" />
                <path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </div>

            <div className="login__field">
              <input
                id="password"
                className="login__input login__input--pw"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={trackCaps}
                onKeyDown={trackCaps}
                placeholder=" "
                disabled={submitting}
              />
              <label className="login__floatlabel" htmlFor="password">
                Password
              </label>
              <svg className="login__fieldicon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="4" y="10" width="16" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <button
                type="button"
                className="login__reveal"
                onClick={() => setShowPassword((v) => !v)}
                disabled={submitting}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>

            {capsOn && !error && (
              <div className="login__caps" role="status">
                ⇪ Caps Lock is on
              </div>
            )}

            {error && (
              <div role="alert" className="login__error">
                <span className="login__erroricon" aria-hidden="true">
                  !
                </span>
                {error}
              </div>
            )}

            <button
              type="submit"
              className="login__submit"
              disabled={submitting || done || !email || !password}
            >
              <span className="login__sheen" aria-hidden="true" />
              {done ? (
                <>
                  Welcome <span className="login__check" aria-hidden="true">✓</span>
                </>
              ) : submitting ? (
                <>
                  <Spinner size="xs" style={{ marginRight: 8 }} />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in <span className="login__arrow" aria-hidden="true">→</span>
                </>
              )}
            </button>

            <p className="login__hint">
              Lost your password? Ask your owner to reset it from the Admin users page.
            </p>
          </form>
        </div>
      </section>
    </main>
  );
}

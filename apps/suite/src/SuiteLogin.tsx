/**
 * The suite's own sign-in page: "Executive" (docs/mockups/login-5-executive.html, picked 22 Nov 2026),
 * in the suite's theme (docs/mockups/dashboard-v2-mrs-samuel.html: cream, white, orange).
 * The shop admin keeps its own page (apps/admin/src/routes/login.tsx).
 *
 * Left: a deep panel with the logo, the line and three goals. Right: the form, centred.
 * Same sign-in as the shop: POST /auth/login, then go to ?next= or "/".
 * No "keep me signed in" box: the server already keeps every sign-in for a fixed number of days.
 */
import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight, Check, Eye, EyeOff, Lock, Mail, Phone } from "lucide-react";
import { api, ApiError } from "@admin/lib/api.js";
import { Spinner } from "@admin/components/Spinner.js";
import "./suite-login.css";

/** WhatsApp's mark (lucide has no WhatsApp icon). */
function WhatsAppIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm4.5 12.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.4.1-.7.3-.2.3-.9.9-.9 2.2s.9 2.5 1.1 2.7c.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2z" />
    </svg>
  );
}
function InstagramIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}
function FacebookIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14 8h3V4h-3c-2.8 0-4 1.8-4 4.3V10H7v4h3v8h4v-8h3l1-4h-4V8.6c0-.4.3-.6.7-.6z" />
    </svg>
  );
}

export function SuiteLoginPage({ defaultDest = "/" }: { defaultDest?: string }): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capsOn, setCapsOn] = useState(false);

  useEffect(() => {
    document.title = "Sign in · Mrs. Samuel Business Suite";
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
      await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      const next = new URLSearchParams(window.location.search).get("next");
      setDone(true);
      window.setTimeout(() => window.location.replace(next ?? defaultDest), 450);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Could not sign in. Try again.";
      setError(msg.charAt(0).toUpperCase() + msg.slice(1));
      setSubmitting(false);
    }
  }

  return (
    <main className="exl">
      <section className="exl-brand">
        <div className="exl-logo">
          <img src="/brand-logo.png" alt="Mrs. Samuel Fruit Juice" />
        </div>

        <div className="exl-quote">
          <div className="exl-eyebrow">Mrs. Samuel Business Suite</div>
          <h1>
            Every customer, every channel, <em>one desk.</em>
          </h1>
          <p>
            Answer WhatsApp, Instagram and Facebook, return every call, and see which posts and adverts bring in orders,
            from one place.
          </p>
        </div>

        <div className="exl-stats">
          <div>
            <b>4</b>
            <span>channels in one inbox</span>
          </div>
          <div>
            <b>&lt; 5 min</b>
            <span>reply-time goal for every chat</span>
          </div>
          <div>
            <b>0</b>
            <span>missed calls left unreturned</span>
          </div>
        </div>
      </section>

      <section className="exl-side">
        <form className={`exl-form${done ? " is-done" : ""}`} onSubmit={handleSubmit} noValidate>
          <span className="exl-badge">
            <i /> Secure staff sign-in
          </span>
          <h2>Sign in</h2>
          <p className="exl-sub">Use the email and password you use for the shop.</p>

          <div className="exl-field">
            <label htmlFor="exl-email">Work email</label>
            <div className="exl-in">
              <Mail size={18} aria-hidden="true" />
              <input
                id="exl-email"
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@mrssamuel.com"
                disabled={submitting}
              />
            </div>
          </div>

          <div className="exl-field">
            <label htmlFor="exl-password">
              Password
              <span className="exl-forgot" title="The owner can reset it in the shop admin, under Users">
                Forgot password? Ask the owner
              </span>
            </label>
            <div className="exl-in">
              <Lock size={18} aria-hidden="true" />
              <input
                id="exl-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={trackCaps}
                onKeyDown={trackCaps}
                placeholder="Your password"
                disabled={submitting}
              />
              <button
                type="button"
                className="exl-reveal"
                onClick={() => setShowPassword((v) => !v)}
                disabled={submitting}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {capsOn && !error && (
            <div className="exl-note" role="status">
              Caps Lock is on
            </div>
          )}
          {error && (
            <div className="exl-error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="exl-btn" disabled={submitting || done || !email || !password}>
            {done ? (
              <>
                Welcome <Check size={18} />
              </>
            ) : submitting ? (
              <>
                <Spinner size="xs" style={{ marginRight: 4 }} /> Signing in…
              </>
            ) : (
              <>
                Sign in to the suite <ArrowRight size={18} />
              </>
            )}
          </button>

          <div className="exl-divider">Connected channels</div>
          <div className="exl-channels">
            <span style={{ color: "#1f9d55" }}>
              <WhatsAppIcon /> WhatsApp
            </span>
            <span style={{ color: "#c13584" }}>
              <InstagramIcon /> Instagram
            </span>
            <span style={{ color: "#1877f2" }}>
              <FacebookIcon /> Facebook
            </span>
            <span style={{ color: "#c84b14" }}>
              <Phone size={15} aria-hidden="true" /> Calls
            </span>
          </div>
        </form>
        <p className="exl-legal">© {new Date().getFullYear()} Mrs. Samuel Fruit Juice · Ajao Estate, Lagos</p>
      </section>
    </main>
  );
}

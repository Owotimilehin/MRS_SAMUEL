import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { PageLoader } from "../components/Spinner.js";
import { refreshAccessToken } from "./api.js";
import type { AdminRole, Capability } from "@ms/shared";

// Refresh the 30-minute access token well before it expires, and again whenever
// the app regains focus, so an active user never hits a mid-action 401 and a
// backgrounded PWA re-arms its session on return instead of bouncing to login.
const PROACTIVE_REFRESH_MS = 10 * 60_000;

export interface AuthUser {
  id: string;
  email: string;
  role: AdminRole;
  branch_id: string | null;
  capabilities: Capability[];
}

const AuthContext = createContext<AuthUser | null>(null);

export function useAuthUser(): AuthUser {
  const u = useContext(AuthContext);
  if (!u) throw new Error("useAuthUser called outside RequireAuth");
  return u;
}

/** Returns a predicate to test the current user's capabilities. */
export function useCan(): (cap: Capability) => boolean {
  const u = useAuthUser();
  return (cap: Capability) => u.capabilities.includes(cap);
}

/**
 * Resolve the current session. If the 15-minute access cookie has expired,
 * try a single refresh (30-day session) before giving up. Returns null when
 * there is genuinely no valid session.
 */
export async function resolveSession(): Promise<AuthUser | null> {
  const fetchMe = async (): Promise<Response> =>
    fetch("/v1/auth/me", { credentials: "include" });
  let res = await fetchMe();
  if (res.status === 401) {
    const refresh = await fetch("/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    if (!refresh.ok) return null;
    res = await fetchMe();
  }
  if (!res.ok) return null;
  const body = (await res.json()) as { data: AuthUser };
  return body.data;
}

export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; user: AuthUser } | { kind: "anon" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const user = await resolveSession();
        if (cancelled) return;
        setState(user ? { kind: "ready", user } : { kind: "anon" });
      } catch {
        if (!cancelled) setState({ kind: "anon" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the session warm while the app is open: refresh on a timer and whenever
  // the tab/PWA regains focus. Best-effort — a genuinely dead session still
  // bounces to login via the next request's 401 handling.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const interval = window.setInterval(() => {
      void refreshAccessToken();
    }, PROACTIVE_REFRESH_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void refreshAccessToken();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state.kind]);

  if (state.kind === "loading") {
    return <PageLoader />;
  }

  if (state.kind === "anon") {
    const here = window.location.pathname + window.location.search;
    const next = here && here !== "/login" ? `?next=${encodeURIComponent(here)}` : "";
    window.location.replace(`/login${next}`);
    return <></>;
  }

  return <AuthContext.Provider value={state.user}>{children}</AuthContext.Provider>;
}

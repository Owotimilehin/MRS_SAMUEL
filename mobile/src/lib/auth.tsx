/**
 * Session state for the app. Mirrors apps/admin/src/lib/auth.tsx:
 *   launch   → GET /v1/auth/me; on 401 try POST /v1/auth/refresh once, then /me again
 *   sign in  → POST /v1/auth/login {email, password} (cookies set natively)
 *   sign out → remove this phone's push token, stop calls, POST /v1/auth/logout
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { z } from "zod";
import { api, ApiError, refreshSession, setSessionExpiredHandler } from "./api";

const SessionUser = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  branch_id: z.string().nullable(),
  capabilities: z.array(z.string()),
});
export type SessionUser = z.infer<typeof SessionUser>;

const LoginResponse = z.object({ data: z.object({ user: SessionUser }) });
const MeResponse = z.object({ data: SessionUser });

type AuthState = { kind: "loading" } | { kind: "anon"; reason?: string } | { kind: "ready"; user: SessionUser };

interface AuthApi {
  state: AuthState;
  signIn(email: string, password: string): Promise<void>;
  /** Runs registered sign-out hooks (push token, calls) before ending the session. */
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

/** Work that must run before the session ends (it still needs the cookie). */
type SignOutHook = () => Promise<void>;
const signOutHooks = new Set<SignOutHook>();
export function addSignOutHook(hook: SignOutHook): () => void {
  signOutHooks.add(hook);
  return () => {
    signOutHooks.delete(hook);
  };
}

async function fetchMe(): Promise<SessionUser | null> {
  try {
    return MeResponse.parse(await api<unknown>("/auth/me", { noRefresh: true })).data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      if (!(await refreshSession())) return null;
      try {
        return MeResponse.parse(await api<unknown>("/auth/me", { noRefresh: true })).data;
      } catch {
        return null;
      }
    }
    throw err;
  }
}

// Refresh the 30-minute access cookie well before it expires while the app is open.
const PROACTIVE_REFRESH_MS = 10 * 60_000;

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  const resolve = useCallback(async () => {
    try {
      const user = await fetchMe();
      setState(user ? { kind: "ready", user } : { kind: "anon" });
    } catch {
      // Network down at launch: show login with a hint; signing in retries.
      setState({ kind: "anon", reason: "We couldn't reach the server. Check your connection." });
    }
  }, []);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  useEffect(() => {
    setSessionExpiredHandler(() => setState({ kind: "anon", reason: "Your session has expired. Please sign in again." }));
    return () => setSessionExpiredHandler(null);
  }, []);

  // Keep the session warm: timer while open, and on every return to the app.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const timer = setInterval(() => void refreshSession(), PROACTIVE_REFRESH_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void refreshSession();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [state.kind]);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = LoginResponse.parse(
      await api<unknown>("/auth/login", { method: "POST", body: { email: email.trim(), password }, noRefresh: true }),
    );
    setState({ kind: "ready", user: res.data.user });
  }, []);

  const signOut = useCallback(async () => {
    for (const hook of [...signOutHooks]) {
      try {
        await hook();
      } catch {
        /* best effort: never block sign-out */
      }
    }
    try {
      await api("/auth/logout", { method: "POST", noRefresh: true });
    } catch {
      /* the cookie may already be gone */
    }
    setState({ kind: "anon" });
  }, []);

  const value = useMemo<AuthApi>(() => ({ state, signIn, signOut }), [state, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** The signed-in user. Only call inside the signed-in part of the app. */
export function useUser(): SessionUser {
  const { state } = useAuth();
  if (state.kind !== "ready") throw new Error("useUser called while signed out");
  return state.user;
}

export function useCan(): (cap: string) => boolean {
  const user = useUser();
  return useCallback((cap: string) => user.capabilities.includes(cap), [user]);
}

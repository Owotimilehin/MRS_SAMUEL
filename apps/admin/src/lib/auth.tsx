import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export interface AuthUser {
  id: string;
  email: string;
  role: "owner" | "manager" | "staff" | "factory";
  branch_id: string | null;
}

const AuthContext = createContext<AuthUser | null>(null);

export function useAuthUser(): AuthUser {
  const u = useContext(AuthContext);
  if (!u) throw new Error("useAuthUser called outside RequireAuth");
  return u;
}

export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ready"; user: AuthUser } | { kind: "anon" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/v1/auth/me", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) setState({ kind: "anon" });
          return;
        }
        const body = (await res.json()) as { data: AuthUser };
        if (!cancelled) setState({ kind: "ready", user: body.data });
      } catch {
        if (!cancelled) setState({ kind: "anon" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          color: "var(--ms-ink-3)",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Loading…
      </main>
    );
  }

  if (state.kind === "anon") {
    const here = window.location.pathname + window.location.search;
    const next = here && here !== "/login" ? `?next=${encodeURIComponent(here)}` : "";
    window.location.replace(`/login${next}`);
    return <></>;
  }

  return <AuthContext.Provider value={state.user}>{children}</AuthContext.Provider>;
}

import { createRouter, createRoute, createRootRoute, Outlet } from "@tanstack/react-router";
import { LoginPage } from "./routes/login.js";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => (
    <main style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>Mrs. Samuel Admin</h1>
      <p>
        <a href="/login">Sign in</a>
      </p>
    </main>
  ),
});

const routeTree = rootRoute.addChildren([indexRoute, loginRoute]);
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

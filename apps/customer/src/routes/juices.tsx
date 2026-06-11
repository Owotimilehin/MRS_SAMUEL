import { createFileRoute, Outlet } from "@tanstack/react-router";

// Pass-through layout for the /juices segment. The listing (juices.index.tsx)
// and the product detail (juices.$id.tsx) each render their own SiteShell, so
// this parent only needs to provide the <Outlet /> for its children.
export const Route = createFileRoute("/juices")({
  component: Outlet,
});

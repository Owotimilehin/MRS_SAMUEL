import { createFileRoute, Outlet } from "@tanstack/react-router";

// `/blog` is a layout parent for `/blog/` (index grid, in blog.index.tsx) and
// `/blog/$slug` (the post). It only needs to provide the <Outlet /> for its
// children — mirrors the /juices layout. Without this split the index grid
// rendered in place of every post detail.
export const Route = createFileRoute("/blog")({
  component: Outlet,
});

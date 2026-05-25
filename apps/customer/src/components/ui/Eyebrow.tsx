import type { ReactNode } from "react";

/** Section eyebrow — small uppercase accent-colored label that introduces a
 * section. Renders as `<div class="ms-label eyebrow">`. */
export function Eyebrow({ children }: { children: ReactNode }): JSX.Element {
  return <div className="ms-label eyebrow">{children}</div>;
}

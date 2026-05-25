import type { ReactNode } from "react";
import { Eyebrow } from "./Eyebrow.js";

/** Standard section header: eyebrow + title + optional sub-copy.
 * Used across How it works, Full Menu, Testimonials, Instagram, Newsletter. */
export function SectionHeader({
  eyebrow,
  title,
  sub,
  align = "center",
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  align?: "left" | "center";
}): JSX.Element {
  return (
    <header style={{ textAlign: align, marginBottom: 28 }}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="ms-section-title" style={align === "center" ? { marginLeft: "auto", marginRight: "auto" } : undefined}>
        {title}
      </h2>
      {sub && (
        <p className="ms-section-sub" style={align === "center" ? { marginLeft: "auto", marginRight: "auto" } : undefined}>
          {sub}
        </p>
      )}
    </header>
  );
}

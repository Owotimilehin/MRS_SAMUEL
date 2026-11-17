import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

/**
 * Turns a few known phrases inside plain copy into real links, so page text
 * can stay a plain string (it is also used for FAQ structured data) while a
 * mention like "our bulk orders page" is still something a customer can tap.
 */
const PATTERN =
  /(bulk orders page|Delivery Information page|Returns & Refunds page|0901 951 2246|info@mrssamuel\.com)/g;

const INTERNAL: Record<string, "/bulk-orders" | "/delivery" | "/returns"> = {
  "bulk orders page": "/bulk-orders",
  "Delivery Information page": "/delivery",
  "Returns & Refunds page": "/returns",
};

const EXTERNAL: Record<string, string> = {
  "0901 951 2246": "https://wa.me/2349019512246",
  "info@mrssamuel.com": "mailto:info@mrssamuel.com",
};

const linkCls = "font-semibold underline underline-offset-2 hover:text-[color:var(--brand-orange)]";

export function LinkedText({ text }: { text: string }): ReactNode {
  return text.split(PATTERN).map((part, i) => {
    const to = INTERNAL[part];
    if (to) {
      return (
        <Link key={i} to={to} className={linkCls}>
          {part}
        </Link>
      );
    }
    const href = EXTERNAL[part];
    if (href) {
      const web = href.startsWith("http");
      return (
        <a
          key={i}
          href={href}
          className={linkCls}
          {...(web ? { target: "_blank", rel: "noreferrer" } : {})}
        >
          {part}
        </a>
      );
    }
    return part;
  });
}

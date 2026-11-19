/** What the admin app gives the inbox screens. See app-frame.tsx. */
import { Link } from "@tanstack/react-router";
import { Shell } from "../components/Shell.js";
import type { CustomerLinkProps, HostApp, LeadLinkProps } from "./app-frame.js";

function AdminCustomerLink({ customerId, children, style }: CustomerLinkProps): JSX.Element {
  return (
    <Link to="/owner/customers/$customerId" params={{ customerId }} style={style}>
      {children}
    </Link>
  );
}

/**
 * Address of the Business Suite, for links out of the admin app (leads are
 * worked there). VITE_SUITE_URL when the build sets it; else this address with
 * "admin." swapped for "suite."; else suite.mrssamuel.com.
 */
function suiteUrl(): string {
  const set = import.meta.env.VITE_SUITE_URL as string | undefined;
  if (set) return set.replace(/\/+$/, "");
  if (typeof window !== "undefined" && /^admin\./.test(window.location.hostname)) {
    return `${window.location.protocol}//${window.location.hostname.replace(/^admin\./, "suite.")}`;
  }
  return "https://suite.mrssamuel.com";
}

/** A lead opens in the suite, in a new tab (suite spec 13, 7.6). */
function AdminLeadLink({ leadId, children, style }: LeadLinkProps): JSX.Element {
  return (
    <a href={`${suiteUrl()}/leads/${encodeURIComponent(leadId)}`} target="_blank" rel="noreferrer" style={style}>
      {children}
    </a>
  );
}

export const adminHost: HostApp = { Shell, CustomerLink: AdminCustomerLink, LeadLink: AdminLeadLink };

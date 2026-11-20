/** What the admin app gives the inbox screens. See app-frame.tsx. */
import { Link } from "@tanstack/react-router";
import { Shell } from "../components/Shell.js";
import type { CustomerLinkProps, HostApp, LeadLinkProps } from "./app-frame.js";
import { suiteUrl } from "./suite-url.js";

function AdminCustomerLink({ customerId, children, style }: CustomerLinkProps): JSX.Element {
  return (
    <Link to="/owner/customers/$customerId" params={{ customerId }} style={style}>
      {children}
    </Link>
  );
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

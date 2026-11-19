/** What the admin app gives the inbox screens. See app-frame.tsx. */
import { Link } from "@tanstack/react-router";
import { Shell } from "../components/Shell.js";
import type { CustomerLinkProps, HostApp } from "./app-frame.js";

function AdminCustomerLink({ customerId, children, style }: CustomerLinkProps): JSX.Element {
  return (
    <Link to="/owner/customers/$customerId" params={{ customerId }} style={style}>
      {children}
    </Link>
  );
}

export const adminHost: HostApp = { Shell, CustomerLink: AdminCustomerLink };

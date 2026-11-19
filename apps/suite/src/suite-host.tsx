/** What the suite gives the inbox screens. See @admin/lib/app-frame.tsx. */
import type { CustomerLinkProps, HostApp } from "@admin/lib/app-frame.js";
import { SuiteShell } from "./SuiteShell.js";

/**
 * Address of the shop's admin app, for links out of the suite.
 *
 * In production the container build passes PUBLIC_ADMIN_URL in as
 * VITE_ADMIN_URL. When that is not set, work it out from where the suite is
 * running: on a developer's machine the admin app is on a local port,
 * anywhere else it is admin.mrssamuel.com.
 */
function adminUrl(): string {
  const set = import.meta.env.VITE_ADMIN_URL;
  if (set) return set;
  const local = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  if (!local) return "https://admin.mrssamuel.com";
  return import.meta.env.DEV ? "http://localhost:3000" : "http://localhost:3010";
}

export const ADMIN_URL: string = adminUrl().replace(/\/+$/, "");

/** The customer's orders and profile live in the shop's admin app, so this opens it in a new tab. */
function SuiteCustomerLink({ customerId, children, style }: CustomerLinkProps): JSX.Element {
  return (
    <a href={`${ADMIN_URL}/owner/customers/${encodeURIComponent(customerId)}`} target="_blank" rel="noreferrer" style={style}>
      {children}
    </a>
  );
}

export const suiteHost: HostApp = { Shell: SuiteShell, CustomerLink: SuiteCustomerLink };

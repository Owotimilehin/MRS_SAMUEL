/**
 * The seam between the inbox screens and the application that hosts them.
 *
 * The inbox screens run in two applications: the shop's admin app and the
 * business suite (apps/suite). Each has its own page frame (menu, header) and
 * its own way of linking to a customer's shop profile. The screens ask for
 * those through this file instead of importing the admin app's Shell, so the
 * same screen code runs unchanged in both.
 *
 *   admin app → lib/admin-host.tsx   (the admin Shell; an in-app link)
 *   suite     → apps/suite/src/suite-host.tsx (the suite's frame; a link out to the admin app)
 */
import { createContext, useContext, type ComponentType, type CSSProperties, type ReactNode } from "react";

export interface FrameProps {
  children: ReactNode;
  title: string;
  /** Optional area label shown above the title. */
  crumb?: string;
  actions?: ReactNode;
}

export interface CustomerLinkProps {
  customerId: string;
  children: ReactNode;
  style?: CSSProperties;
}

export interface LeadLinkProps {
  leadId: string;
  children: ReactNode;
  style?: CSSProperties;
}

export interface HostApp {
  /** The page frame: menu, header, and the body the screen renders into. */
  Shell: ComponentType<FrameProps>;
  /** A link to the customer's orders and profile in the shop. */
  CustomerLink: ComponentType<CustomerLinkProps>;
  /**
   * The address of a comment thread, in an app that has a Comments section
   * (the suite). Left out where there is none (the admin app), and then a
   * "private reply to a comment" line in the timeline is plain text.
   */
  commentHref?: (threadId: string) => string;
  /** A link to a lead on the suite's Leads page (suite spec 13). A host without one shows no link. */
  LeadLink?: ComponentType<LeadLinkProps>;
}

const HostContext = createContext<HostApp | null>(null);

export const HostAppProvider = HostContext.Provider;

function useHost(): HostApp {
  const host = useContext(HostContext);
  if (!host) throw new Error("Inbox screen rendered outside <HostAppProvider>");
  return host;
}

/** The hosting application's page frame. */
export function Frame(props: FrameProps): JSX.Element {
  const { Shell } = useHost();
  return <Shell {...props} />;
}

/** The hosting application's link to a customer's shop profile. */
export function CustomerLink(props: CustomerLinkProps): JSX.Element {
  const { CustomerLink: Impl } = useHost();
  return <Impl {...props} />;
}

/** The address of a comment thread in this app, or null when the app has no Comments section. */
export function useCommentHref(): ((threadId: string) => string) | null {
  return useHost().commentHref ?? null;
}

/** The hosting application's link to a lead in the suite; nothing when the host has none. */
export function LeadLink(props: LeadLinkProps): JSX.Element | null {
  const { LeadLink: Impl } = useHost();
  return Impl ? <Impl {...props} /> : null;
}

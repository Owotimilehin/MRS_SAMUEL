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

export interface HostApp {
  /** The page frame: menu, header, and the body the screen renders into. */
  Shell: ComponentType<FrameProps>;
  /** A link to the customer's orders and profile in the shop. */
  CustomerLink: ComponentType<CustomerLinkProps>;
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

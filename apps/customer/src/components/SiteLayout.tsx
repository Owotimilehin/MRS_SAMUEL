import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useCart } from "../store/cart.js";
import { BRAND } from "../data/menu.js";
import { SearchOverlay } from "./SearchOverlay.js";

const WHATSAPP_URL = `https://wa.me/${BRAND.whatsapp}?text=${encodeURIComponent(
  "Hi Mrs. Samuel! I'd like to place an order.",
)}`;
const PHONE_URL = `tel:${BRAND.phone.replace(/\s/g, "")}`;

interface SiteLayoutProps {
  children: ReactNode;
  /** Identifies which nav link should render as active. */
  active?: "menu" | "about" | "specials" | "locations" | "blog";
  /** Page title + description (sets document.title + meta description). */
  meta?: { title?: string; description?: string };
}

export function SiteLayout({ children, active, meta }: SiteLayoutProps): JSX.Element {
  usePageMeta(meta?.title, meta?.description);
  return (
    <div className="ms-shell">
      <div className="ms-container">
        <SiteNav active={active} />
      </div>
      {children}
      <SiteFooter />
      <WhatsAppFab />
    </div>
  );
}

/** Sticky bottom-right WhatsApp button. Standard NG e-commerce CTA. */
function WhatsAppFab(): JSX.Element {
  return (
    <a
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with Mrs. Samuel on WhatsApp"
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        zIndex: 50,
        width: 56,
        height: 56,
        borderRadius: "50%",
        background: "#25D366",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 8px 22px rgba(37,211,102,0.45)",
        color: "white",
        textDecoration: "none",
      }}
    >
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M20.52 3.48A11.93 11.93 0 0 0 12.05 0C5.5 0 .18 5.32.18 11.87c0 2.09.55 4.13 1.6 5.93L0 24l6.39-1.67a11.86 11.86 0 0 0 5.66 1.44h.01c6.55 0 11.87-5.33 11.87-11.88 0-3.17-1.24-6.16-3.41-8.41zM12.06 21.79h-.01a9.86 9.86 0 0 1-5.03-1.38l-.36-.21-3.79.99 1.01-3.69-.24-.38a9.88 9.88 0 1 1 18.36-5.25c0 5.45-4.44 9.92-9.94 9.92zm5.45-7.42c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.27-.47-2.42-1.49-.89-.79-1.49-1.77-1.67-2.07-.17-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.62-.92-2.21-.24-.58-.49-.5-.67-.51l-.57-.01a1.1 1.1 0 0 0-.8.37c-.27.3-1.05 1.03-1.05 2.5 0 1.48 1.08 2.9 1.23 3.1.15.2 2.12 3.24 5.13 4.54.72.31 1.28.5 1.71.64.72.23 1.37.2 1.89.12.58-.09 1.76-.72 2.01-1.41.25-.69.25-1.28.17-1.41-.07-.13-.27-.2-.57-.35z"/>
      </svg>
    </a>
  );
}

/** Sets <title> and meta[name=description] on mount, restores on unmount. */
function usePageMeta(title?: string, description?: string): void {
  useEffect(() => {
    const prevTitle = document.title;
    if (title) document.title = title;

    let descEl: HTMLMetaElement | null = null;
    let prevDesc: string | null = null;
    if (description) {
      descEl = document.querySelector('meta[name="description"]');
      if (!descEl) {
        descEl = document.createElement("meta");
        descEl.setAttribute("name", "description");
        document.head.appendChild(descEl);
      }
      prevDesc = descEl.getAttribute("content");
      descEl.setAttribute("content", description);
    }

    return () => {
      document.title = prevTitle;
      if (descEl && prevDesc !== null) descEl.setAttribute("content", prevDesc);
    };
  }, [title, description]);
}

interface NavLink {
  key: SiteLayoutProps["active"];
  /** Either a route path (renders as <Link>) or a full URL with hash (renders as <a>). */
  to: string;
  label: string;
  /** Force a native <a> so hash fragments scroll correctly across route changes. */
  anchor?: boolean;
}
const NAV_LINKS: NavLink[] = [
  { key: "menu", to: "/#menu", label: "Menu", anchor: true },
  { key: "about", to: "/about", label: "About" },
  { key: "specials", to: "/specials", label: "Our specials" },
  { key: "locations", to: "/locations", label: "Our locations" },
  { key: "blog", to: "/blog", label: "Blog" },
];

function SiteNav({ active }: { active?: SiteLayoutProps["active"] }): JSX.Element {
  const cartCount = useCart((s) => s.totalItems());
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <>
      <nav className="ms-nav">
        <Link to="/" className="ms-brand" aria-label={BRAND.name}>
          <span className="ms-brand__logo">
            <img src="/assets/brand-logo.png" alt={BRAND.name} />
          </span>
        </Link>

        <div className="ms-pillnav">
          {NAV_LINKS.map((n) =>
            n.anchor ? (
              <a
                key={n.key}
                href={n.to}
                className={active === n.key ? "is-active" : ""}
              >
                {n.label}
              </a>
            ) : (
              <Link
                key={n.key}
                to={n.to}
                className={active === n.key ? "is-active" : ""}
              >
                {n.label}
              </Link>
            ),
          )}
        </div>

        <div className="ms-icons">
          <button
            type="button"
            className="ms-iconbtn"
            aria-label="Search"
            onClick={() => setSearchOpen(true)}
          >
            <Icon name="search" />
          </button>
          <Link
            className="ms-iconbtn"
            to="/cart"
            aria-label={`Cart with ${cartCount} item${cartCount === 1 ? "" : "s"}`}
          >
            <Icon name="cart" />
            {cartCount > 0 && <span className="badge">{cartCount}</span>}
          </Link>
        </div>
      </nav>
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}

function SiteFooter(): JSX.Element {
  const year = new Date().getFullYear();
  return (
    <footer id="contact" className="ms-footer">
      <div className="ms-container ms-footer__inner">
        <div className="ms-footer__cols">
          <div>
            <div className="ms-footer__brand">
              <img src="/assets/brand-logo.png" alt={BRAND.name} />
            </div>
            <p className="ms-footer__tag">
              Good health, bottled fresh. Cold-pressed every morning in Lagos.
            </p>
          </div>
          <div>
            <div className="ms-footer__head">Order</div>
            <ul>
              <li>
                <a href={WHATSAPP_URL} target="_blank" rel="noreferrer">
                  WhatsApp
                </a>
              </li>
              <li>
                <a href={PHONE_URL}>{BRAND.phone}</a>
              </li>
              <li>
                <a
                  href={`https://instagram.com/${BRAND.handle.replace("@", "")}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Instagram DM
                </a>
              </li>
            </ul>
          </div>
          <div>
            <div className="ms-footer__head">Explore</div>
            <ul>
              <li>
                <Link to="/about">About us</Link>
              </li>
              <li>
                <Link to="/specials">Our specials</Link>
              </li>
              <li>
                <Link to="/locations">Locations</Link>
              </li>
              <li>
                <Link to="/blog">Blog</Link>
              </li>
            </ul>
          </div>
          <div>
            <div className="ms-footer__head">Visit</div>
            <address className="ms-footer__addr">
              30 Asa Afariogun Street
              <br />
              Ajao Estate, Lagos
              <br />
              <br />
              Mon–Sat · 8am – 7pm
            </address>
          </div>
        </div>
        <div className="ms-footer__bottom">
          <span>© {year} Mrs. Samuel Fruit Juice. All rights reserved.</span>
          <span>
            <Link to="/privacy">Privacy</Link> · <Link to="/terms">Terms</Link>
          </span>
        </div>
      </div>
    </footer>
  );
}

function Icon({
  name,
  size = 20,
}: {
  name: "search" | "cart";
  size?: number;
}): JSX.Element {
  const c = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "search":
      return (
        <svg {...c}>
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
    case "cart":
      return (
        <svg {...c}>
          <circle cx="9" cy="21" r="1" />
          <circle cx="20" cy="21" r="1" />
          <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
        </svg>
      );
  }
}

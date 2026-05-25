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
    </div>
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
  to: string;
  label: string;
}
const NAV_LINKS: NavLink[] = [
  { key: "menu", to: "/", label: "Menu" },
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
          {NAV_LINKS.map((n) => (
            <Link
              key={n.key}
              to={n.to}
              className={active === n.key ? "is-active" : ""}
            >
              {n.label}
            </Link>
          ))}
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

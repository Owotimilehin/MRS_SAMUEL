import { useState } from "react";
import { motion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import { ShoppingCart, ArrowRight, Menu, X } from "lucide-react";
import { useCart } from "@/lib/cart";
import logoDark from "@/assets/logo-dark.png";

const links = [
  { label: "Home", to: "/" as const },
  { label: "Our Juices", to: "/juices" as const },
  { label: "Shop", to: "/shop" as const },
  { label: "Subscription", to: "/subscription" as const },
  { label: "About Us", to: "/about" as const },
  { label: "Blog", to: "/blog" as const },
  { label: "Contact", to: "/contact" as const },
  { label: "Track order", to: "/track" as const },
];

export function Nav() {
  const { count, setOpen } = useCart();
  const [mobile, setMobile] = useState(false);

  return (
    <header className="absolute top-0 left-0 right-0 z-40">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-5 sm:px-10 py-5">
        <Link to="/" className="flex items-center gap-3">
          <img
            src={logoDark}
            alt="Mrs. Samuel Fruit Juice"
            className="h-12 sm:h-14 w-auto object-contain"
          />
        </Link>

        <nav className="hidden lg:flex items-center gap-7 text-[14px] font-medium text-[color:var(--brand)]">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              activeOptions={{ exact: l.to === "/" }}
              className="relative transition hover:text-[color:var(--brand-orange)] [&.active]:text-[color:var(--brand-orange)]"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3 text-[color:var(--brand)]">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setOpen(true)}
            className="relative grid h-10 w-10 place-items-center rounded-full hover:bg-black/5 transition"
            aria-label="Cart"
          >
            <ShoppingCart className="h-5 w-5" />
            {count > 0 && (
              <span className="absolute -top-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full bg-[color:var(--brand-orange)] text-[10px] font-bold text-white">
                {count}
              </span>
            )}
          </motion.button>
          <Link
            to="/shop"
            className="hidden md:inline-flex items-center gap-2 rounded-full bg-[color:var(--brand)] text-white pl-4 pr-3 py-2 text-sm font-semibold hover:bg-[color:var(--brand-orange)] transition"
          >
            Order Now
            <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15">
              <ArrowRight className="h-3 w-3" />
            </span>
          </Link>
          <button
            onClick={() => setMobile(true)}
            className="lg:hidden grid h-10 w-10 place-items-center rounded-full hover:bg-black/5"
            aria-label="Menu"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </div>

      {mobile && (
        <div className="fixed inset-0 z-50 bg-[color:var(--cream)] lg:hidden">
          <div className="flex items-center justify-between px-5 py-5">
            <img src={logoDark} alt="" className="h-12 w-auto" />
            <button
              onClick={() => setMobile(false)}
              className="grid h-10 w-10 place-items-center rounded-full hover:bg-black/5"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <nav className="flex flex-col gap-1 px-5 mt-4">
            {links.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                onClick={() => setMobile(false)}
                activeOptions={{ exact: l.to === "/" }}
                className="font-display text-3xl py-3 text-[color:var(--brand)] [&.active]:text-[color:var(--brand-orange)]"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}

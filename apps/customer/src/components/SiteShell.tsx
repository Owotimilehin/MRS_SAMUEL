import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Send, Instagram } from "lucide-react";
import { AnimatedBackground } from "@/components/AnimatedBackground";
import { Nav } from "@/components/Nav";
import { CartDrawer } from "@/components/CartDrawer";
import { FloatingCart } from "@/components/FloatingCart";
import logoWhite from "@/assets/logo-white.png";

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <>
      <AnimatedBackground />
      <Nav />
      <main className="relative">{children}</main>
      <Newsletter />
      <Footer />
      <CartDrawer />
      <FloatingCart />
    </>
  );
}

function Newsletter() {
  return (
    <section className="px-5 sm:px-10 pb-12 pt-4">
      <div className="mx-auto max-w-7xl rounded-[1.75rem] bg-[color:var(--brand-orange)] text-white px-6 sm:px-12 py-10 grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-white/80">
            Join Our Community
          </div>
          <h3 className="mt-3 font-display text-3xl sm:text-4xl font-semibold">
            Get 10% Off Your First Order
          </h3>
          <p className="mt-2 text-sm text-white/85 max-w-md">
            Quiet little health notes, new flavours, and the occasional Mrs.
            Samuel recipe — straight from our kitchen to your inbox.
          </p>
        </div>
        <form
          onSubmit={(e) => e.preventDefault()}
          className="flex items-center gap-2 rounded-full bg-white p-1.5 pl-5 text-[color:var(--brand)]"
        >
          <input
            type="email"
            placeholder="Enter your email"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-[color:var(--brand)]/45 py-3"
          />
          <button className="inline-flex items-center gap-2 rounded-full bg-[color:var(--brand)] text-white pl-5 pr-3 py-3 text-sm font-semibold hover:opacity-90 transition" aria-label="Subscribe">
            Subscribe
            <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15">
              <Send className="h-3 w-3" />
            </span>
          </button>
        </form>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer id="contact" className="bg-[color:var(--brand)] text-white/85 px-5 sm:px-10 py-16 mt-6">
      <div className="mx-auto max-w-7xl grid grid-cols-1 md:grid-cols-4 gap-10 items-start">
        <div>
          <img src={logoWhite} alt="Mrs. Samuel Fruit Juice" className="h-14 w-auto object-contain" />
          <p className="mt-4 text-sm max-w-xs text-white/70">
            Pure. Fresh. Real. Cold-pressed Nigerian fruit juice, pressed every morning in Lagos.
          </p>
          <a href="https://instagram.com/Mrs_samuelfruitjuice" target="_blank" rel="noreferrer" className="mt-5 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-[color:var(--brand-orange)] transition">
            <Instagram className="h-4 w-4" />
          </a>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-white/60">Menu</div>
          <ul className="mt-3 space-y-2 text-sm">
            <li><Link to="/" className="hover:text-white">Home</Link></li>
            <li><Link to="/juices" className="hover:text-white">Our Juices</Link></li>
            <li><Link to="/shop" className="hover:text-white">Shop</Link></li>
            <li><Link to="/subscription" className="hover:text-white">Subscription</Link></li>
            <li><Link to="/blog" className="hover:text-white">Blog</Link></li>
          </ul>
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-white/60">Information</div>
          <ul className="mt-3 space-y-2 text-sm">
            <li><Link to="/about" className="hover:text-white">About Us</Link></li>
            <li><Link to="/contact" className="hover:text-white">Contact</Link></li>
            <li>Delivery Information</li>
            <li>Returns & Refunds</li>
          </ul>
        </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-white/60">Customer Care</div>
            <ul className="mt-3 space-y-2 text-sm">
              <li>WhatsApp · 0901 951 2246</li>
              <li>@Mrs_samuelfruitjuice</li>
              <li>30 Asa-Afariogun St, opposite Access Bank, ajao estate</li>
              <li className="text-white/60 text-xs pt-2">Mon–Sat · 8am–8pm<br />Sun · 10am–8pm</li>
            </ul>
          </div>
      </div>
      <div className="mx-auto max-w-7xl mt-12 pt-6 border-t border-white/15 flex flex-wrap items-center justify-between gap-3 text-xs text-white/55">
        <div>© {new Date().getFullYear()} Mrs. Samuel Fruit Juice. All rights reserved.</div>
        <div>Pressed fresh in Lagos. Built with purpose.</div>
      </div>
    </footer>
  );
}

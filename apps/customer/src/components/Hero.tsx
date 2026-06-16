import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "@tanstack/react-router";
import {
  Leaf,
  Sparkles,
  Snowflake,
  Heart,
  ArrowRight,
  Play,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { Product } from "@/lib/api/mappers";
import { ProductDetail } from "@/components/ProductDetail";
import splashBurst from "@/assets/decor/splash-burst.png";
import leafMint from "@/assets/decor/leaf-mint.png";
import heroVideo from "@/assets/hero-video.mp4.asset.json";

const features = [
  { Icon: Leaf, title: "100% Natural", sub: "Real ingredients" },
  { Icon: Sparkles, title: "No Added Sugar", sub: "Naturally sweet" },
  { Icon: Snowflake, title: "Cold Pressed", sub: "More nutrition" },
  { Icon: Heart, title: "Good for You", sub: "Better every day" },
];

// Apple-style directional glide. `direction` is +1 for "previous" and -1 for
// "next", so pressing Next moves the cluster left→right (new bottle enters from
// the left). Motion is tuned the way Apple does it: a decelerating cubic-bezier
// with a long, gentle settle (no harsh spring bounce), and opacity/blur resolve
// slightly faster than position so the bottle sharpens into focus as it arrives.
const EASE_GLIDE = [0.32, 0.72, 0, 1] as const; // iOS sheet/transition curve
const GLIDE = 0.62; // seconds — the position travel
const FOCUS = { duration: 0.42, ease: [0.4, 0, 0.2, 1] as const }; // opacity/blur

// How far toward the side slot the hero bottle travels as it leaves, and the
// scale it collapses to — `SIDE_SCALE` matches the side bottles (h-68% vs the
// hero's h-94% ≈ 0.72) so the exiting bottle visibly *becomes* a side bottle
// while it fades, and the incoming one grows out of the side size into focus.
const SIDE_SLIDE = 190; // px toward the side slot
const SIDE_SCALE = 0.72; // side-bottle size relative to the hero

const centerVariants = {
  // Incoming bottle starts at side size/position and grows into the centre.
  enter: (d: number) => ({ x: d * SIDE_SLIDE, opacity: 0, scale: SIDE_SCALE, filter: "blur(5px)" }),
  center: {
    x: 0,
    opacity: 1,
    scale: 1,
    filter: "blur(0px)",
    transition: {
      x: { duration: GLIDE, ease: EASE_GLIDE },
      scale: { duration: GLIDE, ease: EASE_GLIDE },
      opacity: FOCUS,
      filter: FOCUS,
    },
  },
  // Outgoing bottle slides to the side slot AND shrinks to side size while it
  // fades — so it reads as the hero demoting into a side bottle, not a plain
  // cross-dissolve. Scale travels on the full glide curve so the resize stays
  // in lock-step with the slide; opacity trails a touch behind so the shrink
  // is still visible before it disappears.
  exit: (d: number) => ({
    x: d * -SIDE_SLIDE,
    opacity: 0,
    scale: SIDE_SCALE,
    filter: "blur(5px)",
    transition: {
      x: { duration: GLIDE, ease: EASE_GLIDE },
      scale: { duration: GLIDE, ease: EASE_GLIDE },
      opacity: { duration: 0.5, ease: "linear" as const },
      filter: FOCUS,
    },
  }),
};

// Side bottles cross-dissolve underneath with the same curve but a gentler
// drift, so they read as depth rather than competing with the hero bottle.
const sideVariants = {
  enter: (d: number) => ({ x: d * 80, opacity: 0 }),
  center: {
    x: 0,
    opacity: 0.5,
    transition: {
      x: { duration: GLIDE, ease: EASE_GLIDE },
      opacity: { duration: 0.46, ease: EASE_GLIDE },
    },
  },
  exit: (d: number) => ({
    x: d * -80,
    opacity: 0,
    transition: {
      x: { duration: GLIDE, ease: EASE_GLIDE },
      opacity: { duration: 0.3, ease: "linear" as const },
    },
  }),
};

export function Hero({ products }: { products: Product[] }) {
  const [videoOpen, setVideoOpen] = useState(false);

  const [activeIndex, setActiveIndex] = useState(0);
  const [direction, setDirection] = useState(0);
  const [detail, setDetail] = useState<Product | null>(null);
  const navigating = useRef(false);
  const touchStartX = useRef(0);
  const total = products.length;

  const prev = useCallback(() => {
    if (navigating.current) return;
    navigating.current = true;
    setDirection(1);
    setActiveIndex((i) => (i - 1 + total) % total);
    setTimeout(() => {
      navigating.current = false;
    }, 520);
  }, [total]);

  const next = useCallback(() => {
    if (navigating.current) return;
    navigating.current = true;
    setDirection(-1);
    setActiveIndex((i) => (i + 1) % total);
    setTimeout(() => {
      navigating.current = false;
    }, 520);
  }, [total]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [prev, next]);

  if (total === 0) return null; // no catalog → skip the carousel (all hooks already ran)

  const leftProduct = products[(activeIndex - 1 + total) % total];
  const centerProduct = products[activeIndex % total];
  const rightProduct = products[(activeIndex + 1) % total];

  return (
    <section
      id="top"
      className="relative pt-32 sm:pt-36 pb-20 sm:pb-24 px-5 sm:px-10 max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-10 lg:gap-12 items-center"
    >
      <div className="relative z-10 max-w-xl order-2 lg:order-1">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/75">
          <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--brand-orange)]" />
          100% Natural & Cold Pressed
        </div>
        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7 }}
          className="mt-4 font-display text-[clamp(3rem,8vw,6rem)] font-semibold leading-[0.95] tracking-[-0.035em] text-[color:var(--brand)]"
        >
          Real Fruit.
          <br />
          <span className="text-[color:var(--brand-orange)]">Real Good.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.15 }}
          className="mt-6 text-[17px] leading-relaxed text-[color:var(--brand)]/75 max-w-md"
        >
          Cold-pressed in Lagos from sun-ripened Nigerian fruit. No added sugar. No preservatives.
          Just nature in a bottle — pressed the same morning it reaches you.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.3 }}
          className="mt-8 flex flex-wrap items-center gap-5"
        >
          <Link
            to="/juices"
            className="group inline-flex items-center gap-2 rounded-full bg-[color:var(--brand)] text-white pl-6 pr-5 py-3.5 text-sm font-semibold shadow-lg shadow-[color:var(--brand)]/20 hover:bg-[color:var(--brand-orange)] transition"
          >
            Shop Juices
            <span className="grid h-7 w-7 place-items-center rounded-full bg-white/15 group-hover:translate-x-0.5 transition">
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </Link>
          <button
            onClick={() => setVideoOpen(true)}
            className="group inline-flex items-center gap-3 text-sm font-semibold text-[color:var(--brand)]"
          >
            <span className="grid h-11 w-11 place-items-center rounded-full ring-1 ring-[color:var(--brand)]/25 group-hover:bg-[color:var(--brand)] group-hover:text-white transition">
              <Play className="h-4 w-4 fill-current" />
            </span>
            Watch Our Story
          </button>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.55, duration: 0.6 }}
          className="mt-12 grid grid-cols-2 sm:grid-cols-4 gap-5"
        >
          {features.map(({ Icon, title, sub }) => (
            <div
              key={title}
              className="flex flex-col items-start sm:items-center text-left sm:text-center"
            >
              <span className="grid h-11 w-11 place-items-center rounded-full ring-1 ring-[color:var(--brand)]/20 text-[color:var(--brand)]">
                <Icon className="h-5 w-5" />
              </span>
              <div className="mt-2 text-[13px] font-bold text-[color:var(--brand)]">{title}</div>
              <div className="text-[11px] text-[color:var(--brand)]/60">{sub}</div>
            </div>
          ))}
        </motion.div>
      </div>

      {/* 3-bottle flavour carousel */}
      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.9, delay: 0.1, ease: "easeOut" }}
        className="relative w-full flex flex-col items-center order-1 lg:order-2"
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0].clientX;
        }}
        onTouchEnd={(e) => {
          const delta = touchStartX.current - e.changedTouches[0].clientX;
          if (delta > 50) next();
          else if (delta < -50) prev();
        }}
      >
        {/* ── BOTTLE STAGE — width-constrained so bottles cluster tightly (mirrors Our Story) ── */}
        <div className="relative mx-auto h-[330px] sm:h-[480px] w-full max-w-[460px]">
          {/* Soft radial halo — fades into the page, no hard edge */}
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div
              className="h-[82%] w-[82%] rounded-full blur-3xl opacity-40 animate-splash"
              style={{
                background:
                  "radial-gradient(circle at 50% 58%, #ffb142 0%, #ffd071 35%, transparent 72%)",
              }}
            />
          </div>

          {/* Photoreal splash behind bottles — softly masked so it dissolves into the page */}
          <img
            src={splashBurst}
            alt=""
            aria-hidden
            className="absolute inset-0 m-auto h-[86%] w-[92%] object-contain opacity-50 mix-blend-multiply pointer-events-none"
            style={{
              WebkitMaskImage:
                "radial-gradient(ellipse 52% 45% at 50% 56%, #000 0%, rgba(0,0,0,0.6) 45%, transparent 75%)",
              maskImage:
                "radial-gradient(ellipse 52% 45% at 50% 56%, #000 0%, rgba(0,0,0,0.6) 45%, transparent 75%)",
            }}
          />

          {/* Mint leaves up top */}
          <motion.img
            src={leafMint}
            alt=""
            aria-hidden
            className="absolute left-[8%] top-[2%] z-30 w-12 sm:w-16 opacity-90 pointer-events-none"
            animate={{ rotate: [0, 6, 0] }}
            transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
          />
          <motion.img
            src={leafMint}
            alt=""
            aria-hidden
            className="absolute right-[7%] top-0 z-30 w-10 sm:w-14 opacity-80 -scale-x-100 pointer-events-none"
            animate={{ rotate: [0, -7, 0] }}
            transition={{ duration: 10, repeat: Infinity, ease: "easeInOut", delay: 0.6 }}
          />

          {/* LEFT bottle (faded, behind) — cross-dissolves with a gentle drift */}
          <AnimatePresence custom={direction} initial={false}>
            <motion.div
              key={leftProduct.id + "-left"}
              custom={direction}
              variants={sideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              className="absolute inset-0 z-0 flex items-end justify-start pl-[2%] pb-10 pointer-events-none"
            >
              <motion.img
                src={leftProduct.image}
                alt=""
                aria-hidden
                animate={{ y: [0, -8, 0] }}
                transition={{ duration: 6.5, repeat: Infinity, ease: "easeInOut" }}
                className="h-[68%] w-auto object-contain drop-shadow-[0_18px_22px_rgba(80,40,10,0.16)]"
              />
            </motion.div>
          </AnimatePresence>

          {/* RIGHT bottle (faded, behind) */}
          <AnimatePresence custom={direction} initial={false}>
            <motion.div
              key={rightProduct.id + "-right"}
              custom={direction}
              variants={sideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              className="absolute inset-0 z-0 flex items-end justify-end pr-[2%] pb-10 pointer-events-none"
            >
              <motion.img
                src={rightProduct.image}
                alt=""
                aria-hidden
                animate={{ y: [0, -8, 0] }}
                transition={{ duration: 7, repeat: Infinity, ease: "easeInOut", delay: 0.3 }}
                className="h-[68%] w-auto object-contain drop-shadow-[0_18px_22px_rgba(80,40,10,0.16)]"
              />
            </motion.div>
          </AnimatePresence>

          {/* CENTER bottle (hero, on top) — directional glide + depth */}
          <AnimatePresence custom={direction} initial={false}>
            <motion.div
              key={centerProduct.id + "-center"}
              custom={direction}
              variants={centerVariants}
              initial="enter"
              animate="center"
              exit="exit"
              className="absolute inset-0 z-20 flex items-end justify-center pb-1"
            >
              <motion.img
                src={centerProduct.image}
                alt={centerProduct.name}
                animate={{ y: [0, -10, 0] }}
                transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
                className="h-[94%] w-auto object-contain drop-shadow-[0_30px_38px_rgba(80,40,10,0.28)]"
              />
            </motion.div>
          </AnimatePresence>

          {/* ── LEFT ARROW ── */}
          <button
            onClick={prev}
            aria-label="Previous flavour"
            className="absolute left-[-14px] sm:left-[-22px] top-1/2 -translate-y-1/2 z-40
              h-11 w-11 rounded-full bg-white/90 backdrop-blur-sm
              ring-1 ring-[color:var(--brand)]/15
              grid place-items-center shadow-md group
              hover:bg-[color:var(--brand)] transition-all duration-200"
          >
            <ChevronLeft className="h-5 w-5 text-[color:var(--brand)] group-hover:text-white transition-colors" />
          </button>

          {/* ── RIGHT ARROW ── */}
          <button
            onClick={next}
            aria-label="Next flavour"
            className="absolute right-[-14px] sm:right-[-22px] top-1/2 -translate-y-1/2 z-40
              h-11 w-11 rounded-full bg-white/90 backdrop-blur-sm
              ring-1 ring-[color:var(--brand)]/15
              grid place-items-center shadow-md group
              hover:bg-[color:var(--brand)] transition-all duration-200"
          >
            <ChevronRight className="h-5 w-5 text-[color:var(--brand)] group-hover:text-white transition-colors" />
          </button>
        </div>

        {/* ── PRODUCT INFO CARD (compact) ── */}
        <motion.div
          key={centerProduct.id + "-info"}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="relative z-30 -mt-2 w-full max-w-[320px] rounded-2xl
            bg-white/75 backdrop-blur-md ring-1 ring-black/5
            shadow-[0_20px_50px_-26px_rgba(80,40,10,0.5)] px-4 py-3 text-center"
        >
          <p className="font-display text-[19px] sm:text-[21px] font-semibold leading-tight text-[color:var(--brand)]">
            {centerProduct.name}
          </p>

          {/* Ingredient pills */}
          {centerProduct.ingredients.length > 0 && (
            <div className="mt-2 flex flex-wrap justify-center gap-1">
              {centerProduct.ingredients.slice(0, 3).map((ing) => (
                <span
                  key={ing}
                  className="rounded-full px-2 py-0.5 text-[10px] font-medium text-[color:var(--brand)]/75 ring-1 ring-[color:var(--brand)]/10"
                  style={{ background: centerProduct.palette?.surface ?? "#fdecd2" }}
                >
                  {ing}
                </span>
              ))}
            </div>
          )}

          <button
            onClick={() => setDetail(centerProduct)}
            aria-label={`Choose size and add ${centerProduct.name} to cart`}
            className="mt-3 w-full rounded-full py-2 text-[13px] font-semibold text-white transition-all active:scale-95"
            style={{
              background: centerProduct.palette?.accent ?? "#C84B11",
              boxShadow: `0 10px 22px -10px ${centerProduct.palette?.accent ?? "#C84B11"}88`,
            }}
          >
            Add to Cart
          </button>
        </motion.div>

        {/* ── INDICATOR DOTS ── */}
        <div className="mt-5 flex items-center gap-1.5 z-30">
          {products.map((_, i) => (
            <button
              key={i}
              aria-label={`Go to ${products[i].name}`}
              onClick={() => {
                if (navigating.current || i === activeIndex) return;
                navigating.current = true;
                setDirection(i > activeIndex ? -1 : 1);
                setActiveIndex(i);
                setTimeout(() => {
                  navigating.current = false;
                }, 520);
              }}
              className={`rounded-full transition-all duration-300
                ${
                  i === activeIndex
                    ? "w-5 h-2 bg-[color:var(--brand-orange)]"
                    : "w-2 h-2 bg-[color:var(--brand)]/20 hover:bg-[color:var(--brand)]/40"
                }`}
            />
          ))}
        </div>
      </motion.div>

      <AnimatePresence>
        {videoOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] grid place-items-center bg-black/85 backdrop-blur-sm p-4"
            onClick={() => setVideoOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              className="relative w-full max-w-5xl aspect-video rounded-2xl overflow-hidden shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setVideoOpen(false)}
                className="absolute top-3 right-3 z-10 grid h-10 w-10 place-items-center rounded-full bg-white/95 text-[color:var(--brand)] hover:bg-white"
              >
                <X className="h-4 w-4" />
              </button>
              <video
                src={heroVideo.url}
                className="h-full w-full object-cover"
                autoPlay
                controls
                playsInline
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Buy modal — same as Fresh Favourites */}
      <ProductDetail product={detail} onClose={() => setDetail(null)} />
    </section>
  );
}

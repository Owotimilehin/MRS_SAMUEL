import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  BRAND,
  FRUITS,
  FRUIT_NUTRITION,
  MENU,
  bottleFor,
  ingredientToFruit,
  priceFor,
  type Category,
  type Fruit,
  type MenuItem,
  type Size,
} from "../data/menu.js";
import { useCart } from "../store/cart.js";
import { useCatalog } from "../store/catalog.js";
import { ngn } from "../lib/api.js";
import { SizeToggle } from "../components/ui/SizeToggle.js";
import { SiteLayout } from "../components/SiteLayout.js";

/** Cart line items distinguish sizes by suffix. */
function variantId(item: MenuItem, size: Size): string {
  return `${item.id}-${size}`;
}
function variantName(item: MenuItem, size: Size): string {
  return `${item.name} (${size}ml)`;
}

const FEATURED = ["Ultimate Detox", "Crimson Cooler", "Pineapple Juice", "Sunrise Blend"];
const AUTOPLAY_MS = 5500;

const WHATSAPP_URL = `https://wa.me/${BRAND.whatsapp}?text=${encodeURIComponent(
  "Hi Mrs. Samuel! I'd like to place an order.",
)}`;
const PHONE_URL = `tel:${BRAND.phone.replace(/\s/g, "")}`;

/* Fixed slot positions around the bottle — top→down, alternating sides.
 * Each slot has a base size and rotation. We fill slots in order from the
 * juice's available (mappable) ingredients. */
type Slot = { top: string; left: string; size: string; rotate: string };
/* Slots avoid the Details card (right 0–32%, top 30–58%) and the central bottle column.
 * Sizes bumped ~25% for a bolder, more obvious fruit-around-can composition. */
const SLOTS: Slot[] = [
  { top: "0%",  left: "58%", size: "28%", rotate: "12deg" },
  { top: "6%",  left: "6%",  size: "26%", rotate: "-14deg" },
  { top: "40%", left: "-4%", size: "23%", rotate: "-6deg" },
  { top: "62%", left: "12%", size: "21%", rotate: "8deg" },
  { top: "70%", left: "60%", size: "21%", rotate: "-10deg" },
  { top: "20%", left: "42%", size: "17%", rotate: "20deg" },
];

interface Theme {
  color: string;
  glow1: string;
  glow2: string;
  glow3: string;
  textGrad: string;
}

const THEMES: Record<string, Theme> = {
  orange: {
    color: "#F15A24",
    glow1: "rgba(252, 191, 73, 0.55)",
    glow2: "rgba(241, 90, 36, 0.28)",
    glow3: "rgba(230, 57, 70, 0.10)",
    textGrad: "linear-gradient(135deg, #E63946 0%, #F15A24 50%, #FCBF49 100%)",
  },
  crimson: {
    color: "#E63946",
    glow1: "rgba(230, 57, 70, 0.55)",
    glow2: "rgba(186, 16, 46, 0.28)",
    glow3: "rgba(120, 10, 30, 0.10)",
    textGrad: "linear-gradient(135deg, #E63946 0%, #c91c3d 50%, #7c0b24 100%)",
  },
  green: {
    color: "#2b9348",
    glow1: "rgba(163, 230, 53, 0.55)",
    glow2: "rgba(43, 147, 72, 0.28)",
    glow3: "rgba(20, 83, 45, 0.10)",
    textGrad: "linear-gradient(135deg, #2b9348 0%, #55a630 50%, #a3e635 100%)",
  },
  pink: {
    color: "#ec4899",
    glow1: "rgba(244, 114, 182, 0.55)",
    glow2: "rgba(219, 39, 119, 0.28)",
    glow3: "rgba(131, 24, 67, 0.10)",
    textGrad: "linear-gradient(135deg, #ec4899 0%, #f472b6 50%, #fbcfe8 100%)",
  },
  yellow: {
    color: "#eab308",
    glow1: "rgba(253, 224, 71, 0.55)",
    glow2: "rgba(202, 138, 4, 0.28)",
    glow3: "rgba(113, 63, 4, 0.10)",
    textGrad: "linear-gradient(135deg, #eab308 0%, #facc15 50%, #fef08a 100%)",
  },
};

function themeFor(item: MenuItem): Theme {
  const name = item.name.toLowerCase();
  if (name.includes("detox") || name.includes("booster") || (name.includes("glow") && !name.includes("crimson"))) {
    return THEMES.green;
  }
  if (name.includes("crimson") || name.includes("punch")) {
    return THEMES.crimson;
  }
  if (name.includes("pink") || name.includes("guyabano") || name.includes("delight")) {
    return THEMES.pink;
  }
  if (name.includes("pineapple") || name.includes("tropical") || name.includes("ginger") || name.includes("spark")) {
    return THEMES.yellow;
  }
  if (name.includes("orange")) {
    return THEMES.orange;
  }
  if (item.category === "special") return THEMES.pink;
  if (item.category === "punch") return THEMES.crimson;
  return THEMES.orange;
}

const FRUIT_COLORS: Record<Fruit, string> = {
  pineapple: "#FCBF49",
  orange: "#F15A24",
  carrot: "#f97316",
  watermelon: "#f43f5e",
  ginger: "#fbbf24",
  beetroot: "#9d174d",
  strawberry: "#e11d48",
  lemon: "#facc15",
  mint: "#4ade80",
  apple: "#86efac",
  pawpaw: "#f97316",
  avocado: "#65a30d",
  banana: "#fef08a",
  cucumber: "#22c55e",
  turmeric: "#fbbf24",
  celery: "#86efac",
  soursop: "#a8a29e",
};

function useScrollReveal() {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          }
        });
      },
      { threshold: 0.1 }
    );

    const elements = document.querySelectorAll(".scroll-enter");
    elements.forEach((el) => observer.observe(el));

    return () => {
      elements.forEach((el) => observer.unobserve(el));
    };
  }, []);
}

export function MenuPage(): JSX.Element {
  useScrollReveal();
  const loadCatalog = useCatalog((s) => s.load);
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  return (
    <SiteLayout
      active="menu"
      meta={{
        title: "Mrs. Samuel Fruit Juice — Cold-pressed in Lagos",
        description:
          "Seventeen cold-pressed juices, bottled fresh every morning in Ajao Estate, Lagos. No added sugar. No preservatives. Same-day delivery.",
      }}
    >
      <div className="ms-container"><Hero /></div>
      <div className="ms-container"><TrustStrip /></div>
      <div className="ms-container"><HowItWorks /></div>
      <div className="ms-container"><FlavourMixer /></div>
      <div className="ms-container"><FullMenu /></div>
      <div className="ms-container"><Testimonials /></div>
      <div className="ms-container"><About /></div>
      <div className="ms-container"><InstagramFeed /></div>
      <div className="ms-container"><Newsletter /></div>
    </SiteLayout>
  );
}

/* ────────────────────────── Hero ───────────────────────────────── */
function Hero(): JSX.Element {
  const [index, setIndex] = useState(0);
  const [size, setSize] = useState<Size>(650);
  const [justAdded, setJustAdded] = useState(false);
  const pausedRef = useRef(false);
  const current = MENU[index]!;
  const addToCart = useCart((s) => s.add);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (pausedRef.current) return;
      setIndex((i) => (i + 1) % MENU.length);
    }, AUTOPLAY_MS);
    return () => window.clearInterval(id);
  }, []);

  const goPrev = (): void => setIndex((i) => (i - 1 + MENU.length) % MENU.length);
  const goNext = (): void => setIndex((i) => (i + 1) % MENU.length);

  const variantFor = useCatalog((s) => s.variantFor);
  const ensureCatalog = useCatalog((s) => s.load);
  const onAdd = async (): Promise<void> => {
    // Wait for the live catalog so we send a real variant uuid to the cart API.
    await ensureCatalog();
    const live = variantFor(current.name, size);
    if (!live) return; // catalog couldn't resolve this flavour — silent no-op
    addToCart({
      product_id: live.id,
      variant_id: live.id,
      name: variantName(current, size),
      unit_price_ngn: live.price_ngn,
    });
    setJustAdded(true);
    window.setTimeout(() => setJustAdded(false), 1600);
  };

  const theme = themeFor(current);
  const heroStyle = {
    "--theme-color": theme.color,
    "--theme-glow-1": theme.glow1,
    "--theme-glow-2": theme.glow2,
    "--theme-glow-3": theme.glow3,
    "--theme-text-grad": theme.textGrad,
  } as CSSProperties;

  return (
    <section className="ms-hero scroll-enter" style={heroStyle}>
      <div>
        <div className="ms-badge">
          <span className="dot" /> Faster juice delivery service
        </div>
        <h1 className="ms-h1">
          Juice to make<br />your day <span className="text-grad">fresh.</span>
        </h1>
        <p className="ms-sub">
          Stay cool with seventeen cold-pressed juices, bottled every morning in Lagos.
          No added sugar, no preservatives — delivered the same day you order.
        </p>
        <div className="ms-cta-row">
          <button type="button" className="btn btn--primary" onClick={onAdd}>
            <span className="ico"><Icon name={justAdded ? "check" : "cart"} size={18} /></span>
            {justAdded ? `Added · ${current.name}` : "Add to cart"}
          </button>
          <a className="btn btn--ghost" href="#menu">View menu</a>
        </div>
      </div>

      <div
        onMouseEnter={() => { pausedRef.current = true; }}
        onMouseLeave={() => { pausedRef.current = false; }}
      >
        <HeroScene item={current} size={size} onSizeChange={setSize} />
        <CarouselNav index={index} total={MENU.length} onPrev={goPrev} onNext={goNext} onJump={setIndex} />
      </div>
    </section>
  );
}

function HeroScene({
  item, size, onSizeChange,
}: {
  item: MenuItem;
  size: Size;
  onSizeChange: (s: Size) => void;
}): JSX.Element {
  const sceneRef = useRef<HTMLDivElement>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [squishedFruit, setSquishedFruit] = useState<number | null>(null);
  const [droplets, setDroplets] = useState<{ id: number; left: string; top: string; color: string }[]>([]);
  const [selectedIngredient, setSelectedIngredient] = useState<Fruit | null>(null);

  /* Map this juice's ingredients to fruits we have cutouts for, in order */
  const fruits: { fruit: Fruit; slot: Slot }[] = [];
  for (const ing of item.ingredients) {
    const f = ingredientToFruit(ing);
    if (!f) continue;
    const slot = SLOTS[fruits.length];
    if (!slot) break;
    fruits.push({ fruit: f, slot });
  }

  // Reset focus detail when juice changes
  useEffect(() => {
    setSelectedIngredient(null);
  }, [item.id]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!sceneRef.current) return;
    const rect = sceneRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    // Normalize coordinates between -1 and 1
    const x = (e.clientX - centerX) / (rect.width / 2);
    const y = (e.clientY - centerY) / (rect.height / 2);
    setMousePos({ x, y });
  };

  const handleMouseLeave = () => {
    setMousePos({ x: 0, y: 0 });
  };

  const handleFruitClick = (i: number, fruit: Fruit, slot: Slot) => {
    // Squeeze animation
    setSquishedFruit(i);
    setTimeout(() => {
      setSquishedFruit(null);
    }, 600);

    // Focus ingredient details
    setSelectedIngredient(fruit);

    // Spawn 5 droplets with random offset
    const newDroplets = Array.from({ length: 5 }).map((_, dIdx) => {
      const angle = (dIdx / 5) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const dist = 10 + Math.random() * 20;
      return {
        id: Date.now() + Math.random(),
        left: `calc(${slot.left} + ${slot.size} / 2 + ${Math.cos(angle) * dist}px)`,
        top: `calc(${slot.top} + ${slot.size} / 2 + ${Math.sin(angle) * dist}px)`,
        color: FRUIT_COLORS[fruit] || "#F15A24",
      };
    });

    setDroplets((prev) => [...prev, ...newDroplets]);

    // Cleanup droplets
    setTimeout(() => {
      setDroplets((prev) => prev.filter((d) => !newDroplets.find((nd) => nd.id === d.id)));
    }, 800);
  };

  return (
    <div
      ref={sceneRef}
      className="ms-scene"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Subtle radial sunrise glow behind the can */}
      <div className="ms-scene__glow" aria-hidden />

      {/* Ground shadow + wooden disc podium under the can */}
      <div className="ms-scene__shadow" aria-hidden />
      <div className="ms-scene__podium" aria-hidden />

      {/* The bottle for the current flavour */}
      <img
        key={item.id}
        className="ms-scene__bottle is-enter"
        src={bottleFor(item)}
        alt={item.name}
        onError={(e) => {
          const img = e.currentTarget;
          if (img.src.endsWith("/assets/bottle-hero.png")) return;
          img.src = "/assets/bottle-hero.png";
        }}
      />

      {/* Droplet particles */}
      {droplets.map((d) => (
        <div
          key={d.id}
          className="ms-droplet"
          style={{
            left: d.left,
            top: d.top,
            backgroundColor: d.color,
          } as CSSProperties}
        />
      ))}

      {/* Ingredient-specific photographic fruits with hover nutrition.
       * Base rotation passed via --rot so the float keyframe can compose it
       * with translateY; staggered --delay desyncs the bobbing. */}
      {fruits.map(({ fruit, slot }, i) => {
        const n = FRUIT_NUTRITION[fruit];
        const isSquished = squishedFruit === i;
        const depth = 12 + i * 6; // 12px to 42px offset depending on index
        const px = `${(mousePos.x * depth).toFixed(1)}px`;
        const py = `${(mousePos.y * depth).toFixed(1)}px`;

        return (
          <button
            key={`${item.id}-${fruit}-${i}`}
            type="button"
            className={`ms-fruit ${isSquished ? "is-squished" : ""}`}
            onClick={() => handleFruitClick(i, fruit, slot)}
            style={{
              top: slot.top,
              left: slot.left,
              width: slot.size,
              "--rot": slot.rotate,
              "--delay": `${(-i * 0.85).toFixed(2)}s`,
              "--p-x": px,
              "--p-y": py,
            } as CSSProperties}
            aria-label={`${n.name} nutrition`}
          >
            <img src={`/assets/fruits/${fruit}-cutout.png`} alt={n.name} />
            <span className="ms-fruit__tip" role="tooltip">
              <span className="ms-fruit__tip-name">{n.name}</span>
              <span className="ms-fruit__tip-list">{n.benefits.join(" · ")}</span>
            </span>
          </button>
        );
      })}

      {/* Callout label tags — small pills pointing at scene elements (jusux style) */}
      <span className="ms-tag ms-tag--left" style={{ top: "10%", right: "6%" }}>Natural</span>
      <span className="ms-tag ms-tag--left" style={{ top: "30%", right: "-2%" }}>
        {item.category === "punch" ? "Punch" : item.category === "special" ? "Special" : "Fresh"}
      </span>
      <span className="ms-tag ms-tag--right" style={{ top: "70%", left: "26%" }}>Juice</span>

      {/* Floating Details overlay card — driven by current juice + selected size */}
      <div className="ms-details" aria-label={selectedIngredient ? `${selectedIngredient} nutrition` : "Featured juice"}>
        {selectedIngredient ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
              <div className="ms-details__name" style={{ marginBottom: 0 }}>
                {FRUIT_NUTRITION[selectedIngredient].name}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedIngredient(null);
                }}
                style={{
                  background: "transparent",
                  border: 0,
                  fontSize: "14px",
                  cursor: "pointer",
                  color: "var(--ink-soft)",
                  lineHeight: 1,
                  padding: "2px"
                }}
                aria-label="Back to juice details"
              >
                ✕
              </button>
            </div>
            <div className="ms-details__ings" style={{ fontSize: "10px", color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
              Nutrients & Benefits
            </div>
            <div className="ms-details__ings" style={{ minHeight: "50px", marginBottom: "8px" }}>
              {FRUIT_NUTRITION[selectedIngredient].benefits.map((benefit, bIdx) => (
                <div key={bIdx} style={{ display: "flex", alignItems: "flex-start", gap: "4px", margin: "2px 0", lineHeight: "1.3" }}>
                  <span style={{ color: "var(--theme-color)", fontWeight: "bold" }}>•</span>
                  <span>{benefit}</span>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSelectedIngredient(null)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "center",
                background: "var(--surface-soft)",
                border: "none",
                borderRadius: "999px",
                padding: "6px 0",
                cursor: "pointer",
                fontWeight: "700",
                fontSize: "10px",
                color: "var(--ink)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                transition: "background 0.2s ease"
              }}
            >
              Back to Juice
            </button>
          </>
        ) : (
          <>
            <div className="ms-details__name">{item.name}</div>
            <div className="ms-details__ings">{item.ingredients.join(" · ")}</div>
            <div className="ms-details__price">{ngn(priceFor(item, size))}</div>
            <div className="ms-details__stars">★★★★★</div>
            <SizeToggle size={size} onChange={onSizeChange} />
          </>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────── Flavour Explorer Mixer ─────────────────────────── */
function FlavourMixer(): JSX.Element {
  const [selected, setSelected] = useState<Fruit[]>([]);

  const toggleFruit = (fruit: Fruit) => {
    setSelected((prev) =>
      prev.includes(fruit)
        ? prev.filter((f) => f !== fruit)
        : [...prev, fruit]
    );
  };

  const clearMixer = () => setSelected([]);

  // Find matching juices
  const matchingJuices = useMemo(() => {
    if (selected.length === 0) return [];
    return MENU.filter((juice) => {
      // Check if juice has ALL of the selected fruits
      return selected.every((selFruit) =>
        juice.ingredients.some((ing) => ingredientToFruit(ing) === selFruit)
      );
    });
  }, [selected]);

  // If no exact match (all selected), let's find juices matching ANY of the selected
  const partialMatchingJuices = useMemo(() => {
    if (selected.length === 0 || matchingJuices.length > 0) return [];
    return MENU.filter((juice) => {
      return selected.some((selFruit) =>
        juice.ingredients.some((ing) => ingredientToFruit(ing) === selFruit)
      );
    });
  }, [selected, matchingJuices]);

  // Gather unique health benefits
  const activeBenefits = useMemo(() => {
    const benefitsSet = new Set<string>();
    selected.forEach((fruit) => {
      FRUIT_NUTRITION[fruit]?.benefits.forEach((b) => benefitsSet.add(b));
    });
    return Array.from(benefitsSet);
  }, [selected]);

  const displayedJuices = matchingJuices.length > 0 ? matchingJuices : partialMatchingJuices;
  const isExact = matchingJuices.length > 0;
  const addToCart = useCart((s) => s.add);

  return (
    <section className="ms-mixer scroll-enter">
      <div className="ms-label eyebrow">Flavour Explorer</div>
      <h2 className="ms-section-title">Mix Your Vibe</h2>
      <p className="ms-section-sub" style={{ margin: "0 auto 24px" }}>
        Select ingredients to see which of our 17 cold-pressed juices match, along with their health benefits.
      </p>

      <div className="ms-mixer__grid">
        {FRUITS.map((fruit) => {
          const isActive = selected.includes(fruit);
          const name = FRUIT_NUTRITION[fruit]?.name || fruit;
          return (
            <button
              key={fruit}
              type="button"
              className={`ms-mixer__fruit-btn ${isActive ? "is-active" : ""}`}
              onClick={() => toggleFruit(fruit)}
            >
              <img src={`/assets/fruits/${fruit}-cutout.png`} alt={name} />
              {name}
            </button>
          );
        })}
      </div>

      {selected.length > 0 && (
        <div className="ms-mixer__results">
          {activeBenefits.length > 0 && (
            <div style={{ marginBottom: "24px" }}>
              <div className="ms-mixer__benefit-label">Health Benefits</div>
              <div className="ms-mixer__benefits">
                {activeBenefits.map((b) => (
                  <span key={b} className="ms-mixer__benefit-pill">
                    {b}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="ms-mixer__benefit-label">
              {isExact
                ? `Perfect Matches (${matchingJuices.length})`
                : displayedJuices.length > 0
                ? `Blends containing some of your picks (${displayedJuices.length})`
                : "No matching blends"}
            </div>

            {displayedJuices.length > 0 ? (
              <div className="ms-mixer__juices-grid">
                {displayedJuices.map((juice) => (
                  <MenuCard key={juice.id} item={juice} onAdd={addToCart} />
                ))}
              </div>
            ) : (
              <p className="ms-section-sub" style={{ margin: 0 }}>
                We don't have a blend with this exact combination yet. Try selecting a different mix!
              </p>
            )}
          </div>
          
          <button 
            type="button" 
            className="btn btn--ghost" 
            onClick={clearMixer}
            style={{ marginTop: "24px", padding: "8px 20px", fontSize: "11px" }}
          >
            Reset Mixer
          </button>
        </div>
      )}
    </section>
  );
}


function CarouselNav({
  index, total, onPrev, onNext, onJump,
}: {
  index: number; total: number;
  onPrev: () => void; onNext: () => void;
  onJump: (i: number) => void;
}): JSX.Element {
  return (
    <div className="ms-carousel">
      <button type="button" className="ms-carousel__btn" onClick={onPrev} aria-label="Previous flavour">
        <Icon name="chev-left" />
      </button>
      <div className="ms-carousel__dots" role="tablist" aria-label="Flavours">
        {Array.from({ length: total }).map((_, i) => (
          <button
            key={i}
            type="button"
            className={`ms-carousel__dot ${i === index ? "is-active" : ""}`}
            onClick={() => onJump(i)}
            aria-label={`Flavour ${i + 1}`}
            aria-selected={i === index}
            role="tab"
          />
        ))}
      </div>
      <span className="ms-carousel__count">{index + 1} / {total}</span>
      <button type="button" className="ms-carousel__btn" onClick={onNext} aria-label="Next flavour">
        <Icon name="chev-right" />
      </button>
    </div>
  );
}

/* SideDecorations removed — placeholder slot if we re-add intentional shapes later */

/* ────────────────────────── Trust strip ────────────────────────── */
function TrustStrip(): JSX.Element {
  const items = [
    { icon: "leaf",   label: "100% Natural",     sub: "Real fruit, no concentrates" },
    { icon: "press",  label: "Cold-pressed",     sub: "Bottled fresh every morning" },
    { icon: "no-sugar", label: "Zero added sugar", sub: "Sweetness from the fruit only" },
    { icon: "truck",  label: "Same-day in Lagos", sub: "Order by 11am · door delivery" },
  ] as const;
  return (
    <section className="ms-trust scroll-enter">
      {items.map((t) => (
        <div key={t.label} className="ms-trust__cell">
          <span className="ms-trust__icon"><TrustIcon name={t.icon} /></span>
          <div>
            <div className="ms-trust__label">{t.label}</div>
            <div className="ms-trust__sub">{t.sub}</div>
          </div>
        </div>
      ))}
    </section>
  );
}

function TrustIcon({ name }: { name: "leaf" | "press" | "no-sugar" | "truck" }): JSX.Element {
  const c = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "leaf":     return <svg {...c}><path d="M11 20A7 7 0 0 1 4 13c0-4 3-9 9-10 1 4 1 9-1 13a7 7 0 0 1-1 4z"/><path d="M2 22c7-2 11-7 13-13"/></svg>;
    case "press":    return <svg {...c}><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M3 12h18"/></svg>;
    case "no-sugar": return <svg {...c}><circle cx="12" cy="12" r="9"/><path d="M5 5l14 14"/></svg>;
    case "truck":    return <svg {...c}><rect x="1" y="6" width="14" height="11" rx="1"/><path d="M15 9h4l3 4v4h-7"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/></svg>;
  }
}

/* ────────────────────────── How it works ───────────────────────── */
function HowItWorks(): JSX.Element {
  const steps = [
    { n: "1", title: "Pick your juice", body: "Browse 17 cold-pressed flavours. Mix sizes, mix bottles." },
    { n: "2", title: "Cold-pressed today", body: "Real fruit washed, peeled, and pressed before sunrise in Ajao Estate." },
    { n: "3", title: "Same-day delivery", body: "Out the door by noon. At yours before the day ends." },
  ];
  return (
    <section className="ms-how scroll-enter">
      <header className="ms-how__head">
        <div className="ms-label eyebrow">How it works</div>
        <h2 className="ms-section-title">From our kitchen to your door, the same day.</h2>
      </header>
      <div className="ms-how__grid">
        {steps.map((s) => (
          <div key={s.n} className="ms-how__step">
            <div className="ms-how__num">{s.n}</div>
            <h3 className="ms-how__title">{s.title}</h3>
            <p className="ms-how__body">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ────────────────────────── Testimonials ───────────────────────── */
function Testimonials(): JSX.Element {
  const quotes = [
    { quote: "Best Sunrise Blend I've ever had. Order every Friday now.",                    name: "Adaeze O.",  area: "Ikoyi" },
    { quote: "My kids ask for Pink Paradise by name. Same-day delivery is unreal.",          name: "Chidinma U.", area: "Lekki" },
    { quote: "Crimson Cooler before the gym = different energy. Real fruit you can taste.",  name: "Tunde A.",   area: "Yaba" },
    { quote: "Switched from store-bought juice 6 months ago. Won't go back.",                name: "Funke M.",   area: "Surulere" },
  ];
  return (
    <section className="ms-test scroll-enter">
      <header className="ms-how__head">
        <div className="ms-label eyebrow">Loved across Lagos</div>
        <h2 className="ms-section-title">What our customers say</h2>
      </header>
      <div className="ms-test__grid">
        {quotes.map((q) => (
          <figure key={q.name} className="ms-test__card">
            <div className="ms-test__stars">★★★★★</div>
            <blockquote>"{q.quote}"</blockquote>
            <figcaption>
              <strong>{q.name}</strong> · {q.area}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/* ────────────────────────── Instagram feed ─────────────────────── */
type IgPost = {
  id: string;
  imageUrl: string;
  permalink: string;
  caption: string;
  isVideo: boolean;
};

/** Placeholder tiles shown until the live feed loads (or if it fails). */
const IG_FALLBACK_TILES: { src: string; placeholder: true }[] = [
  { src: "/assets/bottles/sunrise-blend-tight.png", placeholder: true },
  { src: "/assets/bottles/pink-paradise-tight.png", placeholder: true },
  { src: "/assets/bottles/ultimate-detox-tight.png", placeholder: true },
  { src: "/assets/fruits/orange-cutout.png",        placeholder: true },
  { src: "/assets/bottles/crimson-cooler-tight.png", placeholder: true },
  { src: "/assets/fruits/pineapple-cutout.png",     placeholder: true },
];

function InstagramFeed(): JSX.Element {
  const [posts, setPosts] = useState<IgPost[] | null>(null);
  const handle = BRAND.handle.replace("@", "");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/v1/public/instagram/feed");
        if (!res.ok) return;
        const body = (await res.json()) as { data: IgPost[] };
        if (!cancelled && body.data.length > 0) setPosts(body.data.slice(0, 6));
      } catch {
        /* soft-fail — keep placeholders */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const useFallback = !posts || posts.length === 0;

  return (
    <section className="ms-ig scroll-enter">
      <header className="ms-ig__head">
        <div>
          <div className="ms-label eyebrow">@{handle}</div>
          <h2 className="ms-section-title">On the gram</h2>
        </div>
        <a className="ms-ig__follow" href={`https://instagram.com/${handle}`} target="_blank" rel="noreferrer">
          Follow us →
        </a>
      </header>
      <div className="ms-ig__grid">
        {useFallback
          ? IG_FALLBACK_TILES.map((t, i) => (
              <a key={i} className="ms-ig__tile ms-ig__tile--placeholder" href={`https://instagram.com/${handle}`} target="_blank" rel="noreferrer">
                <img src={t.src} alt="" />
              </a>
            ))
          : posts.map((p) => (
              <a key={p.id} className="ms-ig__tile" href={p.permalink} target="_blank" rel="noreferrer" aria-label={p.caption || "Instagram post"}>
                <img src={p.imageUrl} alt={p.caption || ""} loading="lazy" />
                {p.isVideo && <span className="ms-ig__video-badge" aria-hidden>▶</span>}
              </a>
            ))}
      </div>
    </section>
  );
}

/* ────────────────────────── Newsletter ─────────────────────────── */
function Newsletter(): JSX.Element {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (!email) return;
    /* TODO: wire to /v1/public/newsletter once endpoint exists */
    setSubmitted(true);
    setEmail("");
  };
  return (
    <section className="ms-news scroll-enter">
      <div className="ms-news__inner">
        <div className="ms-label eyebrow">Stay fresh</div>
        <h2 className="ms-section-title">New flavours, drops, and Lagos-only specials.</h2>
        <p className="ms-section-sub">Once a week. No spam. Unsubscribe any time.</p>
        <form className="ms-news__form" onSubmit={onSubmit}>
          <input
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            aria-label="Email address"
          />
          <button type="submit" className="btn btn--primary">
            {submitted ? "Subscribed" : "Subscribe"}
          </button>
        </form>
      </div>
    </section>
  );
}

/* ────────────────────────── Full Menu ──────────────────────────── */
const FILTERS: { id: "all" | Category | "featured"; label: string }[] = [
  { id: "all", label: "All 17" },
  { id: "regular", label: "Regulars" },
  { id: "special", label: "Specials" },
  { id: "punch", label: "Punch" },
  { id: "featured", label: "Featured" },
];

function FullMenu(): JSX.Element {
  const [filter, setFilter] = useState<typeof FILTERS[number]["id"]>("all");

  const visible = useMemo(() => {
    if (filter === "all") return MENU;
    if (filter === "featured") return MENU.filter((m) => FEATURED.includes(m.name));
    return MENU.filter((m) => m.category === filter);
  }, [filter]);

  const addToCart = useCart((s) => s.add);

  return (
    <section id="full-menu" className="ms-full scroll-enter">
      <header className="ms-full__head">
        <div className="ms-label eyebrow">The full menu</div>
        <h2 className="ms-section-title">17 cold-pressed juices</h2>
        <p className="ms-section-sub">Bottled fresh every morning · No sugar · No preservatives</p>
      </header>

      <div className="ms-full__tabs" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={filter === f.id ? "is-active" : ""}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="ms-full__grid">
        {visible.map((item) => <MenuCard key={item.id} item={item} onAdd={addToCart} />)}
      </div>
    </section>
  );
}

function MenuCard({
  item,
  onAdd,
}: {
  item: MenuItem;
  onAdd: (line: {
    product_id: string;
    variant_id?: string;
    name: string;
    unit_price_ngn: number;
  }) => void;
}): JSX.Element {
  const [size, setSize] = useState<Size>(650);
  const variantFor = useCatalog((s) => s.variantFor);
  const ensureCatalog = useCatalog((s) => s.load);
  const live = variantFor(item.name, size);
  const price = live?.price_ngn ?? priceFor(item, size);
  return (
    <article className="menu-card">
      <div className="menu-card__media">
        <img
          src={bottleFor(item)}
          alt={item.name}
          onError={(e) => {
            const img = e.currentTarget;
            if (img.src.endsWith("/assets/bottle-hero.png")) return;
            img.src = "/assets/bottle-hero.png";
          }}
        />
      </div>
      <div className="menu-card__body">
        <div className="menu-card__head">
          <h3 className="menu-card__name">{item.name}</h3>
          <span className="menu-card__price">{ngn(price)}</span>
        </div>
        <p className="menu-card__ings">{item.ingredients.join(" · ")}</p>
        <div className="menu-card__foot">
          <SizeToggle size={size} onChange={setSize} />
          <button
            type="button"
            className="menu-card__add"
            aria-label={`Add ${item.name} ${size}ml to cart`}
            onClick={async () => {
              // Ensure catalog so we always send a real variant uuid.
              await ensureCatalog();
              const resolved = live ?? variantFor(item.name, size);
              if (!resolved) return;
              onAdd({
                product_id: resolved.id,
                variant_id: resolved.id,
                name: variantName(item, size),
                unit_price_ngn: resolved.price_ngn,
              });
            }}
          >
            <Icon name="cart" size={16} />
            Add
          </button>
        </div>
        {item.category !== "regular" && (
          <span className={`menu-card__tag menu-card__tag--${item.category} menu-card__tag--floating`}>
            {item.category === "special" ? "Special" : "Punch"}
          </span>
        )}
      </div>
    </article>
  );
}

/* ────────────────────────── About ──────────────────────────────── */
function About(): JSX.Element {
  const stats = [
    { n: "17", label: "Juice flavours" },
    { n: "100%", label: "Natural fruit" },
    { n: "0g", label: "Added sugar" },
    { n: "Same-day", label: "Lagos delivery" },
  ];
  return (
    <section id="about" className="ms-about scroll-enter">
      <div className="ms-about__copy">
        <div className="ms-label eyebrow">The story</div>
        <h2 className="ms-section-title">
          One kitchen.<br />Seventeen juices.<br />
          <span className="text-grad">Zero shortcuts.</span>
        </h2>
        <p className="ms-section-sub">
          Every bottle starts at our kitchen in Ajao Estate before sunrise. We wash, peel, and
          cold-press real fruit — the same kind you'd buy at the market — and bottle it
          immediately. No concentrates, no syrups, nothing on the label your grandmother
          wouldn't recognize.
        </p>
        <p className="ms-section-sub">
          We deliver same-day across Lagos. Most customers come back before they finish the
          first bottle.
        </p>
      </div>
      <div className="ms-about__stats">
        {stats.map((s) => (
          <div key={s.label} className="ms-stat">
            <div className="ms-stat__n text-grad">{s.n}</div>
            <div className="ms-stat__label">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ────────────────────────── Icons ──────────────────────────────── */
function Icon({ name, size = 20 }: { name: "search" | "cart" | "user" | "check" | "chev-left" | "chev-right"; size?: number }): JSX.Element {
  const c = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "search":
      return <svg {...c}><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>;
    case "cart":
      return <svg {...c}><circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" /></svg>;
    case "user":
      return <svg {...c}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>;
    case "check":
      return <svg {...c}><polyline points="20 6 9 17 4 12" /></svg>;
    case "chev-left":
      return <svg {...c}><polyline points="15 18 9 12 15 6" /></svg>;
    case "chev-right":
      return <svg {...c}><polyline points="9 18 15 12 9 6" /></svg>;
  }
}

import { useState, type CSSProperties } from "react";
import { getFlavourVisual, type ProductLike } from "../lib/flavour-visuals.js";

// Renders a product as its assigned bottle floating on its own palette tint,
// with a fruit accent and a soft splash — the core of the admin "Juice Skin".
// One component, four sizes, used everywhere a product appears.
//
//   hero   — product detail banner
//   card   — product grid cards
//   tile   — POS / compact grids
//   chip   — table rows, cart lines, inline tokens
//
// If the bottle image fails to load (no asset assigned, broken URL) it falls
// back to a palette-coloured silhouette so nothing ever renders empty.

export type FlavourMediaSize = "hero" | "card" | "tile" | "chip";

const DIMENSIONS: Record<FlavourMediaSize, { box: number; bottle: number; fruit: number; radius: number }> = {
  hero: { box: 200, bottle: 168, fruit: 56, radius: 28 },
  card: { box: 158, bottle: 128, fruit: 42, radius: 0 },
  tile: { box: 96, bottle: 80, fruit: 26, radius: 16 },
  chip: { box: 46, bottle: 38, fruit: 0, radius: 12 },
};

export interface FlavourMediaProps {
  product: ProductLike;
  size?: FlavourMediaSize;
  /** Show the decorative splash behind the bottle (default: hero/card only). */
  splash?: boolean;
  /** Show the small fruit accent (default: true for hero/card/tile). */
  fruit?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function FlavourMedia({
  product,
  size = "card",
  splash,
  fruit,
  className,
  style,
}: FlavourMediaProps): JSX.Element {
  const v = getFlavourVisual(product);
  const dim = DIMENSIONS[size];
  const [bottleBroken, setBottleBroken] = useState(false);
  const showSplash = (splash ?? (size === "hero" || size === "card")) && !bottleBroken;
  const showFruit = (fruit ?? size !== "chip") && dim.fruit > 0;

  const wrapStyle: CSSProperties = {
    // Per-flavour theming hooks consumed by .flav-media CSS.
    ["--fl-surface" as string]: v.surface,
    ["--fl-accent" as string]: v.accent,
    width: size === "card" ? "100%" : dim.box,
    height: dim.box,
    borderRadius: dim.radius || undefined,
    ...style,
  };

  return (
    <div className={`flav-media flav-media--${size}${className ? ` ${className}` : ""}`} style={wrapStyle}>
      {showSplash && (
        <img className="flav-media__splash" src={v.splash} alt="" aria-hidden="true" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} />
      )}
      {bottleBroken ? (
        <span className="flav-media__silhouette" style={{ height: dim.bottle }} aria-hidden="true" />
      ) : (
        <img
          className="flav-media__bottle"
          src={v.bottle}
          alt=""
          aria-hidden="true"
          loading="lazy"
          style={{ height: dim.bottle }}
          onError={() => setBottleBroken(true)}
        />
      )}
      {showFruit && (
        <img className="flav-media__fruit" src={v.fruit} alt="" aria-hidden="true" loading="lazy" style={{ width: dim.fruit }} onError={(e) => { e.currentTarget.style.display = "none"; }} />
      )}
    </div>
  );
}

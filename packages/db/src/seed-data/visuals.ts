// Per-flavour palette + image mapping, lifted from the customer app's
// src/data/products.ts (SURFACES + bottle/cluster/fruit assets). The actual
// PNGs are served by the customer app from /media/...; here we only record
// which file each flavour uses so the seed can create media_asset rows and
// wire products to them. Palette text colour is the DESIGN_SYSTEM value.

export type Palette = { surface: string; accent: string; text: string };

export const PALETTES: Record<string, Palette> = {
  orange: { surface: "#fdecd2", accent: "#e85d1c", text: "#3a1a05" },
  yellow: { surface: "#fdf3c5", accent: "#c79006", text: "#3a2700" },
  golden: { surface: "#fbe7a8", accent: "#a96b06", text: "#3a2400" },
  cream: { surface: "#fdf1cf", accent: "#a8761a", text: "#3a2700" },
  green: { surface: "#e5f0d2", accent: "#3f6b1f", text: "#152a08" },
  mint: { surface: "#d9ebc8", accent: "#2d5a18", text: "#0f2208" },
  avocado: { surface: "#ecf0cf", accent: "#5a6b1f", text: "#1a2208" },
  watermelon: { surface: "#fbd9de", accent: "#c2243a", text: "#2a0a10" },
  ruby: { surface: "#f4ccd2", accent: "#8a1224", text: "#2a0608" },
  pink: { surface: "#fbd9e4", accent: "#b6275a", text: "#2a0a18" },
  blush: { surface: "#fde2dd", accent: "#c46055", text: "#2a0e08" },
  coral: { surface: "#fde0cf", accent: "#d65a1c", text: "#3a1208" },
  beet: { surface: "#f0d4dd", accent: "#8a1c3f", text: "#2a0a14" },
};

export type Visual = {
  palette: keyof typeof PALETTES;
  bottle: string; // file under /media/bottles/
  cluster: string; // file under /media/decor/
  fruit: string; // file under /media/decor/
};

export const VISUALS: Record<string, Visual> = {
  sunrise: { palette: "orange", bottle: "bottle-sunrise.png", cluster: "cluster-citrus.png", fruit: "fruit-orange-slice.png" },
  "crimson-garden": { palette: "beet", bottle: "bottle-beet.png", cluster: "cluster-root.png", fruit: "fruit-beet-root.png" },
  "crimson-elixir": { palette: "ruby", bottle: "bottle-ruby.png", cluster: "cluster-watermelon.png", fruit: "fruit-watermelon-slice.png" },
  "crimson-cooler": { palette: "watermelon", bottle: "bottle-watermelon.png", cluster: "cluster-watermelon.png", fruit: "fruit-watermelon-slice.png" },
  "ginger-spark": { palette: "coral", bottle: "bottle-coral.png", cluster: "cluster-tropical.png", fruit: "fruit-ginger.png" },
  orange: { palette: "orange", bottle: "bottle-sunrise.png", cluster: "cluster-citrus.png", fruit: "fruit-orange-slice.png" },
  pineapple: { palette: "yellow", bottle: "bottle-yellow.png", cluster: "cluster-tropical.png", fruit: "fruit-pineapple.png" },
  pinecado: { palette: "avocado", bottle: "bottle-avocado.png", cluster: "cluster-green.png", fruit: "fruit-creamy.png" },
  guyabano: { palette: "blush", bottle: "bottle-cream-pink.png", cluster: "cluster-berry.png", fruit: "fruit-berry-mix.png" },
  "vitamin-vibe": { palette: "golden", bottle: "bottle-golden.png", cluster: "cluster-root.png", fruit: "fruit-ginger.png" },
  "ginger-mint-splash": { palette: "mint", bottle: "bottle-mint.png", cluster: "cluster-green.png", fruit: "fruit-kiwi.png" },
  "zesty-sunrise": { palette: "yellow", bottle: "bottle-yellow.png", cluster: "cluster-citrus.png", fruit: "fruit-orange-slice.png" },
  "veggie-burst": { palette: "beet", bottle: "bottle-beet.png", cluster: "cluster-green.png", fruit: "fruit-beet-root.png" },
  "lemon-sip": { palette: "yellow", bottle: "bottle-yellow.png", cluster: "cluster-green.png", fruit: "fruit-ginger.png" },
  "sweet-pepper-splash": { palette: "coral", bottle: "bottle-coral.png", cluster: "cluster-watermelon.png", fruit: "fruit-watermelon-slice.png" },
  melongrape: { palette: "watermelon", bottle: "bottle-watermelon.png", cluster: "cluster-watermelon.png", fruit: "fruit-watermelon-slice.png" },
  "creamy-paradise": { palette: "pink", bottle: "bottle-cream-pink.png", cluster: "cluster-berry.png", fruit: "fruit-creamy.png" },
  "nourish-blend": { palette: "ruby", bottle: "bottle-ruby.png", cluster: "cluster-root.png", fruit: "fruit-mango.png" },
  "tropical-mango": { palette: "yellow", bottle: "bottle-yellow.png", cluster: "cluster-tropical.png", fruit: "fruit-mango.png" },
  "pure-green": { palette: "green", bottle: "bottle-green.png", cluster: "cluster-green.png", fruit: "fruit-kiwi.png" },
};

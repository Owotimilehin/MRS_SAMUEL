export type Category = "regular" | "special" | "punch";

export interface MenuItem {
  id: number;
  name: string;
  category: Category;
  ingredients: string[];
  priceNgn: number;
}

export const BRAND = {
  name: "Mrs. Samuel Fruit Juice",
  tagline: "100% Natural · Good Health in a Bottle",
  handle: "@mrs_samuelfruitjuice",
  phone: "0706 722 0914",
  whatsapp: "2347067220914",
  address: "30 Asa Afariogun Street, Ajao Estate, Lagos",
};

/** All flavours ship in two sizes at uniform pricing (2026-05-17). */
export const SIZES = [330, 650] as const;
export type Size = (typeof SIZES)[number];

export const PRICE_BY_SIZE: Record<Size, number> = {
  330: 2500,
  650: 3500,
};

/** Default-display price (used by `item.priceNgn` callers; equals 650ml price). */
const PRICING: Record<Category, number> = {
  regular: PRICE_BY_SIZE[650],
  special: PRICE_BY_SIZE[650],
  punch:   PRICE_BY_SIZE[650],
};

/** Price for any flavour at the given size. Prices are uniform across category. */
export function priceFor(_item: MenuItem, size: Size): number {
  return PRICE_BY_SIZE[size];
}

const RAW = [
  { id:  1, name: "Sunrise Blend",            category: "regular" as const, ingredients: ["Carrot", "Pawpaw", "Orange", "Pineapple"] },
  { id:  2, name: "Crimson Garden Glow",      category: "regular" as const, ingredients: ["Apple", "Beetroot", "Celery", "Carrot", "Pineapple"] },
  { id:  3, name: "Tropical Swirl",           category: "regular" as const, ingredients: ["Pineapple", "Banana"] },
  { id:  4, name: "Crimson Elixir",           category: "regular" as const, ingredients: ["Beetroot", "Pineapple", "Watermelon"] },
  { id:  5, name: "Immune Booster",           category: "regular" as const, ingredients: ["Pineapple", "Turmeric", "Ginger", "Lemon"] },
  { id:  6, name: "Ultimate Detox",           category: "regular" as const, ingredients: ["Cucumber", "Apple", "Pineapple", "Ginger"] },
  { id:  7, name: "Crimson Cooler",           category: "regular" as const, ingredients: ["Watermelon", "Beetroot", "Carrot"] },
  { id:  8, name: "Ginger Spark",             category: "regular" as const, ingredients: ["Watermelon", "Pineapple", "Ginger"] },
  { id:  9, name: "Ginger Fireball",          category: "regular" as const, ingredients: ["Pineapple", "Ginger"] },
  { id: 10, name: "Orange Juice",             category: "regular" as const, ingredients: ["Orange"] },
  { id: 11, name: "Pineapple Juice",          category: "regular" as const, ingredients: ["Pineapple"] },
  { id: 12, name: "Watermelon Juice",         category: "regular" as const, ingredients: ["Watermelon"] },
  { id: 13, name: "Pinecado Bliss",           category: "regular" as const, ingredients: ["Avocado", "Pineapple"] },
  { id: 14, name: "Blood Booster",            category: "regular" as const, ingredients: ["Mint Leaf", "Celery", "Pineapple", "Ginger"] },
  { id: 15, name: "Pink Paradise",            category: "special" as const, ingredients: ["Strawberry", "Pineapple"] },
  { id: 16, name: "Guyabano Delight",         category: "special" as const, ingredients: ["Strawberry", "Soursop", "Pineapple"] },
  { id: 17, name: "Mrs. Samuel Fruit Punch",  category: "punch"   as const, ingredients: ["House blend"] },
];

export const MENU: MenuItem[] = RAW.map((m) => ({ ...m, priceNgn: PRICING[m.category] }));

/** Find a MENU item by its numeric id (URL param is a string, hence the parse). */
export function findMenuItemById(id: string | number): MenuItem | undefined {
  const n = typeof id === "number" ? id : Number.parseInt(id, 10);
  if (!Number.isFinite(n)) return undefined;
  return MENU.find((m) => m.id === n);
}

/** Returns the path to the per-flavour chilled-can PNG, generated 2026-05-17
 * via Nano Banana (`docs/ui-mockups/assets/generate-flavours.mjs`). */
export function bottleFor(item: MenuItem): string {
  const slug = item.name
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `/assets/bottles/${slug}-tight.png`;
}

/** Fruits we have photographic cutouts for + nutrition tooltip data. */
export const FRUITS = [
  "pineapple", "orange", "carrot", "watermelon", "ginger",
  "beetroot", "strawberry", "lemon", "mint", "apple",
  "pawpaw", "avocado", "banana", "cucumber", "turmeric", "celery", "soursop",
] as const;
export type Fruit = (typeof FRUITS)[number];

/** Maps a juice ingredient string (as it appears in MENU) to a fruit cutout we have. */
export function ingredientToFruit(ingredient: string): Fruit | null {
  const key = ingredient.trim().toLowerCase();
  const direct: Record<string, Fruit> = {
    pineapple: "pineapple",
    orange: "orange",
    carrot: "carrot",
    watermelon: "watermelon",
    ginger: "ginger",
    beetroot: "beetroot",
    strawberry: "strawberry",
    lemon: "lemon",
    mint: "mint",
    "mint leaf": "mint",
    apple: "apple",
    pawpaw: "pawpaw",
    papaya: "pawpaw",
    avocado: "avocado",
    banana: "banana",
    cucumber: "cucumber",
    turmeric: "turmeric",
    tumeric: "turmeric",
    celery: "celery",
    soursop: "soursop",
  };
  return direct[key] ?? null;
}

export const FRUIT_NUTRITION: Record<Fruit, { name: string; benefits: string[] }> = {
  pineapple:  { name: "Pineapple",  benefits: ["Bromelain · digestion", "Vitamin C", "Manganese"] },
  orange:     { name: "Orange",     benefits: ["Vitamin C", "Folate", "Hydrating"] },
  carrot:     { name: "Carrot",     benefits: ["Beta-carotene", "Eye health", "Fiber"] },
  watermelon: { name: "Watermelon", benefits: ["92% water", "Lycopene", "Electrolytes"] },
  ginger:     { name: "Ginger",     benefits: ["Anti-inflammatory", "Soothes nausea", "Warming"] },
  beetroot:   { name: "Beetroot",   benefits: ["Nitrates · blood flow", "Iron", "Stamina"] },
  strawberry: { name: "Strawberry", benefits: ["Vitamin C", "Antioxidants", "Low glycemic"] },
  lemon:      { name: "Lemon",      benefits: ["Vitamin C", "Alkalizing", "Digestion"] },
  mint:       { name: "Mint",       benefits: ["Soothes stomach", "Fresh breath", "Cooling"] },
  apple:      { name: "Apple",      benefits: ["Quercetin", "Fiber", "Heart health"] },
  pawpaw:     { name: "Pawpaw",     benefits: ["Papain · digestion", "Vitamin A", "Hydrating"] },
  avocado:    { name: "Avocado",    benefits: ["Healthy fats", "Potassium", "Vitamin E"] },
  banana:     { name: "Banana",     benefits: ["Potassium", "Quick energy", "B6"] },
  cucumber:   { name: "Cucumber",   benefits: ["96% water", "Vitamin K", "Cooling"] },
  turmeric:   { name: "Turmeric",   benefits: ["Curcumin", "Anti-inflammatory", "Antioxidant"] },
  celery:     { name: "Celery",     benefits: ["Hydrating", "Vitamin K", "Low calorie"] },
  soursop:    { name: "Soursop",    benefits: ["Vitamin C", "Antioxidants", "Tropical"] },
};

/** Fixed positions around the hero stage (percent of hero box). Used by the
 * static landing layout; the carousel uses SLOTS in routes/menu.tsx instead. */
export const FRUIT_POSITIONS: Record<Fruit, { top: string; left: string; size: string }> = {
  pineapple:  { top: "4%",  left: "8%",  size: "20%" },
  orange:     { top: "12%", left: "78%", size: "14%" },
  watermelon: { top: "38%", left: "-2%", size: "18%" },
  carrot:     { top: "62%", left: "82%", size: "13%" },
  strawberry: { top: "78%", left: "10%", size: "12%" },
  ginger:     { top: "24%", left: "50%", size: "11%" },
  beetroot:   { top: "76%", left: "70%", size: "13%" },
  lemon:      { top: "8%",  left: "40%", size: "11%" },
  mint:       { top: "48%", left: "88%", size: "10%" },
  apple:      { top: "54%", left: "22%", size: "12%" },
  pawpaw:     { top: "20%", left: "10%", size: "16%" },
  avocado:    { top: "60%", left: "30%", size: "14%" },
  banana:     { top: "30%", left: "70%", size: "14%" },
  cucumber:   { top: "44%", left: "12%", size: "13%" },
  turmeric:   { top: "70%", left: "55%", size: "11%" },
  celery:     { top: "18%", left: "62%", size: "14%" },
  soursop:    { top: "50%", left: "78%", size: "16%" },
};

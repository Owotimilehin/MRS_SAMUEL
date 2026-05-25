import { createDbClient } from "./client.js";
import {
  adminUser,
  factory,
  branch,
  blogPost,
  product,
  productPrice,
  productVariant,
} from "./schema/index.js";
import argon2 from "argon2";
import { eq, and, isNull } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDbClient(url);

const ownerEmail = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? "ChangeMe!Owner-1234";

async function seedOwner(): Promise<void> {
  const existing = await db.select().from(adminUser).where(eq(adminUser.email, ownerEmail));
  if (existing.length > 0) {
    console.warn("owner already exists, skipping");
    return;
  }
  const hash = await argon2.hash(ownerPassword);
  await db.insert(adminUser).values({ email: ownerEmail, passwordHash: hash, role: "owner" });
  console.warn("owner seeded:", ownerEmail);
  console.warn("temporary password:", ownerPassword);
}

async function seedFactory(): Promise<void> {
  const existing = await db.select().from(factory);
  if (existing.length > 0) {
    console.warn("factory already exists, skipping");
    return;
  }
  await db.insert(factory).values({ name: "Mrs. Samuel Factory" });
  console.warn("factory seeded");
}

async function seedBranch(): Promise<void> {
  const existing = await db.select().from(branch).where(eq(branch.code, "AJAO"));
  if (existing.length > 0) {
    console.warn("branch AJAO already exists, skipping");
    return;
  }
  await db.insert(branch).values({
    name: "Ajao Estate",
    code: "AJAO",
    address: "30 Asa Afariogun Street, Ajao Estate, Ikeja, Lagos",
    phone: "0706 722 0914",
    deliveryZones: [
      { name: "Ajao Estate area", fee_ngn: 1500 },
    ],
    opensAt: "08:00:00",
    closesAt: "20:00:00",
  });
  console.warn("branch Ajao Estate seeded");
}

interface MenuFile {
  pricing: {
    regular_330ml: number;
    regular_650ml: number;
    specials: number;
    fruit_punch: number;
  };
  items: Array<{
    id: number;
    name: string;
    category: "regular" | "special" | "punch";
    ingredients: string[];
  }>;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Price for a flavour at a given can size. Specials and punch don't have
 *  documented size-tiered prices in menu.json, so they fall back to the
 *  documented flat price for any size. */
function priceForSize(
  category: "regular" | "special" | "punch",
  sizeMl: number,
  menu: MenuFile,
): number {
  if (category === "special") return menu.pricing.specials;
  if (category === "punch") return menu.pricing.fruit_punch;
  return sizeMl >= 650 ? menu.pricing.regular_650ml : menu.pricing.regular_330ml;
}

async function seedProducts(): Promise<void> {
  // menu.json lives in the project root: ../../../menu.json relative to this file's
  // tsx execution cwd (packages/db). We resolve from cwd so seed can be invoked
  // either via pnpm filter or directly with tsx.
  const candidates = [
    resolve(process.cwd(), "../../menu.json"),     // when invoked from packages/db
    resolve(process.cwd(), "../../../menu.json"),  // when invoked from repo root
    resolve(process.cwd(), "menu.json"),
  ];
  let menuPath: string | undefined;
  for (const p of candidates) {
    try {
      readFileSync(p, "utf8");
      menuPath = p;
      break;
    } catch {
      /* try next */
    }
  }
  if (!menuPath) {
    console.warn("menu.json not found, skipping product seed. Checked:", candidates.join(", "));
    return;
  }
  const menu = JSON.parse(readFileSync(menuPath, "utf8")) as MenuFile;
  console.warn("seeding products from", menuPath);

  let createdProducts = 0;
  let createdVariants = 0;
  let createdPrices = 0;
  for (const item of menu.items) {
    const slug = slugify(item.name);
    let [row] = await db.select().from(product).where(eq(product.slug, slug));
    if (!row) {
      const inserted = await db
        .insert(product)
        .values({
          name: item.name,
          slug,
          category: item.category,
          ingredients: item.ingredients,
          sizeMl: 330,
          displayOrder: item.id,
        })
        .returning();
      row = inserted[0];
      if (!row) continue;
      createdProducts++;
    }

    // One variant per documented can size, idempotent on (product_id, size_ml).
    // Each variant carries its own current price row in product_price.
    for (const sizeMl of [330, 650] as const) {
      let [variant] = await db
        .select()
        .from(productVariant)
        .where(and(eq(productVariant.productId, row.id), eq(productVariant.sizeMl, sizeMl)));
      if (!variant) {
        const inserted = await db
          .insert(productVariant)
          .values({
            productId: row.id,
            sizeMl,
            sku: `${slug}-${sizeMl}ml`,
          })
          .returning();
        variant = inserted[0];
        if (!variant) continue;
        createdVariants++;
      }
      // Skip if this variant already has an open-ended price.
      const existingPrice = await db
        .select()
        .from(productPrice)
        .where(and(eq(productPrice.variantId, variant.id), isNull(productPrice.validTo)))
        .limit(1);
      if (existingPrice.length > 0) continue;
      await db.insert(productPrice).values({
        productId: row.id,
        variantId: variant.id,
        priceNgn: priceForSize(item.category, sizeMl, menu),
      });
      createdPrices++;
    }
  }
  console.warn(
    `products seeded: ${createdProducts} new (${menu.items.length} total); variants seeded: ${createdVariants}; prices seeded: ${createdPrices}`,
  );
}

interface BlogSeed {
  slug: string;
  title: string;
  excerpt: string;
  bodyMd: string;
  coverUrl: string | null;
}

const BLOG_POSTS: BlogSeed[] = [
  {
    slug: "why-cold-pressed",
    title: "Why cold-pressed beats centrifugal every time",
    excerpt:
      "Heat kills nutrients. Our hydraulic press crushes fruit slowly so the juice that lands in the bottle is the same juice that was in the fruit ten minutes earlier.",
    coverUrl: "/assets/blog/cold-pressed.jpg",
    bodyMd: `# Why cold-pressed beats centrifugal every time

When you cut a pineapple and bite into it, you're tasting roughly 100% of what the fruit has to offer — natural enzymes, vitamins, and that bright tropical sweetness. The moment you process it, you start losing things. The question is how much.

## The two ways to make juice

**Centrifugal juicers** — the kind in most cafés — spin a metal blade at 6,000+ RPM against a mesh basket. Friction creates heat. Heat oxidises. Within ten minutes the colour starts shifting and the vitamin C count drops by up to 40%.

**Cold-press juicers** — what we use — work like a slow hydraulic press. The fruit is crushed at low speed, then squeezed through a fine cloth. No blades. No heat. No oxidation.

## What this means for you

- **More vitamin C, A, and folate** — heat-sensitive nutrients survive intact
- **Brighter colour** — the difference is visible the moment you open a bottle
- **Cleaner taste** — no metallic notes, no froth, no separation
- **Longer shelf life** without preservatives — 48 hours in the fridge vs 24 hours for centrifugal juice

## The 48-hour rule

Even cold-pressed juice doesn't last forever. Every bottle we make has the press date on the label and a 48-hour window. Past that, the natural enzymes start breaking down the sugars and the taste shifts. So we make small batches every morning instead of one big batch on Monday.

If you ever get a bottle from us that tastes "off" or fizzy, it's past its window — bring it back, we'll replace it free.`,
  },
  {
    slug: "what-actually-goes-into-detox",
    title: "What actually goes into our Ultimate Detox",
    excerpt:
      "Cucumber, apple, pineapple, and ginger — in that order. Here's why each one matters and why we kept this recipe so simple.",
    coverUrl: "/assets/blog/ultimate-detox.jpg",
    bodyMd: `# What actually goes into our Ultimate Detox

\"Detox juice\" usually means something with more marketing than ingredients. Ours has four:

1. **Cucumber** — 96% water, electrolyte-rich, and the reason the bottle goes down so easy
2. **Apple** — sweetens the cucumber without sugar, adds quercetin and soluble fibre
3. **Pineapple** — bromelain (the enzyme that breaks down protein), vitamin C, and that signature tropical lift
4. **Ginger** — a small fingertip's worth per bottle; anti-inflammatory and warming

## Why no kale, spirulina, or charcoal?

Because Ultimate Detox should be something you actually want to drink. Charcoal black juice photographs beautifully and tastes like wet ash. Spirulina has a real fishy aftertaste at any meaningful dose. Kale needs a lot of sweetener to be palatable, and at that point you've cancelled most of the green-juice benefit.

Our position: a juice that's pleasant to drink twice a week beats a juice that's punishing to drink once.

## When to drink it

- First thing in the morning, before coffee
- Mid-afternoon if you skipped lunch
- Replace one snack a day for a week — that's the experiment we'd suggest

## The honest part

A juice is not a detox. Your liver and kidneys do that, 24/7, for free. What good juice does is **make it easier to eat more produce than you otherwise would.** That's it. That's the whole pitch.`,
  },
  {
    slug: "lagos-traffic-and-48-hour-shelf-life",
    title: "Why we deliver same-day in Lagos (and why it matters)",
    excerpt:
      "Cold-pressed juice has a 48-hour shelf life. Lagos traffic eats an hour minimum. Here's how we keep the maths working.",
    coverUrl: "/assets/blog/lagos-delivery.jpg",
    bodyMd: `# Why we deliver same-day in Lagos (and why it matters)

A bottle of cold-pressed juice has roughly 48 hours of useful life from the moment we press it. If a courier holds it for 24 of those, you're getting half a bottle.

## How we structure the day

- **5:30am** — fruit arrives from Mile 12 market
- **6:30am** — first press starts
- **8:00am** — orders for the day open
- **9:00am–7:00pm** — Bolt riders pick up in 15-minute windows

The bottle that lands at your door at 2pm was pressed before sunrise the same day. That's the whole reason we limit delivery to Lagos for now.

## What we don't do

- **Pre-press the day before** — by the time you'd open the bottle, you'd have 12 hours of juice left
- **Use long-life packaging** — that requires pasteurisation (heat) which is exactly what cold-pressing was supposed to avoid
- **Centralise into one warehouse** — every extra hop is an hour off the clock

## What this costs you

Delivery is between ₦1,500 and ₦3,500 depending on zone. We're not making money on that line — it covers Bolt + the rider's time. We'd rather charge the real cost than fake "free delivery" and bake it into the bottle price.

## What's next

Once we have the routing dialled in for Lagos, we'll look at Abuja. Other cities sooner if there's enough demand on the WhatsApp line to justify a second press kitchen.`,
  },
  {
    slug: "fruit-sourcing",
    title: "Where our fruit comes from",
    excerpt:
      "Mile 12, Mushin, and a small farm in Ogun for the strawberries. We name names because the supply chain matters.",
    coverUrl: "/assets/blog/sourcing.jpg",
    bodyMd: `# Where our fruit comes from

Most juice brands are vague about sourcing on purpose. We're going to be specific because if you're paying for premium juice, you should know what you're getting.

## The bulk of the menu — Mile 12 Market

Pineapples, oranges, watermelons, carrots, ginger, cucumbers, apples — all of it comes from Mile 12 in Ketu. We have three traders we've worked with for over two years; one of them (Mama Bisi) holds back the best pineapples for us if we call by 6am.

Mile 12 is messy and loud and we love it. The fruit moves fast which is exactly what you want — nothing sitting on a pallet for a week.

## The specials — Ogun State

Strawberries don't grow well in Lagos heat. The ones in Pink Paradise and Guyabano Delight come from a small farm in Sagamu, picked Tuesday and Friday mornings. That's why specials sell out faster — we only get them twice a week.

## The leafy stuff — Mushin

Mint, celery, and cucumber for Blood Booster and Ultimate Detox come from a vegetable garden in Mushin we've been using since 2024. Smaller volumes but the freshness shows in the bottle.

## What we don't import

- No imported apples from South Africa — local apples have less starch and juice better anyway
- No imported berries except strawberries (and we'd rather skip a special than ship from Europe)
- No frozen concentrate ever — if you can't taste the difference, you haven't had real juice

## Want to come see?

We host kitchen visits on the last Saturday of the month. WhatsApp us if you want a slot. Bring a friend, leave with a bottle.`,
  },
  {
    slug: "the-punch-recipe",
    title: "Behind Mrs. Samuel Fruit Punch (the one everyone asks about)",
    excerpt:
      "Our most popular bottle is also the one we're most cagey about. Here's as much as we'll share.",
    coverUrl: "/assets/blog/punch.jpg",
    bodyMd: `# Behind Mrs. Samuel Fruit Punch (the one everyone asks about)

Every week someone messages us asking for the recipe. We'll tell you most of it.

## What's in it

- Pineapple (the base, about 40%)
- Watermelon (for body, about 25%)
- A small amount of carrot (for colour and sweetness)
- Orange (for the citrus lift)
- Beetroot (for that deep crimson)
- A house seasoning we're not telling you about

That last bullet is the one that took us six months to land on, and it's why "Mrs. Samuel Fruit Punch" is on the bottle. It's not chilli, not vinegar, not anything weird — but it's the difference between "fruit cocktail" and "fruit punch."

## Why this combination

The trick with a punch is that no single fruit should dominate. Pineapple by itself is too sharp. Watermelon is too soft. Carrot is too earthy. Orange is too one-note. **Each one cancels a weakness of another.** When the proportions are right, you stop tasting individual fruits and start tasting "punch."

## The colour

People assume it's beetroot doing the work. Beetroot is in there, but the deep red comes more from watermelon + the sugars caramelising slightly during the press. (Cold-press is "cold" but not refrigerated; there's still some warmth from the fruit itself.)

## How to drink it

Cold, in a tall glass, no ice. Ice dilutes it within a minute and the punch loses its punch.

If you want to make a cocktail with it: half punch, half tonic, a squeeze of lime. We're not going to lie — it works.

## Want the seasoning?

Buy 100 bottles in one order and we'll throw in a small jar.`,
  },
];

async function seedBlogPosts(): Promise<void> {
  const [ownerRow] = await db
    .select()
    .from(adminUser)
    .where(eq(adminUser.email, ownerEmail))
    .limit(1);
  const authorId = ownerRow?.id ?? null;
  const now = new Date();
  let created = 0;
  let updated = 0;
  for (let i = 0; i < BLOG_POSTS.length; i++) {
    const post = BLOG_POSTS[i];
    if (!post) continue;
    const existing = await db
      .select()
      .from(blogPost)
      .where(eq(blogPost.slug, post.slug))
      .limit(1);
    // Stagger publishedAt across the last 5 weeks so listing pages render in order.
    const publishedAt = new Date(now.getTime() - i * 7 * 86_400_000);
    if (existing.length === 0) {
      await db.insert(blogPost).values({
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        bodyMd: post.bodyMd,
        coverUrl: post.coverUrl,
        authorUserId: authorId,
        publishedAt,
      });
      created++;
    } else {
      updated++;
    }
  }
  console.warn(
    `blog posts seeded: ${created} new, ${updated} already present (${BLOG_POSTS.length} total)`,
  );
}

async function main(): Promise<void> {
  await seedOwner();
  await seedFactory();
  await seedBranch();
  await seedProducts();
  await seedBlogPosts();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

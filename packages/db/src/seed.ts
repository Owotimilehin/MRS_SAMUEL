import { createDbClient } from "./client.js";
import {
  adminUser,
  factory,
  branch,
  blogPost,
  product,
  productPrice,
  productVariant,
  mediaAsset,
} from "./schema/index.js";
import argon2 from "argon2";
import { eq, and, isNull } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { PALETTES, VISUALS } from "./seed-data/visuals.js";

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

interface CatalogProduct {
  slug: string;
  name: string;
  category: "regular" | "special" | "punch";
  tagline?: string;
  ingredients: string[];
  ingredient_details?: { name: string; benefit: string }[];
  benefits?: string[];
  story?: string;
  pairing?: string;
  best_for?: string[];
  note?: string;
  variants: { size_ml: number; price_ngn: number }[];
}
interface CatalogFile {
  products: CatalogProduct[];
}

/** Find-or-create a media_asset by its url (idempotent across reseeds). */
async function ensureMediaAsset(
  kind: "bottle" | "cluster" | "fruit",
  name: string,
  url: string,
): Promise<{ id: string; created: boolean }> {
  const [existing] = await db.select().from(mediaAsset).where(eq(mediaAsset.url, url)).limit(1);
  if (existing) return { id: existing.id, created: false };
  const [row] = await db.insert(mediaAsset).values({ kind, name, url }).returning();
  return { id: row!.id, created: true };
}

async function seedProducts(): Promise<void> {
  // The canonical storefront catalog (20 flavours with marketing content +
  // variant prices). Shipped inside the package so the migrator image has it.
  const catalog = JSON.parse(
    readFileSync(new URL("./seed-data/catalog.json", import.meta.url), "utf8"),
  ) as CatalogFile;
  console.warn(`seeding ${catalog.products.length} products from storefront catalog`);

  let createdProducts = 0;
  let createdVariants = 0;
  let createdPrices = 0;
  let createdAssets = 0;

  for (let i = 0; i < catalog.products.length; i++) {
    const item = catalog.products[i]!;
    const vis = VISUALS[item.slug];
    const palette = vis ? PALETTES[vis.palette] : null;

    // Media library — bottle + decoration assets, shared across flavours and
    // referenced by id. URLs are served by the customer app from /media/.
    let bottleId: string | null = null;
    let clusterId: string | null = null;
    let fruitId: string | null = null;
    let bottleUrl: string | null = null;
    if (vis) {
      bottleUrl = `/media/bottles/${vis.bottle}`;
      const b = await ensureMediaAsset("bottle", item.name, bottleUrl);
      const c = await ensureMediaAsset("cluster", `${item.slug} cluster`, `/media/decor/${vis.cluster}`);
      const f = await ensureMediaAsset("fruit", `${item.slug} fruit`, `/media/decor/${vis.fruit}`);
      bottleId = b.id;
      clusterId = c.id;
      fruitId = f.id;
      createdAssets += [b, c, f].filter((x) => x.created).length;
    }

    const values = {
      name: item.name,
      slug: item.slug,
      category: item.category,
      ingredients: item.ingredients,
      sizeMl: Math.min(...item.variants.map((v) => v.size_ml)),
      displayOrder: i,
      imageUrl: bottleUrl,
      tagline: item.tagline ?? null,
      story: item.story ?? null,
      pairing: item.pairing ?? null,
      note: item.note ?? null,
      benefits: item.benefits ?? [],
      bestFor: item.best_for ?? [],
      ingredientDetails: item.ingredient_details ?? [],
      palette,
      bottleAssetId: bottleId,
      clusterAssetId: clusterId,
      fruitAssetId: fruitId,
    };

    let [row] = await db.select().from(product).where(eq(product.slug, item.slug));
    if (!row) {
      const inserted = await db.insert(product).values(values).returning();
      row = inserted[0];
      if (!row) continue;
      createdProducts++;
    } else {
      await db
        .update(product)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(product.id, row.id));
    }

    // One variant + open-ended price per catalog size, idempotent on (product, size_ml).
    for (const variant of item.variants) {
      const sizeMl = variant.size_ml;
      let [v] = await db
        .select()
        .from(productVariant)
        .where(and(eq(productVariant.productId, row.id), eq(productVariant.sizeMl, sizeMl)));
      if (!v) {
        const inserted = await db
          .insert(productVariant)
          .values({ productId: row.id, sizeMl, sku: `${item.slug}-${sizeMl}ml` })
          .returning();
        v = inserted[0];
        if (!v) continue;
        createdVariants++;
      }
      const existingPrice = await db
        .select()
        .from(productPrice)
        .where(and(eq(productPrice.variantId, v.id), isNull(productPrice.validTo)))
        .limit(1);
      if (existingPrice.length > 0) continue;
      await db.insert(productPrice).values({
        productId: row.id,
        variantId: v.id,
        priceNgn: variant.price_ngn,
      });
      createdPrices++;
    }
  }
  console.warn(
    `products seeded: ${createdProducts} new (${catalog.products.length} total); variants: ${createdVariants}; prices: ${createdPrices}; media assets: ${createdAssets}`,
  );
}

interface BlogSeed {
  slug: string;
  title: string;
  excerpt: string;
  bodyMd: string;
  coverUrl: string | null;
  author: string;
  readMins: number;
  category: string;
  cluster: string;
}

const BLOG_POSTS: BlogSeed[] = [
  {
    slug: "forty-thousand-bottles-later",
    author: "Mrs. Samuel",
    readMins: 4,
    category: "Story",
    cluster: "tropical",
    title: "Forty thousand bottles later: what's next for Mrs. Samuel",
    excerpt:
      "Last year September, all we had was belief and a cold-press. Today we've sold over 40,000 bottles — and we're bringing in machines that can do 5,000 a day.",
    coverUrl: null,
    bodyMd: `# Forty thousand bottles later: what's next for Mrs. Samuel

Last year September, we started this journey with a simple vision: to create fresh juice people could truly trust. Real fruits. Real quality. Real care.

At the time, all we had was our belief, our passion, and the willingness to work every single day to build something meaningful. There were long nights, early mornings, and a lot of moments where we had to choose faith over fear.

## One order became many

Slowly, people began to believe in what we were building. One order became many orders — and somewhere along the way, without either of us quite noticing the exact bottle it happened on, we crossed **forty thousand bottles sold**.

Forty thousand moments shared in homes, offices, events, gyms, and everyday lives. For us, this is bigger than juice. It's proof that something built with consistency and honesty can grow.

## The biggest step yet

And now, we're getting ready for our biggest step yet. In the coming weeks, we'll be bringing in new production machines designed to produce **up to five thousand bottles daily**.

That means:

- **More growth** — more flavours, more batches, fewer "sold out" messages on WhatsApp
- **More opportunities** — for the people who work with us, and the traders who supply our fruit
- **More freshness for every Nigerian** — because the goal was never to stay small, it was to do this properly at a size that matters

## Still the same kitchen values

Bigger machines don't change what goes in the bottle. Same fruit from the same markets, same hand-checked batches, same 48-hour promise. We're scaling the *how*, not changing the *what*.

What started as a dream between two people is becoming something much bigger than us. And honestly — this is only the beginning.

We want you to be part of this from the very start. [Visit the menu](/) and place your order today, because something big is coming, and we're just getting started.

**Fresh. Real. Made with purpose.**`,
  },
  {
    slug: "more-than-juice-fighting-fruit-waste",
    author: "Mr. Samuel",
    readMins: 6,
    category: "Story",
    cluster: "tropical",
    title: "Why we're building more than a juice company",
    excerpt:
      "Nigeria loses up to half its fresh produce after harvest. Here's why we think a juice bottle is one small way to fix that — and how farmers fit into our next phase.",
    coverUrl: null,
    bodyMd: `# Why we're building more than a juice company

Every year in Nigeria, thousands of tons of fruit are wasted. Mangoes. Oranges. Pineapples. Watermelons. Fruits grown with real, hard work — left to spoil before they ever reach the people who'd happily pay for them.

Studies estimate Nigeria loses somewhere between **30 and 50 percent of fresh produce** after harvest, mostly down to poor storage, difficult transportation, and limited local processing capacity. For a lot of farmers, that turns a season of work into a loss instead of a profit. Waste instead of opportunity.

## We think something different is possible

We believe every fruit that's harvested should become value — for the farmer who grew it, and for the person who eventually drinks it. That belief is the actual reason we started a juice company. Not just to make juice, but to become part of the solution to a problem that's bigger than any one bottle.

Because when fruit gets processed close to where it's grown:

- **Farmers earn more** — there's a buyer for produce that would otherwise sit and spoil
- **Waste goes down** — fruit moves from farm to press in days, not weeks
- **Jobs get created** — pressing, bottling, packing, and delivering all need people
- **The local economy gets a little stronger** — money stays closer to where the fruit came from

## What this looks like for us right now

We already buy in bulk from traders at Mile 12 and a small farm in Ogun State (we wrote about [where our fruit comes from](/blog/fruit-sourcing) a while back). The new production machines we're bringing in — built to handle up to five thousand bottles a day — aren't just about serving more customers faster. They're about being able to take on a lot more fruit, which means creating real, steady demand for what local growers already produce.

## An open invitation

This is bigger than business to us. It's about building something that actually holds up for farmers, distributors, workers, and families across Nigeria — not just for one season, but for the long run.

So to every fruit farmer, and every farm cooperative reading this: we'd genuinely like to talk. Message us on WhatsApp, tell us what you grow and where, and let's see what we can build together.

Let's reduce waste together. Let's create value together. Because the future of fruit processing in Nigeria is just beginning — and we'd rather build it with people than around them.`,
  },
  {
    slug: "why-cold-pressed",
    author: "Mrs. Samuel",
    readMins: 4,
    category: "Wellness",
    cluster: "citrus",
    title: "Why cold-pressed beats centrifugal every time",
    excerpt:
      "Heat kills nutrients. Our hydraulic press crushes fruit slowly so the juice that lands in the bottle is the same juice that was in the fruit ten minutes earlier.",
    coverUrl: null,
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
    author: "Mrs. Samuel",
    readMins: 5,
    category: "Wellness",
    cluster: "green",
    title: "What actually goes into our Ultimate Detox",
    excerpt:
      "Cucumber, apple, pineapple, and ginger — in that order. Here's why each one matters and why we kept this recipe so simple.",
    coverUrl: null,
    bodyMd: `# What actually goes into our Ultimate Detox

"Detox juice" usually means something with more marketing than ingredients. Ours has four:

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
    author: "Mr. Samuel",
    readMins: 4,
    category: "Behind the Scenes",
    cluster: "watermelon",
    title: "Why we deliver same-day in Lagos (and why it matters)",
    excerpt:
      "Cold-pressed juice has a 48-hour shelf life. Lagos traffic eats an hour minimum. Here's how we keep the maths working.",
    coverUrl: null,
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
    author: "Mr. Samuel",
    readMins: 6,
    category: "Behind the Scenes",
    cluster: "root",
    title: "Where our fruit comes from",
    excerpt:
      "Mile 12, Mushin, and a small farm in Ogun for the strawberries. We name names because the supply chain matters.",
    coverUrl: null,
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
    author: "Mrs. Samuel",
    readMins: 5,
    category: "Recipes",
    cluster: "berry",
    title: "Behind Mrs. Samuel Fruit Punch (the one everyone asks about)",
    excerpt:
      "Our most popular bottle is also the one we're most cagey about. Here's as much as we'll share.",
    coverUrl: null,
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
        author: post.author,
        readMins: post.readMins,
        category: post.category,
        cluster: post.cluster,
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

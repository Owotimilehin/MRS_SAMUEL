import { createDbClient } from "./client.js";
import { adminUser, factory, branch, product, productPrice } from "./schema/index.js";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
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

function priceFor(category: "regular" | "special" | "punch", menu: MenuFile): number {
  switch (category) {
    case "regular": return menu.pricing.regular_330ml;
    case "special": return menu.pricing.specials;
    case "punch":   return menu.pricing.fruit_punch;
  }
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

  let created = 0;
  for (const item of menu.items) {
    const slug = slugify(item.name);
    const existing = await db.select().from(product).where(eq(product.slug, slug));
    if (existing.length > 0) continue;
    const [row] = await db
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
    if (!row) continue;
    await db.insert(productPrice).values({
      productId: row.id,
      priceNgn: priceFor(item.category, menu),
    });
    created++;
  }
  console.warn(`products seeded: ${created} new (${menu.items.length} total in menu.json)`);
}

async function main(): Promise<void> {
  await seedOwner();
  await seedFactory();
  await seedBranch();
  await seedProducts();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

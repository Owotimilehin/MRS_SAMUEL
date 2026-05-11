import { createDbClient } from "./client.js";
import { adminUser, factory, branch } from "./schema/index.js";
import argon2 from "argon2";
import { eq } from "drizzle-orm";

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

async function main(): Promise<void> {
  await seedOwner();
  await seedFactory();
  await seedBranch();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

import { createDbClient } from "./client.js";
import { adminUser } from "./schema/index.js";
import argon2 from "argon2";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDbClient(url);

const ownerEmail = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? "ChangeMe!Owner-1234";

async function main() {
  const existing = await db.select().from(adminUser).where(eq(adminUser.email, ownerEmail));
  if (existing.length > 0) {
    console.warn("owner already exists, skipping");
    return;
  }
  const hash = await argon2.hash(ownerPassword);
  await db.insert(adminUser).values({
    email: ownerEmail,
    passwordHash: hash,
    role: "owner",
  });
  console.warn("owner seeded:", ownerEmail);
  console.warn("temporary password:", ownerPassword);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

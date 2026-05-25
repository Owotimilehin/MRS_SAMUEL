import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
  cart,
  cartLine,
  productVariant,
  product,
  productPrice,
  type DbClient,
} from "@ms/db";
import { BusinessError } from "../lib/errors.js";

const COOKIE_NAME = "ms_cart";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, mirrors expires_at

function setCartCookie(c: Context, cartId: string): void {
  setCookie(c, COOKIE_NAME, cartId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

const AddLine = z.object({
  variant_id: z.string().uuid(),
  quantity: z.number().int().positive().default(1),
});

const SetLine = z.object({
  variant_id: z.string().uuid(),
  quantity: z.number().int().nonnegative(),
});

/**
 * Load cart by id, or create a fresh one. Touches expires_at on every call so
 * an active cart never ages out. Returns the cart row alongside the id we
 * should set on the cookie.
 */
async function ensureCart(
  db: DbClient,
  existingId: string | undefined,
): Promise<{ id: string; created: boolean }> {
  if (existingId) {
    const [row] = await db.select().from(cart).where(eq(cart.id, existingId));
    if (row && row.expiresAt > new Date()) {
      await db
        .update(cart)
        .set({
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + COOKIE_MAX_AGE * 1000),
        })
        .where(eq(cart.id, row.id));
      return { id: row.id, created: false };
    }
  }
  const [row] = await db
    .insert(cart)
    .values({ expiresAt: new Date(Date.now() + COOKIE_MAX_AGE * 1000) })
    .returning();
  if (!row) throw new BusinessError("internal_error", "cart create failed", 500);
  return { id: row.id, created: true };
}

interface CartLineOut {
  id: string;
  variant_id: string;
  product_id: string;
  product_name: string;
  size_ml: number;
  unit_price_ngn: number;
  quantity: number;
  line_total_ngn: number;
}

/**
 * Read cart contents joined with current product/variant/price. Variants that
 * are no longer active or have no current price are filtered out so the
 * customer never sees a stale unsellable line.
 */
async function readCart(db: DbClient, cartId: string): Promise<{
  cart_id: string;
  lines: CartLineOut[];
  subtotal_ngn: number;
  total_items: number;
}> {
  const rows = await db
    .select({
      lineId: cartLine.id,
      variantId: cartLine.variantId,
      quantity: cartLine.quantity,
      sizeMl: productVariant.sizeMl,
      productId: product.id,
      productName: product.name,
      priceNgn: productPrice.priceNgn,
    })
    .from(cartLine)
    .innerJoin(productVariant, eq(productVariant.id, cartLine.variantId))
    .innerJoin(product, eq(product.id, productVariant.productId))
    .innerJoin(
      productPrice,
      and(eq(productPrice.variantId, productVariant.id), isNull(productPrice.validTo)),
    )
    .where(
      and(
        eq(cartLine.cartId, cartId),
        isNull(productVariant.deletedAt),
        isNull(product.deletedAt),
        eq(productVariant.isActive, true),
      ),
    )
    .orderBy(desc(cartLine.addedAt));

  const lines: CartLineOut[] = rows.map((r) => ({
    id: r.lineId,
    variant_id: r.variantId,
    product_id: r.productId,
    product_name: r.productName,
    size_ml: r.sizeMl,
    unit_price_ngn: r.priceNgn,
    quantity: r.quantity,
    line_total_ngn: r.priceNgn * r.quantity,
  }));
  const subtotal = lines.reduce((s, l) => s + l.line_total_ngn, 0);
  const totalItems = lines.reduce((s, l) => s + l.quantity, 0);
  return { cart_id: cartId, lines, subtotal_ngn: subtotal, total_items: totalItems };
}

export function publicCartRoutes(db: DbClient) {
  const r = new Hono();

  // GET → current cart (creates an empty one if no cookie / expired).
  r.get("/", async (c) => {
    const existing = getCookie(c, COOKIE_NAME);
    const { id, created } = await ensureCart(db, existing);
    if (created || existing !== id) setCartCookie(c, id);
    return c.json({ data: await readCart(db, id) });
  });

  // POST /lines → add or increment by quantity.
  r.post("/lines", async (c) => {
    const body = AddLine.parse(await c.req.json());
    const existing = getCookie(c, COOKIE_NAME);
    const { id, created } = await ensureCart(db, existing);
    if (created || existing !== id) setCartCookie(c, id);

    const [v] = await db
      .select()
      .from(productVariant)
      .where(and(eq(productVariant.id, body.variant_id), isNull(productVariant.deletedAt)));
    if (!v || !v.isActive) {
      throw new BusinessError("not_found", "variant not found", 404);
    }

    await db
      .insert(cartLine)
      .values({
        cartId: id,
        variantId: body.variant_id,
        quantity: body.quantity,
      })
      .onConflictDoUpdate({
        target: [cartLine.cartId, cartLine.variantId],
        set: { quantity: sql`${cartLine.quantity} + ${body.quantity}` },
      });

    return c.json({ data: await readCart(db, id) });
  });

  // PATCH /lines → set absolute qty. quantity=0 removes the line.
  r.patch("/lines", async (c) => {
    const body = SetLine.parse(await c.req.json());
    const existing = getCookie(c, COOKIE_NAME);
    if (!existing) throw new BusinessError("not_found", "no cart", 404);
    const { id } = await ensureCart(db, existing);
    if (existing !== id) setCartCookie(c, id);

    if (body.quantity === 0) {
      await db
        .delete(cartLine)
        .where(and(eq(cartLine.cartId, id), eq(cartLine.variantId, body.variant_id)));
    } else {
      await db
        .update(cartLine)
        .set({ quantity: body.quantity })
        .where(and(eq(cartLine.cartId, id), eq(cartLine.variantId, body.variant_id)));
    }
    return c.json({ data: await readCart(db, id) });
  });

  // DELETE / → empty the cart (keep the row so the cookie remains valid).
  r.delete("/", async (c) => {
    const existing = getCookie(c, COOKIE_NAME);
    if (!existing) return c.json({ data: { cart_id: null, lines: [], subtotal_ngn: 0, total_items: 0 } });
    const { id } = await ensureCart(db, existing);
    if (existing !== id) setCartCookie(c, id);
    await db.delete(cartLine).where(eq(cartLine.cartId, id));
    return c.json({ data: await readCart(db, id) });
  });

  return r;
}

/**
 * Used by the order-create endpoint: snapshot cart contents into items[] and
 * clear the cart so it can't be re-submitted. Returns null when there's no
 * cookie or the cart has no priced lines.
 */
export async function takeCartAsOrderItems(
  db: DbClient,
  c: Context,
): Promise<Array<{ variant_id: string; quantity: number }> | null> {
  const cookieId = getCookie(c, COOKIE_NAME);
  if (!cookieId) return null;
  const view = await readCart(db, cookieId);
  if (view.lines.length === 0) return null;
  return view.lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity }));
}

/** Called after a successful order to drop the cart. */
export async function clearCartForCookie(db: DbClient, c: Context): Promise<void> {
  const cookieId = getCookie(c, COOKIE_NAME);
  if (!cookieId) return;
  await db.delete(cartLine).where(eq(cartLine.cartId, cookieId));
}

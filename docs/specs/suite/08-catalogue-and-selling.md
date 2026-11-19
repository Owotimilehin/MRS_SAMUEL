# Suite build specs — 08: Catalogue sync and selling in chat

Read `00-foundation.md` first. Size L, suggested model Opus (money, stock and concurrency). Migration `0077_catalogue_sync.sql`. Permission `catalogue.manage`. Meta facts checked on 19 Nov 2026.

Words used here: a **flavour** is a row of `product`; a **size** is a row of `product_variant` (the thing a customer actually buys); an **item** is one entry in Meta's catalogue; the **online branch** is the `branch` row with `is_online_default = true`.

---

## 1. Outcome

When this is finished, shop staff can say:

- "Every juice size we sell online is in our WhatsApp catalogue with the right name, picture and price. I never type a product into Meta."
- "When I change a price or hide a flavour in the shop admin, WhatsApp shows the change within a minute. When a size sells out at the online branch it shows as out of stock within about a minute, and comes back when stock arrives."
- "On the Catalogue page I can see every item, whether Meta accepted it, and if not, why, in plain words. I can press Try again."
- "In a WhatsApp chat I can send one product, a short list of products, or our whole menu."
- "When a customer sends a cart from WhatsApp, I see it beside the chat with the shop's own prices. I choose delivery or pickup, check the address, press one button, and the customer gets a normal shop order with an OPay payment link in the chat."
- "The customer is told by WhatsApp when the order is paid, out for delivery and delivered, if the owner has switched that on."

## 2. Depends on

**Specs and branches.** None must be merged first. If spec 01 is merged, use its exported `graph()` (D7). If it is not, export the existing private `graph()` from `packages/domain/src/inbox/meta.ts` unchanged and add an optional fifth argument `opts?: { token?: string }` (the same change spec 01 makes; whichever lands second keeps the other's). The order-update templates need either spec 06 or WhatsApp Manager (step 6 below).

**Things a person must do in Meta first.** UI labels are **[unverified]**: Meta renames screens often; the API calls beside them are the checked route.

1. **Create the catalogue** (owner, once). Open `https://business.facebook.com/products/catalogs/new` **[verified: https://developers.facebook.com/documentation/ads-commerce/catalog/get-started.md, 19 Nov 2026]**. Choose type "E-commerce" (online products). Choose "Upload product info" (not "Connect a partner platform"). Owner: the business account "aniukwu". Name: `Mrs Samuel Juices`. Press Create. Do not add products by hand. Meta requires the first catalogue to be created this way so the business accepts the catalogue terms: "accepting the Terms of Service by creating your first catalog through Business Manager" **[verified: same page]**.
2. **Copy the catalogue ID** (a long number shown under the catalogue's name in Commerce Manager → Settings, or in Business Settings → Data sources → Catalogues).
3. **Give the system user control of it.** Business Settings → Data sources → Catalogues → pick the catalogue → "Assign people" (or "Add people") → system user `NEWUSERSYSTEM` → turn on "Manage catalogue" (full control) → Save. API equivalent: `POST /{catalog-id}/assigned_users` with `user=<system user id>` and `tasks=["MANAGE"]`, permission `catalog_management`, returns `{ "success": true }` **[verified: https://developers.facebook.com/docs/marketing-api/reference/product-catalog/assigned_users/, 19 Nov 2026]**.
4. **Connect the catalogue to the WhatsApp account.** Either press "Connect to WhatsApp" on the suite's Catalogue page (it calls `POST /{waba-id}/product_catalogs`, section 3), or in WhatsApp Manager → Account tools → Catalogue → choose the catalogue → Connect. Only one catalogue per WhatsApp account: "You can only upload one catalog per WhatsApp account hierarchy" **[verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/upload-inventory.md, 19 Nov 2026]**.
5. **Nothing to subscribe.** Carts arrive on the existing WhatsApp webhook's `messages` field.
6. **Create four templates** (section 8, rule R30) in WhatsApp Manager or through spec 06, then Settings → Templates → Sync in the suite.

**Known blocker to check on day one.** The WhatsApp account today is Meta's *test* account with a *test* number. Whether a catalogue can be connected to a test account is **[unverified]**. If step 4 is refused, build and test everything up to it with the Graph stub, and repeat step 4 when the real number is added (blueprint section 8, item 4).

## 3. Meta reference

Every row is marked. "IB" below means `https://developers.facebook.com/docs/marketing-api/reference/product-catalog/items_batch/`.

### 3.1 Catalogue set-up

| Fact | Status |
|---|---|
| `catalog_management` "grants your app the ability to create, read, update, and delete business-owned product catalogs". In development mode the app can reach only catalogues owned by the app's admins and developers. Updating a catalogue also needs `business_management` | [verified: https://developers.facebook.com/documentation/ads-commerce/catalog/get-started.md, 19 Nov 2026] |
| `GET /{waba-id}/product_catalogs` returns `{ data: [ProductCatalog…] }`. `POST /{waba-id}/product_catalogs` with `catalog_id` (numeric string, required) returns `{ success: bool }`. Permissions listed: `whatsapp_business_management`, `whatsapp_business_messaging`, `catalog_management`. Errors: 100 invalid parameter, 200 permissions, 80008 too many calls to this WhatsApp account. Update and delete are not supported on this edge | [verified: https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/product_catalogs/, 19 Nov 2026] |
| `GET /{phone-number-id}/whatsapp_commerce_settings` returns `{ data: [{ is_cart_enabled, is_catalog_visible, id }] }`. `POST /{phone-number-id}/whatsapp_commerce_settings?is_cart_enabled=true|false` and `?is_catalog_visible=true|false` return `{ "success": true }`. Defaults: cart `true`, catalogue visible `false` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/set-commerce-settings.md, 19 Nov 2026] |
| `GET /{catalog-id}?fields=id,name,product_count,vertical` works for a catalogue the token can manage | [unverified] |

### 3.2 Item data model

Meta's two pages disagree on some limits. **Use the stricter value**, shown in the "We send" column.

| Meta field | Required by Meta | Meta's rule | We send | Status |
|---|---|---|---|---|
| `id` (shown as `retailer_id` when reading, and as `product_retailer_id` in WhatsApp) | yes | unique, max 100 characters | `v-<product_variant.id>` | [verified: IB, 19 Nov 2026] |
| `title` | yes | max 100 (batch page) or 200 (fields page) | `<product.name> <size_ml>ml`, cut to 100 | [verified: IB, 19 Nov 2026] |
| `description` | yes | plain text, no HTML, no links, not all capitals; max 5000 (batch page) or 9999 (fields page) | see R3, cut to 5000 | [verified: IB and https://developers.facebook.com/docs/commerce-platform/catalog/fields, 19 Nov 2026] |
| `availability` | yes | `in stock`, `out of stock` (also `available for order`, `discontinued`, which we never send) | `in stock` or `out of stock` only | [verified: IB, 19 Nov 2026] |
| `condition` | yes | `new`, `refurbished`, `used` | `new` | [verified: IB, 19 Nov 2026] |
| `price` | yes | "a number, followed by a space and then the 3-letter ISO 4217 currency code", full stop as decimal point, no currency symbol, e.g. `9.99 USD` | `<price_ngn>.00 NGN`, e.g. `1500.00 NGN` | [verified: https://developers.facebook.com/docs/commerce-platform/catalog/fields, 19 Nov 2026] |
| `link` | yes | product page on the business's own domain, starts `http://` or `https://` | `<storefront>/juices/<product.slug>` | [verified: same, 19 Nov 2026] |
| `image` | yes (batch page) | array of up to 21 objects `{ url, tag? }`. When `image` is present `image_link` and `additional_image_link` are ignored | `[{ "url": "<absolute picture URL>" }]` | [verified: IB, 19 Nov 2026] |
| picture file | — | "JPEG or PNG format, at least 500 x 500 pixels and up to 8 MB" | the flavour's picture (R4) | [verified: https://developers.facebook.com/docs/commerce-platform/catalog/fields, 19 Nov 2026] |
| `brand` | yes (one of brand, gtin, mpn) | max 100 | `Mrs. Samuel` | [verified: IB, 19 Nov 2026] |
| `item_group_id` | no | groups sizes of one product | `<product.id>` | [verified: IB, 19 Nov 2026] |
| `size` | no | free text | `<size_ml> ml` | [verified: IB, 19 Nov 2026] |
| `google_product_category` | fields page says one category is required; batch page lists it as optional | name or ID from Google's list, max 250 | `Food, Beverages & Tobacco > Beverages > Juice` | field [verified: IB, 19 Nov 2026]; that exact category name is accepted [unverified] |
| `quantity_to_sell_on_facebook`, `sale_price`, `status`, `visibility` | no | — | never sent | [verified: IB, 19 Nov 2026] |
| How a transparent PNG is drawn in WhatsApp (white or black behind it) | — | — | — | [unverified] |

The shop's bottle pictures are `apps/customer/public/media/bottles/*.png`: PNG, 896 × 1200, about 1 MB, transparent background. They meet the size and format rule.

### 3.3 Catalog Batch API

| Fact | Status |
|---|---|
| `POST /{catalog-id}/items_batch` with `item_type=PRODUCT_ITEM` and `requests` = a JSON array, each record `{ "method": "CREATE" \| "UPDATE" \| "DELETE", "data": { … } }`. For DELETE only `id` is needed | [verified: IB, 19 Nov 2026] |
| `allow_upsert` defaults to `true`: "Set this to true if you want to allow requests with method=UPDATE to create new items" | [verified: IB, 19 Nov 2026] |
| Limits: "no more than 5000 records", "under 3000 records for optimal performance", payload at most 28 MB | [verified: IB, 19 Nov 2026] |
| Response: `handles` ("An array of strings, containing either 0 or 1 value. An empty array means that nothing has been ingested") and `validation_status`: array of `{ retailer_id, errors: [{ message }], warnings: [{ message }] }` | [verified: IB, 19 Nov 2026] |
| Errors on the call: 80014 too many batch calls to this catalogue (wait and retry), 100 invalid parameter, 200 permissions, 190 bad token | [verified: IB, 19 Nov 2026] |
| `requests` may be sent as a real JSON array inside a JSON request body (rather than a string form field) | [unverified]; if Meta answers 100, send `requests: JSON.stringify(array)` |
| `GET /{catalog-id}/check_batch_request_status?handle=<handle>&load_ids_of_invalid_requests=true` returns `{ data: [ { handle, status, errors_total_count, warnings: [{ line, id, message }], ids_of_invalid_requests: [] } ] }`. The example shows `status: "finished"`. Errors: 80009 too many calls (wait), 100, 190 | [verified: https://developers.facebook.com/docs/marketing-api/reference/product-catalog/check_batch_request_status/, 19 Nov 2026] |
| Other `status` values (`started`, `error`) and an `errors` array shaped `[{ line, id, message }]` | [unverified] |
| `POST /{catalog-id}/batch` is the old endpoint, gone from API v27; use `items_batch` | [verified: https://developers.facebook.com/documentation/ads-commerce/catalog/guides/manage-catalog-items/catalog-batch-api.md, 19 Nov 2026] |
| Reading items: `GET /{catalog-id}/products?fields=id,retailer_id,availability,price,review_status,review_rejection_reasons,errors&limit=200`. `review_status` is one of `""`, `pending`, `rejected`, `approved`, `outdated` | field names and values [verified: https://developers.facebook.com/docs/marketing-api/reference/product-item/, 19 Nov 2026]; the `/products` edge, its paging and the shape of `errors[]` (`{ title, description, error_type, error_priority }`) [unverified] |

### 3.4 WhatsApp product messages and carts

| Fact | Status |
|---|---|
| Single product: `{ type: "interactive", interactive: { type: "product", body?: { text }, footer?: { text }, action: { catalog_id, product_retailer_id } } }`. Body and footer optional | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/single-product-messages.md, 19 Nov 2026] |
| Header "Cannot be set for 'product' type"; header "Required for 'product_list' type"; section title "Max 24 characters" | [verified: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages, 19 Nov 2026] |
| Product list: `interactive: { type: "product_list", header: { type: "text", text }, body: { text }, footer?: { text }, action: { catalog_id, sections: [{ title, product_items: [{ product_retailer_id }] }] } }`. "up to 30 products" | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/multi-product-messages.md, 19 Nov 2026] |
| At most 10 sections in a product list; header text at most 60 characters; body at most 1024; footer at most 60 (for `product` and `product_list`) | [unverified]; we stay well inside (3 sections, R21) |
| If no item matches the catalogue the API returns an error and sends nothing; if some match, the message is sent without the others | [verified: same multi-product page, 19 Nov 2026] |
| Catalogue message: `interactive: { type: "catalog_message", body: { text }, footer?: { text }, action: { name: "catalog_message", parameters?: { thumbnail_product_retailer_id } } }`. Body required, "Maximum 1024 characters"; footer at most 60 | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalog-messages.md, 19 Nov 2026] |
| Product messages "can only be sent as part of existing chat threads" and cannot be sent as notifications | [verified: single-product page above, 19 Nov 2026] |
| The 24-hour rule: when the customer writes "a 24-hour timer called a customer service window starts"; after it closes "you can only send pre-approved template messages" | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages.md, 19 Nov 2026] |
| Cart: up to 99 units of each item, no limit on different items; one cart per chat per device; no expiry; cleared when sent; a sent cart cannot be edited; a business cannot send a cart | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/catalogs-overview.md, 19 Nov 2026] |
| WhatsApp refuses to add an out-of-stock item to a cart | [unverified] |
| The cart arrives on the `messages` webhook as a message with `type: "order"` and `order: { catalog_id, text, product_items: [{ product_retailer_id, quantity, item_price, currency }] }`. `text` is "Text accompanying the order". It fires when a user orders "through a catalog, single-product, or multi-product message" | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/order.md, 19 Nov 2026] |
| `item_price` is documented as an Integer but the page's own example is `7.99`. Treat it as a number that may have decimals, in the catalogue's currency (naira for us) | [verified: same page, 19 Nov 2026] |
| `messages[].from` (the phone number) can be missing when the user has a username; `from_user_id` is always present | [verified: same page, 19 Nov 2026] |
| Reply buttons: `interactive: { type: "button", body: { text }, footer?, action: { buttons: [{ type: "reply", reply: { id, title } }] } }`. Up to 3 buttons; title at most 20 characters; id at most 256; body at most 1024; footer at most 60. The answer arrives as `interactive: { type: "button_reply", button_reply: { id, title } }` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages.md, 19 Nov 2026] |
| Link button: `interactive: { type: "cta_url", body: { text }, footer?, action: { name: "cta_url", parameters: { display_text, url } } }`. Body at most 1024; `display_text` at most 20; footer at most 60 | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-cta-url-messages.md, 19 Nov 2026] |

### 3.5 Not available to a Nigerian business

| Fact | Status |
|---|---|
| Meta documents in-chat WhatsApp payments for India ("Payments API — India", UPI gateways) and Brazil only; its documentation index lists no other country | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-in/overview.md and https://developers.facebook.com/documentation/business-messaging/whatsapp/llms.txt, 19 Nov 2026] |
| Therefore WhatsApp in-chat payment is not available in Nigeria | [unverified] (an inference; no page says "not Nigeria") |
| Checkout-button templates: only India-based businesses, only for users with Indian numbers | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/catalogs/share-products.md, 19 Nov 2026] |
| Checkout inside Facebook and Instagram Shops is not offered to Nigerian businesses | [unverified] |

So payment is always the shop's own OPay link, and the cart is only a request, never a paid order.

### 3.6 Errors (adds to D10)

Temporary, retry with backoff: `80014`, `80009`, `80008`, plus D10's list. Configuration (stop, alert the owner once a day, show a banner): `190`, `10`, `200`, `299`. Everything else is a refusal.

## 4. Data

### 4.1 Money: the exact rule

The shop stores **whole naira as integers** in every money column: `product_price.price_ngn`, `sale_order.subtotal_ngn`, `.delivery_fee_ngn`, `.total_ngn`, `sale_order_item.unit_price_ngn`, `.line_total_ngn`, `payment.amount_ngn`, `bundle.price_ngn`. There is no kobo anywhere in the database.

- **To OPay:** kobo. `buildOpayCashierBody` in `apps/api/src/payments/opay.ts` sends `amount: { total: amountNgn * 100, currency: "NGN" }` and `parseOpayStatus` converts back with `Math.round(kobo / 100)`. This spec never touches that; it only calls `createCheckout` with `amountNgn`.
- **To Meta:** `metaPrice(priceNgn) = \`${priceNgn}.00 NGN\``. `priceNgn` must be a positive integer, otherwise the item is blocked (R5).
- **From Meta (`item_price` in a cart):** a number in naira, possibly with decimals. It is **stored for display only** and never used to compute anything. Compare with the shop price as `Math.round(item_price) !== priceNgn`.
- **On screen and in messages:** `formatNaira(n) = "₦" + n.toLocaleString("en-NG")`, e.g. `₦4,500`.

### 4.2 Migration `packages/db/migrations/0077_catalogue_sync.sql`

```sql
-- Catalogue sync and selling in WhatsApp chat (spec 08). Additive only: four new
-- catalogue_* tables. No existing table is altered.
-- Undo: DROP TABLE "catalogue_chat_order", "catalogue_batch", "catalogue_item_sync",
-- "catalogue_link" (in that order). Nothing else depends on them.

CREATE TABLE IF NOT EXISTS "catalogue_link" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "catalog_id" text NOT NULL UNIQUE,
  "name" text,
  "waba_id" text,
  "whatsapp_connected" boolean DEFAULT false NOT NULL,
  "is_cart_enabled" boolean,
  "is_catalog_visible" boolean,
  "sync_enabled" boolean DEFAULT false NOT NULL,
  "ask_fulfilment_auto" boolean DEFAULT false NOT NULL,
  "order_updates_enabled" boolean DEFAULT false NOT NULL,
  "sync_requested_at" timestamptz,
  "sync_request_reason" text,
  "full_sync_requested_at" timestamptz,
  "last_sync_at" timestamptz,
  "last_reconcile_at" timestamptz,
  "problem_kind" text CHECK ("problem_kind" IN ('config','temporary')),
  "problem_code" text,
  "problem_message" text,
  "problem_at" timestamptz,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_catalogue_link_single" ON "catalogue_link" ((true));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalogue_batch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "link_id" uuid NOT NULL REFERENCES "catalogue_link"("id") ON DELETE CASCADE,
  "handle" text,
  "kind" text NOT NULL CHECK ("kind" IN ('changes','full','reconcile')),
  "item_count" integer NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL CHECK ("state" IN ('queued','open','finished','failed','lost')),
  "errors_total" integer,
  "checks" integer DEFAULT 0 NOT NULL,
  "result" jsonb,
  "error_code" text,
  "error_message" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "sent_at" timestamptz,
  "finished_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_catalogue_batch_state" ON "catalogue_batch" ("state","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalogue_item_sync" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "link_id" uuid NOT NULL REFERENCES "catalogue_link"("id") ON DELETE CASCADE,
  "retailer_id" text NOT NULL,
  "variant_id" uuid REFERENCES "product_variant"("id"),
  "product_id" uuid REFERENCES "product"("id"),
  "title" text NOT NULL,
  "desired" jsonb,
  "desired_hash" text,
  "pushed_hash" text,
  "state" text DEFAULT 'pending' NOT NULL CHECK ("state" IN ('pending','sent','live','rejected','blocked','removed')),
  "blocked_reason" text,
  "review_status" text,
  "problem_code" text,
  "problem_message" text,
  "batch_id" uuid REFERENCES "catalogue_batch"("id") ON DELETE SET NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "pushed_at" timestamptz,
  "checked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_catalogue_item_retailer" ON "catalogue_item_sync" ("link_id","retailer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_catalogue_item_state" ON "catalogue_item_sync" ("link_id","state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalogue_chat_order" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "inbox_conversation"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id"),
  "wa_message_id" text NOT NULL UNIQUE,
  "catalog_id" text,
  "cart" jsonb NOT NULL,
  "cart_note" text,
  "state" text DEFAULT 'new' NOT NULL CHECK ("state" IN ('new','asked','awaiting_address','ready','placed','cancelled')),
  "fulfilment" text CHECK ("fulfilment" IN ('delivery','pickup')),
  "address" text,
  "next_prompt" text CHECK ("next_prompt" IN ('fulfilment','address','received')),
  "prompt_attempts" integer DEFAULT 0 NOT NULL,
  "idempotency_key" uuid DEFAULT gen_random_uuid() NOT NULL UNIQUE,
  "sale_order_id" uuid UNIQUE REFERENCES "sale_order"("id"),
  "placed_by" uuid REFERENCES "admin_user"("id"),
  "payment_link_sent_at" timestamptz,
  "last_notified_status" text,
  "notify_attempts" integer DEFAULT 0 NOT NULL,
  "problem" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_catalogue_chat_order_conv" ON "catalogue_chat_order" ("conversation_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_catalogue_chat_order_open" ON "catalogue_chat_order" ("state","updated_at");
```

Journal entry to append to `packages/db/migrations/meta/_journal.json`: `{ "idx": 76, "version": "7", "when": 1786800000000, "tag": "0077_catalogue_sync", "breakpoints": true }`. The `when` follows the series (0070 is `1786100000000`; add `100000000` per migration number). See section 14, Q9: the `when` value decides whether Drizzle runs the file.

### 4.3 What the columns mean

- `catalogue_link`: at most one row (the unique index on a constant enforces it). `sync_enabled` false means nothing is ever pushed. `sync_requested_at` is the "something changed, sync now" flag (section 6). `problem_*` holds the last account-level failure for the banner.
- `catalogue_item_sync`: one row per item we manage. `desired` is the exact `data` object for Meta, or `null` when the item should not exist there. `state`:
  - `pending`: differs from what Meta has; goes in the next batch.
  - `sent`: in a batch Meta has not finished.
  - `live`: Meta took the latest version and has not rejected it.
  - `rejected`: Meta refused it (batch error or review). Not retried until `desired_hash` changes or a person presses Try again.
  - `blocked`: we did not send it because something is missing in the shop (`blocked_reason`: `no_picture`, `no_price`).
  - `removed`: hidden in the shop and deleted at Meta.
- `catalogue_chat_order`: one row per cart a customer sent. `cart` is Meta's `product_items` array exactly as received. `idempotency_key` becomes `sale_order.idempotency_key`, so one cart can never become two orders. `last_notified_status` is the last `sale_order.status` the customer was told about.

### 4.4 Drizzle

Add `packages/db/src/schema/catalogue.ts` exporting `catalogueLink`, `catalogueBatch`, `catalogueItemSync`, `catalogueChatOrder`, mirroring the SQL column for column (camelCase property names: `catalogId`, `wabaId`, `whatsappConnected`, `isCartEnabled`, `isCatalogVisible`, `syncEnabled`, `askFulfilmentAuto`, `orderUpdatesEnabled`, `syncRequestedAt`, `syncRequestReason`, `fullSyncRequestedAt`, `lastSyncAt`, `lastReconcileAt`, `problemKind`, …). Type `desired` as `jsonb("desired").$type<MetaItemData | null>()`, `cart` as `$type<ChatCartLine[]>()`. The single-row index is `uniqueIndex("uq_catalogue_link_single").on(sql\`(true)\`)`. Export the file from `packages/db/src/schema/index.ts`.

## 5. Server

### 5.1 Permission

In `packages/shared/src/permissions.ts` add `"catalogue.manage"` to `CAPABILITIES` (after `"inbox.reports"`, with the comment `// Catalogue: connect, sync and repair the Meta catalogue (spec 08).`) and to `ADMIN_CAPS`. Not to `MANAGER_CAPS`. The owner gets it through `[...CAPABILITIES]`.

### 5.2 Domain: `packages/domain/src/meta/catalogue.ts` (new; re-export from `packages/domain/src/index.ts`)

```ts
export const RETAILER_PREFIX = "v-";
export function retailerIdForVariant(variantId: string): string;            // "v-" + id
export function variantIdFromRetailerId(retailerId: string): string | null; // null unless "v-" + uuid
export function metaPrice(priceNgn: number): string;                        // "1500.00 NGN"
export function formatNaira(n: number): string;                             // "₦1,500"

export interface MetaItemData {
  id: string; title: string; description: string;
  availability: "in stock" | "out of stock"; condition: "new";
  price: string; link: string; image: { url: string }[];
  brand: string; item_group_id: string; size: string; google_product_category: string;
}
export interface DesiredItem {
  retailerId: string; variantId: string; productId: string; title: string;
  data: MetaItemData | null;                    // null = must not exist at Meta
  blockedReason: "no_picture" | "no_price" | null;
}
/** Read the shop and say what Meta should hold. Pure SQL reads; no Meta call. */
export function computeDesiredItems(db: DbExecutor, opts: { storefrontBase: string }): Promise<DesiredItem[]>;
/** sha256 hex of JSON.stringify(data) with keys in the order of MetaItemData. "" for null. */
export function hashItem(data: MetaItemData | null): string;
/** Mark that the shop changed. One UPDATE on catalogue_link; a no-op when no row exists. Safe inside any transaction. */
export function requestCatalogueSync(db: DbExecutor, reason: string): Promise<void>;

export function buildBatchRequests(rows: { retailerId: string; data: MetaItemData | null }[]):
  { method: "UPDATE" | "DELETE"; data: MetaItemData | { id: string } }[];
export function sendItemsBatch(cfg: MetaConfig, catalogId: string, requests: unknown[]):
  Promise<{ handle: string | null; validation: { retailer_id: string; errors: { message: string }[]; warnings: { message: string }[] }[] }>;
export function checkBatch(cfg: MetaConfig, catalogId: string, handle: string):
  Promise<{ status: string; errorsTotal: number; errors: { id: string; message: string }[]; invalidIds: string[] }>;
export function listMetaItems(cfg: MetaConfig, catalogId: string):
  Promise<{ retailerId: string; availability: string | null; reviewStatus: string | null; problem: string | null }[]>;
export function getCatalogue(cfg: MetaConfig, catalogId: string): Promise<{ id: string; name: string | null }>;
export function listWabaCatalogues(cfg: MetaConfig, wabaId: string): Promise<{ id: string; name?: string }[]>;
export function connectCatalogueToWaba(cfg: MetaConfig, wabaId: string, catalogId: string): Promise<void>;
export function getCommerceSettings(cfg: MetaConfig, waPhoneNumberId: string): Promise<{ isCartEnabled: boolean; isCatalogVisible: boolean } | null>;
export function setCommerceSettings(cfg: MetaConfig, waPhoneNumberId: string, s: { isCartEnabled?: boolean; isCatalogVisible?: boolean }): Promise<void>;

/** One pass of the sync engine (section 6.1). */
export function syncCatalogue(db: DbClient, cfg: MetaConfig, opts: { storefrontBase: string; force?: boolean; kind?: "changes" | "full" | "reconcile" }):
  Promise<{ pushed: number; removed: number; blocked: number }>;
export function checkOpenBatches(db: DbClient, cfg: MetaConfig): Promise<number>;
export function reconcileCatalogue(db: DbClient, cfg: MetaConfig, opts: { storefrontBase: string }): Promise<{ missing: number; extra: number; unmanaged: number }>;

/** Meta's words turned into shop English (R12). */
export function plainProblem(raw: string | null, reviewStatus?: string | null): string;
export function classifyMetaError(err: unknown): "config" | "temporary" | "refusal";   // D10 + section 3.6

// WhatsApp message builders (pure)
export function buildProductMessage(catalogId: string, retailerId: string, text?: string): Record<string, unknown>;
export function buildProductListMessage(catalogId: string, o: { header: string; body: string; sections: { title: string; retailerIds: string[] }[] }): Record<string, unknown>;
export function buildCatalogueMessage(body: string, thumbnailRetailerId?: string): Record<string, unknown>;
export function buildFulfilmentButtons(chatOrderId: string, body: string): Record<string, unknown>;
export function buildPayButton(body: string, url: string): Record<string, unknown>;

// Chat carts (no Meta calls; run inside the ingest transaction)
export interface ChatCartLine { product_retailer_id: string; quantity: number; item_price: number | null; currency: string | null }
export function parseOrderMessage(m: WaInboundMessage): { catalogId: string | null; note: string | null; lines: ChatCartLine[] } | null;
export function recordChatCart(db: DbExecutor, a: { conversationId: string; customerId: string; waMessageId: string; parsed: NonNullable<ReturnType<typeof parseOrderMessage>> }): Promise<{ id: string; created: boolean }>;
export function applyChatOrderReply(db: DbExecutor, conversationId: string, m: WaInboundMessage): Promise<boolean>;
/** Shop prices and names for a cart. Never uses Meta's prices. */
export function priceChatCart(db: DbExecutor, lines: ChatCartLine[], branchId: string | null): Promise<PricedLine[]>;
export interface PricedLine {
  retailerId: string; variantId: string | null; name: string; sizeMl: number | null; quantity: number;
  shopPriceNgn: number | null; lineTotalNgn: number | null; metaPrice: number | null;
  priceDiffers: boolean; sellable: boolean; inStock: boolean;
}
```

`graph()` calls: `sendItemsBatch` → `graph(cfg, "POST", \`${catalogId}/items_batch\`, { item_type: "PRODUCT_ITEM", requests })`; `checkBatch` → `GET ${catalogId}/check_batch_request_status?handle=${encodeURIComponent(handle)}&load_ids_of_invalid_requests=true`, read `data[0]`; `connectCatalogueToWaba` → `POST ${wabaId}/product_catalogs` body `{ catalog_id }`; commerce settings as in 3.1 (booleans in the query string). All use the system-user token.

### 5.3 Changes to existing domain files

- `packages/domain/src/inbox/meta.ts`: add to `OutboundContent` the member `| { type: "interactive"; interactive: Record<string, unknown>; preview: string }`. In `buildSendPayload` add `case "interactive": return { ...base, type: "interactive", interactive: content.interactive };` **before** the `default` branch.
- `packages/domain/src/inbox/send.ts`: for `content.type === "interactive"` the non-template branch applies unchanged (24-hour check), with `body = content.preview`. Store the interactive object in the queued row's `payload` as `{ interactive: content.interactive }` so the timeline can draw it later. On failure merge, do not replace: `payload: { ...(queued.payload ?? {}), unconfirmed, retryable }`.
- `packages/domain/src/inbox/whatsapp-ingest.ts`:
  - Add to `WaInboundMessage`: `order?: { catalog_id?: string; text?: string; product_items?: { product_retailer_id?: string; quantity?: number; item_price?: number; currency?: string }[] };`.
  - In `parseInbound` add `case "order":` giving `type = "order"` and `body = \`Sent a cart: ${n} item${n === 1 ? "" : "s"}, ${units} bottle${units === 1 ? "" : "s"}${text ? ` — "${text}"` : ""}\`` where `n` is the number of lines and `units` the sum of quantities.
  - In `ingestMessage`, after the message row is inserted and before `touchConversation`: `if (m.type === "order") { const parsed = parseOrderMessage(m); if (parsed) await recordChatCart(db, { conversationId: conversation.id, customerId: cust.id, waMessageId: m.id, parsed }); } else { await applyChatOrderReply(db, conversation.id, m); }`. Both run in the caller's transaction and make no network call.

### 5.4 The one order-creation path: extract, do not copy

Today the storefront's order is created inline in `r.post("/")` of `apps/api/src/routes/public-orders.ts` (the `db.transaction` block that resolves the customer, prices each line from `product_price`, checks stock with `availableVariantAtBranch`, computes the schedule with `orderSchedule`, inserts `sale_order`, `sale_order_item`, `stock_reservation`, and the `sale.online_placed` outbox event). **Move that block, unchanged in behaviour, into a function and call it from both places.**

New file `apps/api/src/lib/online-order.ts`:

```ts
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
export interface PlaceOnlineOrderInput {
  branchId: string;
  idempotencyKey: string;                       // uuid
  /** Give customerId (chat) OR let the function resolve by phone (storefront). */
  customerId?: string;
  customer: { name: string; phone: string; email: string | null; address: string | null; altPhone: string | null };
  items: { variant_id?: string; product_id?: string; quantity: number }[];
  deliveryFeeNgn: number;                       // already decided and verified by the caller
  deliveryQuoteRef: string | null;
  deliveryAddressCode: string | null;
  deliveryAddressFormatted: string | null;
  deliveryState: string | null;
  scheduledDeliveryAt: string | null;           // ISO, already validated by the caller
  deliveryWindow: DeliveryWindow | null;
  notes: string | null;
  paymentProvider: PaymentProvider;
}
export async function placeOnlineOrder(tx: Tx, input: PlaceOnlineOrderInput):
  Promise<{ order: typeof saleOrder.$inferSelect; customerEmail: string | null }>;
```

Rules for the extraction:

1. The route keeps everything before the transaction (idempotent replay of `prior`, Turnstile, date checks, branch check, delivery-quote verification, reading the cart, `getActiveProvider`) and everything after it (`clearCartForCookie`, `createCheckout`, the response). It then calls `db.transaction((tx) => placeOnlineOrder(tx, { … }))`.
2. Inside, when `customerId` is absent the function does exactly what the route does now (`normalizeNigerianPhone`, 422 on a bad number, `resolveCustomer` with `source: "online"`). When `customerId` is given it skips both and uses that id.
3. The order is always inserted with `channel: "online"`, `status: "confirmed"`, `paymentMethod: "card"`, `paymentStatus: "pending"`. **Chat orders are `online` on purpose**: the unpaid-order expiry (`apps/worker/src/jobs/expire-unpaid-orders.ts`), the payment sweep (`payment-reconcile.ts`), the reminder (`unpaid-reminder.ts`), the queue (`online-orders-queue.ts`) and `PATCH …/advance` in `sales.ts` all filter on `channel = 'online'`. The chat origin lives in `catalogue_chat_order`.
4. The `sale.online_placed` outbox event keeps its payload, so the owner's Telegram alert is unchanged.
5. `apps/api/test/integration/online-order.test.ts`, `online-order-schedule.test.ts`, `checkout-opay-failure.test.ts` and `public-cart.test.ts` must pass **without being edited**. That is the proof the move changed nothing.

### 5.5 Routes

**`apps/api/src/routes/catalogue.ts`** (new), `export function catalogueRoutes(db: DbClient)`, registered in `apps/api/src/test-app.ts` as `app.route("/v1/catalogue", catalogueRoutes(db));` beside the inbox routes. `r.use("*", requireAuth())`. Each route checks its capability with `requireCapability`. Errors use `BusinessError`. Audit with `writeAudit(db, c, { …, notify: false })`.

| Method and path | Capability | Request | Response `data` | Audit action |
|---|---|---|---|---|
| `GET /status` | `catalogue.manage` | — | `{ configured: boolean /* META token present */, link: null \| { catalog_id, name, whatsapp_connected, is_cart_enabled, is_catalog_visible, sync_enabled, ask_fulfilment_auto, order_updates_enabled, last_sync_at, last_reconcile_at, problem: null \| { kind, code, message, plain, at } }, online_branch: null \| { id, name }, counts: { live, pending, sent, rejected, blocked, removed }, templates: { order_confirmed, order_paid, order_out_for_delivery, order_delivered /* each "APPROVED" \| other status \| "missing" */ } }` | — |
| `POST /link` | `catalogue.manage` | `{ catalog_id: string /* ^\d{5,30}$ */ }` | the `link` object. Calls `getCatalogue`; on `MetaApiError` returns 422 `catalogue_unreachable` with `plainProblem`. Reads the WABA id from the first active `inbox_phone_number` with a `waba_id`; sets `whatsapp_connected` from `listWabaCatalogues`. 409 `already_linked` if a row exists | `catalogue.link` |
| `DELETE /link` | `catalogue.manage` | — | `{ ok: true }`. Deletes the row (item rows cascade). Does **not** delete anything at Meta | `catalogue.unlink` |
| `POST /connect-whatsapp` | `catalogue.manage` | `{ confirm: true }` | the `link` object. Calls `connectCatalogueToWaba`, then for every active `inbox_phone_number` with `wa_phone_number_id` on that WABA calls `setCommerceSettings({ isCartEnabled: true, isCatalogVisible: true })` and stores what `getCommerceSettings` reads back | `catalogue.connect_whatsapp` |
| `PATCH /settings` | `catalogue.manage`; `order_updates_enabled` and `ask_fulfilment_auto` need role `owner` (403 `owner_only` otherwise) | any of `{ sync_enabled, ask_fulfilment_auto, order_updates_enabled, is_cart_enabled, is_catalog_visible }` (booleans) | the `link` object. The two commerce flags are sent to Meta first; a failure returns 422 and changes nothing locally | `catalogue.settings` with before and after |
| `POST /sync` | `catalogue.manage` | `{ mode: "changes" \| "full" }` | `{ queued: true }` (202). Sets `sync_requested_at = now()`, and for `full` also `full_sync_requested_at = now()` | `catalogue.sync_requested` |
| `GET /items` | `catalogue.manage` | query `state?`, `q?` (matches `title`), `limit` (default 100, max 500), `offset` | `{ items: [{ id, retailer_id, title, state, price_ngn, availability, picture_url, problem_plain, problem_raw, review_status, pushed_at, checked_at }], total }` ordered by state (`rejected`, `blocked`, `pending`, `sent`, `live`, `removed`) then title. `price_ngn` is parsed from `desired.price` | — |
| `POST /items/:id/retry` | `catalogue.manage` | — | the item. Sets `state = 'pending'`, `pushed_hash = null`, clears `problem_*`, calls `requestCatalogueSync(db, "retry")` | `catalogue.item_retry` |
| `GET /sendable` | `inbox.reply` | query `q?` | `{ catalog_id, items: [{ retailer_id, title, price_ngn, availability, picture_url, category }] }`: rows in state `live` or `sent` with `desired` not null. Empty list (not an error) when there is no link or `whatsapp_connected` is false | — |

**Sending products: change `apps/api/src/routes/inbox.ts`.** Add two members to `SendBody`:

```ts
z.object({ type: z.literal("product"), retailer_ids: z.array(z.string().min(3).max(100)).min(1).max(30), text: z.string().trim().max(1024).optional() }),
z.object({ type: z.literal("catalogue"), text: z.string().trim().max(1024).optional() }),
```

In `POST /conversations/:id/messages` (needs `inbox.reply`, as now): load `catalogue_link`; if none or `whatsapp_connected` is false → 409 `catalogue_not_connected`, message `The catalogue is not connected to WhatsApp yet.` For `product`: every id must be a `catalogue_item_sync` row in state `live` or `sent` with `desired` not null, else 422 `item_not_in_catalogue` naming the titles. One id → `buildProductMessage`; two or more → `buildProductListMessage` (R21). For `catalogue` → `buildCatalogueMessage(text ?? default, thumbnail)` where the thumbnail is the first live item by `product.display_order`. Then `sendFromConversation` with `{ type: "interactive", interactive, preview }`. Existing error mapping for `InboxSendError` (window closed etc.) applies. Audit `inbox.send_product` with the retailer ids.

**Chat orders: `apps/api/src/routes/inbox-chat-orders.ts`** (new), `export function chatOrderRoutes(db: DbClient)`, registered as `app.route("/v1/inbox/chat-orders", chatOrderRoutes(db));` **above** the line `app.route("/v1/inbox", inboxRoutes(db));`. Export `withViewer`, `need` and `visibleConversation` from `inbox.ts` (add the `export` keyword; no other change) and use them. Every route loads the row, then calls `visibleConversation(db, c, row.conversationId)` so the one visibility rule applies (404 otherwise).

| Method and path | Capability | Request | What it does | Audit |
|---|---|---|---|---|
| `GET /?conversation_id=<uuid>` | `inbox.view` | — | Newest 10 rows for the conversation: `{ id, state, created_at, cart_note, fulfilment, address, problem, payment_link_sent_at, lines: PricedLine[] (snake_case keys), subtotal_ngn, order: null \| { id, order_number, status, payment_status, total_ngn, delivery_fee_ngn, admin_url } }`. `admin_url` = `${PUBLIC_ADMIN_URL}/owner/orders/${id}` | — |
| `POST /:id/ask` | `inbox.reply` | — | Allowed in `new`, `asked`. Sends the fulfilment buttons (R24) through `sendFromConversation`; on success `state = 'asked'`. 409 `window_closed` passes through | `chat_order.ask` |
| `POST /:id/place` | `inbox.reply` **and** `orders.manage` | `{ fulfilment: "delivery" \| "pickup", address?: string (10–500, required for delivery), delivery_fee_ngn: integer 0–100000 (must be 0 for pickup), items: [{ variant_id: uuid, quantity: 1–99 }] (1–50 lines), notes?: string (max 500) }` | Section 5.6 | `chat_order.place` with order number and total |
| `POST /:id/payment-link` | `inbox.reply` | — | Order must be `confirmed` or `reconcile_needed`, else 409 `not_awaiting_payment`. Calls `createCheckout`, sends R27's message, sets `payment_link_sent_at` | `chat_order.payment_link` |
| `POST /:id/cancel` | `inbox.reply` | — | Allowed unless `placed`. `state = 'cancelled'`, `next_prompt = null`. Sends nothing | `chat_order.cancel` |

### 5.6 Placing the order (`POST /:id/place`), step by step

1. Load the row and conversation; check capabilities and visibility.
2. Find the online branch (`branch.is_online_default = true`, `is_active`, not deleted). None → 409 `no_online_branch`, `No branch is set to take online orders. Ask the owner to choose one in the shop admin.`
3. Load the customer. `phone = toE164(customer.phone)`; none → 409 `no_phone`.
4. `const provider = await getActiveProvider(db)`.
5. One transaction:
   a. `SELECT … FROM catalogue_chat_order WHERE id = $1 FOR UPDATE`.
   b. If `sale_order_id` is set, load that order and skip to step 6 (a double click or retry returns the same order).
   c. If `state = 'cancelled'` → 409 `cart_cancelled`.
   d. `placeOnlineOrder(tx, { branchId, idempotencyKey: row.idempotency_key, customerId: row.customer_id, customer: { name: customer.name ?? "WhatsApp customer", phone, email: customer.email, address: fulfilment === "delivery" ? address : null, altPhone: null }, items, deliveryFeeNgn: fulfilment === "delivery" ? delivery_fee_ngn : 0, deliveryQuoteRef: null, deliveryAddressCode: null, deliveryAddressFormatted: fulfilment === "delivery" ? address : null, deliveryState: null, scheduledDeliveryAt: null, deliveryWindow: null, notes: ["Ordered in WhatsApp chat", notes].filter(Boolean).join(". "), paymentProvider: provider })`.
   e. For delivery, fill the customer's saved address **only if it is empty** (same rule as `resolveCustomer`): `UPDATE customer SET default_address = $addr, updated_at = now() WHERE id = $id AND coalesce(default_address, '') = ''`. Never overwrite.
   f. `UPDATE catalogue_chat_order SET state = 'placed', sale_order_id, fulfilment, address, placed_by, last_notified_status = 'confirmed', next_prompt = null, updated_at = now()`.
   g. Add the label `order` to the conversation: `UPDATE inbox_conversation SET labels = array_append(labels, 'order') WHERE id = $1 AND NOT ('order' = ANY(labels))`, then `publishInboxEvent(tx, signalFor("conversation.updated", conv))`.
6. Outside the transaction: `createCheckout(db, { provider: "opay", amountNgn: order.totalNgn, reference: order.orderNumber, email: customer.email ?? "no-email@example.com", customerName, customerPhone: phone })` (the same placeholder email the storefront uses). If it throws: log, Sentry, and answer `201` with `payment_link: null` and `warning: "The order was created but OPay did not give a payment link. Press “Send payment link” to try again."` **Never** turn this into an error: the order exists and holds stock.
7. Send R27's message. If the send throws `window_closed` and the `order_confirmed` template is approved, send that template instead (R30). If neither can go, answer `201` with `warning: "The order was created but the message could not be sent: <reason>."`
8. Response `201`: `{ data: { order_number, total_ngn, is_preorder, payment_link: string | null, warning?: string } }`.

`BusinessError`s thrown by `placeOnlineOrder` (unknown size, no price) pass through with their own status. Nothing is written in that case, because the transaction rolls back.

### 5.7 Where the shop must say "something changed"

`requestCatalogueSync` is one cheap UPDATE. Add these calls and nothing else in shop code:

| # | File and place | Call | Why |
|---|---|---|---|
| 1 | `apps/api/src/routes/products.ts`, `r.post("/")`, inside `db.transaction`, after the variants loop, before `return { row, variants }` | `await requestCatalogueSync(tx, "product_created")` | new flavour and sizes |
| 2 | same file, `r.patch("/:id")`, straight after the `db.update(product)…returning()` | `await requestCatalogueSync(db, "product_updated")` | name, wording, `is_active` (hide and unhide), `image_url`, `bottle_asset_id` (picture change) |
| 3 | same file, `r.delete("/:id")`, inside the transaction after both updates | `await requestCatalogueSync(tx, "product_deleted")` | flavour retired |
| 4 | same file, `r.post("/:id/variants")`, inside the transaction, before **each** of its two `return` statements | `await requestCatalogueSync(tx, "variant_added")` | new or revived size |
| 5 | same file, `r.post("/:id/prices")`, inside the transaction after the `insert(productPrice)` | `await requestCatalogueSync(tx, "price_changed")` | price change |
| 6 | same file, `r.patch("/:id/variants/:variantId")`, inside the transaction after the `update(productVariant)` | `await requestCatalogueSync(tx, "variant_visibility")` | size retired or restored |
| 7 | `apps/api/src/routes/branches.ts`, the PATCH route, inside its `db.transaction`, after `tx.update(branch).set(patch)…returning()`, only when `body.is_online_default !== undefined` | `await requestCatalogueSync(tx, "online_branch_changed")` | stock is now read from another branch |

**Stock is deliberately not on this list.** Availability at the online branch is `SUM(stock_ledger.delta) − live stock_reservation` (`availableVariantAtBranch` in `packages/domain/src/availability.ts`). It changes in more than thirty places: online payment (`apps/api/src/payments/reconcile.ts`, both `applyPaymentConfirmation` and `applyOfflinePayment`), the till (`routes/sales.ts`: reserve, pay, edit, cancel), checkout reservations (`public-orders.ts`), transfers received (`routes/transfers.ts`), returns, daily close, shift open, adjustments (`routes/inventory.ts`), preorder fulfilment (`preorder-shared.ts`), cancel and refund (`payments-admin.ts`), and unpaid-order expiry in the worker. It also changes **with no write at all** when a reservation's `expires_at` passes. Hooking every site would be fragile and still miss the last case. Instead the worker recomputes every item once a minute and pushes only what differs (section 6.1). The seven calls above only make price and visibility changes arrive in seconds instead of a minute.

**Why not `outbox_event`.** `drainOutbox` in `apps/worker/src/outbox.ts` formats every row for Telegram, and its `default` branch sends unknown event types to the owner's chat. It also runs on the shop loop, which `inbox-loop.ts` says must never wait on Meta. A flag on `catalogue_link` read by a job on the inbox loop avoids both. The outbox **is** used here for owner alerts (section 6.5).

## 6. Worker

Add to `jobs` in `apps/worker/src/inbox-loop.ts` (each runs under `withJobLock`, as every job there does). New file `apps/worker/src/jobs/catalogue.ts` holds thin wrappers that read config and call the domain functions. `storefrontBase` = `process.env.PUBLIC_CUSTOMER_URL || (process.env.PUBLIC_ADMIN_URL ?? "https://www.mrssamuel.com").replace("admin.", "www.")`, trailing `/` removed (the same derivation as `createCheckout`).

| Job name | Every | Function |
|---|---|---|
| `catalogue_sync` | 10 s | `runCatalogueSync(db, log)` |
| `catalogue_batch_check` | 20 s | `runCatalogueBatchCheck(db, log)` |
| `catalogue_reconcile` | 30 min | `runCatalogueReconcile(db, log)` |
| `catalogue_chat_orders` | 10 s | `runChatOrderPrompts(db, log)` then `runOrderUpdates(db, log)` |

All four return at once when `metaConfigFromEnv()` is null or there is no `catalogue_link` row.

### 6.1 `runCatalogueSync`

Skip unless `sync_enabled` and `problem_kind` is not `'config'`. Run a pass when **any** of: `sync_requested_at > coalesce(last_sync_at, '-infinity')`; `full_sync_requested_at` is set; `last_sync_at` is null or older than 60 s. Skip while any `catalogue_batch` is `queued` or `open` (one batch in flight at a time). A pass (`syncCatalogue`):

1. `desired = computeDesiredItems(db, { storefrontBase })`.
2. In one transaction, upsert `catalogue_item_sync` by `(link_id, retailer_id)`: set `variant_id`, `product_id`, `title`, `desired`, `desired_hash`, `blocked_reason`. Then per row: `blockedReason` set → `state = 'blocked'`; `desired_hash = pushed_hash` → leave the state alone; state `rejected` with an unchanged `desired_hash` → leave it; otherwise `state = 'pending'`. Rows whose variant no longer appears in `desired` at all are treated as `data = null`.
3. A row with `data = null` that was never pushed (`pushed_hash` null) → `state = 'removed'`, no request.
4. Take all `pending` rows (all non-blocked rows when `force`), at most 500. If none: set `last_sync_at = now()`, clear `full_sync_requested_at`, stop.
5. Insert a `catalogue_batch` row (`state = 'queued'`, `kind`, `item_count`) and set the rows to `state = 'sent'`, `batch_id`. **Commit before calling Meta** (rule 9: local row first).
6. `sendItemsBatch`. Then:
   - Success with a handle: batch `state = 'open'`, `handle`, `sent_at`. For each entry of `validation` that has errors: that item → `rejected`, `problem_message = errors.map(e => e.message).join("; ")`.
   - Success with no handle ("nothing has been ingested"): batch `failed`; items listed in `validation` → `rejected`; the rest → `pending`, `attempts + 1`.
   - `MetaApiError` with `delivery = "unknown"` (timeout): batch `lost`; items back to `pending`. Sending them again is harmless because every request is an upsert or a delete keyed by `id`.
   - `classifyMetaError` = `temporary`: batch `failed`; items `pending`; do not run another pass for `min(30 s × 2^n, 15 min)` where `n` is the number of consecutive failed batches (count from `catalogue_batch`).
   - `config`: batch `failed`; items `pending`; set `problem_kind = 'config'` with code and message; raise the owner alert (6.5).
   - Any other refusal: batch `failed` with code and message; items `rejected` with that message.
7. Set `last_sync_at = now()`; clear `full_sync_requested_at` when `kind = 'full'`.

### 6.2 `runCatalogueBatchCheck`

For each batch in `open`: `checkBatch`. `status === "finished"` → items in `ids` (`invalidIds` plus `errors[].id`) → `rejected` with the matching message (or `Meta refused this item` when none); every other item of the batch still in `sent` → `live` if its `desired` is not null, `removed` if null; set `pushed_hash = desired_hash`, `pushed_at`, `checked_at`, clear `problem_*`; batch `finished`, `errors_total`, `result`. Any other status → `checks + 1`; after 60 checks (about 20 minutes) batch `lost`, items back to `pending`. A temporary error counts as a check. A config error is handled as in 6.1.

### 6.3 `runCatalogueReconcile` (nightly)

Run only when the Lagos hour is 2 and `last_reconcile_at` is null or more than 20 hours old. Steps: `listMetaItems` (follow `paging.next`, at most 50 pages). Then: an item we hold as `live` that Meta does not list → `state = 'pending'`, `pushed_hash = null`; an item Meta lists with our prefix `v-` that we do not hold or hold as `removed` → queue a DELETE; items without our prefix are **left alone** and counted as `unmanaged`; where Meta's `review_status` is `rejected` → our row `rejected`, `review_status`, `problem_message` from Meta's `errors`/`review_rejection_reasons`; `approved` on a row we hold as `rejected` for review reasons → `live`. Then `syncCatalogue({ force: true, kind: "reconcile" })`. Set `last_reconcile_at`. Log the three counts.

### 6.4 `runChatOrderPrompts` and `runOrderUpdates`

`runChatOrderPrompts`: rows with `next_prompt` not null, `prompt_attempts < 3`, updated in the last 23 hours, oldest first, limit 10. Send R24, R25 or R26 with `sendFromConversation(db, cfg, { conversationId, userId: null, content: { type: "interactive" | "text", … } })`. Message status `sent` → `next_prompt = null` (and `state = 'asked'` after the fulfilment question). Status `failed` → `prompt_attempts + 1`, `problem` = the message's error text. An `InboxSendError` (`window_closed` and the rest) → `next_prompt = null`, `problem` set; do not retry.

`runOrderUpdates`: only when `order_updates_enabled`. Select `catalogue_chat_order` joined to `sale_order` where `state = 'placed'`, `sale_order.status IS DISTINCT FROM last_notified_status`, `notify_attempts < 3`, order created in the last 14 days; limit 20. For each, look the new status up in R29's table. No message for it → just set `last_notified_status`. Otherwise send (R30), then set `last_notified_status` and `notify_attempts = 0`; on failure `notify_attempts + 1` and `problem`; at 3 give up for that status (set `last_notified_status` anyway so later statuses still go out).

### 6.5 Owner alerts

On a `config` problem insert an `outbox_event` `{ eventType: "catalogue.sync_blocked", payload: { code, message } }` unless one was created in the last 24 hours (copy the check in `alertUnknownNumbers`, `apps/api/src/routes/webhooks-whatsapp.ts`). Add to `format()` in `apps/worker/src/outbox.ts`:

```ts
case "catalogue.sync_blocked":
  return { chatIds: [owner], text: `🛍️ *Catalogue sync stopped*\nMeta refused our access (${p["code"]}): ${p["message"]}\n👉 ${SUITE_URL}/catalogue` };
```

with `const SUITE_URL = ADMIN_URL.replace("admin.", "suite.");` beside `ADMIN_URL`.

## 7. Screens

### 7.1 Menu and route (suite)

In `apps/suite/src/SuiteShell.tsx` widen `NavItem["to"]` with `"/catalogue"` and add a section `{ heading: "Selling", items: [{ to: "/catalogue", label: "Catalogue", Icon: ShoppingBag, cap: "catalogue.manage" }] }` between "Conversations" and "Insight". In `apps/suite/src/router.tsx` add `const CataloguePage = lazyNamed(() => import("./features/catalogue/CataloguePage.js"), "CataloguePage");` and a route `path: "/catalogue"`, `component: () => page(<CataloguePage />)`, added to `routeTree`.

Files in `apps/suite/src/features/catalogue/`: `CataloguePage.tsx`, `ConnectCatalogueDialog.tsx`, `ItemProblemDialog.tsx`, `catalogue-api.ts` (calls and `catalogueKeys`, in the style of `@admin/lib/inbox-api.js`), `catalogue-logic.ts` and `catalogue-logic.test.ts` (pure: state labels, sort order, banner choice).

### 7.2 Catalogue page (`/catalogue`)

Title **Catalogue**. Sub-line: `Your juices on WhatsApp. The suite copies them from the shop; you never type them into Meta.`

- **No permission:** `You don't have access to the catalogue. Ask the owner.`
- **Loading:** `DataState` loading. **Error:** `We couldn't load the catalogue. Check your connection and try again.` with **Try again**.
- **Server has no Meta token** (`configured: false`): `WhatsApp is not connected on this server yet, so there is nothing to sync.`
- **Not linked:** a card: heading `Connect your catalogue`, text `Create one catalogue in Meta Commerce Manager, give the suite's system user full control of it, then paste its ID here. The steps are in the help note below.`, a collapsed "How to do this in Meta" list (section 2, steps 1 to 3), field **Catalogue ID** (hint `A long number, for example 123456789012345`), button **Connect**. Errors under the field: `That doesn't look like a catalogue ID. It should be numbers only.` / `Meta wouldn't let us open that catalogue. Check the ID, and check the system user has full control of it. (Meta said: <message>)`.
- **Linked.** Header card with the catalogue name and ID, then five lines, each with its state and one action:
  1. `WhatsApp: connected` or `WhatsApp: not connected` + button **Connect to WhatsApp**. Confirm dialog (rule 7): title `Connect this catalogue to WhatsApp?`, body `Customers will be able to see your menu in WhatsApp and send you a cart. This connects “<name>” to your WhatsApp account and turns on the cart and the menu button on your number.`, buttons **Connect** / **Cancel**.
  2. Switch **Keep WhatsApp in step with the shop**. Off text: `Off. Nothing is being sent to Meta.` On text: `On. Last checked <time, Lagos>.`
  3. Switch **Show the menu button on our WhatsApp profile** (`is_catalog_visible`) and switch **Let customers send a cart** (`is_cart_enabled`).
  4. Switch **Ask “delivery or pickup?” automatically when a cart arrives** (owner only; others see it greyed with `Only the owner can change this.`).
  5. Switch **Tell customers when their order is paid, on its way and delivered** (owner only). When a template is not approved, a warning under it: `These messages need approved WhatsApp templates. Missing or not approved: <names>. Until then, updates are only sent while the customer's 24-hour chat window is open.`
- **Banners** (one at most, first that applies): config problem (red) `Meta has stopped accepting our updates: <plain>. Nothing will sync until this is fixed. (Meta code <code>)`; no online branch (amber) `No branch is set to take online orders, so every juice shows as out of stock. Choose one in the shop admin under Branches.`; temporary problem (amber) `Meta is busy. We will try again shortly.`
- **Counts row:** `Live <n>` · `Waiting <pending+sent>` · `Needs attention <rejected+blocked>` · `Hidden <removed>`; each is a filter. Search box `Search juices`.
- **Buttons:** **Sync now** (toast `Sync started. Changes reach WhatsApp in about a minute.`) and, in a "More" menu, **Send everything again** (confirm: `Send all <n> items to Meta again? Use this only if WhatsApp looks wrong. It can take a few minutes.`) and **Disconnect this catalogue** (confirm: `Stop syncing and forget this catalogue? Items already in Meta stay there until you delete them in Commerce Manager.`).
- **Table** (cards at 390 px): picture, **Juice** (title), **Price** (`₦1,500`), **Stock** (`In stock` / `Out of stock`), **On WhatsApp** (badge), **Last sent**. Badge text by state: `live` → `Live`; `pending` → `Waiting to send`; `sent` → `Sent, waiting for Meta`; `rejected` → `Refused by Meta`; `blocked` → `Not sent`; `removed` → `Hidden`. Rows that are `rejected` or `blocked` show the plain reason under the title and a **Why?** link opening `ItemProblemDialog`: the plain reason, `What Meta said: “<raw>”` (when there is one), what to do, and **Try again** (toast `We'll send it again now.`).
- **Empty:** `No juices yet. Add flavours and sizes in the shop admin and they will appear here.` Empty after a filter: `Nothing matches.`

### 7.3 Inbox: sending products (shared screens, in `apps/admin/src`)

New `components/inbox/ProductPicker.tsx`, opened by a new **Products** button (bag icon, `aria-label="Send products"`) in `components/inbox/Composer.tsx`, shown only when the conversation's channel is WhatsApp and `GET /v1/catalogue/sendable` returns a `catalog_id`. Add `catalogueSendable`, `chatOrders`, `askChatOrder`, `placeChatOrder`, `sendPaymentLink`, `cancelChatOrder` to `lib/inbox-api.ts` and keys to `inboxKeys`.

Dialog title `Send products`. Search box `Search juices`. A tick list: picture, title, price, and `Out of stock` in grey where it applies (still selectable). Counter `<n> of 30 chosen`. Optional field **Message** (placeholder `Add a short note (optional)`). Buttons: **Send <n> product(s)**, **Send our whole menu**, **Cancel**. When the 24-hour window is closed the send buttons are disabled with `You can only send products within 24 hours of the customer's last message. Send a template first.` Errors as toasts: `That juice is no longer in the catalogue. Refresh and choose again.` / `WhatsApp refused this: <plain>.` Empty list: `No products are live on WhatsApp yet. Check the Catalogue page.`

### 7.4 Inbox: the cart beside the chat

New `components/inbox/ChatOrderCard.tsx`, shown at the top of `components/inbox/ContactPanel.tsx` when `GET /v1/inbox/chat-orders?conversation_id=` returns rows (refetch on the stream's `message.created` and `conversation.updated` for that conversation). One card per row, newest first.

- Heading by state: `new` → `Cart received`; `asked` → `Waiting for: delivery or pickup`; `awaiting_address` → `Waiting for the delivery address`; `ready` → `Ready to create the order`; `placed` → `Order <order_number>`; `cancelled` → `Cart dismissed`.
- Lines: `2 × Pineapple Ginger 330ml — ₦3,000`. Notes on a line: `Price in WhatsApp was ₦1,400. The shop price is used.` (when `price_differs`); `No longer sold. Remove it to continue.` (not sellable); `Out of stock: this will become a made-to-order (preorder) order.` (sellable, not in stock). Then `Subtotal ₦…` and, if present, `Customer's note: “…”`.
- Buttons before placing: **Create order…**, **Ask: delivery or pickup?** (only in `new` and `asked`), **Dismiss** (confirm `Dismiss this cart? The customer is not told.`).
- After placing: a status chip (`Waiting for payment`, `Paid`, `Out for delivery`, `Ready / handed over`, `Delivered`, `Cancelled`, `Payment needs checking`), total, **Send payment link again** (only while awaiting payment), and a link **Open in shop admin**.
- Without `orders.manage`, **Create order…** is disabled with `You need order permission to create orders.`

New `components/inbox/PlaceOrderDialog.tsx`, title `Create order from cart`:

- Editable lines (quantity stepper 1–99, remove). Not-sellable lines must be removed before the button enables.
- Radio **How will they get it?** `Delivery` / `Pickup at <online branch name>` (preselected from the customer's answer).
- **Delivery address** (textarea; prefilled from the customer's answer, else their saved address). Error: `Enter the full address: house number, street, area and city.`
- **Delivery fee (₦)** (whole number, default 0), help text `Enter what you agreed with the customer. Leave 0 if delivery is free or will be settled separately.` Hidden for pickup.
- **Note for the shop** (optional).
- Summary: `Subtotal`, `Delivery`, `Total`.
- A box **The customer will receive:** with the exact R27 text and a `Pay now` button drawn under it (rule 7).
- Buttons **Create order and send payment link** / **Cancel**. Success toast: `Order <number> created. Payment link sent.` With a warning: the server's `warning` text. Errors: `No branch is set to take online orders. Ask the owner to choose one in the shop admin.` / `This customer has no usable phone number.` / `One of these juices can no longer be ordered. Remove it and try again.`

Timeline: an incoming `order` message shows its `body` as a normal bubble with a small bag icon; outgoing `interactive` messages show `body` (the preview). If `Timeline.tsx` switches on type, add `order` to the text case. No other timeline change.

## 8. Rules and edge cases

**Items**

- R1. One Meta item per size (`product_variant`), not per flavour. Reason: price, stock and the cart are all per size (`product_price.variant_id`, `stock_ledger.variant_id`, `cart_line.variant_id`, `sale_order_item.variant_id`). `item_group_id = product.id` lets Meta show sizes of one flavour together.
- R2. `retailer_id = "v-" + product_variant.id`. The id never changes; `sku` and `slug` are editable text and are not used. `title = \`${product.name} ${size_ml}ml\`` cut to 100 characters.
- R3. `description` = the first non-empty of `product.story`, `product.tagline`, `"Made with " + ingredients.join(", ") + "."`, `\`${product.name} fruit juice, ${size_ml}ml.\``; strip HTML tags and URLs; collapse white space; if it has no lower-case letter, convert to sentence case; cut to 5000.
- R4. Picture = `product.image_url`, else the `media_asset.url` of `product.bottle_asset_id`. A value starting with `/` gets `storefrontBase` in front (seeded pictures are stored as `/media/bottles/…`). None, or not `http(s)` after that → `blockedReason = "no_picture"`.
- R5. A size is **sellable** when `product.is_active`, `product.deleted_at IS NULL`, `product_variant.is_active`, `product_variant.deleted_at IS NULL`, and it has an open price row (`product_price.valid_to IS NULL`; if several, the latest `valid_from`) with `price_ngn > 0`. This is the storefront's own rule (`variantsByProduct` in `apps/api/src/routes/public-catalog.ts`) plus the positive-price check. Active and visible but no positive price → `blockedReason = "no_price"`. Not sellable for any other reason → `data = null`.
- R6. `availability = "in stock"` only when an online branch exists, `availableVariantAtBranch(db, { branchId, variantId }) > 0`, and `product_variant.preorder_only` is false. Otherwise `"out of stock"`. No stock numbers are ever sent.
- R7. Bundles (`bundle` table) are **not** sent to Meta in this version. A cart line must become a `sale_order_item`, which needs `product_id` and `product_price_id` (both `NOT NULL`); a bundle has neither, no stock, and no contents list. Staff share a bundle as a normal picture and text, then build the order from sizes. The prefix `b-` is reserved for a later version.
- R8. Hidden, retired and deleted sizes are removed with a `DELETE` request, and created again by the normal upsert when they return. Every create and update uses `method: "UPDATE"` (upsert, `allow_upsert` default true); `CREATE` is never used, so a repeat can never fail with "already exists".
- R9. One batch in flight at a time; at most 500 requests per batch.
- R10. Items in Meta without the `v-` prefix are never touched.
- R11. A `rejected` item is not sent again until its `desired_hash` changes or a person presses Try again.
- R12. `plainProblem(raw, reviewStatus)`, first match wins (case-insensitive on `raw`):

| Match | Plain text |
|---|---|
| `reviewStatus = "rejected"` or raw has `policy`, `commerce`, `not allowed` | `Meta's review turned this item down under its selling rules. Open Commerce Manager to see why or to ask for another review.` |
| `image`, `photo`, `picture` | `Meta could not use this picture. It must be a JPG or PNG, at least 500 by 500 pixels and under 8 MB, at a web address anyone can open.` |
| `price`, `currency` | `Meta did not accept the price. Check the price in the shop admin.` |
| `link`, `url`, `domain` | `Meta did not accept the web address for this juice. Check the juice's page opens on the website.` |
| `title`, `name` | `Meta did not accept the name. Keep it under 100 characters and avoid ALL CAPITALS.` |
| `description` | `Meta did not accept the description. Use plain sentences with no web links.` |
| blocked `no_picture` | `This juice has no picture. Add one in the shop admin.` |
| blocked `no_price` | `This size has no price. Set one in the shop admin.` |
| account code 190 | `Our connection to Meta has expired.` |
| account codes 10, 200, 299 | `Meta says we do not have permission to manage this catalogue. Check the system user still has full control of it.` |
| anything else | `Meta refused this item. Its message was: “<raw>”` |

**Sync**

- R13. With `sync_enabled` false no request leaves the server, whatever else happens.
- R14. A price change in the shop admin reaches Meta within 30 seconds; a stock change within 90 seconds (60 s pass + 20 s check) when Meta is healthy.
- R15. A timeout on `items_batch` marks the batch `lost` and re-sends; safe because requests are upserts and deletes.
- R16. Running `syncCatalogue` twice with no shop change sends nothing the second time.
- R17. A `config` error stops all sync until a person fixes it; the next successful `GET /status` call that can reach the catalogue (`getCatalogue`) clears `problem_*`.

**Sending products**

- R18. Product, product-list and catalogue messages obey the 24-hour rule in `sendFromConversation`; outside it the server answers 409 `window_closed` as for text.
- R19. Only items in state `live` or `sent` can be sent.
- R20. One item → single product message; `text`, when given, is the body.
- R21. Two to thirty items → product list. Header `Mrs. Samuel Fruit Juice`. Body = `text` or `Here are the juices we talked about. Tap one to see it or add it to your cart.` Sections by `product.category`, in this order and with these titles: `regular` → `Juices`, `special` → `Specials`, `punch` → `Punch`; empty sections are left out.
- R22. Whole menu → catalogue message, body = `text` or `Tap below to see our full menu and order right here in WhatsApp.`

**Carts**

- R23. A cart is recorded once per `wa_message_id` (`ON CONFLICT DO NOTHING`); a replayed webhook creates nothing. When a new cart arrives, older rows for the same conversation in `new`, `asked`, `awaiting_address` or `ready` become `cancelled`. If `ask_fulfilment_auto` is on, the new row gets `next_prompt = 'fulfilment'`.
- R24. Fulfilment question (reply buttons). Body: `Thank you! We have your cart:\n<lines>\nSubtotal: <₦>\n\nHow would you like to get your order?` where each line is `• 2 × Pineapple Ginger 330ml — ₦3,000` at **shop** prices, lines that are not sellable are shown as `• <title> — no longer available`, and at most 12 lines are listed followed by `…and <n> more`. Buttons: id `co:<chat order id>:delivery` title `Delivery`; id `co:<chat order id>:pickup` title `Pickup`.
- R25. `applyChatOrderReply`: a `button_reply.id` matching `^co:([0-9a-f-]{36}):(delivery|pickup)$` for a row of **this** conversation in `new`, `asked`, `awaiting_address` or `ready` sets `fulfilment`. Pickup → `state = 'ready'`, `next_prompt = 'received'`. Delivery → `state = 'awaiting_address'`, `next_prompt = 'address'`. Address question text: `Please type your full delivery address in one message: house number, street, area and city.` Any other id is ignored. Returns true when it changed a row.
- R26. While a row for the conversation is `awaiting_address` and was updated in the last 24 hours, the next inbound `text` message of at least 10 characters becomes `address` (trimmed, cut to 500), `state = 'ready'`, `next_prompt = 'received'`. A `location` message is used the same way (its `body`). Shorter texts are ignored. Received text, delivery: `Thank you. A member of our team will confirm your order and send your payment link shortly.` Pickup: `Thank you. You can collect from <branch.name>, <branch.address>. A member of our team will confirm your order and send your payment link shortly.` Staff always see and can correct the address before placing, so a wrong capture costs nothing.
- R27. Payment message (link button). Body: `Your order <order_number> is ready.\n<lines>\n<Delivery: ₦… | Pickup at <branch name>>\nTotal: <₦>\n\nTap Pay now to pay safely with OPay. The link works for 30 minutes. If it stops working, tell us and we will send a new one.` Button `display_text`: `Pay now`; `url`: OPay's `redirectUrl`. Preview stored as the message body: `Sent payment link for <order_number> (<₦ total>)`.
- R28. Prices: every amount shown to the customer and stored on the order comes from `product_price` inside `placeOnlineOrder`. `item_price` from Meta is display-only (4.1). A test must prove a cart with `item_price: 1` still produces the shop total.
- R29. Status messages (after placing). Trigger = `sale_order.status` differing from `last_notified_status`:

| New status | Template | Body variables | Where the status is written today |
|---|---|---|---|
| `confirmed` | `order_confirmed` (only when the R27 message could not go because the window was closed) | name, order number, total, payment link | `placeOnlineOrder`; outbox event `sale.online_placed` (now emitted there) |
| `paid` | `order_paid` | name, order number, total | `applyPaymentConfirmation` and `applyOfflinePayment` in `apps/api/src/payments/reconcile.ts`; events `sale.paid_online` / `sale.preorder_paid` |
| `out_for_delivery` | `order_out_for_delivery` | name, order number | `applyDeliveryStatus` in `apps/api/src/delivery/apply-status.ts` (courier picked up) and `PATCH …/advance` in `apps/api/src/routes/sales.ts`. **Neither emits an event** |
| `delivered` | `order_delivered` | name, order number | `applyDeliveryStatus` (event `delivery.completed`), `PATCH …/advance` and `PATCH …/mark-delivered` in `sales.ts` (no event) |
| `handed_over`, `cancelled`, `failed`, `reconcile_needed` | none | — | recorded only |

  Because two of the four changes have no event, and `outbox_event` rows are consumed once by the Telegram drain, the trigger is the status comparison, not the events. It cannot miss a path and needs no change to shop code.
- R30. Template texts (category UTILITY, language `process.env.INBOX_TEMPLATE_LANGUAGE || "en"`, as the missed-call follow-up uses). `name` = the customer's first name or `there`:
  - `order_confirmed`: `Hello {{1}}, your Mrs. Samuel order {{2}} for {{3}} is ready. Pay here to confirm it: {{4}}`
  - `order_paid`: `Thank you {{1}}. We have received your payment of {{3}} for order {{2}}. We are preparing it now.`
  - `order_out_for_delivery`: `Hello {{1}}, your Mrs. Samuel order {{2}} is on its way to you.`
  - `order_delivered`: `Hello {{1}}, your Mrs. Samuel order {{2}} has been delivered. Enjoy! Reply here if anything is not right.`

  Sending: if the template is `APPROVED` in `inbox_template` for the line's WABA, send it (works inside and outside the window). If not approved and the window is open, send the same wording as a plain text. If not approved and the window is closed, send nothing and set `problem = "Template <name> is not approved"`. Whether a URL may be a body variable (`{{4}}`) is **[unverified]**; if Meta rejects the template, change it to a URL button with a dynamic suffix under spec 06.
- R31. One cart → at most one order: `idempotency_key` is unique on both tables and the place route locks the row.
- R32. Carts from a customer whose phone is missing (`from` absent) are not ingested at all today (`ingestMessage` returns false when `toE164` fails). Out of scope here; see Q8.
- R33. Staff may place an order whether or not the automatic questions were asked or answered.
- R35. Erasing a customer's inbox history (`POST /v1/inbox/contacts/:customerId/erase` in `inbox.ts`) deletes their conversations. `catalogue_chat_order.conversation_id` is `ON DELETE CASCADE`, so the cart rows go with them and the erase keeps working; the `sale_order` stays, as the route's comment already promises ("their customer record and orders are the shop's own records"). Merging two contacts (`POST …/contacts/:customerId/merge`) **deletes** a conversation when both contacts have a live one on the same line, which would cascade away its carts. So inside that route's transaction add: in the `if (clash)` branch, before `tx.delete(inboxConversation)`, `UPDATE catalogue_chat_order SET conversation_id = <clash.id>, customer_id = <intoId> WHERE conversation_id = <conv.id>`; in the `else` branch, `UPDATE catalogue_chat_order SET customer_id = <intoId> WHERE conversation_id = <conv.id>`.
- R34. Out-of-stock lines make the order a preorder exactly as on the storefront (`is_preorder` from `placeOnlineOrder`); the dialog warns before placing.

## 9. Tests

**`packages/domain/src/meta/catalogue.test.ts`** (unit, vitest)

- `metaPrice formats whole naira with two decimals and NGN`
- `retailerIdForVariant and variantIdFromRetailerId round-trip; foreign ids give null`
- `hashItem is stable and changes when price or availability changes`
- `buildBatchRequests uses UPDATE for data and DELETE with only id for null`
- `buildProductMessage has no header and carries catalog_id and product_retailer_id`
- `buildProductListMessage requires a text header and keeps section titles within 24 characters`
- `buildCatalogueMessage omits parameters when no thumbnail is given`
- `buildFulfilmentButtons has two buttons with ids co:<id>:delivery and co:<id>:pickup and titles within 20 characters`
- `buildPayButton display_text is "Pay now"`
- `parseOrderMessage reads lines, note and catalog id; tolerates decimal item_price and missing fields`
- `plainProblem maps picture, price, link, policy and unknown messages` (one case per row of R12)
- `classifyMetaError: 190/10/200/299 config; 4/17/32/613/80007/80008/80009/80014/429/5xx temporary; others refusal`

**`packages/domain/src/inbox/inbox.test.ts`** (extend)

- `parseInbound turns an order message into type order with a cart summary`
- `buildSendPayload passes an interactive object through unchanged`

**`apps/api/test/integration/catalogue-sync.test.ts`** (testcontainers; stub `globalThis.fetch` for `https://graph.facebook.com/` as `installGraphStub` does, answering `items_batch` with `{ handles: ["h1"], validation_status: [] }` and `check_batch_request_status` with `{ data: [{ handle: "h1", status: "finished", errors_total_count: 0, warnings: [], ids_of_invalid_requests: [] }] }`; seed with `seedCatalog`, `setOnlineDefaultBranch`, `addBranchStock`)

- `computeDesiredItems lists one item per active priced size with the storefront link and absolute picture URL`
- `a size with no stock at the online branch is out of stock; adding stock makes it in stock`
- `a live reservation that uses the last bottle makes it out of stock`
- `with no online branch every item is out of stock`
- `a retired size, an inactive flavour and a deleted flavour all give data null`
- `a flavour with no picture is blocked and never sent`
- `syncCatalogue sends one UPDATE per changed item and nothing on a second pass`
- `publishing a price through POST /v1/products/:id/prices sets sync_requested_at and the next pass sends the new price`
- `hiding a flavour through PATCH /v1/products/:id sends a DELETE for each of its sizes`
- `checkOpenBatches marks items live, and an item in ids_of_invalid_requests rejected`
- `validation_status errors mark only that item rejected`
- `a timeout marks the batch lost and the items pending`
- `error 80014 leaves items pending and backs off`
- `error 200 sets a config problem, queues one catalogue.sync_blocked alert, and a second failure within 24 hours queues none`
- `sync_enabled false makes no Graph call`
- `reconcile deletes a v- item Meta has that we do not, re-sends one Meta lost, and leaves unprefixed items alone`

**`apps/api/test/integration/catalogue-routes.test.ts`**

- `GET /v1/catalogue/status needs catalogue.manage (403 for a manager, 200 for an admin)`
- `POST /link stores the catalogue, refuses a second, and returns 422 with a plain message when Meta refuses`
- `POST /connect-whatsapp calls product_catalogs then whatsapp_commerce_settings and writes an audit row`
- `PATCH /settings refuses order_updates_enabled for a non-owner`
- `POST /items/:id/retry puts a rejected item back to pending`
- `GET /sendable needs inbox.reply and lists only live and sent items`

**`apps/api/test/integration/catalogue-chat-order.test.ts`** (build webhook payloads like `inboundPayload` in `inbox-whatsapp.test.ts`, with `type: "order"`; set `OPAY_*` env and stub the OPay host as `checkout-opay-failure.test.ts` does)

- `an order webhook stores an order message and one catalogue_chat_order; replaying it creates nothing`
- `a second cart cancels the first open one`
- `GET chat-orders reprices from the shop and flags price_differs`
- `with ask_fulfilment_auto on, the worker step sends the buttons once`
- `a Delivery button reply moves to awaiting_address and the next text becomes the address`
- `a Pickup button reply moves to ready`
- `a button reply carrying another conversation's id is ignored`
- `POST place creates a sale_order with channel online, shop prices, reservations and a sale.online_placed event, and sends a cta_url message with the OPay link`
- `POST place with a cart item_price of 1 still charges the shop price`
- `POST place twice returns the same order number and creates one order`
- `POST place for pickup has delivery fee 0 and no delivery address`
- `POST place fills default_address only when it was empty`
- `POST place when OPay is down returns 201 with payment_link null and a warning; the order exists`
- `POST place needs orders.manage (403 without)`
- `POST place returns 404 for a conversation the viewer cannot see`
- `POST place adds the label order to the conversation`
- `product send: one id builds a product message, three build a product_list, and a non-live id is refused`
- `product send outside the 24-hour window is refused with window_closed`
- `runOrderUpdates sends order_paid once when the order becomes paid, and nothing when order_updates_enabled is off`
- `runOrderUpdates with an unapproved template and an open window sends plain text; with a closed window sends nothing and records the problem`
- `the unpaid-order expiry cancels an unpaid chat order like any online order`
- `erasing a customer's inbox history removes their cart rows and leaves the sale order`
- `merging two contacts moves cart rows to the kept customer`

**Existing tests that must pass untouched:** `online-order.test.ts`, `online-order-schedule.test.ts`, `checkout-opay-failure.test.ts`, `public-cart.test.ts`, `inbox-whatsapp.test.ts`, `products.test.ts`.

**Front end:** `apps/suite/src/features/catalogue/catalogue-logic.test.ts` (`badge text for each state`, `sort puts refused and not-sent first`, `banner choice: config beats no-branch beats temporary`); `apps/admin/src/lib/inbox-logic.test.ts` gains tests for two new pure helpers placed in `inbox-logic.ts`: `chatOrderHeading(state)` and `cartLineNote(line)`.

## 10. Manual check

With a tester phone that has a role on the Meta app, after section 2's steps:

1. Suite → Catalogue → paste the ID → Connect. The header shows the catalogue name.
2. Turn on "Keep WhatsApp in step with the shop". Within two minutes every juice size is `Live`. Open Commerce Manager: the same items, with names like "Pineapple Ginger 330ml", prices in ₦ and pictures.
3. Press "Connect to WhatsApp" and confirm. On the tester phone open the business chat: the menu (shop) button appears on the profile.
4. Shop admin → change one price. Within a minute the Catalogue page shows the new price and Commerce Manager agrees. Change it back.
5. Shop admin → hide a flavour. Within a minute its sizes show `Hidden` and are gone from Commerce Manager. Unhide; they return as `Live`.
6. Sell the last bottle of one size at the online branch (or adjust stock to 0). Within two minutes it is "Out of stock" on the Catalogue page and in WhatsApp. Add stock; it returns.
7. Remove a flavour's picture. Its sizes show `Not sent` with "This juice has no picture." Put it back and press Try again.
8. From the tester phone send "hi". In the suite open the chat → Products → pick one → Send; then pick three → Send; then "Send our whole menu". All three arrive and open correctly.
9. On the phone add two juices to the cart and send it with a note. The chat shows "Sent a cart…" and the cart card appears with shop prices.
10. Press "Ask: delivery or pickup?". Tap Delivery on the phone, then type an address. The card shows "Ready to create the order" with the address.
11. Create order… → fee 500 → check the preview → Create. The phone receives the payment message; "Pay now" opens OPay. The shop admin shows the order as online, awaiting payment.
12. Pay with OPay's test method (or record a payment in the shop admin). With order updates on and templates approved, the phone gets "payment received". Advance the order; the phone gets "on its way", then "delivered".
13. Send a second cart and leave it unpaid for 60 minutes: the order is cancelled by the normal expiry.
14. At 390 px wide, repeat steps 1, 8 and 11.

## 11. Done when

- [ ] Migration 0077, journal entry and Drizzle schema are in; `pnpm typecheck` and `lint` pass.
- [ ] `catalogue.manage` exists and is granted to owner and admin.
- [ ] `placeOnlineOrder` is the only place a storefront or chat order is created; the untouched storefront tests pass.
- [ ] All tests in section 9 exist and pass; no test calls the real Meta or OPay.
- [ ] The seven `requestCatalogueSync` calls are in place; no other shop file changed.
- [ ] `/catalogue` works at desktop and 390 px in every state of 7.2.
- [ ] Products can be sent from a chat; a cart becomes a shop order with an OPay link; the label `order` is added.
- [ ] No token, OPay key or customer data appears in logs, fixtures or responses.
- [ ] Every send that could be harmful twice writes its local row first (batch row, message row).
- [ ] The pull request lists which **[unverified]** facts were checked and what Meta actually returned.

## 12. Out of scope

Bundles as catalogue items; product pictures made specially for Meta (white background); more than one catalogue or WhatsApp account; live courier quotes in chat (staff type the fee); scheduled delivery dates chosen in chat; WhatsApp Flows for the address (spec 07 can replace R25 and R26 by filling `fulfilment` and `address` on the same row and setting `state = 'ready'`); in-chat payments and checkout templates (not offered in Nigeria, 3.5); Messenger and Instagram shops; reporting purchases to Meta (blueprint stage 15); customers without a phone number (R32); telling the customer about a cancelled order.

## 13. Work order

1. Permission `catalogue.manage` (5.1). Build packages.
2. Migration 0077, journal, Drizzle schema, schema index export. Run the migration test set-up once.
3. `catalogue.ts` pure parts: ids, price, hash, builders, `parseOrderMessage`, `plainProblem`, `classifyMetaError`, with unit tests.
4. `computeDesiredItems` and `requestCatalogueSync`, with the first six integration tests.
5. Graph calls and `syncCatalogue`, `checkOpenBatches`, `reconcileCatalogue`; rest of `catalogue-sync.test.ts`.
6. Worker jobs `catalogue_sync`, `catalogue_batch_check`, `catalogue_reconcile`; the owner alert and its `format()` case.
7. The seven `requestCatalogueSync` calls in `products.ts` and `branches.ts`; run `products.test.ts`.
8. `catalogue.ts` routes and `catalogue-routes.test.ts`; register in `test-app.ts`.
9. Suite: nav, route, `features/catalogue/*`; check at 390 px.
10. Extract `placeOnlineOrder`; run the untouched storefront tests. **Stop here for review before going on** (money path).
11. `OutboundContent` interactive, `send.ts`, `SendBody` product and catalogue; tests.
12. `parseInbound` order case, `recordChatCart`, `applyChatOrderReply`, `priceChatCart`; ingest tests.
13. `inbox-chat-orders.ts` routes, including place and payment-link; tests.
14. Worker job `catalogue_chat_orders` (prompts, order updates); tests.
15. Inbox screens: `ProductPicker`, `ChatOrderCard`, `PlaceOrderDialog`, `inbox-api.ts`, logic helpers and tests.
16. Manual check (section 10) with the Graph stub off against the tester phone; note results for every [unverified] fact.

## 14. Open questions

| # | Question | Recommended default (use this unless told otherwise) |
|---|---|---|
| Q1 | Can a catalogue be connected to Meta's *test* WhatsApp account? [unverified] | Try it. If refused, ship everything, leave "Connect to WhatsApp" showing Meta's refusal in plain words, and repeat when the real number is added |
| Q2 | Should chat orders use `sale_order.channel = 'whatsapp'` (the enum has it) so reports split them out? | No: `online`. `whatsapp` is used by the till for counter orders and is skipped by expiry, payment sweep, reminder, queue and `advance`. Report chat orders by joining `catalogue_chat_order` |
| Q3 | Should made-to-order sizes (`preorder_only`) show as in stock so they can be put in a cart? | No: out of stock (the brief asks for in stock or out of stock only). Staff can still build a preorder in the dialog |
| Q4 | Delivery fee in chat: typed by staff, or a live courier quote as on the website? | Typed by staff, default 0. A live quote needs the customer to pick a courier, which chat cannot do simply |
| Q5 | Should "Ask delivery or pickup automatically" be on by default? | Off (rule 7). The owner turns it on once the wording has been seen working |
| Q6 | Does `google_product_category` have to be sent, and is the juice category name accepted? [unverified] | Send it. If Meta rejects the value, drop the field (the batch page lists it as optional) and note it in the pull request |
| Q7 | The brief suggested reacting through `outbox_event`. This spec uses a flag on `catalogue_link` plus a one-minute comparison (5.7) | Keep the flag. It is the only way to catch stock that returns when a reservation expires, and it keeps Meta calls off the shop loop |
| Q8 | WhatsApp can now deliver messages with no phone number (usernames, `from_user_id`). Today such messages are dropped by `ingestMessage` | Out of scope here; raise with spec 01, which owns identities (`inbox_identity` should gain the WhatsApp business-scoped user ID) |
| Q9 | Drizzle's migrator runs a migration only if its journal `when` is later than the newest one already applied. If spec 13 (0081) is merged before this one, 0077 would be **skipped silently** | Merge specs in number order, or at merge time set `when` to a value later than every entry already on `master`. Tes should check this on every suite migration |
| Q10 | **Foundation differences.** (a) Foundation section 6 lists two tables for this spec; this spec adds `catalogue_batch` and `catalogue_chat_order`, both under the reserved `catalogue_` prefix. (b) D10 lists `80007` as the only rate-limit code of its family; Meta's catalogue and WhatsApp-account pages document `80014`, `80009` and `80008`, which are treated as temporary here. (c) Rule 12 puts inbox-screen changes in `apps/admin`; the product picker and cart card follow that, the Catalogue page is suite-only | Accept as written |
| Q11 | Spec 02 may also extend `OutboundContent` and `sendFromConversation` for other channels | Whoever merges second keeps both members of the union; the `interactive` member is WhatsApp-only and `sendFromConversation` should refuse it for other channels with `no_whatsapp` |

---

## Built differently

Departures made while building this spec on `work/olu/suite-08-catalogue` (stacked on `work/olu/suite-05b-inbox-gaps`). Work-order task 16 (the manual check with a tester phone) and the 390 px check in task 9 were not done: no Meta account, Commerce Manager or browser was used. Every **[unverified]** fact in section 3 is therefore still **unchecked**. The integration tests were run against a local PostgreSQL 16, not Docker.

1. **Journal `idx` is 73, not 76.** The previous entry (0074) has `idx` 72. `when` is `1786800000000` as written.
2. **Foreign keys (ruling 9.2.8).** `catalogue_chat_order.customer_id` is `ON DELETE CASCADE`. Every pointer at `sale_order`, `admin_user`, `product` and `product_variant` is `ON DELETE SET NULL`, so these tables can never stop the shop deleting one of its own rows. The erase route also deletes cart rows explicitly; the merge route moves them as R35 says.
3. **`classifyMetaError` is named `classifyCatalogueError`** (ruling 9.2.5: one classifier per API, no shared names; spec 03 owns `classifyMetaError`). Code `283` is also configuration (C2), `80000`–`80009` and `80014` temporary (C3), and a call that never connected is temporary.
4. **Two domain files, not one.** `meta/catalogue.ts` holds sync; `meta/catalogue-chat.ts` holds carts, prices, the automatic questions and order updates (which the spec put in the worker). The worker's `jobs/catalogue.ts` only supplies configuration, so the rules can be tested from the API's integration tests. Customer wording lives in `packages/shared/src/catalogue.ts`, so the dialog shows exactly what the server sends. `MetaItemData` and `ChatCartLine` are declared in `packages/db` (the schema needs them) and re-exported.
5. **`plainProblem(raw, reviewStatus, extra?)`** takes the blocked reason and the account error code as a third argument, and checks them before the wording of `raw` (an access error's text can contain any item keyword).
6. **API error codes.** The API's code list is fixed, so the spec's codes (`catalogue_unreachable`, `already_linked`, `owner_only`, `catalogue_not_connected`, `item_not_in_catalogue`, `no_online_branch`, `no_phone`, `cart_cancelled`, `not_awaiting_payment`, `window_closed`, …) travel in `error.details.reason`, as specs 04, 05 and 10 do.
7. **The follow-up questions are behind the owner's switch too.** With `ask_fulfilment_auto` off, a customer's tap on Delivery or Pickup and their address are still recorded, but the address question and the thank-you (R25, R26) are not queued or sent; staff ask by hand. Foundation rule 7 and C6 allow no unattended customer message without a named owner switch. The switch's help text says so.
8. **Never twice.** Automatic questions and order updates claim the row before sending. A send with no answer from WhatsApp is never repeated; a certain refusal is retried up to three times. `POST /:id/place` claims `payment_link_sent_at` before calling OPay, so a double click or a retry returns the same order and sends no second link; `POST /:id/payment-link` refuses a second request within 30 seconds (`just_sent`).
9. **`POST /:id/place` checks every item is sellable today** (R5) before `placeOnlineOrder` runs, and answers 422 `item_not_sellable`. The storefront's own code accepts a hidden size; a chat order does not.
10. **Sync engine details.** All safety gates (no link, sync off, configuration problem, a batch in flight, waiting after failures) are inside `syncCatalogue`, not only in the worker. A batch left `queued` for two minutes (the process died before calling Meta) becomes `lost`. The wait after failed batches applies to `failed` and `lost` alike. `last_sync_at` is the start of the pass, so a change flagged during a pass gets its own pass. "Send everything again" re-sends refused items; the nightly forced pass does not (R11). A blocked item that Meta already holds is left there, as the spec says.
11. **`requestCatalogueSync` and the ingest hook cannot fail the shop.** Each runs under a savepoint and swallows any error: a product save or an incoming customer message is never lost because of the catalogue. A cart whose row was not written is recorded when the card is opened.
12. **Routes.** `GET /status` calls Meta only while a configuration problem is set (R17). `POST /link` also reads the commerce settings when the catalogue is already connected. `POST /connect-whatsapp` answers 200 with a `warning` when the connection worked but a commerce setting did not. `GET /inbox/chat-orders` also returns `online_branch` and `default_address` for the dialog. Product sends are audited as `inbox.send_product` instead of `inbox.message_send`.
13. **Product list previews** kept as the message body: `Product: <title>`, `Products (n): …`, `Our menu`, each followed by the text sent.
14. **Screens.** The Products button sits in the reply toolbar, which is hidden while the 24-hour window is closed; the dialog still shows the closed-window sentence if the window closes while it is open. The cart card subscribes to the live stream itself. The message preview in the create-order dialog shows "(order number)" where the number will be.
15. **Tests placed differently.** `parseOrderMessage` is tested in `catalogue-chat.test.ts`. The unpaid-order expiry test is in `apps/worker/test/catalogue-chat-orders.test.ts` (the job lives in the worker).
16. **Not stopped for review after task 10.** The extraction is its own commit (`refactor(checkout): move the storefront's order-creation transaction into placeOnlineOrder, unchanged`) so it can be reviewed or reverted alone.

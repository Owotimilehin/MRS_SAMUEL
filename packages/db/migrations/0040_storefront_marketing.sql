-- Storefront marketing + lead capture: bundles and subscription plans served
-- read-only to the site (WhatsApp CTA), plus lead tables for contact-form and
-- subscription enquiries. Display rows are owner-seeded; lead rows are written
-- by the public site and also emit outbox events.

CREATE TABLE "contact_message" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"       text NOT NULL,
  "email"      text NOT NULL,
  "phone"      text,
  "subject"    text NOT NULL,
  "message"    text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "subscription_plan" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"          text NOT NULL UNIQUE,
  "name"          text NOT NULL,
  "price_ngn"     integer NOT NULL,
  "period"        text NOT NULL,
  "bottles_label" text,
  "description"   text,
  "perks"         jsonb NOT NULL DEFAULT '[]'::jsonb,
  "popular"       boolean NOT NULL DEFAULT false,
  "display_order" integer NOT NULL DEFAULT 0,
  "is_active"     boolean NOT NULL DEFAULT true,
  "created_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "subscription_lead" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"       text NOT NULL,
  "phone"      text NOT NULL,
  "plan_slug"  text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "bundle" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"           text NOT NULL UNIQUE,
  "name"           text NOT NULL,
  "price_ngn"      integer NOT NULL,
  "description"    text,
  "contents_label" text,
  "badge"          text,
  "image_url"      text,
  "display_order"  integer NOT NULL DEFAULT 0,
  "is_active"      boolean NOT NULL DEFAULT true,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

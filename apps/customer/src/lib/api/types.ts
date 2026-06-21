// apps/customer/src/lib/api/types.ts
// Mirrors the JSON shapes returned by /v1/public/* endpoints.

export interface ApiVariant {
  id: string;
  size_ml: number;
  sku: string;
  price_ngn: number;
  preorder_only: boolean;
}

export interface ApiPalette {
  surface: string;
  accent: string;
  text: string;
}

export interface ApiIngredientDetail {
  name: string;
  benefit: string;
}

export interface ApiProduct {
  id: string;
  name: string;
  slug: string;
  category: "regular" | "special" | "punch";
  ingredients: string[];
  image_url: string | null;
  tagline: string | null;
  story: string | null;
  pairing: string | null;
  note: string | null;
  benefits: string[];
  best_for: string[];
  ingredient_details: ApiIngredientDetail[];
  palette: ApiPalette | null;
  bottle_url: string | null;
  cluster_url: string | null;
  fruit_url: string | null;
  price_ngn: number;
  variants: ApiVariant[];
}

export interface ApiBranch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_online_default?: boolean;
}

export interface ApiBlogSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  cover_url: string | null;
  published_at: string | null;
  author: string | null;
  read_mins: number | null;
  category: string | null;
  cluster: string | null;
}

export interface ApiBlogPost extends ApiBlogSummary {
  body_md: string;
}

export interface ApiBundle {
  id: string;
  slug: string;
  name: string;
  price_ngn: number;
  description: string | null;
  contents_label: string | null;
  badge: string | null;
  image_url: string | null;
}

export interface ApiSubscriptionPlan {
  id: string;
  slug: string;
  name: string;
  price_ngn: number;
  period: string;
  bottles_label: string | null;
  description: string | null;
  perks: string[];
  popular: boolean;
}

export interface ApiDeliveryOption {
  id: string;
  courier_name: string;
  fee_ngn: number;
  eta_minutes: number | null;
  on_demand: boolean;
}

export interface ApiQuote {
  provider: string;
  quote_token: string | null;
  address_valid: boolean;
  validated_address: { formatted: string; lat: number; lng: number } | null;
  options: ApiDeliveryOption[];
  notice?: string;
}

/** Init config for the Payaza checkout SDK, built server-side per order. */
export interface PayazaCheckoutConfig {
  reference: string;
  connectionMode: "Mock" | "Test" | "Live";
  merchantKey: string;
  amount: number; // kobo (naira × 100)
  currency: "NGN";
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export interface ApiPlacedOrder {
  id: string;
  order_number: string;
  total_ngn: number;
  payment: { provider: "payaza"; reference: string; payaza: PayazaCheckoutConfig };
}

export interface ApiSubscribeResult {
  subscription_id: string;
  payment: { provider: "payaza"; reference: string; payaza: PayazaCheckoutConfig };
}

export interface ApiOrderItem {
  name: string;
  size_ml: number | null;
  quantity: number;
  unit_price_ngn: number;
  line_total_ngn: number;
}

export interface ApiOrderTracking {
  order_number: string;
  status: string;
  payment_status: string;
  total_ngn: number;
  subtotal_ngn: number;
  delivery_fee_ngn: number;
  channel: string;
  created_at: string;
  scheduled_delivery_at: string | null;
  delivery_state: string | null;
  is_preorder: boolean;
  fulfilled_at: string | null;
  paid_at: string | null;
  out_for_delivery_at: string | null;
  delivered_at: string | null;
  reservation_expires_at: string | null;
  resume_payment: { reference: string; payaza: PayazaCheckoutConfig } | null;
  support_whatsapp: { number: string; url: string } | null;
  items: ApiOrderItem[];
  delivery: {
    status: string;
    rider_name: string | null;
    rider_phone: string | null;
    rider_vehicle: string | null;
    tracking_url: string | null;
    eta_minutes: number | null;
    provider: string;
  } | null;
}

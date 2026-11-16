/**
 * Local landing pages: /juice-delivery-lagos/<slug>.
 *
 * One entry = one indexable page targeting "fresh juice <area>" / "juice
 * delivery <area>" searches. Adding an area is a data-only change: the route,
 * sitemap and hub page all read from this list.
 *
 * RULES (Google ignores or penalises thin, near-duplicate "doorway" pages):
 *   - Only list an area the business ACTUALLY delivers to (check the branch's
 *     delivery zones in admin → Zones).
 *   - `intro` and `localNotes` must be written for THAT area — never copy
 *     another entry and swap the name.
 *   - Don't hard-code delivery fees here; fees live in admin and are shown at
 *     checkout. Quote timing only if it's true.
 */
export interface DeliveryArea {
  slug: string;
  /** Display name, e.g. "Ikeja". */
  name: string;
  /** Neighbourhoods/estates covered — helps match long-tail local searches. */
  neighbourhoods: string[];
  /** 2–3 sentences unique to this area. */
  intro: string;
  /** Area-specific practical notes (timing, landmarks, offices, events). */
  localNotes: string[];
}

export const DELIVERY_AREAS: DeliveryArea[] = [
  {
    slug: "ikeja",
    name: "Ikeja & Ajao Estate",
    // TODO(owner): confirm which nearby areas are covered before adding more.
    neighbourhoods: ["Ajao Estate", "Ikeja"],
    intro:
      "Our kitchen is at 30 Asa Afariogun Street, Ajao Estate, so Ikeja and Ajao Estate get the freshest bottles in Lagos. They are pressed in the morning, sent out cold, and in the fridge before the heat of the day.",
    localNotes: [
      "Closest to our kitchen, so this is our fastest delivery area. In-stock orders arrive the same morning or the next morning, depending on when you order.",
      "Prefer to collect? Walk in at Asa Afariogun Street, Ajao Estate. We're open Monday to Saturday 8am–8pm and Sunday 10am–8pm.",
      "Offices around Ikeja can order in bulk for staff, meetings and events. See our bulk orders page for crate pricing.",
    ],
  },
];

export function findArea(slug: string): DeliveryArea | undefined {
  return DELIVERY_AREAS.find((a) => a.slug === slug);
}

/**
 * Everything an area page (/juice-delivery-lagos/<slug>) shows, as plain
 * strings. The route renders exactly these strings, and `areas.test.ts` uses
 * `areaPageText()` to check every page's length and its overlap with every
 * other page — so the test measures what visitors and Google actually read.
 */
import { PUBLISHED_AREAS, type AreaFaq, type DeliveryArea } from "./areas";
import { SITE_URL } from "./seo";

/** Trust badges shown on every local landing page (hub and areas). */
export const LOCAL_BADGES = [
  "100% fruit. No added sugar, no water, no preservatives.",
  "Pressed in the morning, delivered cold.",
  "Made in our kitchen at Ajao Estate, Ikeja.",
] as const;

export function areaPath(a: DeliveryArea): string {
  return `/juice-delivery-lagos/${a.slug}`;
}

export function areaTitle(a: DeliveryArea): string {
  return `Fresh Juice Delivery in ${a.name}, Lagos | Mrs. Samuel`;
}

export function areaSubtitle(a: DeliveryArea): string {
  return `Cold-pressed fruit juice, delivered cold across ${a.neighbourhoods.join(", ")}.`;
}

export const areaHeadings = (a: DeliveryArea) => ({
  places: `Where we deliver in ${a.name}`,
  route: `How your order reaches ${a.name}`,
  occasions: `What ${a.name} orders juice for`,
  notes: "Good to know",
  nearby: "Nearby delivery areas",
  faqs: "Questions",
});

/** Neighbouring area pages that are live (drafts are never linked). */
export function nearbyAreas(a: DeliveryArea): DeliveryArea[] {
  return a.nearby
    .map((slug) => PUBLISHED_AREAS.find((p) => p.slug === slug))
    .filter((p): p is DeliveryArea => !!p && p.slug !== a.slug);
}

export function areaFaqs(a: DeliveryArea): AreaFaq[] {
  return a.faqs;
}

/** The copy written for this area alone (no shared badges or headings). */
export function areaOwnText(a: DeliveryArea): string {
  return [
    a.intro,
    ...a.about,
    ...a.places.flatMap((p) => [p.name, p.note]),
    ...a.route,
    ...a.occasions.flatMap((o) => [o.title, o.text]),
    ...a.localNotes,
    ...a.faqs.flatMap((f) => [f.q, f.a]),
  ].join("\n");
}

/** All visible page text except the live juice grid (which comes from the API). */
export function areaPageText(a: DeliveryArea): string {
  const h = areaHeadings(a);
  return [
    `Juice Delivery · ${a.name}`,
    `Fresh juice in ${a.name}`,
    areaSubtitle(a),
    a.intro,
    ...a.about,
    ...LOCAL_BADGES,
    h.places,
    ...a.places.flatMap((p) => [p.name, p.note]),
    h.route,
    ...a.route,
    h.occasions,
    ...a.occasions.flatMap((o) => [o.title, o.text]),
    ...(a.localNotes.length ? [h.notes, ...a.localNotes] : []),
    ...(nearbyAreas(a).length
      ? [h.nearby, ...nearbyAreas(a).map((n) => `Fresh juice in ${n.name}`)]
      : []),
    h.faqs,
    ...a.faqs.flatMap((f) => [f.q, f.a]),
    "Order fresh juice",
    "Ask on WhatsApp",
  ].join("\n");
}

/**
 * Service schema for one area page: what we do (fresh juice delivery), who
 * does it (the site-wide Organization/FoodEstablishment node) and where
 * (`areaServed`: the area and each neighbourhood, inside Lagos).
 */
export function areaServiceLd(a: DeliveryArea): object {
  const lagos = {
    "@type": "City",
    name: "Lagos",
    containedInPlace: { "@type": "Country", name: "Nigeria" },
  };
  const url = `${SITE_URL}${areaPath(a)}`;
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": `${url}#service`,
    name: `Fresh juice delivery in ${a.name}`,
    serviceType: "Fresh cold-pressed juice delivery",
    url,
    description: a.description,
    provider: {
      "@type": ["Organization", "FoodEstablishment"],
      "@id": `${SITE_URL}/#organization`,
      name: "Mrs. Samuel Fruit Juice",
      address: {
        "@type": "PostalAddress",
        streetAddress: "30 Asa Afariogun Street, Ajao Estate",
        addressLocality: "Ikeja",
        addressRegion: "Lagos",
        addressCountry: "NG",
      },
    },
    areaServed: [
      { "@type": "Place", name: `${a.name}, Lagos`, containedInPlace: lagos },
      ...a.neighbourhoods.map((n) => ({ "@type": "Place", name: n, containedInPlace: lagos })),
    ],
  };
}

/**
 * Local landing pages: /juice-delivery-lagos/<slug>.
 *
 * One entry = one indexable page targeting "fresh juice <area>" / "juice
 * delivery <area>" searches. Adding an area is a data-only change: the route,
 * sitemap and hub page all read from this list.
 *
 * RULES (Google penalises thin, near-duplicate "doorway" pages site-wide):
 *   - `published: true` ONLY for areas the owner confirms we deliver to
 *     (confirmed 16 Nov 2026: all of Lagos). Each needs its own intro and
 *     real neighbourhoods; tests enforce uniqueness. Add owner-supplied facts
 *     (regular estates/offices, events supplied) to `localNotes` over time —
 *     they're what lifts a page above competitors.
 *   - `intro` / `localNotes` are written for THAT area — never copy another
 *     entry and swap the name.
 *   - Never state a delivery fee: checkout prices delivery from a live courier
 *     quote for the exact address (admin zone fees are NOT what's charged).
 *
 * Unpublished entries are drafts: they 404, and are left out of the sitemap
 * and the hub page.
 */
export interface DeliveryArea {
  slug: string;
  /** Display name, e.g. "Lekki". */
  name: string;
  /** Live only when true — see RULES above. */
  published: boolean;
  /** Estates, streets and landmarks covered — real local search terms. */
  neighbourhoods: string[];
  /** 2–3 sentences unique to this area. */
  intro: string;
  /** Owner-supplied facts: regular deliveries, offices, events, timing. */
  localNotes: string[];
}

export const DELIVERY_AREAS: DeliveryArea[] = [
  {
    slug: "ikeja",
    name: "Ikeja & Ajao Estate",
    published: true,
    neighbourhoods: ["Ajao Estate", "Ikeja"],
    intro:
      "Our kitchen is at 30 Asa Afariogun Street, Ajao Estate, so Ikeja and Ajao Estate get the freshest bottles in Lagos. They are pressed in the morning, sent out cold, and in the fridge before the heat of the day.",
    localNotes: [
      "Closest to our kitchen, so this is our fastest delivery area. In-stock orders arrive the same morning or the next morning, depending on when you order.",
      "Prefer to collect? Walk in at Asa Afariogun Street, Ajao Estate. We're open Monday to Saturday 8am–8pm and Sunday 10am–8pm.",
      "Offices around Ikeja can order in bulk for staff, meetings and events. Request a quote on our bulk orders page.",
    ],
  },

  // ---- Owner confirmed all-Lagos delivery (16 Nov 2026); localNotes to come ----
  {
    slug: "isolo-okota",
    name: "Isolo & Okota",
    published: true,
    neighbourhoods: ["Isolo", "Okota", "Ago Palace Way", "Ejigbo", "Ilasamaja"],
    intro:
      "Isolo and Okota sit right next door to our Ajao Estate kitchen, so juice here comes out of the cold room and reaches you within a short ride. Homes along Ago Palace Way and the estates off Okota Road get the same morning-pressed bottles as our walk-in customers.",
    localNotes: [],
  },
  {
    slug: "lekki",
    name: "Lekki",
    published: true,
    neighbourhoods: ["Lekki Phase 1", "Admiralty Way", "Ikate", "Osapa London", "Agungi", "Chevron", "Jakande"],
    intro:
      "From Admiralty Way to Chevron Drive, Lekki runs on early gym sessions, long office days and weekend hosting. All three call for something better than a fizzy drink. We bring cold-pressed juice across the Lekki corridor, packed cold for the trip from the mainland.",
    localNotes: [],
  },
  {
    slug: "ajah",
    name: "Ajah & Sangotedo",
    published: true,
    neighbourhoods: ["Ajah", "Abraham Adesanya", "Sangotedo", "Badore", "Addo Road", "Thomas Estate"],
    intro:
      "Ajah, Sangotedo and Badore are full of family estates, and families go through juice fast. We deliver bundles and 650ml bottles to estates off Addo Road and Abraham Adesanya, so the fridge stays stocked for the school run and the weekend.",
    localNotes: [],
  },
  {
    slug: "victoria-island",
    name: "Victoria Island",
    published: true,
    neighbourhoods: ["Victoria Island", "Oniru", "Adeola Odeku", "Akin Adesola", "Ozumba Mbadiwe"],
    intro:
      "Victoria Island is Lagos's office district, with boardrooms on Adeola Odeku, banks on Akin Adesola, and back-to-back meetings everywhere. We deliver chilled bottles for desks, meeting rooms and client gifts across VI and Oniru.",
    localNotes: [],
  },
  {
    slug: "ikoyi",
    name: "Ikoyi",
    published: true,
    neighbourhoods: ["Ikoyi", "Bourdillon", "Awolowo Road", "Falomo", "Parkview Estate", "Banana Island"],
    intro:
      "Ikoyi homes on Bourdillon, Parkview and Banana Island order juice for their household, their guests and their trainers. We deliver cold-pressed bottles and gift boxes across Ikoyi and Falomo, packed cold all the way.",
    localNotes: [],
  },
  {
    slug: "lagos-island",
    name: "Lagos Island & Marina",
    published: true,
    neighbourhoods: ["Marina", "Broad Street", "CMS", "Obalende", "Tinubu Square"],
    intro:
      "Marina and Broad Street are where long trading days happen, and a cold bottle helps. We deliver to offices and shops across Lagos Island for staff, meetings and afternoon slumps.",
    localNotes: [],
  },
  {
    slug: "yaba",
    name: "Yaba",
    published: true,
    neighbourhoods: ["Yaba", "Sabo", "Akoka", "Onike", "Alagomeji", "Herbert Macaulay Way"],
    intro:
      "Yaba is startups, students and creatives, from the tech offices off Herbert Macaulay Way to the hostels around Akoka. We deliver single bottles for the desk and crates for team days and launches.",
    localNotes: [],
  },
  {
    slug: "surulere",
    name: "Surulere",
    published: true,
    neighbourhoods: ["Surulere", "Adeniran Ogunsanya", "Bode Thomas", "Aguda", "Ojuelegba"],
    intro:
      "Surulere loves a party, and Bode Thomas and Adeniran Ogunsanya don't slow down at weekends. We deliver fresh juice to homes across Surulere, plus chilled crates for owambes, birthdays and naming ceremonies.",
    localNotes: [],
  },
  {
    slug: "gbagada",
    name: "Gbagada",
    published: true,
    neighbourhoods: ["Gbagada Phase 1", "Gbagada Phase 2", "Ifako-Gbagada", "Soluyi", "Atunrase Estate"],
    intro:
      "Gbagada's estates, from Phase 1 and Phase 2 to Atunrase, are home to Lagos workers who leave early and get home late. We deliver to them so there's real fruit in the fridge. Order ahead and your juice is waiting cold when you're back.",
    localNotes: [],
  },
  {
    slug: "maryland",
    name: "Maryland & Anthony",
    published: true,
    neighbourhoods: ["Maryland", "Mende", "Anthony Village", "Onigbongbo", "Ikorodu Road"],
    intro:
      "Maryland, Mende and Anthony Village sit on the Ikorodu Road corridor, a short run from our kitchen. Fresh juice for homes and offices here leaves the cold room and arrives still chilled.",
    localNotes: [],
  },
  {
    slug: "magodo",
    name: "Magodo",
    published: true,
    neighbourhoods: ["Magodo Phase 1", "Magodo Phase 2", "Shangisha", "CMD Road"],
    intro:
      "Magodo Phase 1 and Phase 2 are quiet, gated and family-first. We deliver to homes there for daily drinking, weekend guests and celebrations, right to the gate.",
    localNotes: [],
  },
  {
    slug: "ogba-omole",
    name: "Ogba, Omole & Berger",
    published: true,
    neighbourhoods: ["Ogba", "Agidingbi", "Omole Phase 1", "Omole Phase 2", "Ojodu Berger"],
    intro:
      "From the Omole estates to Ogba and Agidingbi, homes and offices north of Ikeja can order fresh juice without the trip into town. Bottles travel cold from our kitchen and arrive ready to drink.",
    localNotes: [],
  },
  {
    slug: "festac",
    name: "Festac & Amuwo Odofin",
    published: true,
    neighbourhoods: ["Festac Town", "Amuwo Odofin", "Mile 2"],
    intro:
      "Festac Town's avenues and the Amuwo Odofin estates are a busy, close-knit part of Lagos. We deliver fresh juice there for family fridges and for the parties that fill the weekend calendar.",
    localNotes: [],
  },
];

export const PUBLISHED_AREAS: DeliveryArea[] = DELIVERY_AREAS.filter((a) => a.published);

/** Published areas only — drafts must 404. */
export function findArea(slug: string): DeliveryArea | undefined {
  return PUBLISHED_AREAS.find((a) => a.slug === slug);
}

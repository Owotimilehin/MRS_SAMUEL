/**
 * Local landing pages: /juice-delivery-lagos/<slug>.
 *
 * One entry = one indexable page targeting "fresh juice <area>" / "juice
 * delivery <area>" searches. Adding an area is a data-only change: the route,
 * sitemap and hub page all read from this list. The page layout lives in
 * `lib/area-page.ts` + `routes/juice-delivery-lagos.$area.tsx`.
 *
 * RULES (Google penalises thin, near-duplicate "doorway" pages site-wide):
 *   - `published: true` ONLY for areas the owner confirms we deliver to.
 *     Unpublished entries are drafts: they 404, and are left out of the
 *     sitemap and the hub page.
 *   - Every text field is written for THAT area. Never copy another entry and
 *     swap the name: `areas.test.ts` fails any pair of pages whose text
 *     overlaps by 30% or more (5-word shingles), and any page under 600
 *     words of its own copy.
 *   - Only well-known, checkable places (roads, estates, landmarks). No named
 *     customers, offices that order, testimonials or reviews unless the owner
 *     supplies them.
 *   - Never state a delivery fee or a delivery time in minutes/hours: checkout
 *     prices delivery from a live courier quote for the exact address (admin
 *     zone fees are NOT what's charged). Owner-supplied facts go in
 *     `localNotes` once they arrive (see docs/seo/LAGOS-AREAS.md).
 */
export interface AreaPlace {
  /** A real estate, road or landmark. */
  name: string;
  /** One line on why it matters for a delivery there. */
  note: string;
}

export interface AreaOccasion {
  title: string;
  text: string;
}

export interface AreaFaq {
  q: string;
  a: string;
}

export interface DeliveryArea {
  slug: string;
  /** Display name, e.g. "Lekki". */
  name: string;
  /** Live only when true — see RULES above. */
  published: boolean;
  /** Estates, streets and districts covered — real local search terms. Also the schema `areaServed`. */
  neighbourhoods: string[];
  /** Meta description, unique to this page, ≤155 characters. */
  description: string;
  /** Opening paragraph, unique to this area. */
  intro: string;
  /** Further paragraphs about the area and how we serve it. */
  about: string[];
  /** Estates, roads and landmarks we deliver around. */
  places: AreaPlace[];
  /** Typical route from the Ajao Estate kitchen (no times, no fees). */
  route: string[];
  /** What people in this area order juice for. */
  occasions: AreaOccasion[];
  /** Practical, area-specific tips; owner-supplied facts are added here. */
  localNotes: string[];
  /** Area-specific Q&As. Rendered on the page AND used for FAQPage schema. */
  faqs: AreaFaq[];
  /** Slugs of neighbouring area pages (linked only when published). */
  nearby: string[];
}

export const DELIVERY_AREAS: DeliveryArea[] = [
  // TODO(owner): for every area below, share (see docs/seo/LAGOS-AREAS.md):
  // the usual delivery window, estates/offices you deliver to regularly (only
  // ones happy to be named), events supplied there, photos and real reviews.
  {
    slug: "ikeja",
    name: "Ikeja & Ajao Estate",
    published: true,
    neighbourhoods: [
      "Ajao Estate",
      "Ikeja",
      "Allen Avenue",
      "Opebi",
      "Alausa",
      "Ikeja GRA",
      "Oregun",
    ],
    description:
      "Fresh cold-pressed juice in Ikeja and Ajao Estate, made on Asa Afariogun Street. Walk in, or get it delivered to Allen, Opebi, Alausa and the GRA.",
    intro:
      "Our kitchen is at 30 Asa Afariogun Street, Ajao Estate, so Ikeja and Ajao Estate get the freshest bottles in Lagos. They are pressed in the morning, sent out cold, and in the fridge before the heat of the day.",
    about: [
      "Ikeja is the capital of Lagos State and the busiest district on the mainland. The State Secretariat at Alausa, the shops on Allen Avenue and Opebi, the phone and laptop traders of Computer Village and the international airport all sit within a few kilometres of one another. That mix shapes our orders here: a single bottle for a trader's lunch, a box of 330ml bottles for a government meeting, a 650ml for someone heading home from a flight.",
      "Ajao Estate is home turf. The estate sits beside the airport, on the Isolo side, and our kitchen is on an ordinary residential street, so neighbours often walk over before work and leave with a bottle that is still cold from the press. If you live in the estate, collecting is the quickest option of all, and the rest of Ikeja is only a short ride further.",
    ],
    places: [
      {
        name: "Ajao Estate",
        note: "Our kitchen is on Asa Afariogun Street, so every street in the estate is close by.",
      },
      {
        name: "Allen Avenue and Opebi",
        note: "Shops, salons, clinics and offices that keep cold bottles for staff and walk-in clients.",
      },
      {
        name: "Alausa",
        note: "The Lagos State Secretariat and the offices around it, where meetings run long.",
      },
      {
        name: "Computer Village",
        note: "The busy phone market around Otigba Street. Give the plaza name and shop number.",
      },
      {
        name: "Ikeja GRA",
        note: "Quiet residential roads and guest houses a short way from the airport.",
      },
      { name: "Oregun", note: "Offices, warehouses and showrooms along Kudirat Abiola Way." },
      {
        name: "Ikeja City Mall",
        note: "A handy landmark on Obafemi Awolowo Way if you work or shop nearby.",
      },
    ],
    route: [
      "Ikeja orders hardly travel. From Asa Afariogun Street the rider leaves Ajao Estate, picks up Airport Road and heads up into Ikeja, then fans out to Allen Avenue, Opebi, Alausa or the GRA. Addresses inside Ajao Estate never leave the neighbourhood at all.",
      "A short trip means the bottles spend very little time out of the cold room, which is why Ikeja is our fastest delivery area.",
    ],
    occasions: [
      {
        title: "Meetings and training days",
        text: "Firms on Allen Avenue, Opebi and around Alausa order 330ml bottles for meetings, workshops and visitors. For a standing weekly order, request a quote on our bulk orders page.",
      },
      {
        title: "Before and after a flight",
        text: "The airport is next door. A bottle for the journey, or a few waiting in the fridge when you land, is easy to arrange from Ikeja.",
      },
      {
        title: "A stocked fridge at home",
        text: "Families in Ajao Estate and the GRA keep zobo, pineapple and green juice in the fridge for the week, and top up on Saturday.",
      },
    ],
    localNotes: [
      "Closest to our kitchen, so this is our fastest delivery area. In-stock orders arrive the same morning or the next morning, depending on when you order.",
      "Prefer to collect? Walk in at Asa Afariogun Street, Ajao Estate. We're open Monday to Saturday 8am–8pm and Sunday 10am–8pm.",
      "Offices around Ikeja can order in bulk for staff, meetings and events. Request a quote on our bulk orders page.",
    ],
    faqs: [
      {
        q: "Can I pick up my juice in Ajao Estate instead of having it delivered?",
        a: "Yes. Walk in at 30 Asa Afariogun Street, Ajao Estate, Monday to Saturday 8am to 8pm and Sunday 10am to 8pm. If you want a particular juice, message us on WhatsApp first to check it is in stock.",
      },
      {
        q: "Do you deliver to Computer Village and Allen Avenue?",
        a: "Yes. Put the plaza or shop name and a phone number at checkout, and the rider will call as they get close. Those streets are crowded, so a landmark helps.",
      },
      {
        q: "How much does delivery in Ikeja cost?",
        a: "It depends on the exact address. Checkout works out the delivery fee and shows it before you pay. Ajao Estate is next door to the kitchen, and you can always collect for free.",
      },
      {
        q: "Can offices at Alausa order juice in bulk?",
        a: "Yes. Tell us the number of bottles and the date on our bulk orders page and we will send a quote.",
      },
    ],
    nearby: ["isolo-okota", "maryland", "ogba-omole", "agege", "ilupeju"],
  },

  {
    slug: "isolo-okota",
    name: "Isolo & Okota",
    published: true,
    neighbourhoods: [
      "Isolo",
      "Okota",
      "Ago Palace Way",
      "Ire Akari Estate",
      "Ejigbo",
      "Ilasamaja",
      "Cele",
    ],
    description:
      "Cold-pressed juice delivered in Isolo and Okota, next door to our Ajao Estate kitchen. Ago Palace Way, Ire Akari, Ejigbo and Ilasamaja covered.",
    intro:
      "Isolo and Okota sit right next door to our Ajao Estate kitchen, so juice here comes out of the cold room and reaches you within a short ride. Homes along Ago Palace Way and the estates off Okota Road get the same morning-pressed bottles as our walk-in customers.",
    about: [
      "Isolo and Okota grew up as residential districts either side of the Oshodi–Apapa Expressway, and they still feel like neighbourhoods where people know the woman who sells pepper at the corner. Ago Palace Way is the spine of Okota, lined with churches, schools, banks and eateries, while Isolo Road carries the traffic between Mushin and Isolo.",
      "Because Ajao Estate borders Isolo, this is one of the easiest parts of Lagos for us to reach. Parents in Okota order for the school week, small businesses in Ejigbo and Ilasamaja keep bottles chilled for staff, and the many churches off Ago Palace Way order crates when there is a thanksgiving or harvest to celebrate.",
    ],
    places: [
      {
        name: "Ago Palace Way",
        note: "Okota's main road, with estates and side streets branching off both sides.",
      },
      {
        name: "Ire Akari Estate",
        note: "A long-established Isolo estate, a stone's throw from the kitchen.",
      },
      { name: "Cele", note: "The Okota end by the Cele bus stop on the Oshodi–Apapa Expressway." },
      { name: "Ejigbo", note: "Busy residential streets and markets past Isolo, towards Ikotun." },
      {
        name: "Ilasamaja",
        note: "Between Isolo and Mushin, full of workshops and small businesses.",
      },
      { name: "Isolo Road", note: "Shops and homes along the road linking Isolo with Mushin." },
    ],
    route: [
      "This is a neighbour's run. The rider leaves Asa Afariogun Street, crosses out of Ajao Estate into Isolo and either follows Isolo Road or cuts across to Ago Palace Way for Okota. Ejigbo and Ilasamaja are simply a little further along the local roads.",
      "There are no bridges to cross and no Island traffic on the way, so bottles reach Isolo and Okota still properly cold.",
    ],
    occasions: [
      {
        title: "The school week",
        text: "Parents in Okota and Isolo buy 330ml bottles to slip into lunch bags, and a 650ml for the house to share after school.",
      },
      {
        title: "Thanksgiving, harvest and naming ceremonies",
        text: "Ago Palace Way is full of churches, and family celebrations here are big. Chilled crates of zobo and pineapple go down well with jollof and small chops.",
      },
      {
        title: "Shops, salons and workshops",
        text: "Owners in Ejigbo and Ilasamaja keep a few bottles cold for staff on long days, and for customers waiting their turn.",
      },
    ],
    localNotes: [
      "Living in Ire Akari or another gated estate? Add the gate name and a phone number at checkout so the rider can get in without a wait.",
      "After heavy rain some Okota side streets are hard to drive. If yours is one of them, give a nearby landmark on Ago Palace Way and we'll meet you there.",
    ],
    faqs: [
      {
        q: "Do you deliver to Okota and Ago Palace Way?",
        a: "Yes, Okota is one of our closest delivery areas. Enter your street and the nearest bus stop or church at checkout so the rider finds you first time.",
      },
      {
        q: "Can I order juice for a thanksgiving or naming ceremony in Isolo?",
        a: "Yes. For crates, mixed flavours or a fixed delivery date, request a quote on our bulk orders page and tell us roughly how many guests you expect.",
      },
      {
        q: "What does delivery to Isolo cost?",
        a: "Checkout calculates the fee from your exact address and shows it before you pay. Isolo and Okota are close to our kitchen in Ajao Estate.",
      },
      {
        q: "Can I collect from the kitchen instead?",
        a: "Yes. Ajao Estate is next door. Walk in at 30 Asa Afariogun Street, Monday to Saturday 8am to 8pm or Sunday 10am to 8pm.",
      },
      {
        q: "Do you deliver as far as Ejigbo and Ilasamaja?",
        a: "Yes. Both are part of our Isolo run. Ejigbo streets can look alike, so add the name of a nearby church, school or bus stop to your address.",
      },
    ],
    nearby: ["ikeja", "festac", "surulere", "apapa"],
  },

  {
    slug: "lekki",
    name: "Lekki",
    published: true,
    neighbourhoods: [
      "Lekki Phase 1",
      "Admiralty Way",
      "Ikate",
      "Elegushi",
      "Osapa London",
      "Agungi",
      "Jakande",
    ],
    description:
      "Fresh juice delivered cold in Lekki: Phase 1, Admiralty Way, Ikate, Agungi, Osapa London and Jakande. 100% fruit, no added sugar. Order online.",
    intro:
      "From Admiralty Way to the Jakande roundabout, Lekki runs on early gym sessions, long office days and weekend hosting. All three call for something better than a fizzy drink. We bring cold-pressed juice across the Lekki corridor, packed cold for the trip from the mainland.",
    about: [
      "Lekki Phase 1 is one of the liveliest parts of the Island: restaurants and offices along Admiralty Way, gyms that open before sunrise, and apartment blocks that keep rising off the Lekki–Epe Expressway. Further along, Ikate, Agungi, Osapa London and Jakande are packed with young families and people who work from home.",
      "A lot of what we send to Lekki is planned ahead: a week of bottles for someone starting a juice reset, a gift box for a client, or a few crates for a Saturday get-together. Because the bottles cross from the mainland, we pack them cold and send them out while they are at their freshest.",
    ],
    places: [
      {
        name: "Admiralty Way, Lekki Phase 1",
        note: "Offices, restaurants and gyms along Phase 1's busiest road.",
      },
      { name: "Freedom Way", note: "Another Phase 1 road lined with shops, cafés and offices." },
      {
        name: "Ikate and Elegushi",
        note: "Homes and short-let apartments around the Nike Art Gallery and the Elegushi end.",
      },
      {
        name: "Agungi",
        note: "A residential pocket with estates on both sides of the expressway.",
      },
      {
        name: "Osapa London",
        note: "Townhouses and apartment blocks, many with a gate or front desk.",
      },
      {
        name: "Jakande",
        note: "The stretch around the Jakande roundabout, with estates and shops.",
      },
    ],
    route: [
      "Lekki is one of the longer runs from Ajao Estate. The rider crosses to the Island, by Third Mainland Bridge or Eko Bridge depending on traffic, passes through Ikoyi or Victoria Island and joins the Lekki–Epe Expressway. Phase 1 and Ikate come first; Agungi, Osapa London and Jakande are further along.",
      "Bottles are packed cold for that journey. A full address, the building or estate name and a phone number the rider can reach all help the hand-over happen quickly.",
    ],
    occasions: [
      {
        title: "Before and after the gym",
        text: "Early sessions on Admiralty Way end with a green juice or a ginger shot. Many regulars order a few days' worth at once and keep them chilled.",
      },
      {
        title: "Working from home",
        text: "People working from apartments in Ikate and Osapa London order a mixed set for the week so there is always something cold between calls.",
      },
      {
        title: "Brunch and house parties",
        text: "Weekend hosting is a Lekki tradition. A tray of bottles or a gift box makes an easy contribution when you are a guest.",
      },
    ],
    localNotes: [
      "Apartment blocks in Phase 1 usually have a front desk. Add the building name and flat number so the bottles go straight to the right door.",
      "In Jakande and Agungi, mention a nearby landmark or estate gate at checkout. It saves the rider calling for directions.",
    ],
    faqs: [
      {
        q: "Do you deliver to Lekki Phase 1 and Admiralty Way?",
        a: "Yes. Phase 1, Admiralty Way, Ikate, Agungi, Osapa London and Jakande are all covered. Add your building or estate name at checkout.",
      },
      {
        q: "Will the juice still be cold when it gets to Lekki?",
        a: "Yes. We pack bottles cold for the trip from our Ikeja kitchen. Put them in the fridge as soon as they arrive and drink them fresh.",
      },
      {
        q: "How much is delivery to Lekki?",
        a: "It varies with the exact address, because Lekki is long. Checkout shows the delivery fee for your address before you pay.",
      },
      {
        q: "Can I send juice as a gift to someone in Lekki?",
        a: "Yes. Choose a gift box or bundle, enter their address, and include their name and phone number so the rider can reach them.",
      },
      {
        q: "I live in a short-let apartment in Lekki. Can you deliver there?",
        a: "Yes. Give the apartment name, the unit number and your own phone number, because the host or caretaker may not know you are expecting a delivery.",
      },
    ],
    nearby: ["oniru", "chevron", "victoria-island", "ikoyi", "ajah"],
  },

  {
    slug: "ajah",
    name: "Ajah & Sangotedo",
    published: true,
    neighbourhoods: [
      "Ajah",
      "Abraham Adesanya",
      "Badore",
      "Addo Road",
      "Thomas Estate",
      "Sangotedo",
    ],
    description:
      "Fresh juice delivery in Ajah: Abraham Adesanya, Addo Road, Badore and Thomas Estate. Family bundles and 650ml bottles, delivered cold.",
    intro:
      "Ajah, Badore and Addo Road are full of family estates, and families go through juice fast. We deliver bundles and 650ml bottles to estates off Addo Road and Abraham Adesanya, so the fridge stays stocked for the school run and the weekend.",
    about: [
      "Ajah is where the Lekki–Epe Expressway meets the roads into some of the biggest family estates in Lagos. Addo Road and Badore lead off one way, Abraham Adesanya and Thomas Estate sit close to the roundabout, and the Ilaje end of Ajah is a market area that never quite stops. Households here are often large, and they buy juice the way they buy bread: regularly, and plenty of it.",
      "The weekends are full: church in the morning, a family lunch, children's birthdays, visitors from out of town. Parents tell us 650ml bottles and bundles make more sense than single bottles, because a single bottle does not survive long in a house with three children.",
    ],
    places: [
      {
        name: "Ajah roundabout",
        note: "The junction everyone gives directions from. Name the nearest exit or bus stop.",
      },
      {
        name: "Abraham Adesanya Estate",
        note: "A large, established estate close to Ajah, with many family homes.",
      },
      {
        name: "Addo Road",
        note: "Busy road leading to estates, schools and churches off the expressway.",
      },
      { name: "Badore", note: "Residential streets past Addo, with newer estates going up." },
      { name: "Thomas Estate", note: "A well-known estate near the Ajah end of the expressway." },
      {
        name: "Lagos Business School",
        note: "The campus on the Lekki–Epe Expressway, a landmark for nearby streets.",
      },
      {
        name: "Ilaje, Ajah",
        note: "The market end of Ajah, where shop owners can order for the whole stall.",
      },
    ],
    route: [
      "From Ajao Estate the rider crosses to the Island and then travels nearly the full length of the Lekki–Epe Expressway, past Phase 1, Chevron and VGC, before turning off at Ajah for Addo Road, Badore or Abraham Adesanya.",
      "It is a long ride, so we pack every bottle cold and ask for a reachable phone number. Expressway traffic around Ajah can be heavy at rush hour.",
    ],
    occasions: [
      {
        title: "Big-family fridges",
        text: "Bundles and 650ml bottles keep a full house going from Monday to Friday without a supermarket run on the way home.",
      },
      {
        title: "Children's birthdays",
        text: "Juice instead of fizzy drinks at a child's party is an easy win with parents. Order crates in advance on our bulk orders page.",
      },
      {
        title: "Sunday lunch and visitors",
        text: "Chilled zobo and pineapple sit happily next to rice and stew when relatives come round after church.",
      },
    ],
    localNotes: [
      "Most estates off Addo Road and in Badore have security at the gate. Add the estate name and your house number so the guard can wave the rider through.",
      "If you are setting up a regular weekly order for a large household, message us on WhatsApp and we will help plan it.",
    ],
    faqs: [
      {
        q: "Do you deliver to Addo Road and Badore?",
        a: "Yes. We deliver across Ajah, including Addo Road, Badore, Abraham Adesanya and Thomas Estate. Give the estate name at checkout.",
      },
      {
        q: "Is Ajah too far for fresh juice to stay cold?",
        a: "No. It is a long ride from our Ikeja kitchen, which is why bottles are packed cold before they leave. Refrigerate them as soon as they arrive.",
      },
      {
        q: "How much does delivery to Ajah cost?",
        a: "Checkout prices delivery for your exact address and shows the fee before you pay, so you know the full cost up front.",
      },
      {
        q: "Which size is best for a family?",
        a: "Most families in Ajah choose 650ml bottles or a bundle. They go further than single 330ml bottles and still fit in a home fridge.",
      },
      {
        q: "Do you still cover Sangotedo from the Ajah side?",
        a: "Yes. Orders for Sangotedo, Abijo and the estates past Ajah are delivered as part of the same run down the expressway. Put the estate name and the nearest landmark on Monastery Road or Ogombo Road in your address.",
      },
    ],
    nearby: ["sangotedo", "chevron", "lekki"],
  },

  {
    slug: "victoria-island",
    name: "Victoria Island",
    published: true,
    neighbourhoods: [
      "Victoria Island",
      "Adeola Odeku",
      "Akin Adesola",
      "Ozumba Mbadiwe",
      "Ahmadu Bello Way",
      "Kofo Abayomi",
    ],
    description:
      "Cold-pressed juice delivered to offices and homes in Victoria Island: Adeola Odeku, Akin Adesola, Ozumba Mbadiwe and Ahmadu Bello Way.",
    intro:
      "Victoria Island is Lagos's office district, with boardrooms on Adeola Odeku, banks on Akin Adesola, and back-to-back meetings everywhere. We deliver chilled bottles for desks, meeting rooms and client gifts across VI.",
    about: [
      "VI is where much of corporate Nigeria has its head office. Banks, law firms, embassies and consultancies fill the towers on Adeola Odeku, Akin Adesola and Ozumba Mbadiwe, and the hotels and restaurants around Adetokunbo Ademola keep the area busy well into the evening.",
      "Our VI orders are mostly about people at work: a receptionist ordering for a board meeting, an executive assistant arranging client gifts, a team lead thanking staff at the end of a long quarter. We also deliver to the residential streets around Kofo Abayomi and the quieter corners of the island.",
      "Working days in VI are long and often spent indoors under air conditioning, moving from one meeting room to the next. A chilled bottle of real fruit is a small thing, but it is one of the few drinks you can put in front of a client, a colleague or yourself without a second thought about what is in it.",
    ],
    places: [
      {
        name: "Adeola Odeku",
        note: "Office towers, banks and restaurants. Give the building and floor.",
      },
      {
        name: "Akin Adesola",
        note: "Corporate offices and banking halls running through the heart of VI.",
      },
      {
        name: "Ozumba Mbadiwe",
        note: "The waterfront road by the Civic Centre, with offices and event venues.",
      },
      { name: "Ahmadu Bello Way", note: "The road by the Atlantic edge, close to Eko Atlantic." },
      {
        name: "Kofo Abayomi",
        note: "A mix of offices, embassies and homes on the western side of VI.",
      },
      {
        name: "Adetokunbo Ademola",
        note: "Hotels, restaurants and offices around the Eko Hotel end.",
      },
    ],
    route: [
      "The rider leaves Ajao Estate for the Island, over Third Mainland Bridge or Eko Bridge, whichever is moving, then through Obalende or Falomo into Victoria Island.",
      "Office buildings in VI often have strict reception rules. A name, a phone number and the company name on the order mean the bottles get upstairs instead of waiting in the lobby.",
    ],
    occasions: [
      {
        title: "Board meetings and client visits",
        text: "A tray of chilled 330ml bottles looks good on a meeting table and is easy to serve. Order the day before for an early meeting.",
      },
      {
        title: "Client and staff gifts",
        text: "Gift boxes are popular with VI firms at the end of the year, for birthdays, and when a deal closes. Request a quote on our bulk orders page for larger numbers.",
      },
      {
        title: "Desk drinks for long days",
        text: "People who rarely leave the office before dark order a few bottles to keep in the office fridge for the afternoon slump.",
      },
    ],
    localNotes: [
      "For office deliveries, add the company name, floor and a phone number that the front desk can call.",
      "Planning juice for a staff event or end-of-year gifts? Request a quote on our bulk orders page.",
    ],
    faqs: [
      {
        q: "Can you deliver to my office on Adeola Odeku or Akin Adesola?",
        a: "Yes. Add your company name, floor and a reachable phone number at checkout so reception knows the delivery is for you.",
      },
      {
        q: "Do you supply juice for corporate events in Victoria Island?",
        a: "Yes. For meetings, product launches and end-of-year parties, send the date and numbers through our bulk orders page and we will quote.",
      },
      {
        q: "How is the delivery fee to VI worked out?",
        a: "From your exact address. Checkout shows the fee before you pay, so there are no surprises.",
      },
      {
        q: "Do you also deliver to Oniru?",
        a: "Yes, we deliver across Victoria Island and its neighbour Oniru. Add your street or estate name at checkout.",
      },
      {
        q: "Can I order the day before for an early meeting?",
        a: "Yes, and for meetings that start first thing it is the best way. Order the day before, add the meeting room or the host's name, and the bottles will be on their way from our kitchen in the morning.",
      },
    ],
    nearby: ["ikoyi", "oniru", "lagos-island", "lekki"],
  },

  {
    slug: "ikoyi",
    name: "Ikoyi",
    published: true,
    neighbourhoods: [
      "Ikoyi",
      "Bourdillon",
      "Awolowo Road",
      "Falomo",
      "Parkview Estate",
      "Banana Island",
      "Osborne",
    ],
    description:
      "Fresh juice and gift boxes delivered in Ikoyi: Bourdillon, Awolowo Road, Falomo, Parkview, Banana Island and Osborne. Packed cold.",
    intro:
      "Ikoyi homes on Bourdillon, Parkview and Banana Island order juice for their household, their guests and their trainers. We deliver cold-pressed bottles and gift boxes across Ikoyi and Falomo, packed cold all the way.",
    about: [
      "Ikoyi is green, quiet and residential, with tree-lined roads like Bourdillon, Kingsway and Glover, and gated communities such as Parkview, Banana Island and Osborne Foreshore. Awolowo Road and Falomo keep the commercial side going, with boutiques, banks and restaurants.",
      "Many of our Ikoyi orders are placed by a household manager or a personal assistant rather than the person drinking the juice. That is why we ask for clear instructions at checkout: who receives it, which gate, and which number to call.",
      "Ikoyi households also tend to be particular about what goes into the fridge. That suits us. Our bottles hold nothing but pressed fruit and vegetables: no concentrate, no added sugar, no water and no preservatives. It is the kind of juice you would make yourself if you had a cold press, a market run before dawn and the patience to wash and peel everything by hand.",
      "We also see a lot of entertaining here, from small dinners on Bourdillon to family gatherings in Parkview. A mixed set of flavours, served cold, means there is something for the guest who wants ginger, the one who wants pineapple and the child who only drinks orange.",
    ],
    places: [
      {
        name: "Bourdillon Road",
        note: "Residential towers and homes along one of Ikoyi's main roads.",
      },
      { name: "Awolowo Road", note: "Shops, banks and offices. The busiest stretch of Ikoyi." },
      { name: "Falomo", note: "The roundabout and shopping area that links Ikoyi with VI." },
      {
        name: "Parkview Estate",
        note: "A gated estate where security will want a name and number.",
      },
      {
        name: "Banana Island",
        note: "A private island estate with controlled access at the gate.",
      },
      {
        name: "Osborne Foreshore",
        note: "Waterside estates and apartment blocks along Osborne Road.",
      },
    ],
    route: [
      "The rider takes Third Mainland Bridge or Eko Bridge from the mainland, comes into Ikoyi through Obalende, and heads to Awolowo Road, Bourdillon or Kingsway, with Parkview, Banana Island and Osborne further in.",
      "Gated estates check every visitor. A resident's name and phone number on the order mean the gate can confirm the delivery quickly and the bottles reach the house still cold.",
    ],
    occasions: [
      {
        title: "Household and guests",
        text: "A fridge stocked with cold-pressed juice means guests can be offered something real. Mixed sets cover every taste.",
      },
      {
        title: "Training sessions",
        text: "Home workouts with a personal trainer end better with a cold bottle of green juice or a ginger blend.",
      },
      {
        title: "Gifts across the Island",
        text: "Gift boxes for friends, colleagues or a new neighbour, sent with their name and phone number.",
      },
    ],
    localNotes: [
      "For Parkview, Banana Island and other gated estates, add the resident's name and phone number so security can confirm the delivery.",
      "Ordering for someone else's home? Put the receiver's name and number on the order, not just yours.",
    ],
    faqs: [
      {
        q: "Do you deliver inside Banana Island and Parkview?",
        a: "Yes. Add the resident's name, house number and phone number so the estate gate can confirm the delivery.",
      },
      {
        q: "Can my household staff place and receive the order?",
        a: "Yes. Anyone can order online or on WhatsApp. Just make sure the receiver's phone number is on the order.",
      },
      {
        q: "How much is delivery in Ikoyi?",
        a: "The delivery fee depends on your exact address and appears at checkout before payment.",
      },
      {
        q: "Do you deliver gift boxes in Ikoyi?",
        a: "Yes. Choose a gift box on our shop, add the recipient's address, and we deliver it cold.",
      },
      {
        q: "Do you deliver to Osborne Foreshore and Dolphin Estate?",
        a: "Yes. Both are on our Ikoyi run. For apartment blocks, add the tower name and flat number, and a phone number the concierge can call when the rider arrives.",
      },
      {
        q: "Can you deliver to an office on Awolowo Road?",
        a: "Yes. Awolowo Road and Falomo are part of the same Ikoyi run. Add the company name and floor, and the rider will hand the bottles to reception or call you down.",
      },
    ],
    nearby: ["victoria-island", "lagos-island", "lekki", "oniru"],
  },

  {
    slug: "lagos-island",
    name: "Lagos Island & Marina",
    published: true,
    neighbourhoods: [
      "Marina",
      "Broad Street",
      "CMS",
      "Obalende",
      "Tinubu Square",
      "Balogun Market",
      "Idumota",
    ],
    description:
      "Fresh juice delivered to offices, shops and traders on Lagos Island: Marina, Broad Street, CMS, Balogun, Idumota and Obalende.",
    intro:
      "Marina and Broad Street are where long trading days happen, and a cold bottle helps. We deliver to offices and shops across Lagos Island for staff, meetings and afternoon slumps.",
    about: [
      "Lagos Island is the old commercial heart of the city. Banks and shipping firms line the Marina, the Nigerian Exchange sits on Customs Street, and the markets of Balogun and Idumota move more goods in a day than most towns see in a month. The Cathedral Church of Christ at CMS and Tafawa Balewa Square are landmarks everyone knows.",
      "It is also hot, crowded and loud, and people work long hours in it. Traders, bankers and office staff here order juice for a simple reason: they need something cold and real in the middle of the afternoon, and they cannot leave the shop or the desk to find it.",
      "Many Island businesses are family firms that have traded from the same street for decades, and they buy the way they always have: a phone call, a fixed quantity, delivered to the same door each time. We are happy to work like that. Send a WhatsApp message with your shop or office, how many bottles you want and which flavours, and we will set it up so you are not re-entering the same order every week.",
    ],
    places: [
      { name: "Marina", note: "Banks and corporate offices facing the lagoon." },
      { name: "Broad Street", note: "Offices and businesses parallel to the Marina." },
      { name: "CMS", note: "The busy junction by the Cathedral Church of Christ." },
      {
        name: "Balogun Market",
        note: "Give the line, building and shop number. The market is a maze.",
      },
      { name: "Idumota", note: "Wholesale trading streets near the foot of Carter Bridge." },
      {
        name: "Tafawa Balewa Square and Obalende",
        note: "Offices and the motor park on the way to Ikoyi.",
      },
    ],
    route: [
      "From Ajao Estate the rider heads for the Island by Eko Bridge or Carter Bridge, comes down to CMS and the Marina, then into Broad Street, Balogun or Idumota.",
      "Traffic and parking on the Island are tight. A phone number that will be answered and a clear meeting point, such as the gate of your building or the front of your shop, save a lot of time.",
    ],
    occasions: [
      {
        title: "Afternoon slumps at the desk",
        text: "Bank and office staff on the Marina order a few bottles at once and keep them in the office fridge.",
      },
      {
        title: "Shop staff in the markets",
        text: "Traders in Balogun and Idumota order for themselves and their apprentices, so nobody has to leave the stall.",
      },
      {
        title: "Meetings in old offices",
        text: "Boardrooms along Broad Street serve chilled 330ml bottles to visitors. Request a quote on our bulk orders page for a standing order.",
      },
    ],
    localNotes: [
      "For market deliveries, give the line or plaza name, the shop number and a phone number you will answer.",
      "Offices on the Marina: add the floor and company name so the security desk sends the rider up.",
    ],
    faqs: [
      {
        q: "Do you deliver inside Balogun Market?",
        a: "Yes, with clear directions. Add the plaza or line name, your shop number and a phone number, and meet the rider at a known point if the lane is too narrow.",
      },
      {
        q: "Can my office on the Marina order every week?",
        a: "Yes. Request a quote on our bulk orders page for a regular delivery to your office.",
      },
      {
        q: "What is the delivery fee to Lagos Island?",
        a: "Checkout calculates it from the exact address and shows it before you pay.",
      },
      {
        q: "Do you deliver to Obalende and CMS?",
        a: "Yes. We cover the whole of Lagos Island, from Obalende and CMS to Broad Street, the Marina and Idumota.",
      },
      {
        q: "Is the juice safe in the Island heat?",
        a: "It leaves our cold room chilled and is packed cold for the ride over the bridge. Because it contains no preservatives, put it straight into a fridge or cooler when it arrives rather than leaving it on a hot counter.",
      },
    ],
    nearby: ["ikoyi", "victoria-island", "apapa", "yaba"],
  },

  {
    slug: "yaba",
    name: "Yaba",
    published: true,
    neighbourhoods: [
      "Yaba",
      "Sabo",
      "Akoka",
      "Onike",
      "Alagomeji",
      "Herbert Macaulay Way",
      "Jibowu",
    ],
    description:
      "Fresh cold-pressed juice delivered in Yaba: Sabo, Akoka, Onike, Alagomeji, Jibowu and Herbert Macaulay Way. Single bottles to team crates.",
    intro:
      "Yaba is startups, students and creatives, from the tech offices off Herbert Macaulay Way to the hostels around Akoka. We deliver single bottles for the desk and crates for team days and launches.",
    about: [
      "Yaba earned the nickname Yabacon Valley for the tech companies and hubs that opened along Herbert Macaulay Way and the streets around Sabo. It is also a university town: the University of Lagos is in Akoka, Yaba College of Technology is on Herbert Macaulay Way, and Queen's College is just down the road. Tejuosho Market keeps the old trading side alive.",
      "That makes Yaba orders wonderfully varied: a developer who wants something better than energy drinks, a lecturer stocking up for the week, a startup ordering juice for a product launch, a student sharing a 650ml with roommates.",
      "Yaba also moves at a pace of its own. Hubs and co-working spaces fill up early, lectures and exams shape the calendar, and the roads around Sabo and Ojuelegba are rarely quiet. Ordering ahead fits that rhythm: one delivery at the start of the week, bottles in the office or hostel fridge, and no need to step out into the traffic every time you want something cold that is not a soft drink.",
    ],
    places: [
      {
        name: "Herbert Macaulay Way",
        note: "Tech offices, banks and YabaTech along the main road.",
      },
      { name: "Sabo", note: "The busy commercial centre of Yaba, near the Sabo bus stop." },
      { name: "Akoka", note: "Home of the University of Lagos and the streets around its gate." },
      { name: "Onike", note: "Residential streets and student houses between Sabo and Akoka." },
      { name: "Alagomeji", note: "Homes and small businesses close to the railway line." },
      { name: "Jibowu", note: "Where Ikorodu Road meets Yaba, with transport parks and offices." },
    ],
    route: [
      "The rider takes Mobolaji Bank Anthony Way from the airport side down to Maryland, follows Ikorodu Road south to Jibowu, then turns into Yaba for Sabo, Onike or Akoka.",
      "Universities and some offices restrict who can come in. If you are on campus, meet the rider at the gate or at a named building.",
    ],
    occasions: [
      {
        title: "Team days and product launches",
        text: "Startups order crates for demo days, hackathons and launches. It looks better than a crate of soft drinks and is easy to hand out.",
      },
      {
        title: "Long study and coding nights",
        text: "Students and developers order a few bottles at once for long sessions, instead of another energy drink.",
      },
      {
        title: "Lecturers and staff",
        text: "Staff at the universities and colleges keep bottles in the office fridge for the week.",
      },
    ],
    localNotes: [
      "On the UNILAG campus, give the faculty, hostel or building name and meet the rider at a known point.",
      "Ordering for a team? Request a quote on our bulk orders page so we can bring everything at once.",
    ],
    faqs: [
      {
        q: "Do you deliver to UNILAG and the Akoka area?",
        a: "Yes. We deliver to Akoka and the streets around the university. On campus, add your hall or building and a phone number so the rider can meet you.",
      },
      {
        q: "Can a startup order juice for an event in Yaba?",
        a: "Yes. Send the date and the number of guests on our bulk orders page and we will quote for crates.",
      },
      {
        q: "How much is delivery to Yaba?",
        a: "The fee is calculated from your address at checkout and shown before you pay.",
      },
      {
        q: "Is there a juice good for long study sessions?",
        a: "Many students pick ginger or citrus blends. All our juices are 100% fruit and vegetables with no added sugar.",
      },
      {
        q: "Do you deliver to co-working spaces and hubs in Yaba?",
        a: "Yes. Add the hub's name, your company or desk, and a phone number. Most hubs have a front desk that can take the bottles if you are in a call when the rider arrives.",
      },
      {
        q: "Do you deliver around Tejuosho Market and Jibowu?",
        a: "Yes. Both are busy, so give the shop, building or bus stop nearest to you and a phone number you will pick up when the rider calls.",
      },
    ],
    nearby: ["surulere", "maryland", "gbagada", "lagos-island"],
  },

  {
    slug: "surulere",
    name: "Surulere",
    published: true,
    neighbourhoods: [
      "Surulere",
      "Adeniran Ogunsanya",
      "Bode Thomas",
      "Aguda",
      "Ojuelegba",
      "Ogunlana Drive",
      "Masha",
    ],
    description:
      "Fresh juice delivered across Surulere: Bode Thomas, Adeniran Ogunsanya, Ogunlana Drive, Aguda and Masha. Crates for owambes and birthdays.",
    intro:
      "Surulere loves a party, and Bode Thomas and Adeniran Ogunsanya don't slow down at weekends. We deliver fresh juice to homes across Surulere, plus chilled crates for owambes, birthdays and naming ceremonies.",
    about: [
      "Surulere is one of the oldest residential districts on the mainland, and it has kept its character: big family compounds, busy commercial streets and a social calendar that never empties. The National Stadium and Teslim Balogun Stadium give it a sporting identity, and Adeniran Ogunsanya, Bode Thomas and Ogunlana Drive are always busy.",
      "Events are a big part of Surulere life, so many of our orders here are for crates: a 40th birthday, a wedding reception at a hall near Ojuelegba, or a naming ceremony in a family compound in Aguda. Day to day, households order a few bottles to keep the fridge full.",
      "Surulere also has a strong football and fitness culture around its stadiums. Amateur teams train at weekends, joggers use the quieter streets early in the morning, and gyms along the main roads are busy after work. A cold-pressed juice after a session is a simple way to rehydrate with real fruit instead of a sugary sports drink.",
      "Surulere sits right in the middle of the mainland, between Yaba, Mushin, Ebute Metta and Itire, so friends and relatives come from every direction for its parties. Hosts here like to have drinks that will please a crowd of different ages, and a table of chilled bottles in bright colours does that without a single can or plastic sachet.",
    ],
    places: [
      {
        name: "Adeniran Ogunsanya",
        note: "Shops, eateries and the shopping mall on Surulere's main commercial street.",
      },
      { name: "Bode Thomas", note: "Restaurants, offices and lounges that stay busy at weekends." },
      { name: "Ogunlana Drive", note: "A long residential road with many family homes." },
      { name: "National Stadium", note: "A landmark everyone knows. Handy for nearby streets." },
      { name: "Aguda and Masha", note: "Older family compounds and quieter residential streets." },
      { name: "Ojuelegba", note: "The famous junction where Surulere meets Yaba and Mushin." },
    ],
    route: [
      "From Ajao Estate the rider heads through Mushin towards Ojuelegba, then into Surulere along Funsho Williams Avenue, Adeniran Ogunsanya or Bode Thomas, depending on where you are.",
      "Surulere streets are busy at weekends, especially near event halls. Name a meeting point if the party venue is hard to find.",
    ],
    occasions: [
      {
        title: "Owambes and birthdays",
        text: "Crates of zobo, pineapple and orange sit next to the drinks table at Surulere parties. Order early on our bulk orders page so we can plan stock.",
      },
      {
        title: "Naming ceremonies",
        text: "Family celebrations at home need drinks that suit everyone, from grandparents to children.",
      },
      {
        title: "The weekly fridge",
        text: "Households along Ogunlana Drive and in Aguda keep a few bottles cold for the week.",
      },
    ],
    localNotes: [
      "For party deliveries, add the venue name and a contact person who will be at the venue when the juice arrives.",
      "Bulk orders for events need notice so we have enough fruit. Send the date on our bulk orders page as early as you can.",
    ],
    faqs: [
      {
        q: "Can you supply juice for a party in Surulere?",
        a: "Yes. We deliver chilled crates for owambes, birthdays and weddings. Send the date and guest numbers on our bulk orders page for a quote.",
      },
      {
        q: "Do you deliver to Bode Thomas and Ogunlana Drive?",
        a: "Yes, we deliver across Surulere, including Bode Thomas, Ogunlana Drive, Adeniran Ogunsanya, Aguda and Masha.",
      },
      {
        q: "How much is delivery to Surulere?",
        a: "Checkout calculates the fee for your address and shows it before you pay.",
      },
      {
        q: "How long does juice keep after delivery?",
        a: "Our juice has no preservatives, so keep it refrigerated and drink it fresh. For a party, plan to serve it the same day.",
      },
      {
        q: "Can I mix flavours in one event order?",
        a: "Yes. Most Surulere parties take a mix: zobo for the elders, pineapple and orange for the children, and something with ginger for those who like a kick. Tell us the split on the bulk orders page and we will quote for it.",
      },
    ],
    nearby: ["yaba", "isolo-okota", "ilupeju", "apapa"],
  },

  {
    slug: "gbagada",
    name: "Gbagada",
    published: true,
    neighbourhoods: [
      "Gbagada Phase 1",
      "Gbagada Phase 2",
      "Ifako-Gbagada",
      "Soluyi",
      "Atunrase Estate",
      "Medina Estate",
    ],
    description:
      "Fresh juice delivered in Gbagada: Phase 1, Phase 2, Ifako, Soluyi, Atunrase and Medina Estate. Order ahead and it waits cold for you.",
    intro:
      "Gbagada's estates, from Phase 1 and Phase 2 to Atunrase, are home to Lagos workers who leave early and get home late. We deliver to them so there's real fruit in the fridge. Order ahead and your juice is waiting cold when you're back.",
    about: [
      "Gbagada sits between Ikorodu Road and the Third Mainland Bridge approach, which makes it a favourite with people who commute to the Island. Phase 1 and Phase 2 are the planned estates, Atunrase and Medina are quiet residential pockets, and Ifako-Gbagada and Soluyi are busier and more mixed. Gbagada General Hospital and the large church auditoriums along the expressway are landmarks everybody uses.",
      "Because so many residents leave before dawn and come back after dark, our Gbagada orders tend to be planned: a week's worth of bottles delivered once, with someone at home or a neighbour to receive them.",
      "Gbagada is also a church town. Some of the largest auditoriums in Lagos are along the expressway, and the smaller parishes on the estate streets are just as active. Midweek services, vigils and weekend conventions mean volunteers and choir members spend long hours on their feet, and a crate of chilled juice is a welcome sight at the end of a rehearsal.",
    ],
    places: [
      { name: "Gbagada Phase 1", note: "Planned residential estate close to the expressway." },
      { name: "Gbagada Phase 2", note: "Estate streets, schools and small offices." },
      {
        name: "Atunrase Estate",
        note: "A quiet, gated residential estate. Give the house number.",
      },
      { name: "Medina Estate", note: "Family homes off the main roads, near Phase 2." },
      { name: "Ifako-Gbagada and Soluyi", note: "Busy, mixed streets of homes and shops." },
      {
        name: "Gbagada General Hospital",
        note: "A landmark that helps riders find nearby addresses.",
      },
    ],
    route: [
      "The rider leaves Ajao Estate, passes Oshodi and takes the Oshodi–Oworonshoki Expressway to the Gbagada exits, then turns into Phase 1, Phase 2 or Ifako.",
      "If nobody will be home during the day, name a neighbour, a gateman or a shop that can receive the bottles and put them in a fridge.",
    ],
    occasions: [
      {
        title: "The commuter's week",
        text: "A weekly box means a cold bottle for breakfast before the bridge and another waiting in the evening.",
      },
      {
        title: "Church programmes",
        text: "Gbagada has many large churches. Vigils, conventions and choir rehearsals are easier with chilled juice for volunteers.",
      },
      {
        title: "Weekend family time",
        text: "Saturday is the one day the whole house is home. Families order a mixed set for the weekend.",
      },
    ],
    localNotes: [
      "If you will be at work, add the name of someone at home or the gateman who can receive the order.",
      "For Atunrase and other gated estates, include your house number and a phone number for the gate.",
    ],
    faqs: [
      {
        q: "Do you deliver to Gbagada Phase 1 and Phase 2?",
        a: "Yes, along with Atunrase, Medina, Ifako-Gbagada and Soluyi. Add the estate name at checkout.",
      },
      {
        q: "I am at work all day. Can someone else receive my juice?",
        a: "Yes. Put the receiver's name and phone number on the order. The bottles should go in a fridge as soon as they arrive.",
      },
      {
        q: "What does delivery to Gbagada cost?",
        a: "It depends on your exact address. The fee is shown at checkout before you pay.",
      },
      {
        q: "Can churches in Gbagada order in bulk?",
        a: "Yes. For programmes and conventions, request a quote on our bulk orders page with the date and numbers.",
      },
      {
        q: "Can I get one delivery a week instead of ordering every day?",
        a: "Yes. Many Gbagada customers order a mixed set once a week and keep it in the fridge. Message us on WhatsApp if you want help choosing the right number of bottles for your household.",
      },
      {
        q: "Do you deliver to Medina and Atunrase estates?",
        a: "Yes. Give the estate name, street and house number. Both have gates, so a phone number the security man can call makes the hand-over quick.",
      },
    ],
    nearby: ["maryland", "ojota", "magodo", "yaba"],
  },

  {
    slug: "maryland",
    name: "Maryland & Anthony",
    published: true,
    neighbourhoods: [
      "Maryland",
      "Mende",
      "Anthony Village",
      "Onigbongbo",
      "Ikorodu Road",
      "Mobolaji Bank Anthony Way",
    ],
    description:
      "Fresh juice delivered in Maryland, Mende, Anthony Village and Onigbongbo, a short run from our Ikeja kitchen. 100% fruit, delivered cold.",
    intro:
      "Maryland, Mende and Anthony Village sit on the Ikorodu Road corridor, a short run from our kitchen. Fresh juice for homes and offices here leaves the cold room and arrives still chilled.",
    about: [
      "Maryland is a crossroads. Mobolaji Bank Anthony Way comes down from Ikeja and the airport, Ikorodu Road runs through towards Ojota one way and Yaba the other, and Maryland Mall stands right by the junction. Mende is a calm, established estate tucked just off the main road, and Anthony Village, across towards Gbagada, is a busy residential district with its own schools, shops and churches.",
      "Being this close to our Ajao Estate kitchen means Maryland gets bottles that have barely had time to warm up. People here order for the home, for the offices and showrooms along Ikorodu Road, and as a quick present to carry when they visit family.",
      "It is also an area of in-betweens: people who live in Mende but work in Ikeja, families in Anthony whose children school in Ilupeju, commuters who pass the Maryland flyover twice a day. That is why so many orders here are delivered to one address and drunk somewhere else. A few bottles go in the bag in the morning, and the rest wait in the fridge for the evening.",
      "Maryland residents are also some of our most frequent walk-in customers, because Ajao Estate is close enough for a quick trip on a Saturday. If you would rather see the juices before you choose, you are welcome to collect from the kitchen instead.",
    ],
    places: [
      {
        name: "Maryland junction",
        note: "Where Mobolaji Bank Anthony Way meets Ikorodu Road, beside Maryland Mall.",
      },
      {
        name: "Mende",
        note: "A quiet residential estate just off the main road. Add your street and house number.",
      },
      {
        name: "Anthony Village",
        note: "Homes, schools and shops on the Gbagada side of Ikorodu Road.",
      },
      { name: "Onigbongbo", note: "The older residential streets that wrap around Maryland." },
      {
        name: "Ikorodu Road",
        note: "Offices, showrooms and banks along the main road through the area.",
      },
      {
        name: "Mobolaji Bank Anthony Way",
        note: "The road down from Ikeja, lined with offices and churches.",
      },
    ],
    route: [
      "A short and simple run: from Ajao Estate the rider heads up to Mobolaji Bank Anthony Way and follows it down to Maryland, then turns into Mende, Onigbongbo or across the corridor to Anthony Village.",
      "Because the run is short, Maryland and Anthony are among the areas where bottles arrive coldest. The busiest spot is the Maryland junction itself, so if you are close to it, a nearby landmark such as the mall or a named bus stop helps the rider stop in the right place.",
    ],
    occasions: [
      {
        title: "Office fridges on Ikorodu Road",
        text: "Businesses along the corridor order a few bottles at a time for staff and for visitors waiting in reception.",
      },
      {
        title: "Family homes in Mende",
        text: "Weekly orders of 650ml bottles for the house, with a handful of 330ml ones for school bags.",
      },
      {
        title: "A present on the way to a visit",
        text: "Visiting family or friends? A gift box of fresh juice is a thoughtful alternative to a pack of soft drinks.",
      },
    ],
    localNotes: [
      "For Mende and other streets with a gate, add the estate name and house number.",
      "Offices near the Maryland junction: add the building name and floor.",
    ],
    faqs: [
      {
        q: "Do you deliver to Mende and Anthony Village?",
        a: "Yes. We deliver across Maryland, Mende, Anthony Village and Onigbongbo, a short ride from our kitchen.",
      },
      {
        q: "How fresh is juice delivered to Maryland?",
        a: "Very fresh. The ride from Ajao Estate is short, so bottles leave the cold room and arrive still chilled.",
      },
      {
        q: "How much is delivery to Maryland?",
        a: "The delivery fee for your exact address is shown at checkout before you pay.",
      },
      {
        q: "Can I order for an office on Ikorodu Road?",
        a: "Yes. Add the company name and floor. For regular orders, request a quote on our bulk orders page.",
      },
      {
        q: "Is it quicker to collect from Ajao Estate?",
        a: "For many Maryland customers it is a short trip. The kitchen at 30 Asa Afariogun Street is open Monday to Saturday 8am to 8pm and Sunday 10am to 8pm.",
      },
    ],
    nearby: ["ikeja", "ilupeju", "ojota", "gbagada"],
  },

  {
    slug: "magodo",
    name: "Magodo",
    published: true,
    neighbourhoods: ["Magodo Phase 1", "Magodo Phase 2", "Shangisha", "CMD Road", "Isheri"],
    description:
      "Fresh juice delivered to homes in Magodo Phase 1 and Phase 2 (Shangisha), CMD Road and Isheri. Delivered cold, right to the estate gate.",
    intro:
      "Magodo Phase 1 and Phase 2 are quiet, gated and family-first. We deliver to homes there for daily drinking, weekend guests and celebrations, right to the gate.",
    about: [
      "Magodo is really two estates. Phase 1, around Isheri, sits off the Lagos–Ibadan Expressway, and Phase 2, the GRA at Shangisha, is entered from CMD Road. Both are planned, spacious and secure, with wide streets, detached family homes and an active residents' association that takes security seriously.",
      "Life in Magodo is centred on the home: children, visiting relatives, weekend gatherings in the compound and long Sunday afternoons. Our Magodo orders are mostly bundles and 650ml bottles for the household, plus crates when there is a birthday, an anniversary or a family thanksgiving.",
      "Because the estates feel removed from the rush of the city, many residents prefer not to drive out for small errands. Having fresh juice brought to the gate saves a trip to a supermarket on the expressway, and it means the children drink real fruit rather than a carton from the shelf.",
      "Parents here also tell us they like knowing exactly what is in a drink. Every bottle we make is pressed from whole fruit and vegetables, with nothing added, so you can hand one to a toddler, a teenager or a grandparent with the same confidence.",
    ],
    places: [
      {
        name: "Magodo Phase 2 (Shangisha)",
        note: "The GRA reached from CMD Road. Security checks every visitor at the gate.",
      },
      {
        name: "Magodo Phase 1 (Isheri)",
        note: "The older estate on the Lagos–Ibadan Expressway side.",
      },
      {
        name: "CMD Road",
        note: "The road into Phase 2 from Ikosi and Ketu, with offices and shops.",
      },
      { name: "Isheri", note: "Residential streets around Magodo Phase 1." },
      { name: "Shangisha", note: "The community that gives Phase 2 its name." },
      {
        name: "Kosofe",
        note: "The local government area around both estates, a useful landmark for nearby streets.",
      },
    ],
    route: [
      "From Ajao Estate the rider goes north through Ikeja and over towards Ojota and Ketu, then up CMD Road into Phase 2, or onto the expressway side for Phase 1.",
      "Both estates check visitors at the gate. Your name and phone number on the order let security confirm the delivery quickly, so the bottles are not left waiting in the sun outside.",
    ],
    occasions: [
      {
        title: "Everyday family drinking",
        text: "A fridge full of real fruit juice for children, parents and grandparents, topped up once or twice a week.",
      },
      {
        title: "Weekend guests",
        text: "Magodo homes host a lot. Chilled bottles are easy to offer and suit every age at the table.",
      },
      {
        title: "Birthdays in the compound",
        text: "For celebrations at home, request a quote on our bulk orders page for crates in mixed flavours.",
      },
    ],
    localNotes: [
      "Add your house number, street and phone number so the estate gate can confirm your delivery.",
      "Tell us whether you are in Phase 1 or Phase 2. They are reached from different roads.",
    ],
    faqs: [
      {
        q: "Do you deliver to Magodo Phase 1 and Phase 2?",
        a: "Yes. Tell us which phase at checkout, because they are reached by different roads.",
      },
      {
        q: "Will security let the rider in?",
        a: "Yes, once the gate can confirm with you. Add your name and a phone number you will answer.",
      },
      {
        q: "How much is delivery to Magodo?",
        a: "Checkout works out the fee for your address and shows it before you pay.",
      },
      {
        q: "Can I order for a party at home in Magodo?",
        a: "Yes. Send the date and guest numbers on our bulk orders page for a quote.",
      },
      {
        q: "Is your juice suitable for young children?",
        a: "Our juices are 100% fruit and vegetables with no added sugar or preservatives. As with any juice, children are best served small portions alongside meals, and if your child has a medical condition please check with your doctor.",
      },
      {
        q: "Do you deliver to offices on CMD Road?",
        a: "Yes. Add the company name and a contact at reception. For a regular office order, request a quote on our bulk orders page.",
      },
    ],
    nearby: ["ojota", "ogba-omole", "gbagada", "ikorodu"],
  },

  {
    slug: "ogba-omole",
    name: "Ogba, Omole & Berger",
    published: true,
    neighbourhoods: [
      "Ogba",
      "Agidingbi",
      "Omole Phase 1",
      "Omole Phase 2",
      "Ojodu Berger",
      "Isheri Road",
    ],
    description:
      "Fresh juice delivered in Ogba, Agidingbi, Omole Phase 1 and 2 and Ojodu Berger. Cold-pressed in our Ikeja kitchen, delivered cold.",
    intro:
      "From the Omole estates to Ogba and Agidingbi, homes and offices north of Ikeja can order fresh juice without the trip into town. Bottles travel cold from our kitchen and arrive ready to drink.",
    about: [
      "North of Ikeja, Ogba and Agidingbi mix factories and warehouses with busy residential streets, while Omole Phase 1 and Phase 2 are among the best-known estates on the mainland. Ojodu Berger, at the Lagos end of the Lagos–Ibadan Expressway, is a busy transport hub with markets and a constant flow of buses.",
      "Orders here come from two quite different groups. Industrial and office staff around Ogba and Acme Road order bottles for the team, especially in the hot months, and families in the Omole estates order for the home and for guests.",
      "Ogba has grown fast. Streets that were once mostly bungalows now hold shops, schools, churches and blocks of flats, and the roads between Ogba, Agidingbi and Alausa carry a lot of traffic at rush hour. For people who live here and work in Ikeja, ordering to the house is easier than carrying bottles home through that traffic.",
      "Omole, by contrast, is quieter and more settled. Families have lived in the estates for years, children grow up there, and weekends often mean a gathering at someone's house. A few chilled bottles in mixed flavours make hosting easier.",
      "Ojodu Berger deserves a mention of its own. It is where many travellers leave Lagos for Ibadan and the north, and where relatives arrive from out of town. If you are expecting visitors, a fridge of cold-pressed juice waiting at home in Omole or Ojodu is a good way to welcome them after a long road trip.",
    ],
    places: [
      { name: "Ogba", note: "Homes, shops and the industrial area around Acme Road." },
      { name: "Agidingbi", note: "The road linking Ogba with Alausa and the Secretariat." },
      {
        name: "Omole Phase 1",
        note: "An established estate in Ojodu. Gate name and house number help.",
      },
      { name: "Omole Phase 2", note: "A large estate on the Isheri side, mostly family homes." },
      {
        name: "Ojodu Berger",
        note: "The bus terminal and markets at the Lagos–Ibadan Expressway.",
      },
      { name: "Isheri Road", note: "The road connecting Ogba and Ojodu with Berger." },
    ],
    route: [
      "From Ajao Estate the rider goes north through Ikeja and Alausa, along Agidingbi to Ogba, then up Isheri Road to Omole and Berger.",
      "The estates have gates and security, and the factories have reception desks. Add the right name and phone number so the bottles are not held up at either.",
    ],
    occasions: [
      {
        title: "Factory and office teams",
        text: "Staff in Ogba's industrial area order bottles for the whole team, especially on hot afternoons.",
      },
      {
        title: "Family homes in Omole",
        text: "Weekly bundles for the household, with 330ml bottles for the school run.",
      },
      {
        title: "Celebrations and church groups",
        text: "Omole homes host birthdays, anniversaries and fellowship meetings. Request a quote on our bulk orders page.",
      },
    ],
    localNotes: [
      "For Omole Phase 1 and 2, add the estate, street and house number for the gate.",
      "Factory deliveries in Ogba: add the company name and a contact at the gate.",
    ],
    faqs: [
      {
        q: "Do you deliver to Omole Phase 1 and Phase 2?",
        a: "Yes. Add the phase, street and house number at checkout so the gate can let the rider in.",
      },
      {
        q: "Can you deliver to a factory in Ogba?",
        a: "Yes. Add the company name and a phone number for the gate. For regular team orders, request a quote on our bulk orders page.",
      },
      {
        q: "How much is delivery to Ogba and Berger?",
        a: "Checkout calculates the delivery fee for your address and shows it before you pay.",
      },
      {
        q: "Do you deliver to Ojodu Berger?",
        a: "Yes. Give a clear address or landmark, because the area around the bus terminal is very busy.",
      },
      {
        q: "Can I order juice for staff on a fixed day each week?",
        a: "Yes. Tell us the day, the number of bottles and the flavours through our bulk orders page, and we will quote for a regular delivery to your office or factory.",
      },
    ],
    nearby: ["ikeja", "magodo", "agege", "ojota"],
  },

  {
    slug: "festac",
    name: "Festac & Amuwo Odofin",
    published: true,
    neighbourhoods: ["Festac Town", "Amuwo Odofin", "Mile 2", "Satellite Town", "Agboju"],
    description:
      "Fresh juice delivered in Festac Town, Amuwo Odofin, Mile 2 and Satellite Town. Cold-pressed in Ikeja, delivered cold for families and parties.",
    intro:
      "Festac Town's avenues and the Amuwo Odofin estates are a busy, close-knit part of Lagos. We deliver fresh juice there for family fridges and for the parties that fill the weekend calendar.",
    about: [
      "Festac Town was built for FESTAC '77, the Second World Black and African Festival of Arts and Culture, and its numbered avenues and roads still make it one of the easiest parts of Lagos to find your way around. Amuwo Odofin next door has its own estates and markets, and Mile 2 is the interchange where the Oshodi–Apapa Expressway meets the Lagos–Badagry Expressway.",
      "Festac is a community that likes to celebrate: weddings, birthdays, chieftaincy events, church anniversaries and reunions of old school friends. Our orders here are a mix of crates for events and weekly bottles for families who want something better than soft drinks in the fridge.",
      "Many Festac families have lived on the same avenue for decades, and neighbours know each other well. Word of mouth matters here, and so does reliability. If you order for an event, we would rather you tell us early and in detail than find out on the day that the hall was across town.",
      "Further along the expressway, Satellite Town and the streets towards the Trade Fair Complex are growing quickly. If you live out that way, a clear landmark in your address is the best help you can give the rider.",
    ],
    places: [
      {
        name: "Festac avenues",
        note: "The numbered avenues and roads make addresses easy to find. Give yours.",
      },
      { name: "Amuwo Odofin", note: "Estates and family homes next to Festac." },
      { name: "Mile 2", note: "The interchange on the Lagos–Badagry Expressway." },
      { name: "Satellite Town", note: "Residential streets west of Festac, along the expressway." },
      { name: "Agboju", note: "The market and shops near the entrance to Festac." },
      {
        name: "Trade Fair Complex",
        note: "A well-known landmark further along the Lagos–Badagry Expressway.",
      },
    ],
    route: [
      "From Ajao Estate the rider joins the Oshodi–Apapa Expressway and heads south to Mile 2, then turns into Festac or Amuwo Odofin.",
      "The expressway can be slow because of trucks heading to and from the ports. We pack bottles cold to cover the journey, and a phone number you will answer saves time at the other end.",
    ],
    occasions: [
      {
        title: "Weddings and birthdays",
        text: "Event halls in Festac stay busy all year. Order crates early on our bulk orders page so the fruit is bought for your date.",
      },
      {
        title: "Family fridges",
        text: "Weekly bottles for households across the avenues, with flavours the children actually ask for.",
      },
      {
        title: "Church anniversaries and reunions",
        text: "Chilled juice for guests and volunteers, delivered to the hall or the church compound.",
      },
    ],
    localNotes: [
      "Give your avenue or road number and house number. It makes Festac deliveries quick.",
      "For event deliveries, add the hall name and a contact who will be there when the rider arrives.",
    ],
    faqs: [
      {
        q: "Do you deliver to Festac Town and Amuwo Odofin?",
        a: "Yes, along with Mile 2, Satellite Town and Agboju.",
      },
      {
        q: "Can you supply juice for a wedding in Festac?",
        a: "Yes. Request a quote on our bulk orders page with the date and number of guests.",
      },
      {
        q: "How much is delivery to Festac?",
        a: "The fee depends on your address and is shown at checkout before you pay.",
      },
      {
        q: "Will the juice stay cold on the expressway?",
        a: "Yes. Bottles are packed cold for the journey. Refrigerate them on arrival.",
      },
      {
        q: "How early should I order for an event in Festac?",
        a: "As early as you can. Crates for a party need fruit bought and pressed for that day, so send your date on our bulk orders page once it is fixed and we will confirm what we can supply.",
      },
      {
        q: "Do you deliver to Satellite Town and the Trade Fair end?",
        a: "Yes, with a good landmark. Those streets are further along the Lagos–Badagry Expressway, so add a nearby church, school or bus stop to your address and a phone number for the rider.",
      },
    ],
    nearby: ["apapa", "isolo-okota", "surulere"],
  },

  // ---- Q5 drafts. NOT live: published stays false until the owner confirms
  // we deliver there. TODO(owner): confirm each of these 8 areas, then flip
  // `published: true` (the page, sitemap entry and hub link appear together).
  {
    slug: "ikorodu",
    name: "Ikorodu",
    published: false,
    neighbourhoods: ["Ikorodu", "Igbogbo", "Ijede", "Agric", "Owutu", "Ogolonto", "Odogunyan"],
    description:
      "Fresh cold-pressed juice delivered to Ikorodu: Agric, Owutu, Ogolonto, Igbogbo, Ijede and Odogunyan. 100% fruit, no added sugar.",
    // TODO(owner): Ikorodu is the furthest run on this list. Confirm we deliver
    // here, and whether there is a minimum order or a set delivery day.
    intro:
      "Ikorodu is one of the largest and fastest-growing parts of Lagos, and plenty of its residents work across the city. We bring cold-pressed juice up Ikorodu Road from our Ajao Estate kitchen so there is real fruit in the fridge after the long commute home.",
    about: [
      "Ikorodu is a town in its own right, with a history much older than most of the Lagos suburbs around it. The old town centre, the markets around the garage and the waterfront at Ebute sit alongside new estates in Igbogbo, Ijede and along the Sagamu Road, and new homes keep appearing every year.",
      "Many Ikorodu residents spend hours each day on Ikorodu Road or the BRT corridor into the city. That shapes what people want from us: an order placed once, delivered to the house, enough bottles to last the week, and nothing that needs a separate trip to find.",
      "Ikorodu is also home to a big student population at the Lagos State University of Science and Technology, formerly LASPOTECH, and to a growing number of churches, schools and small businesses. Each of them hosts events, from matriculations and harvests to shop openings, where chilled juice is welcome.",
    ],
    places: [
      {
        name: "Ikorodu town and garage",
        note: "The old centre and main transport hub. Name a nearby street or landmark.",
      },
      { name: "Agric", note: "A busy bus stop and residential area on the way into Ikorodu." },
      {
        name: "Owutu and Ogolonto",
        note: "Neighbourhoods along Ikorodu Road before the town centre.",
      },
      { name: "Igbogbo", note: "A historic town with fast-growing estates, east of Ikorodu." },
      { name: "Ijede", note: "Lagoon-side community with new residential developments." },
      { name: "Odogunyan", note: "Newer estates on the Sagamu Road side of Ikorodu." },
      {
        name: "LASUSTECH",
        note: "The state university campus, formerly LASPOTECH, a known landmark.",
      },
    ],
    route: [
      "The rider leaves Ajao Estate for Maryland, then takes Ikorodu Road all the way out past Ojota, Ketu and Mile 12 into Ikorodu, turning off at Agric, Owutu or the town centre depending on your address.",
      "It is a long trip, so we pack bottles cold and keep the route direct. Traffic on Ikorodu Road is heaviest at rush hour, which is one more reason to order ahead and receive one delivery for the week.",
    ],
    occasions: [
      {
        title: "Stocking up for the commute week",
        text: "One delivery of bundles and 650ml bottles keeps a busy Ikorodu household going from Monday to Friday.",
      },
      {
        title: "Church and school events",
        text: "Harvests, prize-giving days and youth programmes call for crates. Request a quote on our bulk orders page.",
      },
      {
        title: "Students and staff on campus",
        text: "A few bottles shared in a hostel or a staff room beat another sachet drink in the heat.",
      },
    ],
    localNotes: [
      "Ikorodu addresses can be hard to find. Add a landmark such as a church, school or bus stop, and a phone number you will answer.",
      "For the newer estates in Igbogbo and Odogunyan, include the estate name and the gate a visitor should use.",
    ],
    faqs: [
      {
        q: "Do you deliver fresh juice to Ikorodu?",
        a: "Ikorodu is on our delivery map. Enter your address at checkout to see whether it can be delivered and what the delivery fee is before you pay.",
      },
      {
        q: "Will the juice still be cold after the trip up Ikorodu Road?",
        a: "Bottles leave our kitchen chilled and are packed cold for the trip. Put them in the fridge as soon as they arrive, because there are no preservatives.",
      },
      {
        q: "How much does delivery to Ikorodu cost?",
        a: "Delivery fee shown at checkout. It depends on your exact address in Ikorodu, so the price is calculated for you before you pay.",
      },
      {
        q: "Can I order for a church harvest or school event in Ikorodu?",
        a: "Yes. Send the date, the venue and the number of guests on our bulk orders page and we will reply with a quote.",
      },
      {
        q: "Can I order juice to be delivered to Ebute or near the jetty?",
        a: "Enter your address at checkout to confirm delivery there. If you are travelling by ferry, choose an address where someone can receive the bottles and put them in a fridge.",
      },
    ],
    nearby: ["ojota", "magodo", "maryland"],
  },

  {
    slug: "sangotedo",
    name: "Sangotedo",
    published: false,
    neighbourhoods: ["Sangotedo", "Monastery Road", "Ogombo Road", "Abijo", "Awoyaya", "Lakowe"],
    description:
      "Fresh juice delivered to Sangotedo, Monastery Road, Ogombo Road, Abijo, Awoyaya and Lakowe. Cold-pressed in Lagos, delivered cold.",
    // TODO(owner): confirm Sangotedo and the estates past it (Abijo, Awoyaya,
    // Lakowe) are on the delivery map. The live Ajah page also lists Sangotedo.
    intro:
      "Sangotedo has grown from farmland into a town of new estates in a few short years, and the families moving in want good food close to home. We send cold-pressed juice down the Lekki–Epe Expressway to Sangotedo, Abijo and Awoyaya, packed cold for the journey.",
    about: [
      "Sangotedo sits past Ajah on the Lekki–Epe Expressway, where the city starts to thin out and the estates get newer. Monastery Road and Ogombo Road are the two names everyone uses for directions, and Novare Lekki Mall, with its Shoprite, has become the area's meeting point.",
      "Residents here are often young families who moved further out for space. They are building a life a long way from the city's markets and big supermarkets, so anything good that can be delivered to the estate gate saves an afternoon on the expressway.",
      "Further on, Abijo, Awoyaya and Lakowe are home to gated communities, golf and lakeside estates and new schools. Many of them are still growing, which means new neighbours, house-warmings and children's parties almost every weekend.",
      "Families here tend to plan their week carefully, because every trip out means time on the expressway. A single delivery of juice, timed for the start of the week or the weekend, fits that pattern. Many new residents also tell us they miss the markets of the mainland, and fresh fruit pressed the same morning brings a bit of that freshness to the edge of the city.",
    ],
    places: [
      {
        name: "Monastery Road",
        note: "The main road into Sangotedo's estates from the expressway.",
      },
      { name: "Ogombo Road", note: "Links Sangotedo with the Abraham Adesanya side of Ajah." },
      {
        name: "Novare Lekki Mall",
        note: "The Shoprite mall on the expressway, a landmark for nearby streets.",
      },
      { name: "Abijo", note: "New estates and schools a little further along the expressway." },
      { name: "Awoyaya", note: "Growing residential area with gated communities." },
      { name: "Lakowe", note: "Known for its lakeside and golf estate, past Awoyaya." },
    ],
    route: [
      "This is one of our longest runs. The rider crosses to the Island from Ajao Estate, joins the Lekki–Epe Expressway and travels its full length past Lekki, Chevron, VGC and Ajah before turning off for Monastery Road, Ogombo Road or the estates further on.",
      "Every bottle is packed cold before it leaves. Ordering ahead, with an exact estate and house number, keeps the hand-over quick when the rider reaches you.",
    ],
    occasions: [
      {
        title: "Young families in new estates",
        text: "Bundles of 650ml bottles mean the fridge is stocked without a long drive to the shops.",
      },
      {
        title: "House-warmings and children's parties",
        text: "New neighbours, new homes, lots of parties. Order crates ahead on our bulk orders page.",
      },
      {
        title: "Weekend golf and lakeside outings",
        text: "A cooler of cold-pressed bottles for a day out at Lakowe or by the water.",
      },
    ],
    localNotes: [
      "Most Sangotedo estates have a gate. Add the estate name, street and house number for security.",
      "If your estate is new and not yet on maps, describe the turning from Monastery Road or Ogombo Road.",
    ],
    faqs: [
      {
        q: "Do you deliver to Sangotedo and Abijo?",
        a: "Enter your Sangotedo or Abijo address at checkout. If it can be delivered you will see the delivery fee before you pay, and you can always ask us on WhatsApp first.",
      },
      {
        q: "Will the juice be cold after such a long ride?",
        a: "Bottles leave our kitchen chilled and are packed cold for the expressway. Refrigerate them as soon as they arrive.",
      },
      {
        q: "What does delivery to Sangotedo cost?",
        a: "Delivery fee shown at checkout. It is calculated for your exact address, so you know the full cost before paying.",
      },
      {
        q: "Can you supply juice for a children's party in my estate?",
        a: "Yes. Tell us the date, the estate and the number of children on our bulk orders page, and we will send a quote.",
      },
      {
        q: "Do you deliver to Awoyaya and Lakowe?",
        a: "These estates are further along the expressway past Sangotedo. Enter your address at checkout to see whether we can deliver there and what the delivery fee is, or ask us on WhatsApp first.",
      },
    ],
    nearby: ["ajah", "chevron", "lekki"],
  },

  {
    slug: "chevron",
    name: "Chevron & Ikota",
    published: false,
    neighbourhoods: [
      "Chevron Drive",
      "Ikota",
      "VGC",
      "Orchid Road",
      "Lafiaji",
      "Igbo Efon",
      "Alpha Beach Road",
    ],
    description:
      "Fresh juice delivered around Chevron Drive, Ikota, VGC, Orchid Road, Lafiaji and Igbo Efon in Lekki. 100% fruit, packed cold.",
    // TODO(owner): confirm delivery around Chevron. The live Lekki page also
    // mentions this stretch; once both are live they should stay distinct.
    intro:
      "The stretch of Lekki around the Chevron roundabout has become a neighbourhood of its own: offices on Chevron Drive, homes on Orchid Road and in Lafiaji, and the gated quiet of VGC next door. We deliver cold-pressed juice to all of it, packed cold for the long ride from Ikeja.",
    about: [
      "Chevron takes its name from the oil company's Lagos head office on Chevron Drive, and the roundabout and toll plaza nearby are among the best-known points on the Lekki–Epe Expressway. Around them, Orchid Road, Lafiaji and Igbo Efon have filled with apartment blocks and terraces, while Ikota and Victoria Garden City offer older, quieter estates.",
      "The Lekki Conservation Centre, with its canopy walkway, is just along the expressway, and Alpha Beach Road runs down towards the Atlantic. It is a part of Lagos where people mix office life with weekend outings, and both are good reasons to have something cold and real to drink.",
      "Residents here are often professionals who work long hours on the Island or from home, and many of them order online for almost everything. A weekly delivery of juice fits that routine neatly.",
      "Weekends around Chevron have their own pattern too. Families head to the Conservation Centre or the beach, friends gather in apartments in Lafiaji and Orchid Road, and VGC residents host in their compounds. A cooler of mixed bottles, delivered the evening before or on the morning, means nobody has to make a supermarket run before the guests arrive.",
    ],
    places: [
      {
        name: "Chevron Drive",
        note: "Offices and estates around the Chevron head office and roundabout.",
      },
      {
        name: "VGC (Victoria Garden City)",
        note: "A large gated estate. Give your house and street for the gate.",
      },
      { name: "Ikota", note: "The estate and the shopping complex beside VGC." },
      { name: "Orchid Road", note: "Apartment blocks and terraces off the expressway." },
      {
        name: "Lafiaji and Igbo Efon",
        note: "Fast-growing residential streets near the second toll plaza.",
      },
      { name: "Alpha Beach Road", note: "Homes and short-lets on the road towards the beach." },
      {
        name: "Lekki Conservation Centre",
        note: "A landmark on the expressway for describing nearby streets.",
      },
    ],
    route: [
      "From Ajao Estate the rider crosses to the Island, comes through Ikoyi or Victoria Island and joins the Lekki–Epe Expressway, passing Lekki Phase 1, Jakande and Agungi before reaching the Chevron roundabout.",
      "From there it is a short turn into Chevron Drive, Orchid Road, Ikota or VGC. Gated estates are the main hold-up, so a resident's name and phone number on the order matter.",
    ],
    occasions: [
      {
        title: "Work-from-home weeks",
        text: "A mixed set delivered on Monday means a cold bottle between calls all week.",
      },
      {
        title: "Office teams on Chevron Drive",
        text: "Bottles for meetings and staff. For regular deliveries, request a quote on our bulk orders page.",
      },
      {
        title: "Beach days and outings",
        text: "Pack a cooler before heading down Alpha Beach Road or to the Conservation Centre.",
      },
    ],
    localNotes: [
      "For VGC, Ikota and other gated estates, add the resident's name, house number and phone number.",
      "Apartment blocks on Orchid Road: include the block name and flat number.",
    ],
    faqs: [
      {
        q: "Do you deliver inside VGC and Ikota?",
        a: "Enter your VGC or Ikota address at checkout to confirm delivery and see the fee. Add the resident's name and phone number so the gate can let the rider in.",
      },
      {
        q: "How much is delivery to Chevron?",
        a: "Delivery fee shown at checkout, calculated for your exact address before you pay.",
      },
      {
        q: "Can an office on Chevron Drive order juice every week?",
        a: "Yes. Request a quote on our bulk orders page with the number of bottles and the day you would like them.",
      },
      {
        q: "Is the juice still fresh after the trip from Ikeja?",
        a: "Yes. It is pressed in the morning and packed cold. Keep it refrigerated when it arrives and drink it fresh.",
      },
      {
        q: "Do you deliver to Lafiaji, Orchid Road and Igbo Efon?",
        a: "Enter your address at checkout to confirm. These streets are busy and fast-changing, so add the block or estate name and a nearby landmark on the expressway.",
      },
    ],
    nearby: ["lekki", "ajah", "sangotedo"],
  },

  {
    slug: "oniru",
    name: "Oniru",
    published: false,
    neighbourhoods: [
      "Oniru Estate",
      "Water Corporation Drive",
      "Palace Road",
      "Akiogun Road",
      "Landmark Beach",
    ],
    description:
      "Fresh juice delivered in Oniru: Oniru Estate, Water Corporation Drive, Palace Road and Akiogun Road, between VI and Lekki. Delivered cold.",
    // TODO(owner): confirm Oniru as its own page. The live Victoria Island
    // page also mentions Oniru; once both are live they must stay distinct.
    intro:
      "Oniru sits between Victoria Island and the Lekki toll gate, a compact neighbourhood of homes, offices, beach clubs and event spaces. We deliver cold-pressed juice across the estate and down to the waterfront.",
    about: [
      "Oniru is royal land. The estate takes its name from the Oniru ruling family, whose palace stands on Palace Road, and the neighbourhood still feels distinct from the busy towers of VI to the west. Its streets are a mix of family homes, offices, restaurants and apartments, with Akiogun Road and Water Corporation Drive the busiest of them.",
      "Down by the Atlantic, Landmark Beach and the Oniru beachfront draw crowds every weekend, and the event halls and centres around Water Corporation Drive host conferences, exhibitions and weddings all year. That makes Oniru a place where juice is ordered for crowds as often as for homes.",
      "For residents, the appeal is simple: Oniru is central, close to both VI and Lekki, yet quieter than either. A delivery of fresh juice to the house fits that easy, in-between life.",
      "Oniru also has a large share of short-let apartments, popular with visitors to Lagos who want to be near both VI and Lekki. Guests staying a few days often want healthy food and drinks without searching the city for them. A mixed set of cold-pressed bottles delivered to the apartment covers breakfast and a cold drink after a long day of meetings.",
    ],
    places: [
      {
        name: "Oniru Estate",
        note: "The residential heart of Oniru. Add your street and house number.",
      },
      {
        name: "Water Corporation Drive",
        note: "Event centres, offices and the road down to the beach.",
      },
      { name: "Palace Road", note: "Home of the Oniru palace, a landmark everybody knows." },
      { name: "Akiogun Road", note: "Busy street of offices, eateries and apartments." },
      {
        name: "Landmark Beach",
        note: "The beachfront and event venues at the end of Water Corporation Drive.",
      },
      {
        name: "Oniru beachfront",
        note: "The stretch of private beaches along the Atlantic, busy at weekends.",
      },
    ],
    route: [
      "From Ajao Estate the rider heads over to the Island by Third Mainland Bridge or Eko Bridge, passes through Victoria Island and turns into Oniru before the Lekki toll gate.",
      "For events by the beach, venues can be busy and parking tight. A contact at the venue and the name of the hall or space get the crates where they need to go.",
    ],
    occasions: [
      {
        title: "Conferences and exhibitions",
        text: "Event spaces in Oniru host business and trade events. Chilled bottles for guests and staff can be quoted on our bulk orders page.",
      },
      {
        title: "Beach weekends",
        text: "A cooler of cold-pressed juice for a day by the sea is far better than a crate of soft drinks.",
      },
      {
        title: "Homes and apartments",
        text: "Residents order a mixed set for the fridge, plus gift boxes for friends nearby.",
      },
    ],
    localNotes: [
      "For event deliveries, add the venue name and a contact person who will be on site.",
      "Apartment buildings: include the building name, flat number and a phone number for the front desk.",
    ],
    faqs: [
      {
        q: "Do you deliver to Oniru Estate?",
        a: "Enter your Oniru address at checkout to confirm delivery. The delivery fee is calculated for your address and shown before you pay.",
      },
      {
        q: "Can you deliver juice to an event at Landmark Beach or on Water Corporation Drive?",
        a: "Yes, with notice. Send the date, the venue and guest numbers on our bulk orders page so we can plan stock and the drop-off.",
      },
      {
        q: "How much is delivery to Oniru?",
        a: "Delivery fee shown at checkout. It depends on your exact address in Oniru.",
      },
      {
        q: "Is Oniru covered by your Victoria Island deliveries?",
        a: "Oniru is right next to VI and served on the same run from our kitchen. Either way, checkout prices delivery for your exact address.",
      },
      {
        q: "Can you deliver to a short-let apartment in Oniru?",
        a: "Yes, once your address is confirmed at checkout. Give the apartment name, unit number and your own phone number, since the caretaker may not know you are expecting a delivery.",
      },
    ],
    nearby: ["victoria-island", "lekki", "ikoyi"],
  },

  {
    slug: "ilupeju",
    name: "Ilupeju",
    published: false,
    neighbourhoods: [
      "Ilupeju",
      "Ilupeju Industrial Estate",
      "Town Planning Way",
      "Palmgrove",
      "Onipanu",
      "Ilupeju Bypass",
    ],
    description:
      "Fresh juice delivered to homes, offices and factories in Ilupeju, Palmgrove and Onipanu, close to our Ajao Estate kitchen. 100% fruit.",
    // TODO(owner): confirm Ilupeju, and whether factories here already order.
    intro:
      "Ilupeju mixes one of Lagos's oldest industrial estates with quiet residential streets, and both are a short ride from our Ajao Estate kitchen. We deliver cold-pressed juice to factory canteens, offices and family homes across Ilupeju, Palmgrove and Onipanu.",
    about: [
      "Ilupeju Industrial Estate has been home to manufacturers and food companies for decades, and its avenues are lined with factory gates, warehouses and head offices. Around it, the residential side of Ilupeju is surprisingly calm, with older homes, churches and schools on tree-lined streets off Town Planning Way.",
      "On the Ikorodu Road side, Palmgrove and Onipanu are busy and commercial, with bus stops that see heavy traffic all day. The Ilupeju Bypass links the estate with Anthony and Maryland, which keeps it well connected to the rest of the mainland.",
      "That mix brings two kinds of order. Factories and offices want bottles for staff and visitors, often on a set day, while households want a few bottles for the fridge. Both are easy from a kitchen that is close by.",
      "The residential side of Ilupeju has its own rhythm. Children walk to schools on the quiet streets, families gather at the many churches on Sundays, and older residents remember when the area was mostly bungalows and gardens. For homes here, juice from a kitchen just down the road means fewer trips into the crowded Ikorodu Road bus stops.",
    ],
    places: [
      {
        name: "Ilupeju Industrial Estate",
        note: "Factory gates, warehouses and offices. Add the company name for security.",
      },
      { name: "Town Planning Way", note: "The main road through residential Ilupeju." },
      { name: "Ilupeju Bypass", note: "The link road towards Anthony and Maryland." },
      { name: "Palmgrove", note: "The busy Ikorodu Road end of Ilupeju." },
      { name: "Onipanu", note: "Shops and homes near the Onipanu bus stop on Ikorodu Road." },
      {
        name: "Industrial Avenue",
        note: "One of the main roads inside the industrial estate, lined with company gates.",
      },
    ],
    route: [
      "From Ajao Estate the rider heads towards Oshodi and across to Ilupeju through Mushin, or via Mobolaji Bank Anthony Way and the bypass, whichever road is clearer.",
      "Factory gates in the industrial estate check every delivery. A company name, the department and a phone number make sure the bottles go in rather than wait outside.",
    ],
    occasions: [
      {
        title: "Factory canteens and staff",
        text: "Bottles for production teams and office staff, especially through the hot season.",
      },
      {
        title: "Visitors and meetings",
        text: "Head offices in the estate offer chilled juice to visiting clients and suppliers.",
      },
      {
        title: "Homes off Town Planning Way",
        text: "Weekly bottles for families in the quieter residential streets.",
      },
    ],
    localNotes: [
      "Factory deliveries: add the company name and a contact at the gate.",
      "Near Palmgrove or Onipanu bus stops, give a building or shop as a meeting point.",
    ],
    faqs: [
      {
        q: "Can you deliver to a factory in Ilupeju Industrial Estate?",
        a: "Enter the factory address at checkout to confirm delivery. Add the company name and a phone number for the gate. For a regular staff order, request a quote on our bulk orders page.",
      },
      {
        q: "How much is delivery to Ilupeju?",
        a: "Delivery fee shown at checkout, calculated from your exact address before you pay.",
      },
      {
        q: "Is Ilupeju close to your kitchen?",
        a: "Yes, it is a short ride from our kitchen in Ajao Estate, so bottles arrive well chilled.",
      },
      {
        q: "Do you deliver to Palmgrove and Onipanu?",
        a: "Enter your address at checkout to confirm. Give a nearby building or shop, because the bus stops there are very busy.",
      },
      {
        q: "Can I collect from your kitchen instead?",
        a: "Yes. Ilupeju is not far from Ajao Estate. Walk in at 30 Asa Afariogun Street, Monday to Saturday 8am to 8pm and Sunday 10am to 8pm, and message us on WhatsApp first if you want a particular flavour.",
      },
      {
        q: "Can a factory order on the same day every week?",
        a: "Yes. Tell us the day, the number of bottles and the flavours through our bulk orders page, and we will reply with a quote for a standing order to your gate.",
      },
    ],
    nearby: ["maryland", "ikeja", "surulere", "yaba"],
  },

  {
    slug: "ojota",
    name: "Ojota & Ogudu",
    published: false,
    neighbourhoods: ["Ojota", "Ogudu", "Ogudu GRA", "Ketu", "Alapere", "Mile 12"],
    description:
      "Fresh juice delivered to Ojota, Ogudu, Ogudu GRA, Ketu, Alapere and Mile 12. Cold-pressed in our Ikeja kitchen and delivered cold.",
    // TODO(owner): confirm Ojota, Ogudu and Ketu are on the delivery map.
    intro:
      "Ojota is the gateway where the Lagos–Ibadan Expressway runs into the city and Ikorodu Road heads off to the north-east. Around it, Ogudu GRA, Alapere and Ketu are busy homes for people who work all over Lagos. We deliver cold-pressed juice across all of them.",
    about: [
      "Ojota is known for its interchange, for the interstate motor park at Ojota New Garage, and for Gani Fawehinmi Freedom Park. The Opebi Link Bridge now connects it directly with Ikeja, which has made the area even more central.",
      "Next door, Ogudu GRA is a planned, leafy estate of family homes, and Ogudu Road runs down towards Alapere and the Third Mainland approach. In the other direction, Ketu and Mile 12 are famous for their food market, where trucks arrive from the north with tomatoes, peppers, yams and fruit.",
      "People here are always on the move, so orders tend to be planned: a set of bottles delivered to the house, an office order for the week, or crates for a family event in the GRA.",
      "Mile 12 market deserves its own note. It is one of the biggest foodstuff markets in Lagos, and traders there know fresh produce better than anyone. They also spend long hours in the heat, and a cold bottle of pressed fruit is a welcome break. If you trade there, give your line or section and a phone number, and meet the rider at a point outside the busiest lanes.",
    ],
    places: [
      { name: "Ojota interchange", note: "Where the Lagos–Ibadan Expressway meets Ikorodu Road." },
      {
        name: "Ogudu GRA",
        note: "A planned estate of family homes. Add your street for the gate.",
      },
      { name: "Ogudu Road", note: "The road from Ojota down towards Alapere." },
      { name: "Ketu and Mile 12", note: "Busy streets around the famous food market." },
      { name: "Alapere", note: "Residential area near Ketu and Ogudu." },
      {
        name: "Gani Fawehinmi Freedom Park",
        note: "A landmark at Ojota for describing nearby streets.",
      },
      {
        name: "Ojota New Garage",
        note: "The interstate motor park at Ojota, a well-known landmark.",
      },
    ],
    route: [
      "From Ajao Estate the rider goes up through Ikeja and over the Opebi Link Bridge to Ojota, or down Mobolaji Bank Anthony Way to Maryland and along Ikorodu Road, then turns off for Ogudu, Ketu or Alapere.",
      "The interchange and market areas are crowded. Give a clear meeting point if you are near Ojota New Garage or Mile 12.",
    ],
    occasions: [
      {
        title: "Family homes in Ogudu GRA",
        text: "A weekly set of bottles for the household and for guests at the weekend.",
      },
      {
        title: "Offices around the interchange",
        text: "Staff orders for meetings and long days. Request a quote on our bulk orders page.",
      },
      {
        title: "Travellers and visitors",
        text: "Relatives arriving through Ojota from out of town? Have cold juice waiting when they reach the house.",
      },
    ],
    localNotes: [
      "For Ogudu GRA, add your street and house number for the gate.",
      "Near the motor park or the market, a named shop or building as a meeting point saves time.",
    ],
    faqs: [
      {
        q: "Do you deliver to Ogudu GRA and Ketu?",
        a: "Enter your address at checkout to confirm delivery and see the delivery fee before you pay.",
      },
      {
        q: "How much is delivery to Ojota?",
        a: "Delivery fee shown at checkout. It is worked out from your exact address.",
      },
      {
        q: "Can I order for a family event in Ogudu?",
        a: "Yes. Tell us the date and the number of guests on our bulk orders page and we will quote.",
      },
      {
        q: "Will the juice be cold when it arrives?",
        a: "Yes. Bottles are pressed in the morning, packed cold and sent from our Ikeja kitchen. Keep them in the fridge once delivered.",
      },
      {
        q: "Do you deliver to traders at Mile 12 market?",
        a: "Enter your address at checkout to confirm. Give your line, section and a phone number, and choose a meeting point outside the busiest lanes where the rider can stop.",
      },
    ],
    nearby: ["maryland", "magodo", "gbagada", "ikorodu"],
  },

  {
    slug: "apapa",
    name: "Apapa",
    published: false,
    neighbourhoods: ["Apapa", "Apapa GRA", "Wharf Road", "Liverpool Road", "Creek Road", "Ijora"],
    description:
      "Fresh juice delivered to offices, homes and port businesses in Apapa: Apapa GRA, Wharf Road, Liverpool Road, Creek Road and Ijora.",
    // TODO(owner): confirm Apapa. Port traffic can make timing unpredictable;
    // tell us if there is a cut-off or a set delivery day for Apapa.
    intro:
      "Apapa is where Nigeria's busiest seaports meet the city, and the offices around them work long, hot days. We deliver cold-pressed juice to shipping and clearing offices, banks and homes in Apapa GRA, straight down the expressway from our kitchen.",
    about: [
      "Apapa is home to the Lagos Port Complex and Tin Can Island Port, and its roads, Wharf Road, Creek Road, Liverpool Road and Warehouse Road, are lined with shipping lines, clearing agents, banks and logistics firms. Behind the commercial streets, Apapa GRA is a quiet, older residential area with large homes and tree-lined roads.",
      "Anyone who has driven to Apapa knows about the trucks. Container and tanker traffic on the approach roads can be heavy, which means people who work here rarely pop out for anything during the day. An order of juice delivered to the office is one less reason to leave.",
      "The port never really stops, and neither do many of the people who work around it. Staff who start early and finish late are glad of something cold and real to drink.",
      "Apapa GRA is a different world from the port roads. Its wide streets and older houses are home to families who have lived there for years, and to company guest houses for staff posted to Lagos. Residents here order for the household, while the guest houses order for visitors who want something fresh after a long day at the port.",
    ],
    places: [
      {
        name: "Wharf Road",
        note: "Port offices and businesses along the main road by the Lagos Port Complex.",
      },
      { name: "Liverpool Road", note: "Offices and homes on one of Apapa's best-known roads." },
      { name: "Creek Road", note: "Shipping and logistics offices close to the water." },
      { name: "Apapa GRA", note: "The quiet residential side of Apapa." },
      { name: "Ijora", note: "Where the expressway and the bridges meet on the way into Apapa." },
      { name: "Tin Can Island Port", note: "The second port, a landmark for offices nearby." },
      {
        name: "Warehouse Road",
        note: "Offices, banks and businesses on one of Apapa's oldest commercial roads.",
      },
    ],
    route: [
      "From Ajao Estate the rider joins the Oshodi–Apapa Expressway and follows it south past Mile 2 and Ijora into Apapa, then turns off for Wharf Road, Creek Road or the GRA.",
      "Truck traffic on the port roads can be slow, so we pack bottles cold to cover the trip and ask for a phone number that will be answered when the rider arrives.",
    ],
    occasions: [
      {
        title: "Port and clearing offices",
        text: "Bottles for staff who rarely get to leave their desks. Request a quote on our bulk orders page for regular orders.",
      },
      {
        title: "Banks and logistics firms",
        text: "Chilled juice for meetings, visitors and long afternoons.",
      },
      {
        title: "Homes in the GRA",
        text: "A weekly set for families on the quiet residential side of Apapa.",
      },
    ],
    localNotes: [
      "Office deliveries: add the company name, floor and a phone number the gate or reception can call.",
      "Inside the ports themselves, security rules apply. Choose an address outside the gate where you can meet the rider.",
    ],
    faqs: [
      {
        q: "Do you deliver to offices in Apapa?",
        a: "Enter your Apapa address at checkout to confirm delivery and see the fee. Add the company name and a phone number for reception.",
      },
      {
        q: "Can you deliver inside the port?",
        a: "Port security controls entry, so please choose an address outside the gate where you or a colleague can meet the rider.",
      },
      {
        q: "How much is delivery to Apapa?",
        a: "Delivery fee shown at checkout, based on your exact address in Apapa.",
      },
      {
        q: "Will traffic affect my order?",
        a: "Port traffic can slow the last part of the trip. Bottles are packed cold for the journey, and ordering ahead gives the most reliable result.",
      },
      {
        q: "Do you deliver to homes in Apapa GRA?",
        a: "Enter your address at checkout to confirm delivery and see the fee. Add your house number and a phone number in case the gate needs to call you.",
      },
    ],
    nearby: ["festac", "lagos-island", "surulere", "isolo-okota"],
  },

  {
    slug: "agege",
    name: "Agege",
    published: false,
    neighbourhoods: ["Agege", "Dopemu", "Orile Agege", "Pen Cinema", "Iju Road", "Abule Egba"],
    description:
      "Fresh juice delivered in Agege, Dopemu, Orile Agege, Pen Cinema, Iju Road and Abule Egba. Cold-pressed in Ikeja, close by.",
    // TODO(owner): confirm Agege and how far up towards Abule Egba we deliver.
    intro:
      "Agege is famous across Nigeria for its bread, and it is just as proud of its busy markets, its stadium and its long, lively roads. We deliver cold-pressed juice from our nearby Ajao Estate kitchen to homes, shops and offices across Agege, Dopemu and Orile Agege.",
    about: [
      "Agege grew up around the railway and Agege Motor Road, and it is still one of the most crowded and energetic parts of the mainland. Pen Cinema junction is its best-known landmark, Agege Stadium hosts football and community events, and the markets around the railway line are busy from early morning.",
      "Dopemu sits between Agege and Ikeja, and Orile Agege and the roads towards Iju and Abule Egba stretch north into newer residential areas. Families here are often large and neighbourhoods close-knit, with churches and mosques at the centre of community life.",
      "Our Agege orders are a mix of homes stocking up and traders who want something cold through a long day in the market heat. Because Agege is close to our kitchen, bottles arrive well chilled.",
      "Agege bread is a name known across the country, and the bakeries, bread sellers and breakfast stalls of Agege start work before dawn. A morning loaf with a cold glass of real fruit juice is a very Lagos breakfast. For families who buy their bread fresh every morning, it makes sense to keep a few bottles of pressed juice in the fridge alongside it.",
    ],
    places: [
      {
        name: "Pen Cinema",
        note: "The famous junction at the heart of Agege. Name the nearest street.",
      },
      { name: "Agege Motor Road", note: "The long main road through the area." },
      { name: "Dopemu", note: "Between Agege and Ikeja, with homes and small businesses." },
      { name: "Orile Agege", note: "Residential neighbourhood with markets and churches." },
      { name: "Agege Stadium", note: "A well-known landmark for nearby addresses." },
      {
        name: "Iju Road and Abule Egba",
        note: "Roads heading north into newer residential areas.",
      },
      {
        name: "Agege railway line",
        note: "The old railway through the heart of Agege, with markets alongside it.",
      },
    ],
    route: [
      "From Ajao Estate the rider heads up through Ikeja to Dopemu, then into Agege along Agege Motor Road, turning off at Pen Cinema or towards Orile Agege and Iju Road.",
      "Agege roads and markets are crowded. A phone number you will answer and a nearby landmark, such as a church, school or bus stop, help the rider find you quickly.",
    ],
    occasions: [
      {
        title: "Large family households",
        text: "650ml bottles and bundles keep the fridge stocked for a full house.",
      },
      {
        title: "Traders in the market heat",
        text: "A few cold bottles for the stall, shared with apprentices through the day.",
      },
      {
        title: "Celebrations and religious events",
        text: "Weddings, naming ceremonies and festivals. Request a quote for crates on our bulk orders page.",
      },
    ],
    localNotes: [
      "Add a landmark near your house, such as a church, mosque, school or bus stop.",
      "For market deliveries, give the market name, your line and a phone number.",
    ],
    faqs: [
      {
        q: "Do you deliver to Agege and Dopemu?",
        a: "Enter your address at checkout to confirm delivery and see the delivery fee before you pay.",
      },
      {
        q: "How much is delivery to Agege?",
        a: "Delivery fee shown at checkout. It is worked out for your exact address.",
      },
      {
        q: "Is Agege close to your kitchen?",
        a: "Yes. Our kitchen is in Ajao Estate, Ikeja, so Agege is a fairly short ride and bottles arrive well chilled.",
      },
      {
        q: "Can I order juice for a wedding or naming ceremony in Agege?",
        a: "Yes. Send the date, the venue and the number of guests on our bulk orders page and we will reply with a quote.",
      },
      {
        q: "Do you deliver as far as Abule Egba and Iju?",
        a: "Enter your address at checkout to see whether delivery is available and what the delivery fee is. Add a landmark, because these roads are long and the streets off them can be hard to find.",
      },
    ],
    nearby: ["ikeja", "ogba-omole", "maryland"],
  },
];

export const PUBLISHED_AREAS: DeliveryArea[] = DELIVERY_AREAS.filter((a) => a.published);

/** Published areas only — drafts must 404. */
export function findArea(slug: string): DeliveryArea | undefined {
  return PUBLISHED_AREAS.find((a) => a.slug === slug);
}

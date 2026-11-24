/**
 * Long-form product copy for /juices/<slug> (SEO roadmap Q3).
 *
 * Product data (name, ingredients, prices, stock) lives in the database and is
 * edited in admin. This file only adds the longer, search-friendly copy the
 * database has no field for, keyed by product slug. Every ingredient named
 * here comes from the live catalogue (`/v1/public/catalog/products`); nothing
 * is invented. Prices and sizes are NOT written here — the page renders them
 * from live data so they never go stale.
 *
 * Body text is the small Markdown subset `renderMarkdown` supports:
 * paragraphs, **bold** and [links](/path).
 *
 * TODO(owner): confirm the exact shelf life (days, chilled) for each juice and
 * whether it differs by bottle size. The storage sections below are phrased
 * generally ("drink it soon", "within the date on the label") until then.
 * TODO(owner): nutrition per bottle (calories, sugar, vitamin C) needs lab or
 * calculated values before it can be shown or added to the Product schema.
 */

export interface ProductCopySection {
  heading: string;
  body: string;
}

export interface ProductCopy {
  /** Unique meta description, 155 characters or fewer. */
  metaDescription: string;
  intro: string;
  sections: ProductCopySection[];
}

const DELIVERY = "/juice-delivery-lagos";

export const PRODUCT_COPY: Record<string, ProductCopy> = {
  "guava-punch": {
    metaDescription:
      "Guava Punch: cold-pressed guava and pineapple juice from Mrs. Samuel, made fresh in Lagos. Tropical, tangy and bright. Order for delivery across Lagos.",
    intro:
      "Guava Punch is what happens when two of the most loved fruits in a Nigerian market share one bottle. Ripe guava gives it a thick, perfumed sweetness, and pineapple cuts through with a sharp, juicy tang. The first sip tastes like the inside of a guava; the finish is all pineapple. It is fuller in body than a citrus juice, but still light enough to drink cold on a hot afternoon.",
    sections: [
      {
        heading: "What goes into it",
        body: "Just two fruits: **guava and pineapple**. Nothing else is added to the bottle, so the colour, the sweetness and the slight pulpiness all come from the fruit itself.\n\nGuava is well known as one of the richest fruit sources of vitamin C, gram for gram ahead of oranges. Pineapple brings bromelain, a natural enzyme found in the fruit, plus its own vitamin C. Cold pressing squeezes the juice out without heat, which helps keep the fresh-fruit taste.",
      },
      {
        heading: "How and when to drink it",
        body: "Guava Punch works best ice-cold, straight from the fridge. Drink it mid-morning when breakfast has worn off, or pour it alongside a plate of rice and stew at lunch, where the tang balances the pepper. It is also a friendly first bottle for anyone new to cold-pressed juice, because it tastes familiar. Give the bottle a good shake first: natural guava pulp settles at the bottom.",
      },
      {
        heading: "Keeping it fresh",
        body: "Because it is cold-pressed and never heated or preserved, Guava Punch has a short life. Put it in the fridge as soon as it arrives, keep it cold, and drink it within the date on the label. Once you open it, finish it the same day for the best taste. Read [why we skip heat and preservatives](/blog/why-cold-pressed) to understand the trade-off.",
      },
      {
        heading: "Who it suits",
        body: "Guava Punch suits anyone who grew up eating guava straight from the tree and misses that taste. It is also a good pick for office fridges and family lunches, because almost everyone likes it on the first try. If you usually buy sweetened fruit drinks, this is an easy switch: the sweetness is all fruit, and the flavour is far brighter.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We deliver Guava Punch across Lagos. See [juice delivery in Lagos](${DELIVERY}) for the areas we cover and how same-day delivery works. If you like pineapple-led bottles, our guide to [pineapple and ginger for everyday wellness](/blog/pineapple-ginger-immunity) is a good next read.`,
      },
    ],
  },

  sunrise: {
    metaDescription:
      "Sunrise Blend: cold-pressed carrot, pawpaw, orange and pineapple juice, pressed fresh in Lagos for breakfast. Order Mrs. Samuel delivery across Lagos.",
    intro:
      "Sunrise Blend is the bottle Mrs. Samuel herself starts the day with. It is a soft, golden juice that tastes like a Lagos fruit tray: sweet carrot underneath, the mellow smoothness of pawpaw in the middle, then a bright lift of orange and pineapple at the end. It is gentle rather than sharp, which makes it easy to drink first thing, even before your stomach is fully awake.",
    sections: [
      {
        heading: "What goes into it",
        body: "Four ingredients, all fresh: **carrot, pawpaw, orange and pineapple**. There is no water, no added sugar and no preservative in the bottle.\n\nCarrot gives the deep orange colour and is a natural source of beta-carotene, which the body turns into vitamin A. Pawpaw contains papain, a natural fruit enzyme, and gives the blend its smooth body. Orange and pineapple add vitamin C and the fresh, tangy finish.",
      },
      {
        heading: "How and when to drink it",
        body: "As the name says, Sunrise Blend belongs to the morning. Pour it chilled beside eggs, akara, bread or a bowl of fruit and yoghurt. It also makes a good mid-morning bottle at your desk when you want something lighter than a soft drink. Shake it well before you open it, because pawpaw and carrot settle naturally, and that is a sign there is real fruit inside.",
      },
      {
        heading: "Keeping it fresh",
        body: "Sunrise Blend is pressed cold and never pasteurised, so treat it like fresh food. Refrigerate it as soon as it reaches you, keep it out of the sun, and drink it before the date on the label. After opening, enjoy it within the day. Our post on [why cold-pressed juice is worth it](/blog/why-cold-pressed) explains why the shelf life is short on purpose.",
      },
      {
        heading: "Who it suits",
        body: "Sunrise Blend suits early risers, busy parents and anyone who skips breakfast and regrets it by ten o'clock. It is mild enough for children and older relatives, and it is a good first bottle if you have never had carrot juice. People who find pure orange juice too sharp on an empty stomach often prefer this softer, rounder blend.",
      },
      {
        heading: "Delivered across Lagos",
        body: `Order Sunrise Blend for delivery across Lagos. Our page on [juice delivery in Lagos](${DELIVERY}) shows the areas we reach and how timing works. Curious where the carrots, oranges and pineapples come from? Read [where our fruit comes from](/blog/fruit-sourcing).`,
      },
    ],
  },

  "crimson-garden": {
    metaDescription:
      "Crimson Garden Glow: cold-pressed apple, beetroot, celery, carrot and pineapple juice made in Lagos. A smooth way to drink your vegetables. Order today.",
    intro:
      "Crimson Garden Glow is our garden in a bottle, and it is the beetroot juice we give to people who say they do not like beetroot. The earthiness is there, but sweet apple and juicy pineapple wrap around it, celery keeps it fresh and green, and carrot rounds the whole thing off. The colour is a deep ruby red; the taste is smoother and sweeter than most people expect from a vegetable juice.",
    sections: [
      {
        heading: "What goes into it",
        body: "Five fresh plants: **apple, beetroot, celery, carrot and pineapple**. No sugar is added and nothing is preserved.\n\nBeetroot is a natural source of dietary nitrates and adds iron and folate. Carrot brings beta-carotene. Celery is mostly water and adds a clean, slightly salty note. Apple and pineapple supply the natural sweetness that makes the vegetables easy to drink, along with vitamin C from the pineapple.",
      },
      {
        heading: "How and when to drink it",
        body: "Crimson Garden Glow is a good mid-afternoon bottle, when energy dips and you want something more filling than water but lighter than a snack. Drink it chilled, on a fairly empty stomach, and sip rather than gulp. It is also a gentle start for anyone building a habit of drinking more vegetables. Shake before opening so the beetroot and carrot mix back in.",
      },
      {
        heading: "Keeping it fresh",
        body: "This juice is cold-pressed and has no preservatives, so it needs the fridge. Chill it on arrival, keep it cold, and drink it within the date printed on the bottle. Once opened, finish it the same day. A slight separation in the bottle is normal for fresh vegetable juice.",
      },
      {
        heading: "Who it suits",
        body: "Crimson Garden Glow suits people who want more vegetables in their week but struggle to eat them, and anyone curious about beetroot but nervous of the taste. It is a comfortable middle ground between our sweet fruit juices and our all-green bottles. It works well as a regular mid-week habit rather than a once-off treat.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We bring Crimson Garden Glow to homes and offices across Lagos. Check [juice delivery in Lagos](${DELIVERY}) to see the areas we cover. Before you plan a juice-only week, read our honest guide on [what actually goes into a detox](/blog/what-actually-goes-into-detox).`,
      },
    ],
  },

  "crimson-elixir": {
    metaDescription:
      "Crimson Elixir: cold-pressed beetroot, pineapple and watermelon juice, made in Lagos for training days. Earthy, bright and cooling. Order for delivery.",
    intro:
      "Crimson Elixir is the bottle for people who train, and for anyone who simply wants to feel strong through a long Lagos day. It is beetroot-forward but never heavy: watermelon makes it light and thirst-quenching, and pineapple adds a bright, tangy edge. Expect a deep crimson colour, an earthy first note, and a cool, fruity finish that makes it easy to drink after a hot session.",
    sections: [
      {
        heading: "What goes into it",
        body: "Three ingredients only: **beetroot, pineapple and watermelon**. No sugar, water or preservative is added.\n\nBeetroot is one of the best-known food sources of dietary nitrates. Research suggests nitrates from beetroot juice may help muscles use oxygen more efficiently during exercise, which is why many athletes drink it. Watermelon is mostly water and naturally contains lycopene. Pineapple adds vitamin C and bromelain, a natural enzyme.",
      },
      {
        heading: "How and when to drink it",
        body: "Many people drink Crimson Elixir about 30 minutes to a couple of hours before a workout, a football match or a long walk. It is just as good chilled with grilled fish in the evening. If beetroot is new to you, start with half a bottle and see how you like it. Note that beetroot can harmlessly turn urine pink for a day.",
      },
      {
        heading: "Keeping it fresh",
        body: "Crimson Elixir is pressed without heat and has no preservatives, so keep it in the fridge from the moment it arrives and drink it within the date on the label. Do not leave it in a hot car or gym bag for hours. Once opened, finish it within the day for the best flavour.",
      },
      {
        heading: "Who it suits",
        body: "Crimson Elixir suits runners, footballers, gym regulars and anyone with a physically demanding day ahead. It also suits people who simply enjoy beetroot and want it in its cleanest form, with only two fruits for balance. If you are building a pre-training routine, try it on a few different days to learn what timing works best for your body.",
      },
      {
        heading: "Delivered across Lagos",
        body: `Get Crimson Elixir delivered across Lagos, to your home, gym or office. Our [juice delivery in Lagos](${DELIVERY}) page explains the areas and timing. For more on staying cool and hydrated, read [why cold-pressed juices beat the Lagos heat](/blog/cold-pressed-juices-beat-lagos-heat).`,
      },
    ],
  },

  "crimson-cooler": {
    metaDescription:
      "Crimson Cooler: cold-pressed watermelon, beetroot and carrot juice that tastes like summer. Pressed fresh in Lagos by Mrs. Samuel. Order for delivery.",
    intro:
      "Crimson Cooler is the bottle our customers describe as tasting like summer. Watermelon leads, so it is light, juicy and refreshing. Beetroot sits underneath with its gentle earthiness and gorgeous colour, and carrot softens the edges with a natural sweetness. If you find beetroot juice too strong, this is the softest way into it: more cooling drink than vegetable juice.",
    sections: [
      {
        heading: "What goes into it",
        body: "Three fresh ingredients: **watermelon, beetroot and carrot**. Nothing is added: no sugar, no water, no preservative.\n\nWatermelon is around nine-tenths water and naturally contains lycopene, the pigment that gives it its red colour. Beetroot adds dietary nitrates, iron and folate. Carrot is a natural source of beta-carotene, which the body converts to vitamin A. Together they make a juice that is hydrating and full of colour.",
      },
      {
        heading: "How and when to drink it",
        body: "Drink Crimson Cooler any time the sun is out. It is perfect after an afternoon of errands, on a weekend at the beach, or with spicy peppered fish, where its sweetness calms the heat. Serve it very cold. Children who will not touch vegetables often enjoy it because watermelon is the main taste.",
      },
      {
        heading: "Keeping it fresh",
        body: "Like every Mrs. Samuel juice, Crimson Cooler is cold-pressed and unpreserved. Refrigerate it straight away, keep it cold, and drink it before the date on the label. Shake before pouring, and finish an opened bottle the same day. Our post on [same-day delivery and freshness](/blog/lagos-traffic-and-48-hour-shelf-life) explains why we move fast.",
      },
      {
        heading: "Who it suits",
        body: "Crimson Cooler suits anyone who wants a cooling, hydrating drink on a hot day, and families who want to sneak a little beetroot and carrot onto the table. It is lighter than Crimson Elixir and sweeter than Crimson Garden Glow, which makes it the friendliest of our three crimson bottles. If you are unsure which beetroot juice to start with, start here.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We deliver Crimson Cooler across Lagos. Visit [juice delivery in Lagos](${DELIVERY}) to check your area. Want more ideas for hot days? Read [why cold-pressed juices beat the Lagos heat](/blog/cold-pressed-juices-beat-lagos-heat).`,
      },
    ],
  },

  "ginger-spark": {
    metaDescription:
      "Ginger Spark: cold-pressed watermelon and pineapple juice with a fresh ginger kick. Sweet, then heat. Made in Lagos by Mrs. Samuel. Order for delivery.",
    intro:
      "Ginger Spark is sweet first, then warm. Watermelon and pineapple open with a soft, juicy sweetness, and then fresh ginger root creeps in at the back of the throat: not too much, just enough to wake you up. It is the bottle to reach for when you need to feel alert without coffee, and it is one of the easiest ways to enjoy ginger if you find ginger shots too fierce.",
    sections: [
      {
        heading: "What goes into it",
        body: "Three ingredients: **watermelon, pineapple and ginger**. We use fresh ginger root, never powder, and add no sugar or preservatives.\n\nGinger has a long history in Nigerian kitchens and research suggests it can help ease mild nausea, which is why many people like it before travelling. Watermelon brings hydration and lycopene. Pineapple adds vitamin C, bromelain and a bright tang that balances the ginger heat.",
      },
      {
        heading: "How and when to drink it",
        body: "Sip Ginger Spark before a long drive on the Third Mainland Bridge, a long meeting, or a long day of study. It is also pleasant after a heavy meal. Drink it chilled; the cold makes the ginger warmth feel even livelier. If you are sensitive to spice, start with a small glass. Anyone on blood-thinning medication should check with a doctor about regular ginger.",
      },
      {
        heading: "Keeping it fresh",
        body: "Ginger Spark is cold-pressed and preservative-free, so it belongs in the fridge. Keep it chilled from delivery and drink it within the date on the label. Shake before opening, because ginger and pineapple pulp settle. Once open, finish it within the day.",
      },
      {
        heading: "Who it suits",
        body: "Ginger Spark suits commuters, students, travellers and anyone who loves the taste of ginger but not its full fire. It is a popular choice for long road trips out of Lagos and for people who feel queasy in traffic. If you already enjoy our Pineapple Juice and want a little more excitement, this is the natural next bottle to try.",
      },
      {
        heading: "Delivered across Lagos",
        body: `Order Ginger Spark for delivery across Lagos; see [juice delivery in Lagos](${DELIVERY}) for areas and timing. To learn more about the pairing at the heart of this bottle, read [pineapple and ginger for everyday wellness](/blog/pineapple-ginger-immunity).`,
      },
    ],
  },

  orange: {
    metaDescription:
      "Pure cold-pressed orange juice from Nigerian oranges, pressed in Lagos with no water, no sugar, nothing else. Order Mrs. Samuel orange juice for delivery.",
    intro:
      "Our Orange Juice is exactly what the label says: Nigerian oranges, pressed, and nothing else. It tastes like the oranges you buy by the roadside, peeled and squeezed straight into a cup: sweet, slightly tart, with a little natural pulp. Next to a carton from the supermarket, the difference is clear. There is no concentrate, no added sugar and no flat, cooked aftertaste.",
    sections: [
      {
        heading: "What goes into it",
        body: "One ingredient: **orange**. Our oranges come from Benue State and are pressed within hours of reaching Lagos. We add no water, no sugar and no preservatives.\n\nOranges are one of the most familiar sources of vitamin C, which the body needs every day because it cannot store much of it. Fresh juice also keeps the natural bright flavour that heating takes away.",
      },
      {
        heading: "How and when to drink it",
        body: "Breakfast, always breakfast. Pour a cold glass beside bread and eggs, yam and egg sauce, or cereal. It is also the easiest juice for children, the first bottle many families order, and a reliable choice for guests at a party. Shake it before pouring so the natural pulp mixes back in, and serve it chilled rather than over lots of ice.",
      },
      {
        heading: "Keeping it fresh",
        body: "Because this juice is never pasteurised, it does not last like shop-bought orange juice. Refrigerate it as soon as it arrives and drink it before the date on the label. An opened bottle tastes best the same day. Fresh orange juice can separate in the fridge; that is normal, just shake it.",
      },
      {
        heading: "Who it suits",
        body: "Our Orange Juice suits everyone, which is exactly why it is a classic. It is the safest choice when you are buying for children, for guests whose tastes you do not know, or for an office meeting. If you have only ever had orange juice from a carton, it is also the clearest way to taste what fresh, cold-pressed juice is really like.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We deliver our Orange Juice across Lagos. See [juice delivery in Lagos](${DELIVERY}) for where we deliver and when. To see how we choose our fruit, read [where our fruit comes from](/blog/fruit-sourcing).`,
      },
    ],
  },

  pineapple: {
    metaDescription:
      "Pure cold-pressed pineapple juice, golden and sweet with nothing added. Pressed fresh in Lagos by Mrs. Samuel. Great for brunch and mocktails. Order now.",
    intro:
      "Our Pineapple Juice is pure, golden pineapple and nothing else. Ripe Nigerian pineapple is sweet enough on its own, so we simply press it and bottle it. The taste is bold and tropical: honeyed sweetness up front, a lively tang in the middle, and a clean finish. It is frothy when you shake it, the way real pressed pineapple always is.",
    sections: [
      {
        heading: "What goes into it",
        body: "One ingredient: **pineapple**. No water, no added sugar and no preservatives.\n\nPineapple naturally contains vitamin C and manganese, and it is the main food source of bromelain, a group of enzymes that researchers have studied for their effect on digestion and inflammation. Cold pressing extracts the juice without heat, which is how the fresh-cut pineapple taste survives in the bottle.",
      },
      {
        heading: "How and when to drink it",
        body: "Pineapple Juice is a brunch favourite. Serve it cold with pancakes, plantain and eggs, or a fruit platter. It is also our most popular mixer: top it with sparkling water and a squeeze of lime for an easy alcohol-free mocktail at a party. Because it is naturally sweet and acidic, sip it rather than drinking a whole bottle at once.",
      },
      {
        heading: "Keeping it fresh",
        body: "Keep the bottle in the fridge from the moment it arrives, and drink it within the date on the label. Pineapple juice separates and foams naturally, so shake well before pouring. Once opened, it tastes best within the day. Never leave it in the sun or a hot car.",
      },
      {
        heading: "Who it suits",
        body: "Pineapple Juice suits people who like bold, sweet, tropical flavours and want nothing but the fruit. It suits hosts too, because it mixes well and pleases a crowd. If you are sensitive to acidic drinks, enjoy it with food rather than on an empty stomach. If you like this bottle, try Ginger Mint Splash or Ginger Spark next.",
      },
      {
        heading: "Delivered across Lagos",
        body: `Order Pineapple Juice for delivery anywhere we cover in Lagos; [juice delivery in Lagos](${DELIVERY}) has the details. For party or office quantities, see [bulk orders](/events-juice-lagos). To learn more about this fruit, read [pineapple and ginger for everyday wellness](/blog/pineapple-ginger-immunity).`,
      },
    ],
  },

  pinecado: {
    metaDescription:
      "Pinecado Bliss: creamy avocado blended into cold-pressed pineapple juice. Smooth, filling and made fresh in Lagos by Mrs. Samuel. Order for delivery.",
    intro:
      "Most people never think to drink avocado. Pinecado Bliss changes their mind on the first sip. Silky avocado gives the juice a thick, creamy body, almost like a smoothie, and bright pineapple keeps it fresh and tangy so it never feels heavy. It is surprisingly addictive: rich, smooth and satisfying, with the sweetness coming entirely from the fruit.",
    sections: [
      {
        heading: "What goes into it",
        body: "Two ingredients: **avocado and pineapple**. Nothing else is added, so there is no sugar, dairy or preservative.\n\nAvocado is unusual among fruits because most of its energy comes from fat, mainly the monounsaturated kind found in olive oil. That is what makes this bottle feel filling. Pineapple brings vitamin C, bromelain and the tropical tang that lifts the avocado.",
      },
      {
        heading: "How and when to drink it",
        body: "Pinecado Bliss is more than a drink. It works as a late breakfast on a busy morning, a light lunch on the go, or something to have after a gym session when you want to feel full. Shake it very well before opening and drink it cold. Because it is richer than our other juices, many people enjoy half a bottle at a time.",
      },
      {
        heading: "Keeping it fresh",
        body: "Avocado is delicate, so this bottle needs extra care. Keep it chilled the whole time, drink it within the date on the label, and finish it soon after opening. A little natural browning or thickening at the top is normal for fresh avocado. Learn more in [why cold-pressed juice is worth it](/blog/why-cold-pressed).",
      },
      {
        heading: "Who it suits",
        body: "Pinecado Bliss suits busy people who need something filling between meetings, gym-goers who want a satisfying bottle after training, and anyone who likes smoothies but wants a lighter, pressed drink. It also suits the curious: if you have never thought of avocado as a drink, this bottle is a gentle and delicious introduction to the idea.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We deliver Pinecado Bliss across Lagos; check [juice delivery in Lagos](${DELIVERY}) for areas and delivery times. It travels best when you put it straight into the fridge on arrival.`,
      },
    ],
  },

  guyabano: {
    metaDescription:
      "Guyabano Delight: rare cold-pressed soursop with strawberry and pineapple, made fresh in Lagos. Creamy, ripe and unusual. Order Mrs. Samuel delivery.",
    intro:
      "Guyabano Delight is built around soursop, a fruit that is hard to find and harder to press well. Guyabano is its Filipino name. The taste is unlike anything else on our menu: creamy and fragrant, somewhere between pineapple, banana and citrus. Strawberry adds a soft berry sweetness and a pink blush, and pineapple brightens the finish. It is a calm, gentle bottle with a rich texture.",
    sections: [
      {
        heading: "What goes into it",
        body: "Three fruits: **soursop (guyabano), strawberry and pineapple**. We add no sugar and no preservatives.\n\nMr. Samuel sources our soursop personally from a single grower in the South-West, which is why this juice is not always available. Soursop naturally contains vitamin C and fibre. Strawberries are rich in vitamin C and antioxidants, and pineapple adds bromelain and a tropical tang.",
      },
      {
        heading: "How and when to drink it",
        body: "This is a slow-sipping bottle. Enjoy it chilled on a quiet evening, with a book, or as a treat after dinner in place of something sweeter. It also makes a lovely surprise for guests who think they have tried every juice. Shake well first; soursop pulp is naturally thick and settles.",
      },
      {
        heading: "Keeping it fresh",
        body: "Guyabano Delight is cold-pressed, so keep it refrigerated from the moment it arrives. Drink it within the date on the label and finish an opened bottle the same day. Because soursop supply is limited, if you see it in stock, order what you will drink soon rather than storing it for long.",
      },
      {
        heading: "Who it suits",
        body: "Guyabano Delight suits adventurous drinkers, fans of soursop who rarely find it fresh in Lagos, and anyone who wants a juice that feels special. It is also a thoughtful gift for friends and family who already know our classics. Because the soursop supply is small, it is worth ordering whenever you see it in stock.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We deliver Guyabano Delight across Lagos when the fruit is in. See [juice delivery in Lagos](${DELIVERY}) to check your area. To find out how we pick the farms behind our specials, read [where our fruit comes from](/blog/fruit-sourcing).`,
      },
    ],
  },

  "vitamin-vibe": {
    metaDescription:
      "Vitamin Vibe: cold-pressed turmeric, ginger, lemon, carrot and pineapple juice. A daily wellness bottle made in Lagos from fresh roots. Order delivery.",
    intro:
      "Vitamin Vibe is our daily wellness blend, and it has real character. Fresh turmeric gives it a warm, earthy depth and a vivid golden colour. Ginger adds heat, lemon adds a sharp, clean lift, and a carrot and pineapple base makes the whole thing smooth and drinkable. It tastes bold and lively, a bottle you feel as much as taste.",
    sections: [
      {
        heading: "What goes into it",
        body: "Five fresh ingredients: **turmeric, pineapple, ginger, lemon and carrot**. We use whole turmeric and ginger root, never powder, and add no sugar or preservatives.\n\nTurmeric contains curcumin, a compound researchers have studied widely for its anti-inflammatory effects. Ginger has been used for generations to settle the stomach. Lemon and pineapple add vitamin C, and carrot provides beta-carotene and natural sweetness.",
      },
      {
        heading: "How and when to drink it",
        body: "Many customers sip Vitamin Vibe first thing in the morning, before food, as a small daily ritual. Others keep it for the afternoon slump. Drink it chilled and shake it hard first, because turmeric and ginger settle. Turmeric can stain, so mind your white shirt. If you take medication or are pregnant, ask your doctor about daily turmeric and ginger.",
      },
      {
        heading: "Keeping it fresh",
        body: "Vitamin Vibe is pressed without heat or preservatives. Keep it in the fridge, drink it within the date on the label, and finish an opened bottle within the day. If you are buying several for the week, ask us about delivery timing so each bottle is as fresh as possible.",
      },
      {
        heading: "Who it suits",
        body: "Vitamin Vibe suits people who already love ginger and turmeric in their cooking and want them in a daily drink. It suits anyone building a morning routine, and those who prefer bold, earthy flavours over sweet ones. If you have tried turmeric powder in hot water and found it chalky, the fresh root here tastes completely different and much smoother.",
      },
      {
        heading: "Delivered across Lagos",
        body: `Order Vitamin Vibe for delivery across Lagos; [juice delivery in Lagos](${DELIVERY}) lists our areas. For the research behind two of its key ingredients, read [pineapple and ginger for everyday wellness](/blog/pineapple-ginger-immunity).`,
      },
    ],
  },

  "ginger-mint-splash": {
    metaDescription:
      "Ginger Mint Splash: cold-pressed pineapple, fresh ginger and mint leaf. Cool, bright and built for Lagos afternoons. Made by Mrs. Samuel. Order today.",
    intro:
      "Ginger Mint Splash was built for Lagos afternoons. Bright pineapple opens it up, a clean ginger snap follows, and then hand-torn mint leaves a cool, fresh finish that lingers. It is sweet, warm and cooling all at once. If you love a chilled glass of pineapple juice but want something more grown-up, this is the bottle.",
    sections: [
      {
        heading: "What goes into it",
        body: "Three fresh ingredients: **pineapple, ginger and mint leaf**. No sugar, water or preservative is added.\n\nPineapple gives the base, along with vitamin C and bromelain, a natural fruit enzyme. Fresh ginger root brings the warmth and has long been used to settle the stomach. Mint leaf adds the cooling finish; many people find mint soothing after a meal.",
      },
      {
        heading: "How and when to drink it",
        body: "Ginger Mint Splash shines after a heavy meal, when you want something to freshen up. It is also excellent with grilled suya, where the mint and pineapple calm the pepper. Serve it very cold, or pour it over ice with a sprig of mint for guests. It is a smart non-alcoholic choice for evening gatherings.",
      },
      {
        heading: "Keeping it fresh",
        body: "Fresh mint and ginger lose their brightness over time, so this juice is best fresh. Refrigerate it on arrival, drink it within the date on the label, and shake well before opening. Once open, finish it the same day. Our [same-day delivery story](/blog/lagos-traffic-and-48-hour-shelf-life) explains why timing matters.",
      },
      {
        heading: "Who it suits",
        body: "Ginger Mint Splash suits people who love pineapple but want a fresher, more grown-up flavour, and anyone looking for a refreshing drink after a big lunch. It also suits hosts who want an alcohol-free drink that still feels special. If Ginger Spark is the warm bottle in our range, this one is the cool, crisp alternative.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We deliver Ginger Mint Splash across Lagos; see [juice delivery in Lagos](${DELIVERY}). For more cooling ideas, read [why cold-pressed juices beat the Lagos heat](/blog/cold-pressed-juices-beat-lagos-heat).`,
      },
    ],
  },

  "zesty-sunrise": {
    metaDescription:
      "Zesty Sunrise: cold-pressed apple, orange, pineapple, lemon and ginger juice. Our brightest morning bottle, pressed fresh in Lagos. Order for delivery.",
    intro:
      "Zesty Sunrise is our brightest morning bottle. Five fruits argue beautifully: apple sweetens, orange and pineapple bring the sunshine, lemon sharpens everything, and ginger lingers with a gentle warmth at the end. The result is zingy, fresh and very awake, a juice that tastes like it wants you out of bed.",
    sections: [
      {
        heading: "What goes into it",
        body: "Five fresh ingredients: **apple, orange, pineapple, lemon and ginger**. No added sugar, no water and no preservatives.\n\nOrange, lemon and pineapple are all natural sources of vitamin C. Apple supplies natural sweetness and a rounder body. Fresh ginger root gives the warm finish. Because the juice is cold-pressed, the citrus keeps its fresh, sharp flavour rather than the flat taste of heated juice.",
      },
      {
        heading: "How and when to drink it",
        body: "Zesty Sunrise is made for breakfast, the school run and early meetings. Pour a cold glass with your morning meal, or pack a bottle for the drive to work. Children usually like it because apple and orange lead, while adults enjoy the ginger finish. Shake before opening.",
      },
      {
        heading: "Keeping it fresh",
        body: "Keep Zesty Sunrise in the fridge from the moment it arrives and drink it before the date on the label. Citrus juice tastes best cold and fresh, so finish an opened bottle within the day. Read [why we cold-press instead of heat-treating](/blog/why-cold-pressed) for the full story.",
      },
      {
        heading: "Who it suits",
        body: "Zesty Sunrise suits morning people and those who wish they were. It works for families, because children like the apple and orange, and for professionals who want a bright start before a long day. If you find our Orange Juice a bit too simple and Vitamin Vibe a bit too strong, Zesty Sunrise sits comfortably in between the two.",
      },
      {
        heading: "Delivered across Lagos",
        body: `Order Zesty Sunrise for delivery across Lagos. Visit [juice delivery in Lagos](${DELIVERY}) to see the areas we cover and how ordering works. Stock up for the family or the office with a [bulk order](/events-juice-lagos).`,
      },
    ],
  },

  "veggie-burst": {
    metaDescription:
      "Veggie Burst: cold-pressed beetroot, ugu, celery, ginger and pineapple. A Nigerian green juice made fresh in Lagos by Mrs. Samuel. Order for delivery.",
    intro:
      "Veggie Burst is built around ugu, the fluted pumpkin leaf Nigerian grandmothers swear by. It is our most serious vegetable juice: deep, earthy and green, with beetroot giving it a dark ruby colour. Pineapple keeps it drinkable with a sweet, tangy lift, celery adds freshness, and ginger warms the finish. It tastes like real food, because it is.",
    sections: [
      {
        heading: "What goes into it",
        body: "Five fresh ingredients: **beetroot, ugu (fluted pumpkin leaf), celery, ginger and pineapple**. No sugar or preservatives are added.\n\nUgu is a leafy green widely eaten across Nigeria in soups, and it is a source of iron and other minerals. Beetroot adds dietary nitrates and folate. Celery is hydrating, ginger brings warmth, and pineapple supplies vitamin C and the natural sweetness that balances the greens.",
      },
      {
        heading: "How and when to drink it",
        body: "Drink Veggie Burst mid-morning, or after a hard training session when you want something that feels nourishing. Serve it chilled and sip it slowly. If you are new to green juices, start with a small glass. Veggie Burst complements a balanced diet; it does not replace your vegetables or any treatment from your doctor.",
      },
      {
        heading: "Keeping it fresh",
        body: "Leafy-green juices are delicate. Refrigerate Veggie Burst as soon as it arrives, drink it within the date on the label, and shake it before opening. An opened bottle should be finished the same day. Natural separation is normal.",
      },
      {
        heading: "Who it suits",
        body: "Veggie Burst suits people who grew up with ugu soup and want those familiar greens in a quicker form, athletes who want a hearty recovery drink, and anyone who wants their juice to taste properly of vegetables. If Pure Green feels too light for you, Veggie Burst is earthier and more filling, with beetroot giving it extra depth and colour.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We deliver Veggie Burst across Lagos; [juice delivery in Lagos](${DELIVERY}) shows our areas and timing. Thinking of a green-juice reset? First read our honest guide to [what actually goes into a detox](/blog/what-actually-goes-into-detox).`,
      },
    ],
  },

  // TODO(owner): the catalogue note says "330ml only — preorder required", but
  // the live data sells 650ml with stock and 330ml at zero. Confirm which is
  // right in admin; this copy avoids repeating either claim.
  "lemon-sip": {
    metaDescription:
      "Lemon Sip: cold-pressed lemon, ginger and cucumber juice, the cleanest sip on our menu. Made fresh in Lagos by Mrs. Samuel. Order for Lagos delivery.",
    intro:
      "Lemon Sip is the cleanest sip on our menu. Three ingredients, nothing added, and a taste that is crisp, sharp and refreshing. Cool cucumber makes up the body, lemon brings a bright, sour zing, and fresh ginger adds a gentle warmth at the end. It is not sweet like our fruit blends; think of it as a grown-up, upgraded glass of lemon water.",
    sections: [
      {
        heading: "What goes into it",
        body: "Just **lemon, ginger and cucumber**. There is no sugar, water or preservative in the bottle.\n\nCucumber is about 95 per cent water, which is why this juice feels so light and hydrating. Lemon is a source of vitamin C and gives the bottle its sharp flavour. Fresh ginger root adds warmth and has a long history of being used to settle the stomach.",
      },
      {
        heading: "How and when to drink it",
        body: "Lemon Sip is a reset bottle. Drink it first thing in the morning, or as an afternoon pick-me-up instead of a fizzy drink. It is refreshing chilled or poured over ice. Because lemon is acidic, rinse your mouth with water afterwards if you drink it often, to be kind to your teeth.",
      },
      {
        heading: "Keeping it fresh",
        body: "Lemon Sip is pressed without heat, so keep it cold from delivery onward and drink it within the date on the label. Shake before opening and finish an opened bottle within the day. Cucumber juice is best fresh, so order what you plan to drink soon.",
      },
      {
        heading: "Who it suits",
        body: "Lemon Sip suits people cutting back on sugar, anyone who drinks lemon water and wants something more interesting, and those who like a sharp, savoury taste over a sweet one. It is also a good bottle between heavier meals. If you love Pure Green but want something even lighter, Lemon Sip is the simplest juice on our menu.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We deliver Lemon Sip across Lagos. See [juice delivery in Lagos](${DELIVERY}) for areas and timing. If you are drinking it as part of a cleanse, read [what actually goes into a detox](/blog/what-actually-goes-into-detox) for the honest science.`,
      },
    ],
  },

  "sweet-pepper-splash": {
    metaDescription:
      "Sweet Pepper Splash: cold-pressed tomato, bell pepper and pineapple juice. Savoury meets sweet in a bottle Lagos has never tasted. Order for delivery.",
    intro:
      "Sweet Pepper Splash is our most surprising bottle, and the one people order again by week two. Tomato and bell pepper give it a savoury, almost garden-fresh flavour, a little like a chilled tomato soup, while pineapple pulls it back towards sweet and tangy. On the first sip people are not sure; by the third, they are hooked. Nothing else in Lagos tastes like it.",
    sections: [
      {
        heading: "What goes into it",
        body: "Three ingredients: **tomato, bell pepper and pineapple**. No sugar, salt or preservative is added.\n\nTomatoes are one of the richest food sources of lycopene, the red pigment researchers link with heart and skin health. Bell pepper is a strong source of vitamin C and adds a mild, natural sweetness with no heat. Pineapple brings bromelain, more vitamin C and the bright finish that ties it all together.",
      },
      {
        heading: "How and when to drink it",
        body: "Sweet Pepper Splash is a perfect brunch juice, next to eggs, toast or plantain. It is also brilliant at sunset with grilled fish or chicken, where its savoury notes match the food. Serve it well chilled. If you enjoy unusual flavours, start here; if you prefer sweet, try it alongside a meal first.",
      },
      {
        heading: "Keeping it fresh",
        body: "This juice is cold-pressed and preservative-free. Keep it refrigerated, drink it within the date on the label, and shake before opening because tomato pulp settles. Finish an opened bottle within the day. Read [why cold-pressed juice is worth it](/blog/why-cold-pressed) to see why we never heat our juice.",
      },
      {
        heading: "Who it suits",
        body: "Sweet Pepper Splash suits adventurous palates, people who prefer savoury drinks to sweet ones, and anyone who enjoys a fresh tomato salad. It also suits hosts who want a talking point on the table at brunch. If you tend to find fruit juices too sugary, the tomato and pepper here give a more balanced, food-friendly flavour.",
      },
      {
        heading: "Delivered across Lagos",
        body: `Order Sweet Pepper Splash for delivery across Lagos; visit [juice delivery in Lagos](${DELIVERY}) to check your area and delivery times.`,
      },
    ],
  },

  melongrape: {
    metaDescription:
      "Melongrape: cold-pressed watermelon, grape and carrot juice. Cool, sweet and family-friendly, pressed fresh in Lagos by Mrs. Samuel. Order for delivery.",
    intro:
      "Melongrape is an unlikely trio that won every round of a Saturday family taste-test, and it has been on the menu ever since. Watermelon makes it light and cooling, grapes add a deep, wine-like sweetness, and carrot gives it a smooth, rounded finish. It is one cool pour of fruit: sweet, juicy and easy for every age.",
    sections: [
      {
        heading: "What goes into it",
        body: "Three ingredients: **watermelon, grapes and carrot**. No sugar, water or preservatives are added.\n\nWatermelon is mostly water and naturally contains lycopene. Grapes are a source of natural sugars for quick energy and contain polyphenols such as resveratrol, especially in the skins. Carrot brings beta-carotene, which the body converts to vitamin A, and helps the juice feel fuller.",
      },
      {
        heading: "How and when to drink it",
        body: "Melongrape is made for hot afternoons, picnic baskets and Sunday lunch. Pour it chilled for the whole table, pack it for a beach day, or serve it at a children's party. Because it is naturally sweet, it is a great swap for soft drinks. Shake gently before opening.",
      },
      {
        heading: "Keeping it fresh",
        body: "Melongrape is pressed without heat and contains no preservatives, so keep it in the fridge from the moment it arrives. Drink it within the date on the label and finish an opened bottle within the day. Keep it out of hot cars and direct sun on outings; a cooler bag helps.",
      },
      {
        heading: "Who it suits",
        body: "Melongrape suits families, children and anyone who wants a cooling, naturally sweet drink without the fizz. It is one of the easiest bottles to share, so it works well for picnics, gatherings and Sunday lunch. If you love Crimson Cooler but would rather skip beetroot, Melongrape gives you the same light, watermelon-led refreshment with a grape twist.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We deliver Melongrape across Lagos; see [juice delivery in Lagos](${DELIVERY}) for areas. For events, ask about [bulk orders](/events-juice-lagos). Read [why cold-pressed juices beat the Lagos heat](/blog/cold-pressed-juices-beat-lagos-heat) for more hot-weather ideas.`,
      },
    ],
  },

  "creamy-paradise": {
    metaDescription:
      "Creamy Paradise: strawberry, banana and pineapple in a smooth, indulgent cold-pressed juice. A kid-approved treat made fresh in Lagos. Order for delivery.",
    intro:
      "Creamy Paradise is the bottle that wins over juice sceptics on the first sip. Ripe banana gives it a thick, creamy body, strawberry brings a sweet berry flavour and a pink colour, and pineapple keeps it bright so it never feels heavy. It tastes like a treat, smooth and indulgent, but every bit of the sweetness comes from fruit.",
    sections: [
      {
        heading: "What goes into it",
        body: "Three fruits: **strawberry, banana and pineapple**. No sugar, dairy or preservatives are added.\n\nBanana is a well-known source of potassium and is what makes this juice so creamy. Strawberries are rich in vitamin C and antioxidants. Pineapple adds more vitamin C, the enzyme bromelain and a fresh tang. The strawberries for our specials come from a small farm outside Lagos, so supply can vary.",
      },
      {
        heading: "How and when to drink it",
        body: "Creamy Paradise is perfect as an after-school treat, a weekend dessert swap or a celebration drink at a birthday. Children love it, and adults reach for it when they want something sweet without a fizzy drink. Shake very well, because banana thickens as it rests, and serve chilled.",
      },
      {
        heading: "Keeping it fresh",
        body: "Banana and strawberry are delicate, so keep this bottle cold the whole time. Refrigerate it on arrival, drink it before the date on the label, and finish an opened bottle the same day. Some thickening is normal and simply means real fruit.",
      },
      {
        heading: "Who it suits",
        body: "Creamy Paradise suits children, anyone with a sweet tooth, and people who say they do not like juice. It is a favourite for birthdays, school lunch boxes and family movie nights. If you enjoy Pinecado Bliss for its creamy texture but want something sweeter and fruitier, this is the bottle to try next.",
      },
      {
        heading: "Delivered across Lagos",
        body: `Order Creamy Paradise for delivery across Lagos; [juice delivery in Lagos](${DELIVERY}) shows where we deliver. To see where our strawberries and other fruit come from, read [where our fruit comes from](/blog/fruit-sourcing).`,
      },
    ],
  },

  "pure-green": {
    metaDescription:
      "Pure Green: cold-pressed cucumber, spinach, celery, kale and apple juice. A clean green reset made fresh in Lagos by Mrs. Samuel. Order for delivery.",
    intro:
      "Pure Green is five greens and one honest apple: the bottle we drink on days we want to feel lighter by evening. It is fresh and grassy, with cool cucumber up front, a clean mineral taste from spinach, kale and celery, and just enough apple sweetness to keep it pleasant. It is the most savoury, least sweet juice on our menu, and that is the point.",
    sections: [
      {
        heading: "What goes into it",
        body: "Five fresh ingredients: **cucumber, spinach, celery, kale and apple**. No sugar, water or preservatives are added.\n\nCucumber and celery are mostly water and make the juice light and hydrating. Spinach and kale are dark leafy greens that contain folate, vitamin K and other nutrients. Apple supplies the only sweetness in the bottle, which keeps the natural sugar lower than in our fruit-led juices.",
      },
      {
        heading: "How and when to drink it",
        body: "Drink Pure Green chilled on an empty stomach in the morning, or alongside a light salad at lunch. It suits people building a daily green habit and anyone cutting back on sweet drinks. Shake before opening. Green juice adds to a balanced diet; it does not replace whole vegetables or medical advice.",
      },
      {
        heading: "Keeping it fresh",
        body: "Green juices are the most delicate of all, so keep Pure Green in the fridge from delivery and drink it within the date on the label. Finish an opened bottle the same day. A change in colour after a while is natural oxidation, not spoilage, but it is a sign to drink up.",
      },
      {
        heading: "Who it suits",
        body: "Pure Green suits people who already enjoy salads and green vegetables, anyone reducing sugar, and those who want a light, clean drink to start the day. It is the least sweet bottle on our menu, so give it a few sips to get used to it. If you want something greener but earthier, try Veggie Burst next.",
      },
      {
        heading: "Delivered across Lagos",
        body: `We deliver Pure Green across Lagos; see [juice delivery in Lagos](${DELIVERY}) for areas and timing. Planning a cleanse? Read [what actually goes into a detox](/blog/what-actually-goes-into-detox) first.`,
      },
    ],
  },
};

export function productCopy(slug: string): ProductCopy | undefined {
  return Object.prototype.hasOwnProperty.call(PRODUCT_COPY, slug) ? PRODUCT_COPY[slug] : undefined;
}

/** Visible words in a copy entry (headings + text, link labels not URLs). */
export function copyWordCount(c: ProductCopy): number {
  const text = [c.intro, ...c.sections.flatMap((s) => [s.heading, s.body])]
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*/g, "");
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

-- Blog refresh 2026-06-17:
--  (1) give every existing post a distinct, content-matched cluster so the
--      decorative hero art varies per post (they were all empty -> all showed
--      the same "tropical" fallback).
--  (2) add 4 new SEO-targeted posts aimed at high-intent Nigerian juice/health
--      search terms (zobo/hibiscus, tigernut/kunu aya, pineapple+ginger, heat).
-- Idempotent: cluster updates are by slug; inserts use ON CONFLICT DO NOTHING.

-- (1) Vary the existing posts' visuals.
UPDATE blog_post SET cluster = 'green'      WHERE slug = 'why-cold-pressed' AND cluster IS NULL;
UPDATE blog_post SET cluster = 'root'       WHERE slug = 'what-actually-goes-into-detox' AND cluster IS NULL;
UPDATE blog_post SET cluster = 'citrus'     WHERE slug = 'lagos-traffic-and-48-hour-shelf-life' AND cluster IS NULL;
UPDATE blog_post SET cluster = 'tropical'   WHERE slug = 'fruit-sourcing' AND cluster IS NULL;
UPDATE blog_post SET cluster = 'watermelon' WHERE slug = 'the-punch-recipe' AND cluster IS NULL;
UPDATE blog_post SET cluster = 'citrus'     WHERE slug = 'forty-thousand-bottles-later' AND cluster IS NULL;
UPDATE blog_post SET cluster = 'root'       WHERE slug = 'more-than-juice-fighting-fruit-waste' AND cluster IS NULL;

-- (2) New posts.
INSERT INTO blog_post (slug, title, excerpt, body_md, author, read_mins, category, cluster, published_at)
VALUES
(
  'zobo-hibiscus-health-benefits',
  'The Health Benefits of Zobo (Hibiscus): Nigeria''s Ruby Superdrink',
  'Zobo isn''t just a party staple — cold-pressed hibiscus is one of the most antioxidant-rich drinks you can make from a Nigerian market. Here''s what it does for your body.',
  $md$
Walk through any Lagos market and you'll find dried hibiscus petals — *zobo* — sold in dusty heaps for a few hundred naira. Most people boil it with sugar and call it a day. We cold-press it. The difference is the whole point.

## What zobo actually is

Zobo is brewed from the dried calyces of *Hibiscus sabdariffa*. Those deep-red petals are loaded with **anthocyanins** — the same family of antioxidants that make blueberries famous — plus vitamin C and natural plant acids.

## Why cold-pressing matters

Boiling zobo for an hour, then drowning it in sugar, does two things: it cooks off heat-sensitive vitamin C, and it turns a healthy drink into a sugar delivery system. Cold extraction keeps the antioxidants intact and lets the fruit's own tartness carry the flavour — no need for a cup of sugar.

## The benefits, plainly

- **Heart health.** Several studies link hibiscus to modestly lower blood pressure — one reason zobo has a reputation among older Nigerians as a "blood tonic."
- **Antioxidant load.** Those anthocyanins help mop up the free radicals that come with Lagos traffic fumes and fried-food Fridays.
- **Hydration without the crash.** A lightly-sweetened zobo rehydrates you in the heat without the sugar spike of a soft drink.

## How we make ours

We rinse the calyces, cold-steep them, press, and bottle within hours — no boiling, no preservatives, just a touch of natural sweetness. The result is a ruby-red drink that tastes like the market smells: bright, tart, alive.

Try it chilled, straight from the fridge. Your afternoon will thank you.
$md$,
  'Mrs. Samuel',
  4,
  'Wellness',
  'berry',
  now()
),
(
  'tigernut-kunu-aya-benefits',
  'Tigernut Milk (Kunu Aya): Benefits, Nutrition & Why We Cold-Press It',
  'Kunu aya has fed northern Nigeria for generations. Here''s the nutrition behind tigernut milk — and why pressing it cold beats the roadside version.',
  $md$
Long before "plant milk" became a supermarket category, northern Nigeria was drinking **kunu aya** — tigernut milk — out of recycled bottles on every street corner. It turns out our grandmothers were ahead of the trend.

## What is a tigernut?

Despite the name, a tigernut isn't a nut at all — it's a small tuber, sweet and slightly chewy, sold dried or fresh across Nigerian markets. Soaked and pressed, it yields a creamy, naturally sweet milk.

## The nutrition

- **Resistant starch & fibre** that feed your gut bacteria and keep you full.
- **Healthy fats** similar in profile to olive oil.
- **Magnesium, potassium and iron** — minerals most Nigerian diets run short on.
- Naturally **dairy-free, nut-free and gluten-free**, so it works for almost everyone.

## Why cold-pressed, not roadside

Traditional kunu aya is delicious but risky: it's often made with untreated water and sits unrefrigerated in the sun for hours. We soak clean, press cold, bottle immediately and keep it chilled — same ancestral drink, none of the gamble.

## How to drink it

Cold, on its own, as a breakfast-on-the-go. Or blend a bottle into a smoothie for extra creaminess. It's the most Nigerian "oat milk" you'll ever taste — except we had it first.
$md$,
  'Mrs. Samuel',
  4,
  'Wellness',
  'root',
  now()
),
(
  'pineapple-ginger-immunity',
  'Pineapple & Ginger: The Immunity Duo Nigerians Swear By',
  'Why the pineapple-ginger combo shows up in every Nigerian kitchen when someone feels a cold coming — and what the science actually says.',
  $md$
Ask any Nigerian aunty what to drink when you feel a cold coming, and you'll hear the same answer: **pineapple and ginger**. It's not folklore for nothing.

## The pairing

**Pineapple** brings *bromelain*, an enzyme that helps break down protein and is studied for easing inflammation and clearing congestion. **Ginger** brings *gingerol*, a warming compound with a long track record for soothing nausea and sore throats.

Together they make a drink that's sharp, sweet and just spicy enough to make you sit up.

## What it's good for

- A **vitamin-C hit** from fresh pineapple to support your immune system.
- **Digestive relief** — both bromelain and ginger are gentle on an upset stomach.
- That **clear-headed warmth** when the harmattan dust has your throat scratchy.

## Why fresh beats bottled-from-concentrate

Most "pineapple ginger" you buy is reconstituted concentrate with added sugar and flavouring. Bromelain is fragile — heat and processing destroy it. We cold-press fresh pineapple with raw ginger root, so the enzyme and the kick both survive into the bottle.

Keep one in the fridge for the next time someone in the house starts sniffling.
$md$,
  'Mrs. Samuel',
  3,
  'Wellness',
  'citrus',
  now()
),
(
  'cold-pressed-juices-beat-lagos-heat',
  '5 Cold-Pressed Juices to Beat the Lagos Heat',
  'When the sun turns Lagos into an oven, sugary soft drinks make it worse. Here are five cold-pressed bottles that actually cool you down.',
  $md$
There's hot, and then there's *Lagos in March* hot. When the heat hits, the worst thing you can reach for is a sugary, fizzy drink — it spikes your blood sugar and leaves you thirstier. Here's what we reach for instead.

## 1. Watermelon
Over 90% water, naturally sweet, and full of electrolytes. Cold-pressed watermelon is basically nature's sports drink — minus the dye and sugar.

## 2. Cucumber & Mint
Cooling in the most literal sense. Light, crisp, and barely sweet — the bottle you finish in one go after standing in traffic.

## 3. Zobo (Hibiscus)
Tart, ruby-red and refreshing served ice-cold. The natural acidity makes your mouth water, which is exactly what you want in the heat.

## 4. Pineapple
Tropical, juicy and high in vitamin C. A chilled bottle tastes like a holiday you didn't take.

## 5. Green Blend
Cucumber, green apple and a little ginger. Hydrating with a clean, grassy finish that doesn't sit heavy.

## The rule of thumb

In the heat, choose **water-rich fruit over sugar-heavy ones**, and always drink it cold. Every bottle on this list is cold-pressed, unsweetened where it can be, and delivered the same morning it's made — so it's still fresh when it hits your fridge.

Stay cool out there.
$md$,
  'Mrs. Samuel',
  4,
  'Recipes',
  'watermelon',
  now()
)
ON CONFLICT (slug) DO NOTHING;

-- Report.
SELECT slug, cluster, (published_at IS NOT NULL) AS published FROM blog_post ORDER BY created_at;

# Image shot list for Grok

Every image on mrssamuel.com that isn't a real bottle photo, with a verdict and a ready-to-paste Grok prompt. Generated from an audit of `apps/customer/src` on 17 Nov 2026.

## How we work a batch

1. Pick a batch below. Paste each prompt into Grok as-is (one prompt per image).
2. Send the results back as `ID  link` lines, for example `B1-03 https://...`. Any number at a time.
   Grok links can expire within hours, so send them the same day. If a link won't open for Claude, save the image instead into `~/Downloads/grok/` named by its ID (`B1-03.jpg`).
3. Claude downloads each image, looks at it, and rejects it if it has text, a fake bottle or label, warped fruit or extra fingers. It then crops it to size, converts it to WebP (about 100–200KB), strips the metadata, saves it under `apps/customer/public/media/`, wires it into the page and opens a pull request.

## Rules baked into every prompt (and why)

- **No bottles, labels or logos.** Grok can't draw our real bottle, and a made-up bottle on a product page misleads customers. Where a bottle belongs, the real studio photo goes on top in code.
- **No faces.** A generated person beside a real brand reads as a fake customer or a fake founder.
- **No text.** AI text comes out garbled. Headlines are added by the site.
- **Real photo preferred** is marked where the image claims something true about the business (your kitchen, farm, the founders). Use the Grok version only as a stop-gap.

## Verdicts: every image placement on the site

| Tag | Where | What's there now | Verdict |
|---|---|---|---|
| K1 | Bottle photos everywhere (home categories, hero, shop cards, cart, checkout, area pages) | Real studio bottle photos | ✅ Keep. Compress later (about 1MB each) |
| K2 | Header and footer logo, favicon | Brand logo | ✅ Keep |
| K3 | /qr page | QR code | ✅ Keep |
| K4 | Home hero video ('Watch our story') | 9MB video | ✅ Keep (check it's your own footage) |
| K5 | Home hero, around the bottles | Orange splash and mint-leaf cut-outs | 🟡 OK to keep: small accents around real bottles |
| K6 | /terms, /returns, /contact page heroes | Fruit cluster / mint cut-outs | 🟡 OK to keep: utility pages, low value. Swap later if you like |
| X1 | **Link preview image** (shown on every WhatsApp/IG/Google share) | Screenshot of an OLD home page (shows 'Subscription' menu, old headline) | ❌ Replace first. → B3-07 |
| X2 | **Blog cards and article tops** (home, /blog, every post) | One of 6 fruit cut-outs, repeated across posts; 5 posts point to images that don't exist | ❌ Replace. → Batch 1 |
| X3 | **Blog post share image** | Same fruit cut-out | ❌ Replace. → Batch 1 (same images) |
| X4 | **Shop, /juices cards and product pages**: fruit beside each bottle | Cut-outs, several wrong: Pure Green shows kiwi (none in it), Lemon Sip shows ginger only, Sweet Pepper shows watermelon, Guyabano shows mixed berries, Guava Punch has no image | ❌ Replace. → Batch 2 |
| X5 | **/about hero** | Beetroot, carrot and ginger cut-out | ❌ Replace with a REAL photo of the founders. → R1 (B3-06 fallback) |
| X6 | **Home 'Our story' section** | Citrus cut-out behind 3 bottles | ❌ Replace, real photo preferred. → R2 (B3-05 fallback) |
| X7 | /juices, /delivery, /blog, Lagos hub page heroes | Fruit cluster cut-outs | ❌ Replace. → B3-01 to B3-04 |
| X8 | 14 Lagos area page heroes | The same citrus cut-out on all 14 | 🟡 Optional. → Batch 4 |
| X9 | Home Instagram tiles (when the live feed is off) | Green tiles with captions | ❌ Use stills from your own reels. → R3 |

## Real photos needed (Grok can't do these honestly)

- **R1, About hero:** Mr. & Mrs. Samuel together, ideally in the kitchen or shop. Portrait (4:5), daylight.
- **R2, Home story section:** juice being pressed or bottled at your kitchen. Portrait (4:5).
- **R3, Instagram tiles:** a screenshot or still frame from each of your two reels (DbRSDhwsWUK and DZ4i_QeMj7M), plus up to 4 more favourite posts. Square.
- **Blog, if you have them:** your team or kitchen (B1-05), a market or farm you buy from (B1-06, B1-10). A real photo always beats the Grok version for these three.

Phone photos are fine. Send the originals; Claude removes the location data before anything goes online.

## Batch 1: blog covers (11 images)

Used for the blog card, the top of the article and the share preview. Saved as `/media/blog/<slug>.webp`. All 16:9 landscape.

### B1-01 · The Health Benefits of Zobo (Hibiscus) (`zobo-hibiscus-health-benefits`)
```text
16:9 landscape image. A carved calabash bowl full of dried deep-ruby hibiscus (zobo) petals, a clear glass tumbler of dark ruby zobo drink with ice, fresh ginger slices, a few cloves and pineapple chunks on a weathered wooden table. Three-quarter angle, rich red tones. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B1-02 · 5 Cold-Pressed Juices to Beat the Lagos Heat (`cold-pressed-juices-beat-lagos-heat`)
```text
16:9 landscape image. Five plain clear glasses of chilled fresh juice in different colours (watermelon red, orange, pale green, golden pineapple, coral pink) sitting in a metal tray of crushed ice, heavy condensation, bright hot afternoon sun with palm-leaf shadows across the table. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B1-03 · Pineapple & Ginger: The Immunity Duo (`pineapple-ginger-immunity`)
```text
16:9 landscape image. A golden ripe pineapple cut in half, fresh knobbly ginger roots with a few thin slices, and one plain glass of pale golden juice on a light wooden board. Close, bright, appetising. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B1-04 · Tigernut Milk (Kunu Aya) (`tigernut-kunu-aya-benefits`)
```text
16:9 landscape image. Raw tigernuts spilling from a small woven raffia basket, a plain glass of creamy beige tigernut milk, a few dates and pieces of fresh coconut on a cream linen cloth. Soft, calm, natural. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B1-05 · Forty thousand bottles later (`forty-thousand-bottles-later`)
> ⚠️ REAL PHOTO PREFERRED (your actual kitchen or team). Use this only as a fallback.

```text
16:9 landscape image. Stacked wooden crates overflowing with fresh oranges, pineapples and carrots in a small, clean juice kitchen at sunrise, stainless-steel prep tables in the background, warm light through a window. No people. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B1-06 · Why we're building more than a juice company (`more-than-juice-fighting-fruit-waste`)
> ⚠️ REAL PHOTO PREFERRED (a farm or market you actually buy from). Fallback only.

```text
16:9 landscape image. A Nigerian open-air fruit market at dawn: woven baskets piled with ripe mangoes, oranges and pineapples, some slightly imperfect but good fruit. A vendor's hands arranging fruit, no face visible. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B1-07 · Why cold-pressed beats centrifugal (`why-cold-pressed`)
```text
16:9 landscape image. Close-up of fresh bright orange carrot juice streaming from a stainless-steel cold press into a plain glass jug, whole carrots, apples and a lemon beside it. Clean kitchen, crisp detail on the liquid. No brand names on any machine. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B1-08 · What goes into our Ultimate Detox (`what-actually-goes-into-detox`)
> ⚠️ Check the fruits match the ingredients listed in the post before generating.

```text
16:9 landscape image. Overhead flat-lay of detox ingredients on a cream surface: cucumber, celery sticks, green ugu leaves, fresh ginger, lemon halves and a halved beetroot, neatly arranged with breathing space. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B1-09 · Why we deliver same-day in Lagos (`lagos-traffic-and-48-hour-shelf-life`)
```text
16:9 landscape image. An insulated cooler bag, open, with ice packs and fresh fruit inside, strapped on the back seat of a delivery motorbike. Blurred busy Lagos street behind with yellow danfo buses, early morning light. Rider not visible. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B1-10 · Where our fruit comes from (`fruit-sourcing`)
> ⚠️ REAL PHOTO PREFERRED (your actual supplier). Fallback only.

```text
16:9 landscape image. Hands holding freshly harvested pineapples in a Nigerian farm field, red earth, rows of pineapple plants, early morning haze. No faces. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B1-11 · Behind Mrs. Samuel Fruit Punch (`the-punch-recipe`)
> ⚠️ Check the fruits match the recipe in the post before generating.

```text
16:9 landscape image. A plain glass jug and two plain glasses of deep coral-red fruit punch with ice, surrounded by watermelon wedges, pineapple chunks, orange slices and fresh mint on a wooden table. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

## Batch 2: flavour images (19 images)

Replaces the fruit cut-out beside each bottle on /shop, /juices and the product page. Each shows exactly the ingredients in that juice. The left side is left empty on purpose so the real bottle photo sits there. Saved as `/media/flavours/<slug>.webp`. All square.

### B2-01 · Guava punch (`guava-punch`)
```text
Square 1:1 image. Fresh halved pink guavas and pineapple chunks arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-02 · Sunrise Blend (`sunrise`)
```text
Square 1:1 image. Fresh carrots, a halved orange pawpaw with black seeds, orange slices and pineapple chunks arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-03 · Crimson Garden Glow (`crimson-garden`)
```text
Square 1:1 image. Fresh a red apple, a halved beetroot, celery sticks, carrots and pineapple chunks arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-04 · Crimson Elixir (`crimson-elixir`)
```text
Square 1:1 image. Fresh a halved beetroot, pineapple chunks and a watermelon wedge arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-05 · Crimson Cooler (`crimson-cooler`)
```text
Square 1:1 image. Fresh watermelon wedges, a halved beetroot and carrots arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-06 · Ginger Spark (`ginger-spark`)
```text
Square 1:1 image. Fresh watermelon wedges, pineapple chunks and fresh ginger root arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-07 · Orange Juice (`orange`)
```text
Square 1:1 image. Fresh whole and halved juicy oranges with a few green leaves arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-08 · Pineapple Juice (`pineapple`)
```text
Square 1:1 image. Fresh a whole golden pineapple and juicy pineapple rings arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-09 · Pinecado Bliss (`pinecado`)
```text
Square 1:1 image. Fresh a halved ripe avocado with its stone and pineapple chunks arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-10 · Guyabano Delight (`guyabano`)
```text
Square 1:1 image. Fresh a halved soursop (guyabano) showing white flesh, fresh strawberries and pineapple chunks arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-11 · Vitamin Vibe (`vitamin-vibe`)
```text
Square 1:1 image. Fresh fresh turmeric root, ginger root, lemon halves, carrots and pineapple chunks arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-12 · Ginger Mint Splash (`ginger-mint-splash`)
```text
Square 1:1 image. Fresh pineapple chunks, fresh ginger root and a bunch of mint leaves arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-13 · Zesty Sunrise (`zesty-sunrise`)
```text
Square 1:1 image. Fresh a green apple, orange slices, pineapple chunks, lemon halves and ginger root arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-14 · Veggie Burst (`veggie-burst`)
```text
Square 1:1 image. Fresh a halved beetroot, green ugu (fluted pumpkin) leaves, celery, ginger root and pineapple chunks arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-15 · Lemon Sip (`lemon-sip`)
```text
Square 1:1 image. Fresh lemon halves, fresh ginger root and cucumber slices arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-16 · Sweet Pepper Splash (`sweet-pepper-splash`)
```text
Square 1:1 image. Fresh ripe tomatoes, red and yellow bell peppers and pineapple chunks arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-17 · Melongrape (`melongrape`)
```text
Square 1:1 image. Fresh watermelon wedges, a bunch of red grapes and carrots arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-18 · Creamy Paradise (`creamy-paradise`)
```text
Square 1:1 image. Fresh fresh strawberries, ripe bananas and pineapple chunks arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B2-19 · Pure Green (`pure-green`)
```text
Square 1:1 image. Fresh cucumber, spinach, celery sticks, kale leaves and a green apple arranged in the RIGHT half of the frame on a plain warm-cream surface. The LEFT 40% of the frame is empty plain cream surface (our real bottle photo is placed there later). Slight 30-degree top-down angle, gentle soft shadow. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

## Batch 3: page heroes, home story and share image (7 images)

Saved as `/media/pages/<name>.webp`.

### B3-01 · /juices page hero (top right)
```text
4:5 portrait image. An abundant still life of the fruit and vegetables we press: pineapples, oranges, a watermelon wedge, carrots, beetroot, ginger, cucumber and pawpaw on a cream linen surface. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B3-02 · /delivery page hero
```text
4:5 portrait image. An open insulated cooler bag full of ice packs and fresh fruit on the doorstep of a Lagos apartment, morning light, potted plant beside the door. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B3-03 · /juice-delivery-lagos hub hero
```text
4:5 portrait image. A wooden tray of fresh oranges, pineapples and watermelon in the foreground, a softly blurred busy Lagos street behind with yellow danfo buses and palm trees, golden morning light. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B3-04 · /blog page hero
```text
4:5 portrait image. Overhead flat-lay of Nigerian fruit on cream linen: halved pawpaw, pineapple, oranges, a watermelon wedge, dried hibiscus petals and ginger, clean and uncluttered. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B3-05 · Home page 'Our story' section (behind the 3 bottles)
> ⚠️ REAL PHOTO PREFERRED (your kitchen at 5am is the story). Fallback only.

```text
4:5 portrait image. Early-morning juice kitchen prep table: crates of oranges, pineapples and carrots, a stainless-steel cold press in soft focus, sunrise light through a window. No people. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B3-06 · /about page hero
> ⚠️ REAL PHOTO STRONGLY PREFERRED: this page is about Mr. & Mrs. Samuel. A photo of the two of you will do far more than any generated image. Fallback only.

```text
4:5 portrait image. Sunrise over a Nigerian fruit farm, rows of pineapple plants and orange trees, warm haze. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B3-07 · Link preview image (WhatsApp, Instagram, Google), 1200x630
```text
1.91:1 wide landscape image. Plain warm-cream surface with fresh fruit (orange halves, pineapple, watermelon wedge, mint) clustered at the far right edge only. The left two-thirds is completely empty cream space (logo, headline and our real bottles are added on top later). Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

## Batch 4: Lagos area pages (14 images, optional)

Lowest priority. A unique image per area helps a little, but the unique text matters far more. Saved as `/media/areas/<slug>.webp`. All 4:5 portrait.

### B4-01 · Ikeja & Ajao Estate (`ikeja`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a busy commercial road with shops, okada and traffic in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-02 · Isolo & Okota (`isolo-okota`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a bustling residential street with small shops and kiosks in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-03 · Lekki (`lekki`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a modern estate road lined with palm trees and new houses in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-04 · Ajah (`ajah`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a new residential estate road, fresh paint, young trees in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-05 · Victoria Island (`victoria-island`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, glass office towers and wide roads in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-06 · Ikoyi (`ikoyi`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a quiet leafy street with bougainvillea over white walls in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-07 · Lagos Island (`lagos-island`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a crowded colourful market street in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-08 · Yaba (`yaba`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a lively street near a university with young professionals' cafes in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-09 · Surulere (`surulere`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a busy residential neighbourhood street with old two-storey houses in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-10 · Gbagada (`gbagada`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a residential area beside a wide expressway in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-11 · Maryland (`maryland`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a busy road junction with an overpass in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-12 · Magodo (`magodo`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a calm gated estate street with neat lawns in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-13 · Ogba & Omole (`ogba-omole`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a tidy residential estate street with trees in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

### B4-14 · Festac (`festac`)
```text
4:5 portrait image. An open insulated cooler bag with ice packs and fresh fruit in the foreground on a low wall; behind it, softly out of focus, a wide tree-lined avenue with residential blocks in Lagos, Nigeria, morning light. Generic scene, no recognisable landmarks, no street signs. Photorealistic editorial food photography, soft natural morning daylight, warm cream (#FFF8ED) tones with deep green (#0E3F1F) and orange (#E85D1C) accents, shallow depth of field, fresh and real (juice droplets, natural imperfections), Nigerian / West African setting. Absolutely no text, words, letters, logos, labels, bottles, cans, cups with branding, packaging or watermarks. No people's faces.
```

## Code changes that come with the images

Done by Claude in the same pull request as each batch:

- Blog: use the real cover when there is one, `alt` set to the post title, share image set to the cover, lazy loading. The 5 broken `/assets/blog/*.jpg` links stop being used.
- Flavour cards: photo behind, real bottle in front, fixed width and height so the page doesn't jump.
- Page heroes: show a rounded photo card instead of a floating cut-out.
- Share image: logo, headline and two real bottles placed on B3-07, exported at 1200x630.
- Bottle PNGs: compressed from about 1MB to about 150KB each, which speeds up every page.

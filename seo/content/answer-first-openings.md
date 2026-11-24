# Answer-first openings (roadmap N3)

Each block below is a 40 to 60 word direct-answer paragraph to place as the **first paragraph** of the page, above everything else. For blog posts, paste it into the post body in admin (Owner → Blog). For code pages, it replaces or sits above the current intro text in the file named.

The 10 pages were chosen from the live sitemap (https://mrssamuel.com/sitemap.xml) and the known high-impression pages. TODO(owner): once Search Console access is set up, check this list against the real top 10 by impressions and swap any page that is not in it.

Rules followed: no new business facts. Every fact used is already stated on the live site (cold-pressed, no concentrates, no added sugar, no preservatives, kitchen in Ajao Estate, Ikeja, delivery across Lagos the same morning or next morning, 48-hour window, 330ml and 650ml bottles). Health statements match the cited guides.

## 1. Pineapple and ginger post

URL: https://mrssamuel.com/blog/pineapple-ginger-immunity

Where: blog post body, first paragraph (already in seo/content/pineapple-ginger-benefits.md).

Pineapple and ginger juice gives your body vitamin C, fluid and two well-studied plant compounds: bromelain from pineapple and gingerol from ginger. Research suggests ginger may ease nausea and support digestion, and vitamin C supports normal immune function. It will not cure a cold, but it is a refreshing, nourishing glass.

## 2. Kunu aya post

URL: https://mrssamuel.com/blog/tigernut-kunu-aya-benefits

Where: blog post body, first paragraph (already in seo/content/kunu-aya-benefits.md).

Kunu aya is a creamy drink made from tigernuts, often blended with dates, coconut and ginger. Its main benefits: it is naturally dairy-free, it gives you steady energy, and tigernuts bring fibre, resistant starch and minerals such as magnesium and potassium. Early research suggests it may support gut health, but studies are still small.

## 3. Zobo post

URL: https://mrssamuel.com/blog/zobo-hibiscus-health-benefits

Where: blog post body, first paragraph. If the expanded zobo rewrite (branch work/olu/seo-guides-drinks) is published, use its own opening instead and drop this one.

Zobo, also called sobolo, is a deep-red drink made from dried hibiscus calyces. It gives you fluid and plant compounds called anthocyanins. Some studies suggest hibiscus may modestly lower blood pressure, but the evidence is mixed and it is no substitute for medicine. Choose zobo with little or no added sugar.

## 4. Juice delivery in Lagos

URL: https://mrssamuel.com/juice-delivery-lagos

Where: apps/customer/src/routes/juice-delivery-lagos.index.tsx, first paragraph under the H1.

Mrs. Samuel delivers fresh, cold-pressed juice across Lagos, from our kitchen in Ajao Estate, Ikeja, to the Island, Lekki, Ajah and the mainland. Order online and your bottles arrive cold, the same morning or the next morning depending on when you order. Every juice has no concentrates, no added sugar and no preservatives.

TODO(owner): confirm delivery fees and any areas not covered, then add one sentence on fees after this paragraph.

## 5. Home page

URL: https://mrssamuel.com/

Where: apps/customer/src/routes/index.tsx, the first text block under the hero.

Mrs. Samuel makes fresh, cold-pressed fruit and vegetable juice in Lagos. Every bottle is pressed in our kitchen in Ajao Estate, Ikeja, with no concentrates, no added sugar and no preservatives, then delivered cold across Lagos the same morning or the next morning. Choose from fruit blends, green juices and more, in 330ml and 650ml bottles.

## 6. Juice menu

URL: https://mrssamuel.com/juices

Where: apps/customer/src/routes/juices.index.tsx, intro paragraph under the H1.

This is the full Mrs. Samuel juice menu: cold-pressed fruit blends like pineapple, orange and Ginger Mint Splash, green juices like Pure Green, and vegetable blends like Veggie Burst. Every juice lists its ingredients, comes in 330ml or 650ml bottles, and is made with no concentrates, no added sugar and no preservatives.

TODO(owner): the page title and meta description mention zobo and tigernut, but neither is in the live product catalogue. Either list them as products or remove them from the title and description.

## 7. Shop

URL: https://mrssamuel.com/shop

Where: apps/customer/src/routes/shop.tsx, intro paragraph under the H1.

Buy fresh juice online in Lagos from the Mrs. Samuel shop. Pick single bottles in 330ml or 650ml, or choose a bundle or gift box. Every juice is cold-pressed with no concentrates, no added sugar and no preservatives, and is delivered cold across Lagos the same morning or the next morning.

TODO(owner): confirm bundle and gift box names match what is live on /shop.

## 8. Why cold-pressed post

URL: https://mrssamuel.com/blog/why-cold-pressed

Where: blog post body, first paragraph (before the current opening about cutting a pineapple).

Cold-pressed juice is made by crushing fruit and vegetables slowly and squeezing out the juice with pressure, instead of spinning them against a fast blade. There is no added heat and no pasteurisation. The result tastes closer to fresh fruit, but it has a short life: keep it cold and drink it within about 48 hours.

TODO(owner): the current body of this post says centrifugal juicing loses "up to 40%" of vitamin C within ten minutes. That figure has no source. Add a citation or remove it before Google or AI answers quote it.

## 9. Pure Green product page

URL: https://mrssamuel.com/juices/pure-green

Where: product description (admin, product copy), first paragraph.

Pure Green is our classic green juice: cucumber, spinach, celery, kale and apple, cold-pressed in Lagos. It is vegetable-led, with one apple for a gently sweet finish, so it suits people who want a less sweet juice. No concentrates, no added sugar, no preservatives. Drink it cold, with a meal.

TODO(owner): add lab-tested sugar per bottle if available. If you take warfarin or have had kidney stones, the product page should link to /blog/green-juice-benefits, which explains why to check with a doctor.

## 10. Lekki delivery page

URL: https://mrssamuel.com/juice-delivery-lagos/lekki

Where: apps/customer/src/lib/areas.ts, the `intro` for slug `lekki` (or a new first paragraph above it).

Yes, Mrs. Samuel delivers fresh cold-pressed juice to Lekki, including Lekki Phase 1, Admiralty Way, Ikate, Osapa London, Agungi, Chevron and Jakande. Bottles are packed cold for the trip from our kitchen in Ikeja and arrive the same morning or the next morning, depending on when you order.

TODO(owner): confirm the Lekki delivery fee and whether same-morning delivery reaches the whole Lekki corridor.

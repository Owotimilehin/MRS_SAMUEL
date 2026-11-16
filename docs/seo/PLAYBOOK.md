# Mrs. Samuel SEO playbook

**Goal:** be the first result when someone in Lagos searches for fresh juice. That means the Google Maps results ("fresh juice near me", "juice shop Ikeja") and the top of page one for "juice delivery Lagos", "fresh juice Lagos", "zobo drink Lagos", "bulk juice for parties Lagos" and similar searches.

**Realistic timing:** 2–4 months of steady work. Google rewards consistency, not one big push.

**What moves rankings, in order:**
1. **Google Business Profile**, reviews especially. This decides the Maps results.
2. **Links from other websites**, such as food bloggers, press and directories.
3. **The website itself.** The pull request on `work/olu/aggressive-seo` handles this.
4. **New content every week.**

---

## This week (owner)

### 1. Google Search Console (30 min)
1. Go to search.google.com/search-console, choose **Add property**, then **Domain**, and enter `mrssamuel.com`.
2. Google gives you a TXT record. Add it in **Cloudflare → DNS** for mrssamuel.com, then click **Verify**.
3. Open **Sitemaps** and submit `sitemap.xml`. Do this after the SEO pull request is merged. The new sitemap lists 43 pages; the old one listed 9.
4. Open **URL Inspection**, check `https://mrssamuel.com/juice-delivery-lagos`, then click **Request indexing**.
5. Share Search Console access with whoever does the monthly review (Settings → Users).

### 2. Cloudflare redirects (10 min)
Right now `www.mrssamuel.com` and `http://mrssamuel.com` both load the site instead of redirecting. This splits Google's attention across copies of the site.
- **SSL/TLS → Edge Certificates → Always Use HTTPS:** turn it on.
- **Rules → Redirect Rules:** add a rule that sends hostname `www.mrssamuel.com` to `https://mrssamuel.com${path}` with a 301 redirect, keeping the query string.

### 3. Pick one phone number
The website shows **0901 951 2246**. The branch record in admin shows **0706 722 0914**. Google trusts a business more when its name, address and phone are identical everywhere. Pick one public number, and use it on the website, the Google profile, Instagram and every directory.

### 4. Send us the Google Maps link
Open the listing on Google Maps, tap **Share** and copy the link. We'll connect it to the website's business details.

---

## Google Business Profile: full setup checklist

- [ ] **Primary category:** *Juice shop*. **Extra categories:** *Health food store*, *Caterer*, *Fruit and vegetable store*. Only add the extras if they're true.
- [ ] **Business name** exactly "Mrs. Samuel Fruit Juice". Don't add keywords to the name; Google suspends listings for that.
- [ ] Address, hours and phone exactly as on the website.
- [ ] **Website:** `https://mrssamuel.com`. **Order link:** `https://mrssamuel.com/shop`.
- [ ] **Service areas:** the Lagos areas you really deliver to.
- [ ] **Description** (750 characters max). Use this:
  > Mrs. Samuel Fruit Juice makes fresh, 100% natural juice in Lagos. Every bottle is cold-pressed from whole fruit and vegetables at our kitchen in Ajao Estate, Ikeja: zobo, pineapple, orange, green juice, tigernut and more. There's no added sugar, no water and no preservatives. Order online for cold delivery across Lagos, or walk in. We also supply chilled crates for weddings, parties, offices and corporate gifts. Over 40,000 bottles shared.
- [ ] **Products:** add every juice, each with a photo, price and a link to its page on mrssamuel.com.
- [ ] **Photos:** 20 or more real ones (shopfront and sign, the kitchen, bottles, the team, deliveries, events). Add 2–3 new photos every week.
- [ ] **Posts:** one per week (a new flavour, an offer, an event you supplied). Copy your best Instagram post.
- [ ] **Questions & answers:** add 5 common questions yourself and answer them. You can reuse the website's Q&A.

## Reviews: the biggest lever for Maps

Target: **10 new Google reviews a month**, and a reply to every one within 48 hours.

- Get the review link from your Google profile (**Ask for reviews**). Shorten it and put it on:
  - the WhatsApp message sent after every delivery
  - a sticker or card in every delivery bag, and on the receipt. Google's **Ask for reviews** screen gives you a ready-made QR code for this. It's separate from the website QR at `/qr`.
  - your Instagram story highlight
- WhatsApp message to send the day after delivery:
  > Hi {name}, thank you for ordering from Mrs. Samuel! 🍍 If you enjoyed your juice, would you leave us a quick Google review? It really helps a small Lagos business: {link}
- **Never** buy reviews, post reviews yourself, or offer discounts in exchange for reviews. Google removes them and can suspend the listing.

## Instagram: turn your audience into Google signals

Instagram helps you on Google in three ways:
1. **Google now shows public Instagram posts from business accounts in its results.** A caption that says "fresh juice delivery in Lekki" can show up when someone searches that.
2. **Instagram sends people to the website,** and people who arrive and order are a signal Google rewards.
3. **People who see you on Instagram later search your name on Google,** which lifts your whole listing.

### Set up once (15 min)
- [ ] **Bio link:** `mrssamuel.com/ig`. This is your own link page, already built, so it replaces Linktree. It sends people to Shop, Lagos delivery, bulk orders, WhatsApp and the blog.
- [ ] **Name field:** "Mrs. Samuel | Fresh Juice Lagos". Instagram search reads the name field, so people searching "fresh juice Lagos" on Instagram find you.
- [ ] **Bio text:** say what and where. For example: "100% fresh cold-pressed juice 🍍 No added sugar. Delivered cold all round Lagos. Order 👇"
- [ ] **Story highlights:** *Order*, *Delivery areas*, *Reviews*, *Press*, *Events*.
- [ ] **Account settings:** make sure it's a public Business or Creator account. That's what lets Google show your posts.
- [ ] **Leave a Google review:** once you have the review link from your Google profile, send it to the developer. A "Leave us a Google review" button then appears on `/ig`.

### Every post (habits)
- **Write captions in search words, naturally.** The first line counts most: "Fresh zobo, pressed this morning in Ikeja 🌺" works better than "Monday vibes ✨".
- **Tag the location** (Lekki, Victoria Island, Ikeja and so on) on every delivery and event post.
- **Add alt text** (Advanced settings → Accessibility): describe the photo, e.g. "Bottles of fresh pineapple juice on ice at a Lekki wedding".
- **End with "Order: link in bio"** or "Delivery all round Lagos: link in bio".
- **Use 3–5 specific hashtags,** not 30 generic ones: #freshjuicelagos #lagosjuice #zobo #coldpressedjuice #lagosevents.

### Weekly content loop (ties Instagram and the website together)
| Day | Instagram | Website |
|---|---|---|
| Mon | Carousel from the week's blog post ("5 things about zobo") | Publish that post in admin → Blog |
| Wed | Reel delivering to one area, location tagged: "Fresh juice delivery in Yaba" | The matching area page is already live; send us any local fact from the delivery |
| Fri | Customer or critic repost, plus a story with a link sticker to the Google review link | That review lifts your Maps ranking |
| Sat | Event or bulk-order reel (wedding, office) | Links to `/bulk-orders` |

### Food critics and influencer mentions
- **Repost every mention** to your story and the *Press* highlight.
- **Send the developer the list** of every critic who has featured you: their name, Instagram handle, and the link to the post or article. It goes on the website as an "As featured in" section, which builds trust for customers and Google.
- **The big one:** if a critic also has a **blog, YouTube channel or website**, ask them to add a link to mrssamuel.com (see the template below). One link from a real Lagos food site is worth more than hundreds of likes.
- **Collaborate with Lagos gyms, fitness coaches and wellness creators.** Use Instagram's Collab post feature so the post shows on both accounts.

### The Instagram feed on the website
The home page now shows your latest Instagram posts and captions. Fresh posts mean fresh text on the page, and Google likes that. It needs two things on the server:
- the server fix in this update, so the feed works even when the server's cache is down
- a valid Instagram access token (`IG_ACCESS_TOKEN`). These expire every 60 days. The developer should check it's set and put a renewal reminder in the calendar. If the feed is empty after deploying, an expired token is the likely reason.

## Food critics and bloggers: turn mentions into links

**This is the most valuable job on this list.** A link from a Lagos food blog or a news site to mrssamuel.com counts as a vote of trust in Google's eyes.

1. **Collect every mention:** each critic's name, the platform, and the URL of the post or article. Put them in one list and send it to the developer. We'll add an "As featured in" section to the website.
2. For every mention on a **website** (blog, news site, YouTube description), ask the writer to add a link:
   > Hi {name}, thank you again for featuring Mrs. Samuel. It meant a lot to us! Would you be able to add a link to our website, mrssamuel.com, in the post so readers can order? Happy to send a fresh crate your way to say thanks.
3. **New outreach:** pitch Lagos food writers (for example Foodie in Lagos and Eat Drink Lagos) and lifestyle and wellness bloggers. Offer a tasting crate, but don't make a link a condition of it.
4. Offer a quote or story to business and lifestyle press: "From one kitchen to 40,000 bottles", or the fruit-waste story.

## Directories (one afternoon, same details everywhere)

Use exactly the same name, address, phone, website and hours on each:
- [ ] Apple Maps (Apple Business Connect)
- [ ] Bing Places (can import from Google)
- [ ] VConnect
- [ ] BusinessList.com.ng
- [ ] Finelib
- [ ] Facebook page: fill in the address, hours and website
- [ ] Chowdeck, Glovo or similar delivery apps, if you sell there. Their listings rank too.

## Website content (ongoing)

- **One blog post a week**, 800 words or more, answering a real question Lagos customers ask. Drafts are ready in `docs/seo/blog-drafts/`. Paste them in through **admin → Blog**.
- **Delivery-area pages:** each area you really deliver to gets its own page (Lekki, VI, Ikoyi, Yaba, Surulere…). Send the developer the list of areas with fees and timing. The pages only work if each one is real and different from the others.
- **Make the existing short posts longer**, especially the zobo and tigernut posts. They're about 265 words now and should be 800 or more.

## Monthly check (30 min, first Monday)

| Where | What to look at |
|---|---|
| Search Console → Performance | Top searches, clicks, average position for "fresh juice lagos", "juice delivery lagos" |
| Search Console → Pages | Any "not indexed" pages, sent to the developer |
| Google Business Profile → Performance | Calls, website clicks, direction requests, searches |
| Google Maps (incognito, in Lagos) | Search "fresh juice near me" and "juice shop Ikeja", and note your position |
| Reviews | New this month (target 10) and average rating |

## Don't

- Stuff keywords into the business name, or add hidden text to the site.
- Buy links, reviews or followers.
- Create fake listings or "branches" at addresses you don't operate from.
- Publish near-copies of the same page for different areas.

Any of these can get the website or the Maps listing penalised, and that's far harder to undo than to avoid.

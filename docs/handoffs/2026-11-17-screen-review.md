# Screen review: every page, desktop and phone

Review of the look and fit of every screen on 17 Nov 2026, by Olu with Claude. Nothing was changed. It covers 54 staff-app screens and 17 storefront pages, each photographed at desktop (1440 wide) and phone (390 wide) from a local preview, then checked by an automatic layout pass and by eye.

Limits: the preview database is nearly empty (20 products, 1 branch, 3 customers, 3 demo chats, no sales), so screens were seen mostly in their empty state. Order, sale, return and shift detail screens were not seen because there is no data to open. Nothing was checked on a real phone. Items marked "check live" may be an artefact of the screenshot.

Severity: **High** = broken or unusable. **Medium** = clearly looks wrong. **Low** = polish.

## Fix once, fixes everywhere (staff app)

| # | Problem | Where | Severity |
|---|---|---|---|
| S1 | **The orange splash picture sits over the stat tiles and the page title** in the green banner. It was meant to be faint (40%) but its animation forces it to 80 to 100%. On desktop it hides tile numbers; on phone it sits over the title. | About 40 screens. `apps/admin/src/index.css:1573` and `:1672-1676` | High on phone, Medium on desktop |
| S2 | **The floating "Not taking calls / Dial" bar covers content** at the bottom right of every screen. No space is reserved for it. New with the inbox. | Every screen. `components/inbox/inbox.css:100-104`, `CallBar.tsx` | High on phone, Medium on desktop |
| S3 | **Tables run off the side of a phone** with nothing to show they scroll, so action buttons are out of sight. | Admin users, Packaging, Audit log, Blog, Bookkeeping, Devices, Inbox settings (all table tabs) | High |
| S4 | **Phone top bar wraps to two or three rows.** The round avatar drops onto its own row and wastes 50 to 90px. Header height differs between screens. | Most screens. `index.css:774` | Medium |
| S5 | **Form text is under 16px**, so an iPhone zooms the page whenever a field is tapped. | Every form field and dropdown on phone | Medium |
| S6 | **Number columns: the heading is left-aligned, the numbers right-aligned**, so they sit far apart. | Factory inventory, Packaging, Zones. `index.css:379-382` vs `:399` | Medium |
| S7 | **Buttons of different heights side by side** (32, 36 and 40px). | Orders, Analytics, Transfers (all three), Variance, open conversation | Medium |
| S8 | **Computer-style dates** such as "2026-11" and "2026-11-17" beside "17 Nov 2026" on the same screens. | Bookkeeping, Analytics, Dashboard, Variance, Shift start, Inbox hours | Medium |
| S9 | **Page names disagree** between the top bar, the banner and the breadcrumb ("Activity log" / "Audit log", "Today's sales" / "Sales", "Storefront" / "Marketing"). Breadcrumbs appear on some screens only. | About 15 screens | Low |
| S10 | **Empty states come in five styles**, from a titled card to bare grey text. | App-wide | Low |
| S11 | **"Cans" and "bottles" are both used** for the same thing. | Adjustments, Inventory, Preorders, Product detail vs Factories, Packaging, Returns | Low |
| S12 | **Raw internal words shown to staff**: lower-case "regular / special / bottle / owner", web slugs under product names, hex colours, "(sets `valid_to`)", template codes like `missed_call_followup`, half-translated audit actions ("inbox — note add", "Customer #export"). | Products, Product detail, Factory inventory, Packaging, Audit log, Inbox templates | Medium |
| S13 | Two refresh buttons side by side with different colours per screen; greyed-out "Export CSV" with no reason given; dropdowns that may show no arrow (check live). | Audit log, Devices, Dashboard, Customers, Orders | Low |
| S14 | Two menu items highlighted at once. | Inbox reports and Inbox settings (Inbox stays lit); Branch "Overview" stays lit on Today's sales. `Shell.tsx:77-79`, `BranchTabs.tsx:19` | Medium |

## Staff app, screen by screen

Only screens with their own problems are listed. All others are fine apart from the shared items.

### Broken on a phone (High)

- **Branch detail** (`/owner/branches/:id`): page is about 600px wide. Delivery zones sits off-screen. The Phone field is squashed to 24px and shows one digit. Fixed two-column layout, `routes/owner/branch-detail.tsx:159,177,195,338`.
- **Bookkeeping**: page is wider than the screen and "+ Add expense" is pushed out of reach. Amount and Receipt columns are off-screen.
- **Settings**: page is wider than the screen. The Instagram handle runs past the edge, the address is cut off, values wrap to five lines.
- **Blog**: titles break one word per line, action buttons are off-screen.
- **Audit log**: only "When" and "Who" are visible.
- **Inbox reports**: page is about 657px wide; the staff and number tables push it sideways. Chart bars are hairlines (check live).
- **Inbox settings, Hours tab**: page is about 455px wide; the call bar covers the holiday Name field. On Numbers, Edit / Check / Register on WhatsApp are off-screen. Six top-right buttons have cut-off labels.
- **Open conversation**: the call bar covers "Send a template" (and will cover Send), so staff cannot reply. Nothing visible opens the contact panel: tapping the name does, but nothing shows that. The first message hides under a 190px header.
- **Till** (`/branch/sell`): the cart and Charge button sit below all 20 products, about 2,500px down (roughly four screens of scrolling per sale), with no sticky total. On desktop the Charge button is also below the first screen (about 1,000px down on a 900px-tall window), so staff scroll to charge even with an empty cart; it will be worse on a tablet.

### Broken on desktop (High)

- **Variance**: the top bar is broken. The month picker stretches to about 615px, the search box is squashed to 125px and the title wraps. `routes/owner/variance.tsx:60`.

### Medium

- **Bundles**: the screen calls an API address that does not exist (404). It shows a red error and "No bundles yet" together. `routes/owner/bundles.tsx:115-125`.
- **Open conversation, desktop**: the red "Delete this customer's messages and calls…" label spills out of its button (`ContactPanel.tsx:140-142`). The list tab row is cut off at the right with no hint that it scrolls. The assignee box cuts off the name. Icons stack above the text in "WhatsApp reply" / "Internal note" and in the "Main line" chip (`inbox.css:28,52`).
- **Inbox list**: the Closed tab says "All clear"; the labels filter vanishes on that tab so the layout jumps.
- **Inbox reports**: numbers disagree ("Got a reply 0% (0 of 3)" beside 1 reply in the staff table; 4 messages in the banner, 3 + 3 on the chart). May be demo data; needs checking.
- **Inbox settings**: "Edit" has three different looks; "Check" sits 4px higher than its neighbours; owner's boxes are unticked although owners are not limited.
- **Dashboard**: the selected period looks like plain text (check live); six cards in a five-column row leave one alone; headings wrap to three lines on phone.
- **Analytics**: top bar wraps; "Profit & loss" breaks into three lines on phone; empty chart shows "₦0 ₦1 ₦2 ₦3 ₦4".
- **Customers**: the list says "0 Total / No customers yet" while three customers exist and one opens by link. Needs checking.
- **Customer detail**: the "Since" tile shows a full date and time in large type and is three times wider than the others.
- **Checkout log**: does not match the rest of the app (no banner, narrow centred column, bare text).
- **Devices**: device shown as a cut-off internal ID with no name; "ONLINE" badge breaks in two on phone.
- **Product detail**: a green "Publish" button beside every price although nothing changed; "Delete flavour" sits right beside "Deactivate"; name and tagline repeated three times.
- **Settings**: the refund limit box looks editable but the note says to contact support; the sample receipt shows a different phone number and address spelling from the branch details.
- **Orders**: "Awaiting fulfilment" is on by default, so an empty system says "No matches" instead of "no orders yet".
- **Branch home**: status reads "SYNCED · NEVER".
- **Shift start**: says "No products to count" while the till lists 20; "Confirm opening stock" touches the Notes box.
- **Shift end**: neither tab is selected; the history screen points to a "Shift end" tab that does not exist (`routes/branch/closes.tsx:145`).
- **Till**: bag and straw +/− are bare symbols; "None (0)" does not look like a button; "0 left" is red on every line.
- **Stock**: "Adjust stock" is greyed out with no explanation.

### Low

Uneven label spacing in Branch detail; "1 ZONES"; emoji icons on Branches; "Code is immutable"; "Sub enquiries"; Vendors search with no icon; product badge colours that mean nothing; "Point Of Sale"; login "Sign in" button looks disabled; a dangling dot in the login status line on phone; inventory colour key at the bottom of 60 rows; "Read-only view" note shown to the owner; "Force sync" green on one screen and "Sync now" beige on another.

## Storefront

### High

- **Brand fonts load on the home page only.** Juices, Shop, Checkout, Track and the order page fall back to plain fonts. `apps/customer/src/routes/index.tsx:40-42` should be in the shared page shell.
- **"Last year September"** on About and the featured blog post. The business started in September 2024. `routes/about.tsx:21`.
- **Two pages send customers to bulk pricing that does not exist.** "See our bulk orders page for pricing" and "crate pricing"; Bulk Orders has a quote form and no prices. `routes/juice-delivery-lagos.index.tsx:30`, `routes/ig.tsx`.

### Medium

- **Track page example is the wrong format**: "e.g. 1042" while order numbers look like MS-000000. `routes/track.tsx:46`.
- **Product photos do not match the juice** on about ten products (Sweet Pepper Splash shows watermelon and strawberry; Guyabano shows berries; Pure Green shows kiwi and pear).
- **Testimonials and bundles name juices not on the menu**: "Pink Paradise", "Detox", "Immune Booster", "Blood Booster". `components/Testimonials.tsx:8-9`; bundle text comes from the database.
- **Phone newsletter**: "Subscribe" pokes out of the white box on every page. `components/SiteShell.tsx:53`.
- **Instagram reel cards**: the play button sits on top of the caption. `components/Testimonials.tsx:98-100`.
- **Phone home page is very long**: 15 product cards one per row, about 6,600px, and no "View all juices" link.
- **Hard-cropped images**: the tropical fruit picture has straight cut edges on Juices, Delivery, Blog and the Lagos page.
- **Contact form**: "Your name" sits 16px higher than "Email"; contact cards have uneven gaps; icon circles squash on phone (`routes/contact.tsx:145,111,157`). "Quick questions?" points to the FAQ with no link.
- **Bulk Orders and White Label**: no hero image; form styled differently from Contact, with no required marks.
- **Bundles are 330ml** but no product card offers 330ml; bundles are WhatsApp-only while the page says "add straight to your cart".
- **Order page**: opens with tiny "Order MS-000000" and no heading; no "not found" message.

### Statements that disagree between pages

- Delivery speed: "same morning" (About, QR, a blog title) vs "same or next morning" (Delivery, Terms, FAQ).
- "Pressed the same morning it shipped" vs "in stock" and "made to order".
- "100% fruit" and "no water" vs "whole fruit and vegetables".
- Address: "ajao estate" (footer, Contact), "Asa-Afariogun St" vs "Asa Afariogun Street", "Ajao Estate, Ikeja" vs "Ajao Estate, Lagos".
- "Across Lagos" vs "Nationwide arranged on request" (White Label).

### Low

"ajao estate" in lower case; "Basket" vs "Cart"; a cup emoji as the empty-cart picture; "Track order" in a different case from the other menu items and missing from the footer; unlabelled Instagram icon in the footer; no privacy policy although emails are collected; carousel dots 8px and banner X 22px; stray "₦4,500" beside the Specials heading; "650ml: Get it today (evening)" is unclear; the Journal link promises zobo and tigernut guides that do not exist; QR page hero styled differently.

Not seen: the lower part of the home page on a phone (blog, FAQ, footer), because the screenshot tool wraps at 16,384px.

## Suggested order

1. S1 and S2: two small styling fixes that clear the most visible problems on every screen.
2. The nine phone-broken screens and the till cart.
3. Storefront fonts, the three wrong statements, the Track example.
4. Inbox polish (buttons, tabs, labels, empty states).
5. S4 to S14 as one consistency pass.
6. Owner decisions: product photos, testimonial and bundle names, delivery wording, bulk pricing.

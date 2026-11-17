# Business suite: proposed scope (version 2)

Draft for approval, 17 Nov 2026, by Olu with Claude. Nothing here is built yet. It replaces the first draft after the owner asked for a full suite: everything Meta offers a business, shop stock synced to Meta, calls on private virtual numbers, and AI built in.

The Meta and phone-number facts below come from web research on 17 Nov 2026, mostly Meta's and Twilio's own pages. Pages were read through a summarising tool, so re-read any figure at its link before it goes into a budget or contract. "Unconfirmed" means no official page settled it.

## The idea in three sentences

Staff today answer WhatsApp in one screen and look up orders, stock and enquiries in others, and Instagram and Facebook messages are not in the app at all. The suite brings every customer channel Meta offers into one place, keeps Meta's catalogue in step with shop stock, handles phone calls on the business's own numbers, and uses AI to help staff answer faster. Done means: one person on one screen can take a customer from first message or call, on any channel, to a paid and delivered order, and the owner sees sales, service and marketing results together.

## Five facts that change the plan

1. **WhatsApp replies are no longer free.** Since 1 Oct 2026 Meta charges per delivered message for ordinary replies too. Each business number gets 1,000 free reply messages a month. With no payment method on the WhatsApp account, replies stop being delivered once those are used. The suite needs a usage counter and a warning. [1]
2. **A Nigerian business cannot place WhatsApp calls to customers.** Meta blocks business-started WhatsApp calls for numbers in Nigeria (and four other countries). Customers can call the business on WhatsApp, and that is free. So outbound calls must go over a normal phone line. [2]
3. **Twilio is probably the wrong phone provider for Nigeria.** Twilio's own pages conflict on whether it sells a voice-capable Nigerian number, its calls into Nigeria cost about $0.23 a minute, and it has no two-way SMS there. A local provider (Africa's Talking was quoted at roughly ₦15 to ₦20 a minute outbound) looks better. The Nigerian regulator is also penalising foreign-routed calls that show a local number. The voice code written so far is Twilio-only and would need a second provider. [3]
4. **Phone number is no longer a guaranteed customer key.** WhatsApp now has usernames, and a message can arrive with a Meta customer ID and no phone number. The inbox today matches customers by phone only. [4]
5. **Marketing messages are moving to a different Meta API**, with the old route switched off on 13 Oct 2027. Build broadcasts on the new one from the start. For Nigeria it sends, but without Meta's delivery tuning or click reports. [5]

Also: Meta allows a business to use its own AI for customer service on WhatsApp, with a required way to reach a human. General-purpose AI chatbots are banned, and WhatsApp chat content must not be used to train AI models. [6]

## What "everything Meta can do" means for a Nigerian business

| | What | Verdict |
|---|---|---|
| **Build** | WhatsApp, Instagram DMs and Messenger in one inbox, with story replies, comment replies and private replies | Available |
| | WhatsApp templates, buttons and lists, in-chat forms (Flows), product and catalogue messages, cart sent back to our own checkout | Available. Catalogue on the WhatsApp number to be confirmed in the account |
| | Shop products, prices and in/out of stock synced to Meta's catalogue | Available. Meta only uses "in stock / out of stock" outside Shops, not quantities |
| | Customer-started WhatsApp calls answered in the suite | Available once the number reaches Meta's 2,000-customer messaging level |
| | Ads that open a WhatsApp chat, and reporting purchases back to Meta so ads can be measured | Available. Needs a higher Meta access level |
| | Our own AI assistant with hand-off to a person | Allowed |
| | Meta's reports: message volumes and costs, template results, call figures | Available |
| **Skip for now** | Threads, WhatsApp groups (needs a blue tick), Messenger calling, creating ad campaigns from the suite (Ads Manager does this), Page statistics | Available but low value for a small retailer |
| **Not possible** | Business-started WhatsApp calls; WhatsApp in-chat payments; Facebook and Instagram Shops, product tags and Meta checkout; two-way SMS through Twilio | Not offered in Nigeria, or not confirmed |
| **Check in the account** | Meta's own AI agent; keeping the WhatsApp Business phone app alongside the API; exact Nigerian message prices | Unconfirmed |

## Proposed phases

Each phase can go live on its own.

### Phase 0: make what exists solid (in progress)

- Screen fixes from `2026-11-17-screen-review.md` (being done on the branch).
- Payment fixes P1 to P3 from `2026-11-17-app-and-payments-audit.md` (being done on a separate branch).
- First real test of the inbox with a Meta test number.
- Start the approvals below. They take the longest and block later phases.

### Phase 1: one inbox for every Meta channel

- Add Instagram DMs, story replies and mentions, Messenger, and comments on Facebook and Instagram posts, each with Meta's reply-window rules enforced.
- Store Meta's customer ID alongside the phone number, so customers without a visible number are handled.
- WhatsApp usage and cost counter against the 1,000 free replies per number.
- Consent record per customer and channel, with opt-out honoured everywhere.

Done when: a message on any of the three apps lands in the same list, with the same assignment, notes and labels.

### Phase 2: one customer, one screen; sell from the chat

- The customer's orders, delivery status and spend inside the conversation; chats and calls on the customer page.
- Catalogue sync: products, prices and in/out of stock pushed to Meta when they change in the shop.
- Send products and the catalogue in a chat; the customer's cart comes back as an order in our system with a payment link.
- Automatic WhatsApp updates: order confirmed, paid, out for delivery, delivered.

Done when: staff answer "where is my order?" without leaving the chat, a sold-out juice shows as out of stock on WhatsApp within minutes, and a cart sent on WhatsApp becomes a normal order.

Depends on the payment fixes.

### Phase 3: calls on the business's own numbers

- Choose a Nigerian phone provider and get numbers (needs company documents).
- Make the calling code work with that provider as well as Twilio: phone menu, hours, voicemail, recording with a spoken notice, transfer.
- Answer customer-started WhatsApp calls in the same call bar.
- Outbound calls over the phone line only.

Done when: a customer can ring a Nigerian number or tap call on WhatsApp and reach the right team, and staff can call back from the conversation.

### Phase 4: AI built in

- Call transcripts and summaries (needs a transcription provider).
- Suggested replies drawn from quick replies, the product list, order status and delivery rules. Staff approve before sending.
- Optional auto-answer for simple questions outside hours (hours, delivery areas, order status), always with "talk to a person".
- Chat summaries for hand-overs and automatic labels (complaint, bulk enquiry).
- Guardrails: no chat content used to train any model; no card details in chat.

Done when: staff accept or edit a suggested reply in one tap, and every call has a readable summary.

### Phase 5: marketing and measurement

- Broadcasts to chosen groups of customers on Meta's new marketing route, with opt-in, opt-out and daily limits enforced.
- Ads that open WhatsApp tracked through to the order, with purchases reported back to Meta.
- Website and bulk-order enquiries arriving in the inbox with an owner, plus tasks and reminders.
- One owner dashboard: sales, reply times, missed calls, message costs, campaign results.

## Deliberately left out

Payroll and attendance; replacing accounting; supplier purchasing; creating ad campaigns inside the suite; anything Meta does not offer in Nigeria.

## What could go wrong

1. **Approvals stall the work.** Instagram, Messenger, ad measurement and calling each need Meta to approve the app or the business. We would notice as features that work in testing but cannot be switched on. Mitigation: apply in Phase 0; build each phase against Meta's test accounts meanwhile.
2. **Message costs surprise the owner.** Replies now cost money past 1,000 a month per number, and AI auto-answers add messages. We would notice on Meta's bill. Mitigation: the usage counter in Phase 1, and AI auto-answer off by default.
3. **The phone provider choice is wrong twice.** The calling code is built for Twilio and never tested live; a Nigerian provider has different features. We would notice in the first real call test. Mitigation: confirm the provider and test one real number before building further on calls.

Everything goes live only when Tes merges. A merge deploys immediately and applies any database change with it. Phases 1 to 3 all add database tables.

## Approvals and accounts to start now

| # | What | Who | Why first |
|---|---|---|---|
| 1 | Meta business verification (already under way) | Owner | Unlocks higher limits and the access levels below |
| 2 | Payment method on the WhatsApp account | Owner | Without it replies stop after 1,000 a month |
| 3 | Meta app review for WhatsApp, Instagram and Messenger messaging, comments, and the "human agent" feature. Needs a working demo and a public privacy policy with deletion instructions | Tes | Needed before Phase 1 can go live. The storefront has no privacy policy today |
| 4 | Higher ads access level and the marketing terms | Tes | Needed for catalogue sync at full access and ad measurement |
| 5 | Nigerian phone provider account and numbers (company registration, address, authorisation letter) | Owner and Tes | Needed for Phase 3 |
| 6 | Transcription provider | Tes | Needed for Phase 4 |

## Decisions needed

| # | Decision | Who | Recommendation |
|---|---|---|---|
| 1 | Approve this scope and phase order | Owner | Approve Phases 0 to 3; confirm 4 and 5 after the inbox has run live for a few weeks |
| 2 | Phone provider: stay with Twilio, or move to a Nigerian provider | Tes | Get a quote and a test number from a Nigerian provider before deciding |
| 3 | AI auto-answer to customers: on or off | Owner | Start with suggestions to staff only |
| 4 | Is the first live test of the inbox done before Phase 1 is built? | Tes | Yes |
| 5 | Owner wording decisions from the screen review, and a privacy policy | Owner | Needed for Meta's review and the storefront relaunch |

## Sources for the key facts

1. https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
2. https://developers.facebook.com/documentation/business-messaging/whatsapp/calling
3. https://www.twilio.com/en-us/sip-trunking/pricing/ng , https://www.twilio.com/en-us/voice/pricing/ng , https://www.twilio.com/en-us/guidelines/ng/sms (local provider prices are from secondary pages and need a direct quote)
4. https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids
5. https://developers.facebook.com/documentation/business-messaging/whatsapp/marketing-messages/overview
6. https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform (section 4.7) and https://whatsappbusiness.com/policy/

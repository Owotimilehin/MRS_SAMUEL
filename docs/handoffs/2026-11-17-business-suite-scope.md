# From shared inbox to business suite: proposed scope

Draft for approval, 17 Nov 2026, by Olu with Claude. Nothing in this document is built yet. It needs a yes from the owner on what the business wants, and from Tes on order and timing.

## The idea in three sentences

Today the inbox is one more tool in the menu: staff answer a WhatsApp message there, then go to other screens to find the customer's order, check stock or log an enquiry. A business suite puts the customer conversation at the centre and brings the rest of the business to it, so one person on one screen can answer, sell, follow up and see what happened. Done means: a staff member can handle a customer from first message to delivered order without leaving the conversation, and the owner sees sales and service in one place.

## What exists today (checked in the code)

| Area | What is there | What is missing |
|---|---|---|
| Conversations | WhatsApp and calls in one timeline, teams, hours, phone menu, voicemail, notes, labels, templates, quick replies, reports. Built, never run against real WhatsApp or Twilio. | Go-live testing. No transcription, so no call summaries. |
| Customers | One customer record shared by the shop and the inbox. The inbox links out to the customer's profile. | The conversation does not show the customer's orders. The customer page does not show chats or calls. |
| Orders | Till, online orders, preorders, returns, delivery. | No way to start an order or send a payment link from a chat. |
| Customer updates | Customers get emails (payment reminder and others). The owner gets Telegram alerts. | No WhatsApp updates ("order confirmed", "out for delivery"). |
| Enquiries | Website contact, bulk-order and white-label forms are saved in their own lists and alert the owner. | They never reach the inbox, have no owner, no status and no follow-up. |
| Marketing | Leads list, blog, bundles, newsletter sign-up. | No way to message a group of customers. No opt-out record. |
| Follow-up | Missed-call follow-up message only. | No tasks, reminders or "call back by" dates. |
| Reports | Sales dashboard and analytics. Separate inbox reports. | No single view of sales and service together. |
| Phone app | Inbox app written, never run on a phone. | Device testing; the newer features (transfer, hold, merge). |

## Proposed suite, in order

Each phase is useful on its own and can go live before the next starts.

### Phase 0: make what exists solid (in progress)

- Fix the screen problems in `2026-11-17-screen-review.md` (being done now, on the branch).
- Run the inbox against Meta's test number and a Twilio test number on the staging copy.
- Fix the top payment problems in `2026-11-17-app-and-payments-audit.md` (P1 to P3 and A1). Phase 2 depends on these.
- One look across the app: page titles, buttons, empty states, dates, wording.

Done when: every screen passes the phone and desktop check, a real test message and test call work end to end, and a failed checkout no longer poisons its retry.

### Phase 1: one customer, one screen

- In the conversation: the customer's recent orders, delivery status, what they usually buy, total spent, open returns.
- On the customer page: chats, calls, voicemails and notes alongside orders.
- Search one box for a name, phone number or order number and land on the same record.
- Labels on customers (VIP, wholesale, complaint) usable in both places.

Done when: staff can answer "where is my order?" without leaving the chat.

### Phase 2: sell and update from the conversation

- Start an order from a chat: pick products, see stock, send the customer a payment link.
- Automatic WhatsApp updates: order confirmed, payment received, out for delivery, delivered, preorder ready. Each needs a template approved by Meta.
- Order questions route to the right team by order status.

Done when: an order placed from a chat shows in Orders like any other, and the customer receives each update on WhatsApp.

### Phase 3: enquiries and follow-up

- Website contact, bulk-order and white-label forms arrive in the inbox as conversations with an owner.
- A simple pipeline for business enquiries: new, quoted, won, lost.
- Tasks and reminders on a conversation or customer ("call back Friday"), with a "my tasks" list.
- Reply-time targets with a warning when a chat is waiting too long.

Done when: no enquiry sits unanswered without someone's name on it.

### Phase 4: reach customers

- Send an approved template to a group (for example customers who ordered in the last 60 days), with opt-out honoured and recorded.
- Results: sent, delivered, read, replied, orders that followed.
- Limits respected automatically (Meta caps how many people a business can message per day).

Done when: the owner can announce a new flavour to past customers in a few clicks and see what it earned.

### Phase 5: help for staff and owner

- Call transcripts and AI summaries (needs a transcription provider to be chosen).
- Suggested replies from quick replies and past answers; staff always approve before sending.
- After-hours auto-answers for common questions (hours, delivery areas, order status).
- One owner dashboard: sales, stock alerts, reply times, missed calls, open enquiries.
- Quotes and invoices for bulk orders.

## Deliberately left out

- Payroll, staff attendance and HR.
- Replacing accounting software. Bookkeeping stays as it is.
- Supplier purchasing beyond the existing vendors and packaging screens.
- Channels other than WhatsApp and phone (Instagram, email) until the first two are proven live.

## What could go wrong

1. **Building on unproven ground.** The inbox has never handled a real WhatsApp message or call. If Phase 1 starts before Phase 0's live test, problems found later cost more to fix. We would notice at the first real test. Mitigation: Phase 0 first.
2. **Payment links from chat inherit today's payment faults.** A customer who pays late is still not detected. We would notice as "paid but cancelled" complaints. Mitigation: payment fixes P1 to P3 before Phase 2.
3. **Meta rules.** Order updates and broadcasts need approved templates and are capped per day; breaking the rules can get the number restricted. We would notice as rejected templates or blocked sends. Mitigation: opt-out and caps built in from the start of Phase 4, and business verification finished first.

Everything goes live only when Tes merges. A merge deploys immediately and applies any database change with it.

## Decisions needed

| # | Decision | Who | Recommendation |
|---|---|---|---|
| 1 | Is this the suite the business wants, or are there parts missing or not wanted? | Owner | Approve Phases 0 to 3; treat 4 and 5 as later. |
| 2 | Order of work after Phase 0 | Tes | Phase 1 then 2. They deliver the biggest daily saving for staff. |
| 3 | Go-live of the inbox itself: before or after Phase 1? | Tes | Before. Real use will shape Phase 1. |
| 4 | Payment fixes: who and when | Tes | Before Phase 2 starts. |
| 5 | Transcription provider (for call summaries) | Tes | Decide in Phase 5; not blocking. |
| 6 | Owner wording decisions from the screen review (delivery promise, product photos, juice names in testimonials and bundles, bulk pricing) | Owner | Needed before the storefront is relaunched. |

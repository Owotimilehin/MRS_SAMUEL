# The business suite: what it contains and what it is for

Draft for the owner's approval, 17 Nov 2026, by Olu with Claude. It lists every feature proposed for the suite, section by section. Updated the same day with the services in the owner's Meta Business Messaging Platform brief; rows from the brief are marked **(brief)**. The build order is in `2026-11-17-suite-app-plan.md`; what Meta allows in Nigeria, with sources, is in `2026-11-17-business-suite-scope.md`.

Status key: **Built** = written and tested on the branch, not yet live, never run against real WhatsApp or a real phone line. **Planned** = not started. **Blocked** = Meta or the phone networks do not allow it for a Nigerian business today.

## What the business uses it for

| Job | How the suite does it |
|---|---|
| Answer every customer in one place | WhatsApp, Instagram, Messenger, comments and phone calls land in one list, shared by the team |
| Never lose a customer between staff | Every conversation has an owner, a team and a status; hand-overs keep the history and notes |
| Answer "where is my order?" in seconds | The customer's orders, delivery status and payment show beside the chat |
| Sell inside the conversation | Send products from the catalogue; the customer's cart becomes a normal order with a payment link |
| Keep Meta showing the truth | Prices and in/out of stock follow the shop automatically |
| Run a proper phone line | Nigerian numbers, a phone menu, hours, voicemail, recording, transfer, call-back |
| Know which advert makes the phone ring | A number per advert; every call and message tagged with where it came from |
| Know what customers call about | Every call transcribed, summarised and tagged with reason and outcome by AI |
| Reply faster with fewer mistakes | AI drafts replies from real order and stock data; staff approve |
| Bring customers back | Messages to chosen groups, with consent and Meta's limits respected, and sales measured |
| See the business in one view | Sales, reply times, missed calls, message costs and campaign results together |
| Stay inside the rules | Consent records, opt-outs, deletion on request, recording notices, an audit trail |

## 1. Inbox

| Feature | Status |
|---|---|
| WhatsApp messages: text, photos, video, voice notes, documents, location, contacts, reactions, replies | Built |
| Delivery and read ticks; "failed" and "not confirmed" states with the reason | Built |
| The 24-hour reply rule enforced, with a template offered when the window is closed | Built |
| Phone calls, missed calls and voicemails in the same timeline as messages | Built |
| Lists: Mine, Unassigned, Team, All open, Closed; search by name or number; filter by number and label | Built |
| Assign to a person or team; auto-assign to whoever replies first; status open, pending, closed | Built |
| Internal notes that the customer never sees; "someone is typing" between staff | Built |
| Labels, quick replies, approved templates with fill-in fields | Built |
| Live updates without refreshing; unread counts; phone notifications | Built |
| Instagram direct messages, story replies and story mentions | Planned |
| Messenger messages for the Facebook Page | Planned |
| Comments on Facebook and Instagram posts: reply publicly, hide, or answer privately | Planned |
| Buttons, lists and in-chat forms (for example a delivery-address form or a complaint form) | Planned |
| Reply-time targets with a warning when a customer has waited too long | Planned |
| Snooze a conversation until a time; reminders and tasks ("call back Friday") | Planned |
| Collision warning when two staff open the same conversation | Planned |
| Saved views (for example "bulk enquiries waiting") | Planned |
| Website contact, bulk-order and white-label forms arriving as conversations | Planned |
| Rules: route by channel, number, hours, keyword or customer label; auto-label; auto-reply outside hours | Planned |
| Customer satisfaction question after a conversation closes | Planned |
| Typing indicator shown to the customer while staff or the assistant writes; mark as read | Planned (brief). Mark as read is built |
| Messenger and Instagram extras: quick replies, button and carousel messages, a persistent menu, a "Get started" button, ice-breaker questions | Planned (brief) |
| WhatsApp business profile edited from the suite: about, description, address, email, website, photo | Planned (brief) |
| Hand a conversation between the assistant, a person and another app without losing it | Planned (brief) |

## 2. Calls and virtual numbers

| Feature | Status |
|---|---|
| Answer and place calls in the browser; mute, hold, transfer to a team | Built (Twilio only; hold is silence, no music) |
| Phone menu ("press 1 for orders"), per-number opening hours and holidays, uploaded greetings | Built |
| Ring a whole team; voicemail when nobody answers or out of hours | Built |
| Recording with storage, playback and delete by Owner or Admin; kept until deleted | Built |
| Missed-call follow-up message on WhatsApp | Built |
| "Taking calls" switch per person; who is on a call now | Built |
| Calls ring the phone app when the browser is closed | Built, never run on a device |
| Nigerian local numbers through a Nigerian provider | Planned. Twilio's own pages conflict on whether it sells them |
| Customer-started WhatsApp calls answered in the same call bar | Planned. Needs Meta's 2,000-customer level |
| Spoken notice that the call is recorded | Planned |
| Call-back queue: missed callers listed for return calls, with attempts tracked | Planned |
| Queue with hold music and position; overflow to another team or to voicemail | Planned |
| Warm transfer (speak to the colleague first), three-way call, supervisor listen-in | Planned |
| Click to call from any customer, order or conversation | Planned |
| Staff calling a customer on WhatsApp | **Blocked** for Nigerian business numbers |
| Two-way SMS | **Blocked** on Twilio in Nigeria; one-way with a registered sender name is possible |

## 3. Call tracking

| Feature | Status |
|---|---|
| A separate number for each advert or place (Instagram bio, flyer, Google, radio, delivery bag) | Planned |
| Every call shows its source, and so does the customer record | Planned |
| Per source: calls, missed calls, answer time, first-time callers, orders that followed, revenue | Planned |
| Messages tracked the same way: which advert, post or QR code started the chat | Planned |
| QR codes and links that open WhatsApp with the source already recorded | Planned |
| Missed-call rate by hour and day, to plan staffing | Built in part (missed calls by day) |
| Purchases reported back to Meta so adverts can be measured and tuned | Planned. Needs a higher Meta access level |

## 4. Contacts

| Feature | Status |
|---|---|
| One record shared with the shop: name, phone, notes, labels | Built |
| Merge duplicates; erase a customer's messages and calls on request (Owner only) | Built |
| Export contacts | Built |
| Identities on every channel on one record (WhatsApp, Instagram, Messenger, phone), including customers whose number Meta hides | Planned |
| Orders, delivery status, spend, favourite products and returns on the contact | Planned |
| Chats, calls and voicemails on the shop's customer page | Planned |
| Consent per channel and purpose (service, marketing, calls), with date and how it was given | Planned |
| Opt-out handled automatically on "STOP" and honoured on every channel | Planned |
| Groups: built from rules ("ordered in the last 60 days", "bulk buyer", "complained this month") | Planned |
| Business accounts: several contacts under one company for bulk and white-label buyers | Planned |
| Import contacts from a file, with consent recorded | Planned |

## 5. Catalogue and selling

| Feature | Status |
|---|---|
| Products, prices, photos and in/out of stock sent to Meta when they change in the shop | Planned |
| Sync status per product, with the reason when Meta rejects one | Planned |
| Send one product or a set of products in a chat | Planned |
| The customer's WhatsApp cart arrives as an order in the shop with a payment link | Planned. Needs the payment fixes merged |
| Start an order for the customer from the conversation, with stock shown | Planned |
| Automatic WhatsApp updates: order confirmed, paid, out for delivery, delivered, preorder ready | Planned |
| Quotes and invoices for bulk orders, sent in the chat | Planned |
| Payment links in the chat through the shop's payment provider, with the order marked paid when the payment lands | Planned (brief). The shop uses OPay today; the brief names Paystack and Flutterwave. Built behind one interface so a provider can be added |
| Automatic receipt after payment | Planned (brief) |
| Abandoned-cart reminder while the free reply window is open | Planned (brief) |
| Catalogue kept in step from a spreadsheet or another store as well as the shop | Planned (brief), only if a second source is needed |
| A catalogue for adverts that hides sold-out juices automatically | Planned |
| Paying inside WhatsApp | **Blocked** in Nigeria |
| Facebook and Instagram Shops with Meta checkout, and product tags on posts | **Blocked** or not confirmed for Nigeria |

## 6. Assistant (AI)

| Feature | Status |
|---|---|
| Summaries of call recordings | Built in part: the summary step exists, but there is no transcription provider yet |
| Every call transcribed, in English and Nigerian usage as far as the provider allows | Planned |
| Each call tagged: reason (order, delivery, complaint, bulk enquiry), outcome (order placed, follow-up needed, unresolved), anything promised | Planned |
| Suggested replies drafted from quick replies, the product list, stock, order status and delivery rules; staff approve or edit | Planned |
| Conversation summary for hand-overs and for long threads | Planned |
| Automatic labels and routing from what the customer wrote | Planned |
| Follow-up tasks created from missed, unresolved or promised-a-call-back conversations | Planned |
| Translation of incoming messages (for example Pidgin or Yoruba to English) for staff | Planned |
| Tone and spelling check before sending | Planned |
| Optional auto-answer outside hours for simple questions, always with "talk to a person" | Planned. Owner decision; off by default |
| Weekly digest for the owner: top reasons for contact, complaints by topic, what customers ask for that is not on the menu | Planned |
| **AI agent that answers customers by itself, day and night,** using real data: it can search the knowledge base, look up a product, build a cart, create a payment link, check an order, take a booking, record a lead, and hand over to a person | Planned (brief). Owner decision; off until switched on, per channel and per hours |
| Knowledge base: FAQs, price lists, delivery rules and policies the assistant answers from, edited in the suite | Planned (brief) |
| Memory per customer: what they ordered, asked and were promised | Planned (brief) |
| Hands over to a person when it is unsure, when the customer is upset, or when they ask for a human | Planned (brief) |
| Answers in English, Pidgin, Yoruba, Hausa, Igbo and French | Planned (brief). Quality in each language must be tested before it is switched on |
| Assistant controls: editable instructions, a test area to try questions before going live, review of every transcript, thumbs up or down to improve answers | Planned (brief) |
| Share of conversations handled by the assistant alone, by a person, or handed over | Planned (brief) |
| Never gives medical, legal or financial advice; personal details hidden in logs | Planned (brief) |
| Quality review: calls and chats that need a manager's look | Planned |
| Guardrails: no chat content used to train any model; no card details in chat; every AI action logged | Planned. Required by Meta's terms |
| A general-purpose chatbot on WhatsApp | **Blocked** by Meta's terms; AI for the business's own customer service is allowed |

## 7. Broadcasts and marketing

| Feature | Status |
|---|---|
| Send an approved template to a chosen group, now or scheduled | Planned |
| Meta's daily limits and quality rating respected automatically; sends spread out safely | Planned |
| Results: sent, delivered, read, replied, opted out, orders and revenue that followed | Planned |
| Template manager: write, submit for Meta's approval, see status and quality | Built in part (sync and use); writing and submitting is Planned |
| Adverts that open a WhatsApp, Instagram or Messenger chat tracked through to the order | Planned |
| Customer lists shared with Meta for adverts, with consent | Planned |
| Lead forms from Meta adverts arriving in the inbox | Planned, unconfirmed |
| Double opt-in and a consent log; "STOP" honoured at once | Planned (brief) |
| A/B tests of two versions of a message | Planned (brief) |
| Sequences: welcome series, win-back, after-purchase follow-up | Planned (brief) |
| Cost estimate before sending, by country and message type | Planned (brief) |
| Quality-rating watch that pauses sends before Meta restricts the number | Planned (brief) |
| **Adverts created in the suite:** click-to-WhatsApp, Messenger and Instagram ads with picture or video, audience, budget and a pre-filled first message | Planned (brief). Needs Meta's highest ads access. Every ad confirmed by a person, with a daily cap only the owner can raise |
| Daily spend, cost per conversation and cost per sale, by advert | Planned (brief) |
| Rules such as "pause this ad if a sale costs more than ₦X" | Planned (brief) |
| Lookalike audiences built from customer groups | Planned (brief) |

## 8. Reports

| Feature | Status |
|---|---|
| Messages in and out, new conversations, replies, first-reply time, by day, number and staff member | Built |
| Calls in, missed, answered, by day and number | Built |
| Message costs against the 1,000 free replies per number each month, with a warning | Planned |
| WhatsApp number health: quality rating, messaging limit, template status | Planned |
| Sources: which advert, post or number brought calls, chats and orders | Planned |
| Sales that came from conversations and calls | Planned |
| Reasons for contact and outcomes, from the AI tags | Planned |
| Team view: load per person, reply times, open conversations | Built in part |
| One owner dashboard combining shop sales with service and marketing | Planned |
| The full path: advert click, conversation, lead, order, paid | Planned (brief) |
| Resolution time; template results and opt-out rate | Planned (brief) |
| Daily summary sent to the owner on WhatsApp | Planned (brief) |
| Export to a spreadsheet; scheduled email of the weekly summary | Built in part (contacts export) |

## 9. Settings and control

| Feature | Status |
|---|---|
| Numbers and channels: connect, check status, register | Built for WhatsApp and Twilio |
| Teams, members, who may use which number | Built |
| Hours, holidays, phone menus, greetings | Built |
| Permissions per role and per person: view, reply, assign, close, export, listen, delete, erase, settings, reports | Built |
| Audit log of who did what, in plain sentences | Built |
| Connect Instagram and the Facebook Page; connect a Nigerian phone provider | Planned |
| Automation rules and auto-replies | Planned |
| AI settings: what it may answer, tone, what it must hand to a person | Planned |
| Recording policy and spoken notice; data deletion requests from Meta | Planned |
| Privacy policy and data-deletion page (Meta's review requires both) | Planned. The storefront has neither today |
| A view-only role | Planned (brief) |
| How long messages, recordings and transcripts are kept, set per type | Planned (brief). Recordings are kept until deleted, by the owner's choice |
| A permanent Meta access token held as a server setting, with the least access it needs | Planned (brief). Needed before go-live; the test token expires |
| Keep the existing WhatsApp Business phone app on the same number ("coexistence") | Planned (brief). Unconfirmed for Nigerian numbers; calls do not work on a coexistence number |
| Replay a webhook that failed, from a list of recent ones | Planned (brief). Failed ones are already kept and retried |
| Several businesses in one suite, each with its own numbers, staff and data | **Decision needed.** See the plan |

## 10. Phone app

| Feature | Status |
|---|---|
| Inbox, replies, notes, calls and notifications on iPhone and Android | Built, never run on a device |
| Transfer, hold, merge and the newer inbox features | Planned |
| Everything else in this document on the phone | Planned, after the web app |

## 11. Social (Instagram and Facebook)

| Feature | Status |
|---|---|
| Comment-to-message: a keyword in a comment sends the customer a private reply and moves them to WhatsApp | Planned (brief) |
| Auto-reply to common comments; hide spam automatically | Planned (brief) |
| Thank-you message when a customer mentions the business in a story | Planned (brief) |
| Schedule and publish Instagram posts, reels and carousels from the suite | Planned (brief) |
| AI help writing captions | Planned (brief) |
| Mood of comments on the business's own posts | Planned (brief) |
| Account and post statistics | Planned (brief) |

## 12. Forms and bookings (WhatsApp Flows)

| Feature | Status |
|---|---|
| In-chat forms: delivery address, preorder, bulk-order enquiry, complaint | Planned |
| Booking with live availability, for example a delivery slot or a pickup time; reminders and rescheduling | Planned (brief) |
| Surveys and satisfaction scores; feedback forms | Planned (brief) |
| Lead and sign-up forms; simple identity checks | Planned (brief) |

## 13. Notifications and connections

| Feature | Status |
|---|---|
| One-time codes by WhatsApp (copy-code and one-tap) for sign-in or order confirmation | Planned (brief) |
| Order, delivery, payment and appointment alerts | Planned |
| A private address other systems can call to send a message (for example the till or the wholesale site) | Planned (brief) |
| Outgoing notices to other tools when something happens (new lead, new order, missed call) | Planned (brief) |
| Connections: Google Sheets, a CRM such as HubSpot or Zoho, Zapier or Make, Slack and email alerts | Planned (brief), each built only when asked for |

## Limits to plan around

- WhatsApp replies are free for the first 1,000 a month per number, then charged. Without a payment method on the WhatsApp account, replies stop.
- A business may only message a customer first with an approved template, and how many new customers it can reach per day grows with verification and good quality.
- Instagram and Messenger allow replies for 24 hours after the customer's last message, or 7 days for a human answer.
- Marketing messages on WhatsApp move to a new Meta route by October 2027; the suite will use it from the start.
- Each Meta channel needs Meta's approval of the app, which needs a working demo and a public privacy policy.

# The business suite: what it contains and what it is for

Draft for the owner's approval, 17 Nov 2026, by Olu with Claude. It lists every feature proposed for the suite, section by section. The build order is in `2026-11-17-suite-app-plan.md`; what Meta allows in Nigeria, with sources, is in `2026-11-17-business-suite-scope.md`.

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
| Creating and editing ad campaigns | Not planned. Meta's Ads Manager does this |

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

## 10. Phone app

| Feature | Status |
|---|---|
| Inbox, replies, notes, calls and notifications on iPhone and Android | Built, never run on a device |
| Transfer, hold, merge and the newer inbox features | Planned |
| Everything else in this document on the phone | Planned, after the web app |

## Limits to plan around

- WhatsApp replies are free for the first 1,000 a month per number, then charged. Without a payment method on the WhatsApp account, replies stop.
- A business may only message a customer first with an approved template, and how many new customers it can reach per day grows with verification and good quality.
- Instagram and Messenger allow replies for 24 hours after the customer's last message, or 7 days for a human answer.
- Marketing messages on WhatsApp move to a new Meta route by October 2027; the suite will use it from the start.
- Each Meta channel needs Meta's approval of the app, which needs a working demo and a public privacy policy.

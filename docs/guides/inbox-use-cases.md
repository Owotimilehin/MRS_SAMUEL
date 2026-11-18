# Part 3: Use cases

What the business can use the Inbox for, area by area. Each line says how it works and what needs to be in place.

**Status key**

| Mark | Meaning |
|---|---|
| **Now** | Works today with nothing extra |
| **Now + template** | Works today once the named template is approved by WhatsApp |
| **Phone line** | Built; starts when the business phone line is connected |
| **Coming** | Planned, not available yet |

A reminder that shapes many of these: staff can reply freely for 24 hours after a customer's last message. To reach a customer after that, or to message first, an approved template is needed.

## The ten to start with

If the team does only these ten well, the Inbox has paid for itself.

| # | Use case | Why it matters most |
|---|---|---|
| 1 | Answer every new enquiry within 10 minutes | Speed is what turns a WhatsApp question into an order |
| 2 | Take orders on WhatsApp and enter them at the till as a WhatsApp sale | Many customers prefer to order by chat |
| 3 | "Where is my order?" answered with the rider's name and number | The most common question after payment |
| 4 | Payment proof received and confirmed in the chat | Removes the biggest cause of anxious follow-ups |
| 5 | Sold out → offer a preorder or an alternative | Saves a sale that would otherwise be lost |
| 6 | Complaints handled in one thread with photos and a note of the outcome | Keeps customers, and shows the owner what goes wrong |
| 7 | Bulk and event enquiries labelled and followed up next day | The largest orders the business gets |
| 8 | Customer notes kept up to date | Regulars feel known; staff stop asking the same questions |
| 9 | Hand-overs with an internal note | No customer repeats themselves when shifts change |
| 10 | Monday review of the reports and the complaint label | Turns conversations into decisions |

## A. Before the order: turning questions into sales

| Use case | How it works in the Inbox | Set up needed | Status |
|---|---|---|---|
| **Menu and price enquiry** | Customer asks what you sell. Staff send the "Menu and prices" quick reply and ask what they have in mind. | Quick reply | Now |
| **Flavour recommendation** | Customer says "something not too sweet" or "for my kids". Staff suggest two flavours and note the preference on the contact. | Staff know the range; notes habit | Now |
| **Ingredient and health questions** | "Is there added sugar?", "What is in Pure Green?" Staff answer from the product list. Health advice is never given; ingredients only. | Quick replies for the common ones | Now |
| **Is it in stock today?** | Staff check the branch stock screen and answer. | Access to branch stock | Now |
| **First-time customer** | Greet, ask what they are looking for, explain delivery and how to order, save their name on the contact. | "Greeting" and "How to order" quick replies | Now |
| **Order taken in the chat** | Customer lists what they want. Staff confirm items, size, address and time, then enter the sale at the till choosing WhatsApp as the source. | Till access for the person answering, or a hand-over note to the branch | Now |
| **Preorder for a later date** | For 330ml bottles, specials or large quantities. Staff agree the date, enter the preorder, and label the chat `preorder`. | `preorder` label | Now |
| **Order for pickup** | Customer wants to collect. Staff confirm the time, and message when it is ready. | "Ready for pickup" quick reply | Now |
| **Gift box and bundles** | Bundles are ordered through WhatsApp. Staff take the recipient's name, address, date and any message for the card. | Quick reply describing each bundle with its price | Now |
| **Sold out** | Never end on "not available". Offer a preorder date or a similar flavour. | "Out of stock" quick reply | Now |
| **Delivery fee and time before ordering** | Customer sends an address. Staff give the fee for that area and the likely time. | Zone fees to hand | Now |
| **Delivery outside the usual areas** | Staff note the address, check with the owner, and reply with a quote. Chat set to **Pending** meanwhile. | Agreed process for out-of-area quotes | Now |
| **Customer went quiet before paying** | Within 24 hours: a friendly nudge. After 24 hours: the payment reminder template. | `payment_reminder` template | Now + template |
| **Sending the menu as a picture or PDF** | Staff attach the current menu image or price list. | An up-to-date menu file | Now |
| **Products and prices shown as a catalogue inside WhatsApp** | Customer browses and adds to a cart in the chat. | Catalogue sync | Coming |

## B. Orders and payments

| Use case | How it works in the Inbox | Set up needed | Status |
|---|---|---|---|
| **Order confirmation** | After an order is placed, the customer gets a confirmation with the order number. Inside 24 hours staff send it as a reply; otherwise as a template. | `order_confirmed` template | Now + template |
| **Proof of payment by transfer** | Customer sends a screenshot. Staff check the payment has actually arrived before confirming, then reply "Payment received". The photo stays in the thread as a record. | "Payment received" quick reply; a rule that a screenshot alone is never proof | Now |
| **Payment failed or charged twice** | Staff take the order number, label the chat `payment`, check the order's payment status, and escalate to the owner if money moved. | `payment` label | Now |
| **Paid after the order was cancelled** | When the owner gets a "paid after cancel" alert, staff contact the customer the same day to either fulfil the order or arrange a refund. | Owner passes the alert to customer care | Now + template if over 24 hours |
| **Change to an order** | Customer wants to add a bottle or change a flavour. Staff confirm whether it is still possible and update the order. | Knowing the cut-off for changes | Now |
| **Change of address** | Staff update the delivery details and tell the rider. | None | Now |
| **Cancellation request** | Staff confirm, cancel in the shop system, and explain the refund. | Refund rule known to staff | Now |
| **Refund status** | Staff check and tell the customer when to expect it. Refunds above ₦5,000 need the owner's approval, so set **Pending** and note it. | Owner approval process | Now |
| **Store credit** | When a customer is given credit instead of a refund, staff tell them the balance and note it on the contact. | Staff can see the customer's credit | Now |
| **Receipt on request** | Staff send the receipt as a photo or document. | None | Now |
| **Payment link sent in the chat** | Customer taps a link and pays. | Selling from chat | Coming |
| **Automatic "order confirmed" and "paid" messages** | Sent by the system without staff. | Order updates | Coming |

## C. Delivery

| Use case | How it works in the Inbox | Set up needed | Status |
|---|---|---|---|
| **"Where is my order?"** | Staff open the order, and reply with the status, the rider's name and phone number, and the tracking link if there is one. | Staff can open orders; `delivery` label | Now |
| **Order out for delivery** | Staff tell the customer the rider is on the way. | "Order on the way" quick reply; `order_out_for_delivery` template | Now + template |
| **Rider cannot find the address** | Staff message or call the customer for a landmark and pass it to the rider. The landmark is then saved in the customer's notes for next time. | Notes habit | Now |
| **Customer not available** | Staff agree a new time or a safe place, and note it. | None | Now |
| **Running late** | Tell the customer before they ask. A late delivery with a warning is forgiven; one without is a complaint. | A habit of proactive messages | Now |
| **No rider available, or delivery failed** | When the owner gets a delivery alert, customer care contacts the customer with a new time. | Owner passes delivery alerts to customer care | Now |
| **Delivery photo** | Rider's proof-of-delivery photo is forwarded into the chat when a customer says nothing arrived. | Riders send photos to staff | Now |
| **Scheduled deliveries for regulars** | "Every Friday morning for the office." Staff note the standing order on the contact and confirm each week. | Notes; a weekly reminder outside the system for now | Now |
| **Automatic delivery updates** | Out for delivery and delivered, sent by the system. | Order updates | Coming |

## D. After the sale: care, complaints and returns

| Use case | How it works in the Inbox | Set up needed | Status |
|---|---|---|---|
| **Storage and shelf-life questions** | "How long does it last?" "Can I freeze it?" | "Storage" quick reply | Now |
| **Something is wrong with the order** | Staff apologise first, ask for the order number and a photo, label `complaint`, and resolve in the same thread. | "Complaint first reply" quick reply; `complaint` label | Now |
| **Wrong or missing item** | Staff check the order, then arrange a replacement or refund, and note the outcome. | Authority to replace up to an agreed value | Now |
| **Damaged or leaking bottle** | Photo in the chat is the evidence. Replacement or refund as above. | Same | Now |
| **Return or refund request** | The business accepts reports within 24 hours of delivery. Staff check the time, record the return, and tell the customer what happens next. | Returns rule known to staff | Now |
| **Taste or quality feedback** | Thank the customer, label `feedback`, and pass serious points to production with an internal note. | `feedback` label | Now |
| **Escalation to the owner** | Internal note with the facts, assign to the owner or the team lead, and tell the customer when they will hear back. | Named escalation person | Now |
| **Asking for feedback after delivery** | A short message the next day. Inside 24 hours as a reply, otherwise a template. | `feedback_request` template | Now + template |
| **Turning a complaint into loyalty** | After the fix, a follow-up a few days later: "Was the replacement all right?" Note the complaint and outcome on the contact. | Follow-up habit; `follow_up` template | Now + template |
| **Customer asks for their data to be deleted** | Staff tell the owner. The owner deletes the customer's messages and call records from the contact panel. | Owner only | Now |

## E. Business customers: bulk, events and white label

| Use case | How it works in the Inbox | Set up needed | Status |
|---|---|---|---|
| **Event or party order** | Staff ask five things: date, number of guests or bottles, flavours, delivery address, budget. Label `bulk`, quote, and follow up next day. | "Bulk orders" quick reply; `bulk` label; a price guide for quantities | Now |
| **Office or corporate orders** | Weekly or monthly supply. Staff record the contact person, the company, and the standing order in the notes. | Notes habit | Now |
| **Resellers and shops** | Enquiries about stocking the juice. Staff qualify (where, how many, how often) and pass to the owner. | Agreed wholesale terms | Now |
| **White-label enquiries** | A business wants juice under its own brand. Staff collect the details and assign to the owner. | A short list of qualifying questions | Now |
| **Quote sent as a document** | Staff attach the quote as a PDF. It stays in the thread. | A quote format | Now |
| **Following up a quiet enquiry** | Filter by `bulk`, find chats with no reply, and send a follow-up. | `follow_up` template | Now + template |
| **Several contacts at one company** | Each person is a separate contact. Note the company name on each so they can be found by search. | Naming rule: "Ada (Zenith Office)" | Now |
| **Website enquiry forms arriving in the Inbox** | Bulk and white-label forms land as conversations with an owner. | Enquiries in the inbox | Coming |
| **A pipeline: new, quoted, won, lost** | See every business enquiry by stage. | Pipeline | Coming |

## F. Keeping customers and bringing them back

Marketing messages may only go to customers who have agreed to receive them. Start a record of who has agreed now, in the contact notes, so the business is ready.

| Use case | How it works in the Inbox | Set up needed | Status |
|---|---|---|---|
| **Remembering regulars** | Notes hold favourite flavours and usual order. Staff greet by name and suggest "the usual". | Notes; `vip` label | Now |
| **Asking permission to send offers** | At the end of a good conversation: "May we message you when we have a new flavour?" Record yes or no in the notes. | A fixed line in the notes, such as "Offers: yes, 18 Nov" | Now |
| **Telling a regular about a flavour they asked for** | One customer, one message, because they asked. | A marketing template, and their agreement | Now + template |
| **Weekly specials** | Specials are limited. Customers who agreed are told when they are available. | Marketing template; agreement record | Now + template, one by one |
| **Festive and gift seasons** | Christmas, Valentine's, Mother's Day gift boxes offered to customers who agreed. | Marketing template; bundle details | Now + template, one by one |
| **Win-back** | A customer who has not ordered for a while gets a personal check-in. | Marketing template; agreement | Now + template |
| **Referrals** | Thank a customer who sends a friend; note who referred whom. | Notes habit | Now |
| **Reviews** | After good feedback, ask for a review or permission to share their words. | A quick reply with the review link | Now |
| **From Instagram to WhatsApp** | A "Message us on WhatsApp" link in the Instagram bio and posts brings followers into the Inbox. | A WhatsApp link for the business number | Now |
| **QR code on bottles and bags** | Scanning opens a WhatsApp chat with the business. | Printed QR code for the WhatsApp link | Now |
| **One message to many customers, with results** | Broadcasts to chosen groups, measured through to sales. | Broadcasts | Coming |
| **Instagram and Facebook messages and comments in the Inbox** | One place for every channel. | More channels | Coming |

## G. Inside the business

| Use case | How it works in the Inbox | Set up needed | Status |
|---|---|---|---|
| **Customer care and the branch working together** | Customer care takes the order in the chat and leaves an internal note for the branch, or assigns the chat to the branch team. | A branch team in the Inbox | Now |
| **Shift hand-over** | At close, every open chat is closed or carries a note saying what happens next. | Closing routine | Now |
| **Covering breaks and days off** | A chat is reassigned with one click. Nothing is trapped on someone's phone. | None | Now |
| **Training new staff** | New staff read closed conversations to learn tone and answers, then reply under supervision. | Read access | Now |
| **Checking quality** | The manager reads a sample of each person's chats weekly. | Manager access to the team's chats | Now |
| **Stock-out notice to the team** | When a flavour runs out, the team lead tells customer care so answers are consistent. | A team habit; later, stock shown in the chat | Now |
| **Feeding product decisions** | Requests for flavours or sizes the business does not sell are labelled `feedback` and reviewed monthly. | `feedback` label | Now |
| **Settling disputes** | The full thread, with photos, times and read ticks, shows what was said and when. | None | Now |
| **A second number for wholesale** | A separate number with its own team and hours, in the same Inbox. | A second WhatsApp number | Now |
| **Audit** | The audit log shows who changed, assigned, exported or deleted what. | Owner access | Now |

## H. Running and measuring the business

| Use case | How it works in the Inbox | Set up needed | Status |
|---|---|---|---|
| **How busy are we, and when?** | Messages per day show the peaks. Staff the busy days. | Weekly review | Now |
| **Are customers being answered?** | "Got a reply" should be 100%. Anything less is lost sales. | Weekly review | Now |
| **How fast are we?** | Typical first reply against the target. | A target | Now |
| **Who is carrying the load?** | Replies by staff member. | Weekly review | Now |
| **What do customers complain about?** | Filter by `complaint` and read them. Count by cause: late, wrong item, taste, damage. | Consistent labelling | Now |
| **What do customers ask for most?** | Count chats by label each week. Turn the top questions into quick replies and website answers. | Consistent labelling | Now |
| **Is the number healthy?** | Status and quality rating checked each morning. | Morning routine | Now |
| **Customer list for the owner** | Export contacts to a spreadsheet. | Owner or admin | Now |
| **Which advert or post brought the customer?** | Source recorded on every conversation and order. | Ad tracking | Coming |
| **Sales that came from conversations** | Orders linked to the chats that produced them. | Orders in chat | Coming |

## I. The phone line

All of these are built and begin when the business phone line is connected.

| Use case | How it works | Status |
|---|---|---|
| **Customers who prefer to call** | Calls ring in the browser for staff who have "Take calls" switched on. | Phone line |
| **Order taken by phone** | Staff take the order during the call; it is entered at the till as usual. The call appears in the customer's conversation. | Phone line |
| **"Press 1 for orders, 2 for deliveries"** | A phone menu sends callers to the right team. | Phone line |
| **Missed calls** | The caller automatically gets a WhatsApp message saying the business will call back, and the missed call shows in the Inbox. | Phone line |
| **Calls out of hours** | The caller hears the after-hours message and can leave a voicemail, which appears in the Inbox. | Phone line |
| **Calling a customer back** | One click from their conversation. | Phone line |
| **Passing a caller to a colleague** | Transfer to another team during the call. | Phone line |
| **Recording for disputes and training** | Recordings are kept with the conversation until the owner deletes them. | Phone line |
| **Missed-call rate** | The reports show calls answered, missed and out of hours by day. | Phone line |

## J. What the next stages unlock

So the business can plan campaigns and staffing around them.

| Stage | New use cases |
|---|---|
| **Orders inside the chat** | Answer "where is my order?" without leaving the conversation; see what a customer usually buys while talking to them |
| **Selling from the chat** | Send products from a catalogue; the customer's cart becomes an order with a payment link; automatic order and delivery updates |
| **Every channel** | Instagram and Facebook messages, story replies and comments answered in the same Inbox; a keyword in a comment starts a private chat |
| **Follow-up tools** | Reminders, tasks and reply-time warnings; website enquiries arriving with an owner; a pipeline for bulk orders |
| **Broadcasts** | New flavours, specials and festive offers to customers who agreed, with opt-out and results |
| **Phone line with tracking** | A different number on each advert, so the business knows which one made the phone ring |
| **AI help** | Suggested replies, call summaries with reason and outcome, automatic labels, an out-of-hours assistant, a weekly digest for the owner |

## Using this catalogue

1. Pick the ten at the top and make sure each has its quick reply, label or template in place.
2. Walk the team through one area a week, starting with A and C.
3. Each month, pick two more use cases to do well.
4. When a customer situation comes up that is not on this list, add it.

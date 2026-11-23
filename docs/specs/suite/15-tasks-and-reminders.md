# Suite build spec 15: Tasks and reminders

Size M. Suggested model: Opus (it touches the conversation list every staff member uses, and the visibility rule). Read `00-foundation.md` first; it wins where the two disagree. Blueprint stage 6 (`docs/handoffs/2026-11-19-suite-blueprint.md`).

No Meta call is made anywhere in this spec. Nothing is sent to a customer.

---

## 1. Outcome

A staff member can say:

- "From an open chat I press **Snooze** and pick *Later today (17:00)*, *Tomorrow (09:00)*, *Next Monday (09:00)* or a date and time. The chat leaves my open lists. At that time it comes back to the top, marked *Back from snooze*. If the customer writes before then, it comes back straight away."
- "On a chat or on a contact I add a **reminder**: a note ('call back about the party order') and a due time. It is mine unless I give it to someone else. When it falls due my suite tells me (sound, pop-up or banner, and a push on the phone app), the **Tasks** menu item shows a count, and the Tasks page lists it under *Due*. I mark it done or move it to another time."
- "The owner can set a **reply-time target** ('reply within 15 minutes during opening hours'). Chats waiting longer show *Waiting 42 min* in amber, and in red once they are twice the target. The Overview's *Today at a glance* says how many chats are over the target."

## 2. Depends on

| Needs | Why |
|---|---|
| `work/olu/suite-redesign` (ba8f815) | Suite menu, Overview, Calls, chocolate-orange look |
| Nothing at Meta | No Meta call |

## 3. Meta reference

None.

## 4. Data

Migration `packages/db/migrations/0087_tasks_reminders.sql` (0086 is reserved by another branch). Additive only.

```sql
-- Undo: DROP TABLE "inbox_reminder";
--       DROP INDEX "idx_inbox_conv_snoozed";
--       ALTER TABLE "inbox_conversation" DROP COLUMN "snoozed_until", DROP COLUMN "snoozed_by", DROP COLUMN "woke_at";
ALTER TABLE "inbox_conversation" ADD COLUMN IF NOT EXISTS "snoozed_until" timestamptz;
ALTER TABLE "inbox_conversation" ADD COLUMN IF NOT EXISTS "snoozed_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL;
ALTER TABLE "inbox_conversation" ADD COLUMN IF NOT EXISTS "woke_at" timestamptz;
CREATE INDEX IF NOT EXISTS "idx_inbox_conv_snoozed" ON "inbox_conversation" ("snoozed_until") WHERE "snoozed_until" IS NOT NULL;
CREATE TABLE IF NOT EXISTS "inbox_reminder" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "conversation_id" uuid REFERENCES "inbox_conversation"("id") ON DELETE CASCADE,
  "note" text NOT NULL,
  "due_at" timestamptz NOT NULL,
  "assignee_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "created_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "notified_at" timestamptz,
  "done_at" timestamptz,
  "done_by" uuid REFERENCES "admin_user"("id") ON DELETE SET NULL
);
-- indexes: open reminders per assignee by due time; due-and-not-yet-alerted; per conversation; per customer
```

- `snoozed_until` null = not snoozed. A value in the past means "due to wake"; lists treat it as awake even before the worker clears it.
- `woke_at` is set when a snooze ends by time; it makes the row look unread until someone opens the chat (`POST /read` clears it).
- A reminder always has a `customer_id`; `conversation_id` is set when it was added from a chat. A contact-only reminder has `conversation_id` null.
- Journal: `idx` 84, `when` 1787800000000, tag `0087_tasks_reminders` (after `0086_broadcasts` at idx 83). Ruling 9.2.1 applies: whoever merges sets `when` later than every entry on `master`.
- Drizzle: three columns on `inboxConversation`, new `inboxReminder` in `packages/db/src/schema/inbox.ts`.
- Reply-time target: no column. Stored in `app_settings` under key `inbox_reply_target` as `{ "minutes": number | null }`. Missing row = off.

## 5. Server

### 5.1 Shared rules (`packages/shared/src/inbox.ts`, tested)

- `businessMinutesBetween(from, to, rules, holidays, timeZone)`: minutes of `[from, to)` that fall inside opening windows, skipping holiday dates. Same reading of the hours tables as `isOpenNow` (no overnight windows). No schedule on the line = every minute counts.
- `replyFlag(waitingMinutes, targetMinutes)`: `null` under the target or when off; `{ tone: "warning" }` at or over it; `{ tone: "danger" }` at twice it. Text `Waiting 42 min` / `Waiting 1 h 5 min`.
- `REPLY_TARGET_KEY = "inbox_reply_target"`, limits 5 to 1440 minutes.

### 5.2 Domain (`packages/domain/src/inbox/core.ts`)

- `touchConversation`: when the customer wrote (`inboundWa`) or the activity counts as unread (`unreadIncrement`), clear `snoozed_until` and `snoozed_by` in the same update ("a customer message always wakes it").
- `wakeSnoozedConversations(db, now)`: one `UPDATE … WHERE snoozed_until <= now RETURNING`, setting `snoozed_until = null`, `woke_at = now`, `last_activity_at = greatest(last_activity_at, now)` (so it sorts to the top) and publishing `conversation.updated` for each.
- `waitingSinceSql`: SQL for "the customer's oldest message after our last reply". A reply is an outgoing message sent by a staff member (`sender_user_id` set) or one written in Meta's own app (`payload ? 'echo'`). Automatic replies do not count. Reactions, system notices and advert referrals do not start the clock.

### 5.3 Routes

All under `/v1/inbox`, behind `withViewer` (needs `inbox.view`). The new routes live in `apps/api/src/routes/inbox-tasks.ts`, mounted at `/v1/inbox/tasks`; the list, detail, unread, read and PATCH changes are in `inbox.ts`.

| Route | Permission | What |
|---|---|---|
| `POST /tasks/snooze/:conversationId` `{ until: ISO }` | `inbox.reply`, chat visible | Only open or pending chats. `until` at least 1 minute ahead, at most 90 days. Audit `inbox.conversation_snooze` |
| `DELETE /tasks/snooze/:conversationId` | `inbox.reply`, chat visible | Wake now. Audit `inbox.conversation_unsnooze` |
| `GET /conversations` | as today | `status=open` leaves out snoozed chats; new `status=snoozed` lists them (soonest wake first). Each row gains `snoozed_until`, `woke_at`, `waiting_since`, `waiting_minutes`; the page gains `reply_target_minutes` |
| `GET /conversations/:id` | as today | Adds `snoozedUntil`, `snoozedBy`, `wokeAt` (the row's own fields) |
| `GET /unread` | as today | Leaves out snoozed chats |
| `PATCH /conversations/:id` with `status: closed` | as today | Also clears the snooze |
| `GET /tasks/reply-target` | `inbox.view` | `{ target_minutes, late, longest_minutes }` over open chats the viewer may see |
| `GET /tasks/reminders?view=due\|upcoming\|done\|everyone&conversation_id=&customer_id=` | `inbox.view` | See 5.4 |
| `GET /tasks/reminders/count` | `inbox.view` | `{ due }`: my open reminders that are due, for the badge |
| `POST /tasks/reminders` `{ note, due_at, assignee_id?, conversation_id? \| customer_id? }` | see 5.4 | Audit `inbox.reminder_add` |
| `PATCH /tasks/reminders/:id` `{ note?, due_at?, assignee_id?, done? }` | see 5.4 | Moving `due_at` clears `notified_at` so it alerts again. `done: false` reopens. Audit `inbox.reminder_update` |
| `DELETE /tasks/reminders/:id` | creator, or `inbox.assign` | Audit `inbox.reminder_delete` |

Settings, in `inbox-settings.ts`: `GET /settings/reply-target` and `PUT /settings/reply-target { minutes: number | null }`, both `inbox.settings`. Audit `inbox.reply_target_update`.

### 5.4 Who sees and changes a reminder (one rule, `packages/domain/src/inbox/reminders.ts`)

- **On a chat**: visible only to people who may see that chat (`canSeeConversation` / `conversationScope`). No second rule.
- **On a contact only**: visible to its assignee and its creator, and to anyone with `contacts.view`.
- **Adding**: on a chat, you must see the chat. On a contact, you need `contacts.view`.
- **Giving it to someone else** needs `inbox.assign`, and they must be able to see it (on a chat: `canSeeConversation` for them; on a contact: `inbox.view` and `contacts.view`). Otherwise 400 "That person can't see this chat".
- **Changing, marking done, rescheduling**: the assignee, the creator, or someone with `inbox.assign` who can see it.
- Every list and count is filtered with the same rule in SQL; a reminder you may not see answers 404.
- Erase and merge (ruling 9.2.8): erase deletes the contact's reminders; merge moves them to the kept contact, and reminders on a folded chat move to the kept chat.

## 6. Worker (`apps/worker/src/jobs/inbox-tasks.ts`, in `inbox-loop.ts`)

| Job | Every | What |
|---|---|---|
| `inbox_snooze_wake` | 30 s | `wakeSnoozedConversations` |
| `inbox_reminders_due` | 30 s | Reminders with `due_at <= now`, not done, `notified_at` null, at most 100. For each: if the assignee may still see it, publish `reminder.due` (delivered only to `userIds: [assignee]`) and send a push to the assignee's phones (unless their notification level is `none`). Always set `notified_at`, so one reminder alerts once. A reminder more than 12 hours overdue when first seen (worker was down) is marked without a push |

Both run under `withJobLock`. Neither calls Meta. The push uses the existing Expo sender in `inbox-push.ts`.

## 7. Screens

All wording plain English. Colours only from CSS variables. Segmented controls are `.ibx-tabs`; statuses are dotted `.pill--…`.

### 7.1 Conversation header (shared inbox, `ConversationHeader.tsx`)
- **Snooze** button (clock icon) for people with `inbox.reply` on an open or pending chat. Opens a small dialog: four choices (*Later today, 17:00* only while 17:00 is at least 30 minutes away; *Tomorrow, 09:00*; *Next Monday, 09:00*; *Pick a date and time*). The chosen time is spelt out ("Comes back Tue 25 Nov, 09:00"). Note under: "If the customer writes before then, the chat comes back straight away."
- When snoozed: a pill *Snoozed until Tue 09:00* and a **Wake now** button in place of Snooze.
- **Remind** button (bell-plus icon): reminder dialog (7.3), on this chat.
- The chat's open reminders show as a strip under the header: note, due time pill, *Done* button.

### 7.2 Conversation list (`ConversationList.tsx`)
- New tab **Snoozed** before *Closed*.
- A row back from snooze is bold like an unread row and shows *Back from snooze*.
- A row in the Snoozed tab shows *Until Tue 09:00*.
- Reply target: an open row waiting at or over the target shows a dotted pill *Waiting 42 min* (amber), red at twice the target.

### 7.3 Reminder dialog (shared, `ReminderDialog.tsx`)
- Note (required, up to 500 characters), "When" as the same presets plus *In 1 hour* and *Pick a date and time*, "For" (Me, or a staff member for people with `inbox.assign`). Save button "Save reminder". Used for add and for reschedule.

### 7.4 Tasks page (suite, `/tasks`, menu "Conversations" after Calls, needs `inbox.view`)
- Segmented control: *Due (n)*, *Coming up*, *Everyone's* (people with `inbox.assign` only), *Done*, *Snoozed chats*.
- Table card: customer (link to the chat, or to the contact), note, due (pill: red "Overdue 2 days", amber "Due 20 min ago", accent "Today 15:00", plain "Fri 28 Nov, 09:00"), for whom, actions (*Done*, *Move*, *Delete* for the creator).
- Empty states: "Nothing due. Reminders you add on a chat or a contact show here when they fall due."
- Badge on the menu item: my due count.

### 7.5 Reminders on a contact (suite `ContactPage.tsx`)
- A *Reminders* card: open reminders for this contact (on any of its chats the viewer can see, and contact-only ones), *Add reminder* button.

### 7.6 Inbox settings
- New section **Reply time**: a segmented control *Off / On*; when on, "Reply within [15] minutes during opening hours". Help: "Chats waiting longer show in amber, and in red at twice the time. Only time inside each line's opening hours counts; holidays are skipped. A line with no schedule counts every minute."

### 7.7 Overview
- *Today at a glance* gains "**3 chats** have waited longer than your 15-minute reply target. The longest has waited 1 h 10 min." when the target is on and any chat is late.

### 7.8 Alerts
- `useInboxNotifier` (shared) handles `reminder.due`: sound, banner when the tab is in front ("Reminder: call back about the party order"), desktop pop-up when it is not, and refreshes the Tasks badge. It always alerts, whatever the person's message-alert level, except `none`.

## 8. Rules and edge cases

1. Snooze presets are in Lagos time whatever the browser's zone.
2. *Later today* is the chat's line's closing time today (17:00 when the line has no hours set), offered only while it is at least 30 minutes away, and not at all once the line has closed or on a day it does not open (Q4).
3. *Next Monday* is the Monday after today; on a Monday it is seven days ahead.
4. A custom time in the past or under a minute ahead is refused (screen and server). More than 90 days ahead is refused.
5. A customer message (or a missed call or voicemail, which also count as unread) wakes a snoozed chat at once.
6. A snooze that ends by time moves the chat to the top and marks it *Back from snooze* until someone opens it.
7. Closing a chat clears its snooze. A closed chat cannot be snoozed.
8. Snoozed chats are not counted in the unread badge and are not flagged for the reply target.
9. Reply waiting time counts only from the customer's oldest message after our last reply, and only minutes inside the line's opening hours; holidays count nothing.
10. Automatic replies (after-hours, opt-out) do not stop the clock; a reply typed in Meta's own app does.
11. Pending chats (waiting for the customer) are not flagged.
12. A reminder alerts its assignee once. Moving its time lets it alert again.
13. A reminder on a chat the assignee can no longer see does not alert them; it stays on the list for people who can see it.
14. A reminder is never visible to someone who cannot see its chat.
15. Erasing a contact deletes their reminders; merging moves them.

## 9. Tests

| File | Tests |
|---|---|
| `packages/shared/src/inbox.test.ts` | business minutes: inside one window, across lunch gap, across a holiday, across a weekend, no schedule = wall minutes, to before from = 0; replyFlag: off, under, warning, danger, wording |
| `apps/admin/src/lib/inbox-logic.test.ts` | snooze presets in Lagos time (morning, after 16:30, late evening, on a Sunday, on a Monday, browser in another zone); `lagosInputToDate`; custom-time problems; reminder due tone and label; tabs include Snoozed |
| `packages/domain/src/inbox/reminders.test.ts` | visibility rule: chat in scope, chat out of scope, contact-only (assignee, creator, contacts.view, other); who may change |
| `apps/worker/src/jobs/inbox-tasks.test.ts` | which reminders get a push (pure picker): not done, not alerted, assignee can see, level none, too old |
| `apps/suite/src/nav.test.ts` | Tasks lit on `/tasks`, comes after Calls |
| `apps/api/test/integration/inbox-tasks.test.ts` (needs Docker) | snooze hides from open list and shows in snoozed; inbound message wakes; wake job; reminders CRUD and scope (404 outside scope); count; reply-target summary; erase deletes reminders |

## 10. Manual check

1. Open a chat, Snooze, *Pick a date and time* two minutes ahead. It leaves *Mine*. Within a minute after the time it is back at the top, bold, *Back from snooze*.
2. Snooze another until tomorrow; message it from the tester phone. It comes back at once, unread.
3. Add a reminder due in two minutes. When due: banner (or pop-up), Tasks badge shows 1, Due tab lists it. Mark done: the badge clears.
4. Settings, Reply time, On, 5 minutes. During opening hours, write from the tester phone and wait. After 5 minutes the row shows amber *Waiting 5 min*, red after 10. Overview says 1 chat over target.

## 11. Done when

- [ ] Migration 0087 and journal entry; Drizzle schema matches.
- [ ] Snooze, wake by time, wake by customer message.
- [ ] Reminders: add, list, count, alert once, done, reschedule, delete; scope respected.
- [ ] Reply target setting, list flag, Overview line.
- [ ] Tasks page in the menu after Calls; badge.
- [ ] Type-check and unit tests pass in every touched package; integration test written.

## 12. Out of scope

Recurring reminders, reminders by email or WhatsApp to staff, SLA reports over time, auto-assignment when a chat is late.

## 13. Work order

1. Migration, journal, Drizzle schema.
2. Shared rules and tests (business minutes, reply flag).
3. Domain: touchConversation wake, wake job function, reminder visibility rule and tests.
4. API routes, settings route, erase and merge.
5. Worker jobs and tests.
6. Admin shared screens: logic and tests, API client, header, list, dialog, settings, notifier.
7. Suite: Tasks page, menu, router, badge, contact card, Overview line.

## 14. Open questions

| # | Question | Answer |
|---|---|---|
| Q1 | Should a chat coming back from snooze make a sound? | **Yes** (owner, 22 Nov 2026). The worker sends `conversation.woke` with `conversation.updated` when the timer wakes a chat; `useInboxNotifier` plays the message sound (one per batch), shows "Back from snooze: {name}", or a desktop pop-up when the tab is away. Follows the person's alert level; never for the chat they are reading. No phone push |
| Q2 | Should staff see each other's reminders? | Only with `inbox.assign` (the *Everyone's* tab), and always within the chat-visibility rule |
| Q3 | Should the reply target differ per line or per channel? | **One target for the whole business for now** (owner, 22 Nov 2026) |
| Q4 | Should the "Later today" time follow each line's closing time? | **Yes** (owner, 22 Nov 2026). Conversation detail returns `number.closes_today_at` (`closingTimeToday` in `@ms/shared`): the end of today's last window for the chat's line. Label *Later today, 18:30 (closing)*. Null (already closed, holiday, not open today) hides the choice; a line with no hours set keeps 17:00 |

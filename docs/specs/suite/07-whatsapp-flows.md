# Suite build spec 07: WhatsApp Flows (in-chat forms and bookings)

Read `00-foundation.md` first. Size L. Suggested model: Opus. Permission: `templates.manage` (managing forms); `inbox.reply` (sending one in a chat). Migration: `0076_wa_flows.sql`.

Every Meta fact is tagged **[verified: URL, 19 Nov 2026]** or **[unverified]**. Before coding against an unverified fact, read the page.

On screen a Flow is always called a **form**. "Flow" appears only in code.

---

## 1. Outcome

**Phase A (four fixed forms, no server conversation with WhatsApp):**

- "In a chat I press **Send a form**, choose 'Delivery address', and the customer gets a message with a button. They tap it, fill in a short form inside WhatsApp, and press send."
- "Their answers arrive in the chat as a tidy card: each question with its answer. No more copying an address out of five messages."
- "From the card I can save the address to the customer's contact, or mark the form as handled. A complaint form flags the chat and tells the owner."
- "If the customer has been quiet for more than 24 hours, I send an approved template that has a form button instead."
- "Under **Templates and forms → Forms** I see our four forms (delivery address, bulk-order enquiry, complaint, pickup request), whether each is live at WhatsApp, and I can preview one, send a test to my own phone, publish it, or retire it."

**Phase B (a live delivery-slot picker):**

- "The customer opens 'Choose a delivery time', sees only the days and times we still have room for, and picks one. If someone else takes the last place while they are choosing, the form tells them and shows what is left."

## 2. Depends on

- **Spec 06 merged** (the `/templates` page and its tab bar, `templates.manage`, `packages/domain/src/meta/templates.ts`, the template editor), and with it `work/olu/inbox-gaps`. What that branch provides is listed in spec 06 section 2; the part that matters here: `templateNeeds()` marks a template with a `FLOW` button as **not sendable** ("opens a form"), and `buildTemplateComponents()` has no form-button part. Section 5.5a (task 13) changes both.
- **From spec 05:** `graphRaw()`, exported `graph()`, `META_APP_ID`.
- **Meta, to build and test:** nothing new. Draft forms can be created, previewed and sent in draft mode on the test account [unverified that draft sends work before business verification; see section 14, item 1].
- **Meta, to use with real customers:** the business must be **verified** and keep **high message quality** before a form can be published and sent. [verified: https://developers.facebook.com/docs/whatsapp/flows/gettingstarted and https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi, 19 Nov 2026] Verification is pending (blueprint section 8, item 3).
- **A person must do for Phase B (Tes, in his own terminal; section 5.9):** generate the key pair, put the private key in the server's `.env`, subscribe the `flows` webhook field, and confirm `https://api.mrssamuel.com/v1/webhooks/whatsapp-flows` is reachable.

## 3. Meta reference

### 3.1 What a Flow is

A Flow is a small multi-screen form that opens inside the WhatsApp chat. It is described by one JSON document ("Flow JSON") stored at Meta against the WhatsApp account. Two kinds:

| Kind | How it works | Used in |
|---|---|---|
| **Without an endpoint** (static) | Every screen is fixed in the JSON. WhatsApp shows the screens itself. When the customer finishes, the answers come to our normal message webhook. Our servers are not involved while the form is open | Phase A |
| **With a data endpoint** (dynamic) | WhatsApp calls our server, encrypted, when the form opens and when a screen is submitted; we answer with what to show next. Needs a key pair, an uploaded public key, `data_api_version` and `routing_model` in the JSON, and `endpoint_uri` on the Flow | Phase B |

[verified: https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson and https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint, 19 Nov 2026]

### 3.2 Flows API (on the WhatsApp account)

| Fact | Status |
|---|---|
| Create: `POST /{waba-id}/flows` with `name` (required), `categories` (required, at least one of `SIGN_UP`, `SIGN_IN`, `APPOINTMENT_BOOKING`, `LEAD_GENERATION`, `CONTACT_US`, `CUSTOMER_SUPPORT`, `SURVEY`, `OTHER`), optional `flow_json` (the JSON as a string), `publish` (boolean), `clone_flow_id`, `endpoint_uri`. New Flows start as `DRAFT`. Returns `{ id, success, validation_errors }` | [verified: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi, 19 Nov 2026] |
| Update details: `POST /{flow-id}` with `name`, `categories`, `endpoint_uri`, `application_id`. "Flows with endpoints need a connected app." Returns `{ success: true }` | [verified: same page, 19 Nov 2026] |
| Update the JSON: `POST /{flow-id}/assets` as multipart form-data: `file` (the JSON file, max 10 MB), `name=flow.json`, `asset_type=FLOW_JSON`. Returns `{ success, validation_errors }` | [verified: same page, 19 Nov 2026] |
| Each `validation_errors` item has `error`, `error_type`, `message`, line and column numbers, `pointers`. All must be fixed before publishing | [verified: same page, 19 Nov 2026] |
| Preview: `GET /{flow-id}?fields=preview.invalidate(false)` returns `preview.preview_url` and `preview.expires_at`. The link needs no login and lasts 30 days | [verified: same page, 19 Nov 2026] |
| List: `GET /{waba-id}/flows` returns `data[]` of `id, name, status, categories, validation_errors` with cursors | [verified: same page, 19 Nov 2026] |
| Read: `GET /{flow-id}?fields=id,name,categories,status,validation_errors,json_version,data_api_version,endpoint_uri,health_status,application,preview` | [verified: same page, 19 Nov 2026] |
| Status: `DRAFT` (testing only, sent with `"mode": "draft"`), `PUBLISHED` (can be sent to customers), `DEPRECATED` (cannot be sent or opened; cannot be restored), `BLOCKED` (endpoint unhealthy; cannot be sent or opened), `THROTTLED` (only 10 sends an hour) | [verified: same page, 19 Nov 2026] |
| Publish: `POST /{flow-id}/publish`. Deprecate: `POST /{flow-id}/deprecate`. Delete: `DELETE /{flow-id}`, **drafts only**. Each returns `{ success: true }` | [verified: same page, 19 Nov 2026] |
| Can a published Flow be changed? The API page says a published Flow "can't be deleted or updated afterward". The lifecycle page says updating a published Flow's JSON **returns it to Draft**, and that old messages keep the old content | **Meta's pages disagree.** [verified as a contradiction: flowsapi page above and https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/lifecycle.md, 19 Nov 2026] Section 8, rule 9 handles both |
| Token needs `whatsapp_business_management` and `whatsapp_business_messaging` | [verified: flowsapi page, 19 Nov 2026] |
| Flow names must be unique within the account | [unverified] |
| Maximum number of Flows per account | [unverified] not stated |

### 3.3 Flow JSON

| Fact | Status |
|---|---|
| Latest version **7.3** (10 Sep 2025), recommended for publishing. Versions 5.1 to 7.3 can be published; 5.0 and older are frozen | [verified: https://developers.facebook.com/docs/whatsapp/flows/changelogs, 19 Nov 2026] |
| A frozen version cannot be published but still sends; an expired version cannot be sent or opened. Usually 90 days' notice | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/versioning.md, 19 Nov 2026] |
| Top level: `version` and `screens` required; `routing_model` and `data_api_version` needed only with an endpoint. `data_channel_uri` is no longer used (set `endpoint_uri` by API) | [verified: https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson, 19 Nov 2026] |
| Screen: `id` (unique; `SUCCESS` is reserved), `title`, `layout` (required), `terminal`, `success` (terminal screens only, default true), `data` (declares incoming values; each needs `__example__`), `refresh_on_back`, `sensitive` (5.1+) | [verified: same page, 19 Nov 2026] |
| Screen `id` may contain only letters and underscores | [unverified] All ids here are upper-case letters and underscores |
| Layout type `SingleColumnLayout` with `children`. A terminal screen must have a `Footer` | [verified: same page, 19 Nov 2026] |
| Actions: `navigate` `{ name, next: { type: "screen", name }, payload }`; `complete` `{ name, payload }` (ends the Flow and sends the payload to the business); `data_exchange` `{ name, payload }` (endpoint only); `update_data` and `open_url` (6.0+) | [verified: same page, 19 Nov 2026] |
| References: `${form.<field>}`, `${data.<field>}`, and across screens `${screen.<SCREEN_ID>.form.<field>}` (4.0+) | [verified: same page, 19 Nov 2026] |
| The `Form` wrapper is optional from 4.0; inputs can sit directly in the layout | [verified: same page, 19 Nov 2026] |
| `null` is not supported in payloads; an unanswered optional field is left out or empty | [verified: same page, 19 Nov 2026] |
| `routing_model`: map of screen id → screens it can go forward to; at most 10 branches; every route must end at a terminal screen | [verified: same page, 19 Nov 2026] |
| Keep the `complete` payload small; only what the customer entered; no images | [verified: same page, 19 Nov 2026] |
| Limits: 50 components per screen; Flow JSON at most 10 MB | [verified: https://developers.facebook.com/docs/whatsapp/flows/reference/components and flowjson page, 19 Nov 2026] |

Components used here and their limits [verified: https://developers.facebook.com/docs/whatsapp/flows/reference/components, 19 Nov 2026]:

| Component | Required | Limits |
|---|---|---|
| `TextHeading`, `TextSubheading` | `text` | 80 characters, not blank |
| `TextBody` | `text` | 4096 characters |
| `TextCaption` | `text` | the page prints "409" (probably 4096); keep under 400 |
| `TextInput` | `label`, `name` | label 20; `helper-text` 80; `input-type` one of `text`, `number`, `email`, `password`, `passcode`, `phone`; `required`; default `max-chars` 80 |
| `TextArea` | `label`, `name` | label 20; `helper-text` 80; default `max-length` 600 |
| `RadioButtonsGroup` | `name`, `data-source`, `label` | 1 to 20 options; label 30; option title 30, description 300 |
| `CheckboxGroup` | as above | plus `min-selected-items`, `max-selected-items` |
| `Dropdown` | `label`, `data-source` | label 20; up to 200 options; option title 30 |
| `DatePicker` | `label`, `name` | label 40; `min-date`, `max-date`, `unavailable-dates` as `YYYY-MM-DD` (from 5.0) |
| `OptIn` | `label`, `name` | 120 characters; 5 per screen |
| `Footer` | `label`, `on-click-action` | label 35; one per screen |

Types of `min-chars`, `max-chars`, `max-length` (number or string) are **[unverified]**, so the forms here do not set them.

Design guidance from Meta that these forms follow: one task per screen; sentence case; a call-to-action that says what happens; dropdown only for 8 or more options, radio buttons for fewer; no more than 10 options showing; helper text for formats; finish in well under 5 minutes; after completion send a confirming message. [verified: https://developers.facebook.com/docs/whatsapp/flows/guides/bestpractices, 19 Nov 2026]

### 3.4 Sending a Flow

| Fact | Status |
|---|---|
| Interactive message: `type: "interactive"`, `interactive: { type: "flow", header?, body, footer?, action: { name: "flow", parameters } }`. Parameters: `flow_message_version: "3"`; `flow_id` **or** `flow_name` (not both); `flow_cta` (button text; 30 characters or fewer advised, no emoji); `flow_token` (ours; default `"unused"`); `flow_action` `navigate` (default) or `data_exchange`; `flow_action_payload: { screen, data? }` only with `navigate`, `screen` must be an entry screen; `mode` `draft` or `published` (default) | [verified: https://developers.facebook.com/docs/whatsapp/flows/guides/sendingaflow, 19 Nov 2026] |
| An interactive Flow message is an ordinary (non-template) message, so it can go only inside the 24-hour window; outside it Meta answers `131047` | [verified for `131047`: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes, 19 Nov 2026]; that Flow messages follow the window is [unverified] on the Flows page itself |
| Header, body and footer length limits of the interactive message | [unverified] This spec uses body ≤ 1024, footer ≤ 60, no header |
| Template with a form button, at creation: in `BUTTONS`, `{ "type": "FLOW", "text": "<max 25>", "flow_id": "<id>", "flow_action": "navigate", "navigate_screen": "<SCREEN>" }` (`flow_name` or `flow_json` may replace `flow_id`). The Flows guide misspells the last key as `nagivate_screen`; the template reference lists `navigate_screen` | [verified: sendingaflow page above and https://developers.facebook.com/docs/graph-api/reference/whats-app-business-hsm/, 19 Nov 2026] |
| Template with a form button, at send: component `{ "type": "button", "sub_type": "flow", "index": "0", "parameters": [{ "type": "action", "action": { "flow_token": "<ours>", "flow_action_data": { … } } }] }`; both inner fields optional | [verified: sendingaflow page above, 19 Nov 2026] |
| Listed template components include the button's `flow_id` | [unverified] |
| Send errors: `132068` the Flow is blocked; `132069` the Flow is throttled (10 already sent this hour); `131026` the customer's WhatsApp is too old for this Flow version | [verified: error-codes page above and versioning page, 19 Nov 2026] |

### 3.5 Receiving the answers

| Fact | Status |
|---|---|
| The completed form arrives on the **`messages`** field of the existing WhatsApp webhook as a message of `type: "interactive"` with `interactive: { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json: "<JSON as a string>" } }`. `response_json` holds `flow_token` and whatever the `complete` payload (or the endpoint's final answer) carried | [verified: https://developers.facebook.com/docs/whatsapp/flows/guides/receiveflowresponse, 19 Nov 2026] |
| `context.id` is the message ID of the Flow message the customer answered; `context.from` is our number | [verified: same page, 19 Nov 2026] |
| The answer does **not** include the Flow ID; put our own identifier in the payload or the token | [verified: same page, 19 Nov 2026] |
| `from` (the phone number) is **left out** when the customer has adopted a WhatsApp username; `from_user_id` (a business-scoped ID) is always present | [verified: same page and https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/interactive.md, 19 Nov 2026] See section 14, item 2 |

### 3.6 Data endpoint (Phase B)

| Fact | Status |
|---|---|
| Key pair: 2048-bit RSA, PEM. Meta's commands: `openssl genrsa -des3 -out private.pem 2048` then `openssl rsa -in private.pem -outform PEM -pubout -out public.pem` | [verified: https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/whatsapp-business-encryption/, 19 Nov 2026] |
| Upload: `POST /{phone-number-id}/whatsapp_business_encryption`, `Content-Type: application/x-www-form-urlencoded`, field `business_public_key=<PEM>`. Returns `{ success: true }`. Once **per phone number**. The number must be registered. Token needs `whatsapp_business_messaging` | [verified: same page, 19 Nov 2026] |
| Check: `GET /{phone-number-id}/whatsapp_business_encryption` returns `business_public_key` and `business_public_key_signature_status` (`VALID` or `MISMATCH`) | [verified: same page, 19 Nov 2026] |
| Upload again after re-registering the number, or when alerts `public-key-missing` / `public-key-signature-verification` arrive | [verified: https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint, 19 Nov 2026] |
| Upload errors: `100` the key is not a valid 2048-bit RSA public key in PEM; `10` the number is not allowed to use endpoint Flows; `131000` Meta failed to sign the key | [verified: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes, 19 Nov 2026] |
| Request to our endpoint: HTTPS POST, JSON `{ encrypted_flow_data, encrypted_aes_key, initial_vector }`, all base64 strings; header `X-Hub-Signature-256: sha256=<HMAC of the raw body with the app secret>` | [verified: implementingyourflowendpoint page above, 19 Nov 2026] |
| Decrypt: (1) base64-decode `encrypted_aes_key`, RSA-decrypt with our private key using OAEP padding, SHA-256 for both the hash and MGF1 → a 128-bit AES key. (2) base64-decode `encrypted_flow_data` and `initial_vector`; the last 16 bytes of the data are the GCM tag; decrypt with AES-128-GCM → UTF-8 JSON | [verified: same page, 19 Nov 2026] |
| Decrypted body: `version` ("3.0"), `action` (`INIT` when the form opens, `BACK`, `data_exchange` on a submit, `ping` for the health check), `screen`, `data`, `flow_token`. From Flow JSON 7.3 with `data_api_version` 4.0 also `flow_token_signature`, a JWT (HS256) signed with the app secret | [verified: same page, 19 Nov 2026] |
| Answer: JSON → encrypt with AES-128-GCM using the same AES key and the request IV with **every bit flipped**, empty AAD, 16-byte tag appended; base64-encode; send as plain text | [verified: same page, 19 Nov 2026] |
| Answer shapes: next screen `{ "screen": "<ID>", "data": { … } }` (`data.error_message` shows an error on that screen); finish `{ "screen": "SUCCESS", "data": { "extension_message_response": { "params": { "flow_token": "<same>", …ours } } } }`; `params` reach the messages webhook | [verified: same page, 19 Nov 2026] |
| Health check: request `{ "version": "3.0", "action": "ping" }` → answer `{ "data": { "status": "active" } }` (encrypted the same way) | [verified: same page, 19 Nov 2026] |
| Error notice from the client: `data` holds `error` and `error_message` → answer `{ "data": { "acknowledged": true } }` | [verified: same page, 19 Nov 2026] |
| Status codes we return: **421** cannot decrypt (the client fetches the key again and retries); **432** signature check failed; **427** the token is no longer valid, optional body `{ "error_msg": "…" }` shown to the customer, and the button is then disabled | [verified: https://developers.facebook.com/docs/whatsapp/flows/reference/error-codes, 19 Nov 2026] |
| Our answer must arrive within **10 seconds** | [verified: same page, 19 Nov 2026] |
| `data_api_version` "3.0" is the version the guide documents; "4.0" (11 Nov 2025) is recommended and adds Meta-side request checks plus the optional `flow_token_signature` | [verified: https://developers.facebook.com/docs/whatsapp/flows/changelogs, 19 Nov 2026]. Whether the wire format differs in 4.0 is [unverified]; Phase B uses "3.0" (section 14, item 5) |
| Webhook field **`flows`** (subscribe beside `messages`): `value.event` one of `FLOW_STATUS_CHANGE` (`flow_id`, `old_status`, `new_status`, `message`), `CLIENT_ERROR_RATE`, `ENDPOINT_ERROR_RATE`, `ENDPOINT_LATENCY`, `ENDPOINT_AVAILABILITY`, `FLOW_VERSION_EXPIRY_WARNING`. Latency alerts at p90 of 1 s, 5 s, 7 s; availability below 90% | [verified: https://developers.facebook.com/docs/whatsapp/flows/reference/flowswebhooks, 19 Nov 2026] |

**App review:** none for the business's own account.

## 4. Data

### 4.1 Migration `packages/db/migrations/0076_wa_flows.sql`

```sql
-- WhatsApp Flows (in-chat forms). Additive only: two new tables.
-- wa_flow: one row per form version created at Meta. wa_flow_response: one row per completed form.
-- Undo: DROP TABLE wa_flow_response; DROP TABLE wa_flow;

CREATE TABLE IF NOT EXISTS "wa_flow" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "waba_id" text NOT NULL,
  "key" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "meta_flow_id" text,
  "meta_name" text NOT NULL,
  "status" text DEFAULT 'DRAFT' NOT NULL,
  "uses_endpoint" boolean DEFAULT false NOT NULL,
  "json_version" text,
  "uploaded_hash" text,
  "published_hash" text,
  "validation_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_error" text,
  "created_by" uuid REFERENCES "admin_user"("id"),
  "published_by" uuid REFERENCES "admin_user"("id"),
  "published_at" timestamptz,
  "retired_at" timestamptz,
  "synced_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_wa_flow_key_version" ON "wa_flow" ("waba_id","key","version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_wa_flow_meta_id" ON "wa_flow" ("meta_flow_id") WHERE "meta_flow_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wa_flow_response" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" uuid NOT NULL UNIQUE REFERENCES "inbox_message"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "inbox_conversation"("id"),
  "request_message_id" uuid REFERENCES "inbox_message"("id") ON DELETE SET NULL,
  "flow_id" uuid REFERENCES "wa_flow"("id"),
  "flow_key" text NOT NULL,
  "flow_token" text,
  "data" jsonb NOT NULL,
  "status" text DEFAULT 'new' NOT NULL,
  "handled_by" uuid REFERENCES "admin_user"("id"),
  "handled_at" timestamptz,
  "actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wa_flow_response_conv" ON "wa_flow_response" ("conversation_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wa_flow_response_key" ON "wa_flow_response" ("flow_key","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wa_flow_response_slot" ON "wa_flow_response" (("data"->>'day'),("data"->>'slot')) WHERE "flow_key" = 'delivery_slot';
```

Journal entry, appended last: `{ "idx": <previous idx + 1>, "version": "7", "when": 1786700000000, "tag": "0076_wa_flows", "breakpoints": true }` (`when` larger than every earlier entry).

### 4.2 Drizzle — new file `packages/db/src/schema/wa-flow.ts`, exported from the schema index

`waFlow` and `waFlowResponse` mirroring the SQL exactly (camelCase fields: `wabaId`, `key`, `version`, `metaFlowId`, `metaName`, `status`, `usesEndpoint`, `jsonVersion`, `uploadedHash`, `publishedHash`, `validationErrors` as `jsonb().$type<FlowValidationError[]>()`, `lastError`, `createdBy`, `publishedBy`, `publishedAt`, `retiredAt`, `syncedAt`, `createdAt`, `updatedAt`; and `messageId`, `conversationId`, `requestMessageId`, `flowId`, `flowKey`, `flowToken`, `data` as `jsonb().$type<Record<string, unknown>>()`, `status`, `handledBy`, `handledAt`, `actions` as `jsonb().$type<FlowResponseAction[]>()`, `createdAt`). Types: `interface FlowValidationError { error?: string; error_type?: string; message?: string; line_start?: number; column_start?: number }`, `interface FlowResponseAction { action: string; by: string; at: string; detail?: string }`.

### 4.3 Meaning

- `key`: our name for the form, from the registry (`delivery_address`, `bulk_order`, `complaint`, `pickup_request`, `delivery_slot`). `flow_key` on a response is the same, or `unknown`.
- `version`: 1, 2, 3… A new row is made only when Meta will not accept a change to a published form (section 8, rule 9). The **current** form for a key is the highest `version` whose status is `PUBLISHED`; for testing, the highest version of any status.
- `uploaded_hash`: SHA-256 (hex) of the exact JSON text last accepted by Meta. `published_hash`: the hash that was live when it was published. The repo file's hash differing from `uploaded_hash` means "the form in the code is newer than the one at WhatsApp".
- `wa_flow_response.status`: `new` or `handled`. `actions`: a log of what staff did with it.
- No key material and no token is stored anywhere in the database.

## 5. Server

### 5.1 Files

| File | What |
|---|---|
| `packages/shared/src/wa-flows.ts` (+ export) | The registry: for each form its key, staff title, description, Meta name and categories, button text, default message, entry screen, whether it uses the endpoint, and the field list (name → label, kind) used to draw the card. Browser-safe |
| `packages/domain/src/meta/flows/definitions/*.flow.json` | The Flow JSON files: `delivery-address`, `bulk-order`, `complaint`, `pickup-request` (Phase A), `delivery-slot` (Phase B) |
| `packages/domain/src/meta/flows/definitions.ts` | Imports each JSON (`import x from "./definitions/delivery-address.flow.json" with { type: "json" };`, `resolveJsonModule` is already on) and exports `flowJsonText(key): string` (stable `JSON.stringify(def, null, 2)`) and `flowJsonHash(key): string` |
| `packages/domain/src/meta/flows.ts` | Flows API calls (5.3) |
| `packages/domain/src/meta/flow-responses.ts` | `parseFlowReply`, `recordFlowResponse`, `flowResponseCard` (5.5) |
| `packages/domain/src/meta/flow-token.ts` | Signed form tokens (5.4) |
| `packages/domain/src/meta/flow-crypto.ts` | Phase B decrypt and encrypt (5.9) |
| `packages/domain/src/meta/flow-slots.ts` | Phase B slots (5.10) |
| `packages/domain/src/inbox/meta.ts`, `send.ts`, `whatsapp-ingest.ts` | Send a form message; ingest `nfm_reply` |
| `apps/api/src/routes/wa-flows.ts` | Management routes, mounted at `/v1/wa-flows` |
| `apps/api/src/routes/inbox.ts` | Send-a-form and response-action routes; card data in the timeline; erase |
| `apps/api/src/routes/webhooks-whatsapp-flows.ts` | Phase B endpoint, mounted at `/v1/webhooks/whatsapp-flows` |
| `apps/api/src/env.ts`, `docker-compose.yml` | Phase B: `WA_FLOW_PRIVATE_KEY_B64`, `WA_FLOW_PRIVATE_KEY_PASSPHRASE` (both optional strings; `api` service only) |

### 5.2 Registry (`packages/shared/src/wa-flows.ts`)

```ts
export type FlowKey = "delivery_address" | "bulk_order" | "complaint" | "pickup_request" | "delivery_slot";
export type FlowFieldKind = "text" | "phone" | "choice" | "multi" | "date" | "longtext";
export interface FlowField { name: string; label: string; kind: FlowFieldKind; options?: Record<string, string> }  // options: id -> title
export interface FlowDef {
  key: FlowKey; title: string; description: string;
  metaName: string; categories: string[];
  cta: string; defaultMessage: string; entryScreen: string;
  usesEndpoint: boolean; phase: "A" | "B";
  label: string;                      // conversation label added when an answer arrives
  fields: FlowField[];
}
export const WA_FLOWS: readonly FlowDef[];
export function flowDef(key: string): FlowDef | null;
```

| key | title | metaName | categories | cta | defaultMessage | entryScreen | label |
|---|---|---|---|---|---|---|---|
| `delivery_address` | "Delivery address" | `ms_delivery_address` | `["OTHER"]` | "Add address" | "Please tap the button and fill in your delivery address. It takes about a minute." | `ADDRESS` | `delivery-address` |
| `bulk_order` | "Bulk-order enquiry" | `ms_bulk_order` | `["LEAD_GENERATION"]` | "Start enquiry" | "Planning an event or a large order? Tap the button and tell us what you need. We will reply with a quote." | `DETAILS` | `bulk-order` |
| `complaint` | "Report a problem" | `ms_complaint` | `["CUSTOMER_SUPPORT"]` | "Report a problem" | "We are sorry something went wrong. Tap the button and tell us what happened so we can put it right." | `PROBLEM` | `complaint` |
| `pickup_request` | "Pickup request" | `ms_pickup_request` | `["APPOINTMENT_BOOKING"]` | "Choose pickup time" | "Tap the button to tell us when you would like to collect your order." | `PICKUP` | `pickup` |
| `delivery_slot` (Phase B) | "Delivery time" | `ms_delivery_slot` | `["APPOINTMENT_BOOKING"]` | "Choose a time" | "Tap the button to choose a delivery time. You will only see times we still have room for." | `PICK_DAY` | `delivery-slot` |

When a version above 1 is created, the Meta name gets `_v<version>` appended.

### 5.3 Flows API (`packages/domain/src/meta/flows.ts`)

```ts
export interface MetaFlow { id: string; name?: string; status?: string; categories?: string[]; validation_errors?: FlowValidationError[]; json_version?: string; endpoint_uri?: string }
export function createFlow(cfg: MetaConfig, wabaId: string, f: { name: string; categories: string[]; flowJson: string; endpointUri?: string }): Promise<{ id: string; validationErrors: FlowValidationError[] }>;
export function uploadFlowJson(cfg: MetaConfig, flowId: string, flowJson: string): Promise<FlowValidationError[]>;      // multipart via graphRaw + FormData
export function getFlow(cfg: MetaConfig, flowId: string): Promise<MetaFlow>;                                             // fields=id,name,status,categories,validation_errors,json_version,endpoint_uri
export function listFlows(cfg: MetaConfig, wabaId: string): Promise<MetaFlow[]>;                                         // follows cursors
export function flowPreviewUrl(cfg: MetaConfig, flowId: string, fresh: boolean): Promise<{ url: string; expiresAt: string }>;  // preview.invalidate(<fresh>)
export function publishFlow(cfg: MetaConfig, flowId: string): Promise<void>;
export function deprecateFlow(cfg: MetaConfig, flowId: string): Promise<void>;
export function deleteDraftFlow(cfg: MetaConfig, flowId: string): Promise<void>;
export function setFlowEndpoint(cfg: MetaConfig, flowId: string, endpointUri: string, applicationId: string): Promise<void>;   // Phase B
export function uploadFlowPublicKey(cfg: MetaConfig, phoneNumberId: string, publicKeyPem: string): Promise<void>;              // Phase B, form-urlencoded
export function getFlowPublicKeyStatus(cfg: MetaConfig, phoneNumberId: string): Promise<{ present: boolean; status: string | null }>;  // Phase B
export function explainFlowError(err: unknown): string;
```

`createFlow` never passes `publish: true`. `explainFlowError`: codes `190`, `10`, `200`, `299` → "WhatsApp would not let us in. The connection needs fixing by the technical lead."; retryable or no answer → "WhatsApp did not answer. Check the list in a minute before trying again."; `132068` → "WhatsApp has blocked this form because of errors. It cannot be sent until that is fixed."; `132069` → "This form has been sent 10 times in the last hour, which is WhatsApp's limit while it has problems. Try again later."; `131047` → "More than 24 hours have passed since the customer last wrote. Send a template first."; `131026` → "This customer's WhatsApp is too old to open the form. Ask them to update WhatsApp, or take the details in chat."; anything else → "WhatsApp refused this: {Meta's message} (Meta {code})".

### 5.4 Tokens (`flow-token.ts`)

```ts
/** "<key>.<conversationId>.<expiresEpochSeconds>.<sig>", sig = base64url(HMAC-SHA256(secret, "wa-flow:" + first three parts)).slice(0, 32) */
export function makeFlowToken(secret: string, key: FlowKey, conversationId: string, now: Date, ttlMs?: number): string;   // ttl default 3 days
export function readFlowToken(secret: string, token: string, now: Date): { ok: true; key: string; conversationId: string } | { ok: false; reason: "malformed" | "bad_signature" | "expired" };
```
`secret` is `env.JWT_SIGNING_KEY` (the same secret `uploadToken` in `inbox.ts` uses). Compare signatures with `crypto.timingSafeEqual`. A token is not a secret from the customer and carries no personal data.

### 5.5 Sending a form in a chat

`meta.ts`: add to `OutboundContent`
```ts
| { type: "flow"; flowId: string; flowToken: string; cta: string; body: string; footer?: string;
    action: "navigate" | "data_exchange"; screen?: string; mode: "published" | "draft" }
```
`buildSendPayload` case `"flow"`: `{ ...base, type: "interactive", interactive: { type: "flow", body: { text: body }, ...(footer ? { footer: { text: footer } } : {}), action: { name: "flow", parameters: { flow_message_version: "3", flow_id, flow_cta: cta, flow_token: flowToken, flow_action: action, ...(action === "navigate" ? { flow_action_payload: { screen } } : {}), mode } } } }`. No `data` is sent for the entry screen.

`send.ts`: add `payloadExtra?: Record<string, unknown>` to `SendInput`; merge it into the `payload` written with the queued row and kept on failure. For `content.type === "flow"` the existing non-template branch applies unchanged (24-hour check; `body = content.body`); store the message with `type: "flow"`.

New route **`POST /v1/inbox/conversations/:id/flows`** in `inbox.ts`: `need(c, "inbox.reply")`, `visibleConversation`, body `{ flow_key: string, message?: string (trim, 1..1024), test?: boolean }`.
1. `def = flowDef(flow_key)` → else 400 "Unknown form."
2. Find the conversation's number → its `waba_id`. Pick the `wa_flow` row: when `test` is true (needs `templates.manage` as well) the highest version with a `meta_flow_id` and status `DRAFT` or `PUBLISHED`, `mode = status === "PUBLISHED" ? "published" : "draft"`; otherwise the highest version with status `PUBLISHED` → none: 409 "This form is not live at WhatsApp yet. Ask an admin to publish it under Templates and forms."
3. `token = makeFlowToken(...)`.
4. `sendFromConversation(db, cfg, { conversationId, userId, content: { type: "flow", flowId: row.metaFlowId, flowToken: token, cta: def.cta, body: message ?? def.defaultMessage, action: def.usesEndpoint ? "data_exchange" : "navigate", screen: def.entryScreen, mode }, payloadExtra: { flow: { key: def.key, flow_row_id: row.id, token, title: def.title, cta: def.cta } } })`.
5. Errors and status codes exactly as the existing messages route (window closed → 409 with reason `window_closed`; failed send → 502 with the message row). Audit: `inbox.flow_send`, entity `inbox_conversation`, `after: { flow_key, message_id }`, `notify: false`.

**`GET /v1/inbox/flows`** (`inbox.view`): `{ data: [{ key, title, description, cta, default_message, live: boolean, testable: boolean }] }` for every registry form of phase A, plus phase B once a `delivery_slot` row exists.

### 5.5a A form outside the 24 hours: a template with a form button

An interactive form message cannot be sent once the window has closed. The way round it is an approved template whose button opens the form (section 3.4). Four changes, all on top of `work/olu/inbox-gaps` and spec 06:

1. **`templateNeeds`** (`packages/shared/src/inbox-templates.ts`): remove `FLOW` from `UNSENDABLE_BUTTONS`. Add to `TemplateNeeds` the field `flowButtons: { index: number; text: string; flowId: string | null }[]` (empty by default); a `FLOW` button pushes `{ index, text, flowId: String(b.flow_id) or null }`. More than one `FLOW` button → not sendable, reason "This template has more than one form button, which the inbox can't send yet".
2. **`OutboundContent` template variant** (`meta.ts`): add `flowButtons?: { index: number; flowToken: string }[]`. `buildTemplateComponents` appends, after the link buttons and ordered by index: `{ type: "button", sub_type: "flow", index: String(index), parameters: [{ type: "action", action: { flow_token: flowToken } }] }`. No `flow_action_data` is sent.
3. **`sendFromConversation`** (`send.ts`): when `needs.flowButtons` has an entry, look up `wa_flow` by `meta_flow_id = flowId`. Not found, or `flowId` null (Meta did not list it) → `InboxSendError("template_unsupported", "This template opens a form the suite does not know. Sync forms under Templates and forms, or use another template.")`. Found but not `PUBLISHED` → `template_unsupported`, "The form behind this template is not live at WhatsApp." Otherwise make a token with `makeFlowToken` (the signing secret is passed in through a new optional `SendInput.flowTokenSecret`, set by the route from `env.JWT_SIGNING_KEY`), put it in `content.flowButtons`, and add `payloadExtra.flow = { key, flow_row_id, token, title, cta: button text }` so the answer is matched exactly as for an interactive form. The 24-hour check is skipped as for every template.
4. **Spec 06's editor**: add `{ type: "FLOW"; text: string; flowKey: string }` to `DraftButton`; a fourth choice in "Add a button": **"Form button"** with a label (25 characters) and a select "Which form?" listing live forms from `GET /v1/inbox/flows` (helper: "The customer taps it to open the form. Only one form button per template."). `draftToComponents` needs the Meta flow ID and entry screen, so the submit route resolves `flowKey` to the current live `wa_flow` row and emits `{ "type": "FLOW", "text": text, "flow_id": metaFlowId, "flow_action": usesEndpoint ? "data_exchange" : "navigate", "navigate_screen": entryScreen }` (`navigate_screen` only for `navigate`). New `validateDraft` errors: `flow_count` "A template can have one form button at most." and `flow_missing` "Choose which form the button opens." `componentsToDraft` maps a `FLOW` button back through `meta_flow_id`; an unknown flow makes the template read-only as before. A form button counts toward the 10-button limit and sits with the non-reply buttons for the grouping rule.

The template picker in `Composer.tsx` needs no new input (the form button has no blank); it shows the button label in the preview as it does for other buttons.

### 5.6 Receiving the answers (`whatsapp-ingest.ts`, `flow-responses.ts`)

```ts
export function parseFlowReply(m: WaInboundMessage): { responseJson: Record<string, unknown>; flowToken: string | null } | null;
export function recordFlowResponse(db: DbExecutor, a: { messageId: string; conversationId: string; contextWaMessageId: string | null; reply: { responseJson: Record<string, unknown>; flowToken: string | null } }): Promise<{ flowKey: string; title: string; label: string | null }>;
export function flowResponseCard(flowKey: string, data: Record<string, unknown>): { title: string; rows: { label: string; value: string }[] };
```

- Add to `WaInboundMessage.interactive`: `nfm_reply?: { name?: string; body?: string; response_json?: string }`.
- `parseFlowReply` returns null unless `m.type === "interactive"` and `m.interactive?.type === "nfm_reply"`. It parses `response_json` (a string) with try/catch; on failure or a non-object it returns `{ responseJson: { _raw: <first 2000 characters> }, flowToken: null }`. `flowToken` is `responseJson.flow_token` when a string.
- `parseInbound`: for `nfm_reply` return `type: "interactive"`, `body: "Completed a form"` (this replaces today's `null` body for that case).
- `ingestMessage`: after the message row is inserted and before `touchConversation`, if `parseFlowReply(m)` is not null call `recordFlowResponse`, then update the message's `body` to `` `Completed form: ${title}` `` and use that for the preview. If a `label` comes back, add it to `inbox_conversation.labels` when not already there (lower-case, as the PATCH route does).
- `recordFlowResponse` resolves the form in this order: (1) the outbound message whose `wa_message_id = contextWaMessageId` → its `payload.flow.key` and `flow_row_id` (also sets `request_message_id`); (2) `responseJson.flow_key` when it is a registry key; (3) the token's first part, read with `readFlowToken` ignoring expiry; (4) `unknown` with title "Form". It stores `data` = `responseJson` without `flow_token` and `flow_key`, each string value cut to 2000 characters, at most 40 keys. Insert with `onConflictDoNothing` on `message_id` (replays are safe).
- **Complaint:** when the key is `complaint`, insert `outbox_event` `eventType: "inbox.flow_complaint"`, `payload: { conversation_id, response_id }` in the same transaction; add the case to `apps/worker/src/outbox.ts`: "⚠️ *A customer reported a problem*\nA complaint form has just been filled in on WhatsApp.\n👉 {suite or admin URL}/inbox/{conversation_id}". No customer details in the alert.
- `flowResponseCard`: for each registry field, in order, that has a value: `label` and a display value (`choice` → the option's title or the raw id; `multi` → titles joined with ", "; others as is). Then any other keys as "Other: {key}" rows. Unknown form: every key as a row.

Timeline (`buildTimelinePage` in `inbox.ts`): left-join `wa_flow_response` on `message_id` and add to each message `flow_response: { id, flow_key, status, handled_by_name, handled_at, title, rows } | null` (built with `flowResponseCard`). For outbound `type = 'flow'` messages add `flow_sent: { title, cta } | null` from `payload.flow`. Add both as optional fields to `TimelineMessage` in `apps/admin/src/lib/inbox-types.ts`.

### 5.7 Acting on an answer

**`POST /v1/inbox/flow-responses/:id/action`** (`inbox.reply`; the response's conversation must be visible, else 404). Body `{ action: "handled" | "reopen" | "save_address" | "add_note" }`.

| action | Does | Allowed when |
|---|---|---|
| `handled` | `status = 'handled'`, `handled_by`, `handled_at` | status `new` |
| `reopen` | `status = 'new'`, clear handled fields | status `handled` |
| `save_address` | Sets `customer.default_address` to "{street}, {area title}. Landmark: {landmark}" (the landmark part only when given; max 500 characters); returns `{ before, after }` | key `delivery_address` |
| `add_note` | Adds an `inbox_note` on the conversation: "{title}\n{label}: {value}\n…" | any |

Each appends `{ action, by: userId, at, detail }` to `actions` and writes audit `inbox.flow_response_action` (entity `wa_flow_response`, `before`/`after` for `save_address`, `notify: false`). After any action publish `signalFor("message.status", conv, messageId)` so open screens refresh the card. Nothing here sends anything to the customer.

Erasure: in `POST /v1/inbox/contacts/:customerId/erase`, delete `wa_flow_response` rows for the customer's conversations in the same transaction, before messages are removed or blanked. Add it to that route's test.

### 5.8 Managing forms (`/v1/wa-flows`, every route `requireAuth()` + `requireCapability("templates.manage")`)

`FlowDto`: `{ key, title, description, phase, uses_endpoint, account: { waba_id, label }, version, meta_flow_id, meta_name, status, state, validation_errors, last_error, code_is_newer, published_at, synced_at }`, where `state` is one of `not_created`, `draft_invalid` (has validation errors), `draft_ready`, `live`, `live_update_waiting` (published but `code_is_newer`), `retired`, `blocked`, `throttled`.

| Route | Does | Audit |
|---|---|---|
| `GET /` | One `FlowDto` per registry form per WhatsApp account (rows that do not exist yet are `not_created`). Phase B forms are listed only when `WA_FLOW_PRIVATE_KEY_B64` is set | — |
| `POST /:key/create` body `{ waba_id }` | `createFlow` with the repo JSON → insert the row (`version` = highest existing + 1, or 1), `uploaded_hash`, `validation_errors`, `json_version` from the JSON. A Meta name clash → the message from `explainFlowError`, row not created | `wa_flow.create` |
| `POST /:id/upload` | `uploadFlowJson` with the repo JSON; store hash and errors. If Meta refuses because the form is published, answer 409 `details.reason: "published_locked"`, "WhatsApp will not change a form that is already live. Make a new copy instead." | `wa_flow.upload` |
| `POST /:id/new-version` | Same as create, with `version + 1` and the `_v<n>` name. The old version stays live until the new one is published | `wa_flow.create` |
| `GET /:id/preview` | `flowPreviewUrl(…, false)`; `?fresh=1` makes a new link. `{ data: { url, expires_at } }` | — |
| `POST /:id/publish` body `{ confirm_title }` | Checks: `confirm_title` equals the form's title; `validation_errors` empty; `uploaded_hash` equals the repo hash (else 409 "Upload the latest version first."). `publishFlow` → read back with `getFlow` → store status, `published_hash`, `published_by`, `published_at`. If the read-back status is not `PUBLISHED`, say so | `wa_flow.publish` (`notify: true`) |
| `POST /:id/retire` body `{ confirm_title }` | `deprecateFlow`; `status = 'DEPRECATED'`, `retired_at`. Refused (409) when it is the only live version of a key and `?force=1` is not given: "This is the only live version. Customers will no longer be able to open forms already sent. Retire anyway?" | `wa_flow.retire` (`notify: true`) |
| `POST /:id/delete-draft` | Only status `DRAFT`: `deleteDraftFlow`, then delete the row (it has no history; responses keep `flow_key`) | `wa_flow.delete` |
| `POST /sync` | `listFlows` per account; update `status`, `validation_errors`, `synced_at` on rows matched by `meta_flow_id`. Never creates rows | — |
| `GET /encryption` (Phase B) | Per WhatsApp number: `{ number_id, label, key_configured: boolean, uploaded: boolean, signature_status }` | — |
| `POST /encryption/:numberId/upload` (Phase B) | Derives the public key from the private key in env and calls `uploadFlowPublicKey`; reads the status back | `wa_flow.key_upload` (`notify: true`; never logs key text) |

Meta errors: `explainFlowError(err)` as `error.message`; 502 for no answer or retryable, 409 otherwise; configuration codes also raise the `inbox.meta_config` owner alert (spec 05 section 5.3).

### 5.9 Phase B: keys and the endpoint

**Where the private key lives:** only in the server's environment, as `WA_FLOW_PRIVATE_KEY_B64` (the PEM file, base64 on one line) and, if the key has a passphrase, `WA_FLOW_PRIVATE_KEY_PASSPHRASE`. **Never in the database, the repository, a log line, an audit row, a test fixture or a chat.** Tests generate a throwaway key pair at run time with `crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })`.

**Set-up (Tes runs these in his own terminal; Claude never runs or sees them):**
1. `openssl genrsa -out wa_flow_private.pem 2048` (Meta's own example adds `-des3` for a passphrase; if used, also set the passphrase variable).
2. `base64 < wa_flow_private.pem | tr -d '\n'` → paste the output as the value of `WA_FLOW_PRIVATE_KEY_B64` in `/opt/mrs-samuel/.env`. Delete the `.pem` file from the laptop, or keep it in the password manager.
3. `cd /opt/mrs-samuel && docker compose up -d api` (must say Recreated).
4. In the suite: Templates and forms → Forms → "Secure connection" → "Send our key to WhatsApp" for each number. The status must read "In place".
5. App Dashboard → WhatsApp → Configuration → Webhooks → subscribe the field `flows`.

**`flow-crypto.ts`**
```ts
export function loadFlowPrivateKey(env: { WA_FLOW_PRIVATE_KEY_B64?: string; WA_FLOW_PRIVATE_KEY_PASSPHRASE?: string }): crypto.KeyObject | null;   // cached per process
export function flowPublicKeyPem(key: crypto.KeyObject): string;        // crypto.createPublicKey(key).export({ type: "spki", format: "pem" })
export class FlowDecryptError extends Error {}
export function decryptFlowRequest(body: { encrypted_flow_data: string; encrypted_aes_key: string; initial_vector: string }, key: crypto.KeyObject): { payload: Record<string, unknown>; aesKey: Buffer; iv: Buffer };
export function encryptFlowResponse(response: unknown, aesKey: Buffer, iv: Buffer): string;
```
- `decryptFlowRequest`: `aesKey = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(encrypted_aes_key, "base64"))`; must be 16 bytes. `buf = Buffer.from(encrypted_flow_data, "base64")`; `tag = buf.subarray(-16)`; `data = buf.subarray(0, -16)`; `iv = Buffer.from(initial_vector, "base64")`; `d = crypto.createDecipheriv("aes-128-gcm", aesKey, iv); d.setAuthTag(tag)`; JSON-parse `Buffer.concat([d.update(data), d.final()]).toString("utf8")`. Any failure throws `FlowDecryptError` (no detail in the message).
- `encryptFlowResponse`: `flipped = Buffer.from(iv.map((b) => ~b & 0xff))`; `c = crypto.createCipheriv("aes-128-gcm", aesKey, flipped)`; return `Buffer.concat([c.update(JSON.stringify(response), "utf8"), c.final(), c.getAuthTag()]).toString("base64")`.

**`POST /v1/webhooks/whatsapp-flows`** (public; `bodyLimit` 1 MB). In order:
1. Read the raw body. Key not configured → 503, empty body.
2. `verifyMetaSignature(raw, header "x-hub-signature-256", env.META_APP_SECRET)` false → **432**, empty body. Log "flow endpoint: bad signature" (no body).
3. Parse the JSON envelope and `decryptFlowRequest`; `FlowDecryptError` or a malformed envelope → **421**, empty body.
4. `payload.action === "ping"` → answer `{ data: { status: "active" } }`.
5. `payload.data?.error` present (an error notice) → log `{ screen, error }` at warn; answer `{ data: { acknowledged: true } }`.
6. `readFlowToken(env.JWT_SIGNING_KEY, payload.flow_token, now)`: not ok, or its key is not `delivery_slot` → **427** with JSON body `{ "error_msg": "This form has expired. Please ask us to send it again." }` (plain JSON, not encrypted) [whether a 427 body must be encrypted is unverified].
7. `handleSlotFlow(db, { action, screen, data, conversationId, token }, now)` (5.10) → the response object.
8. Every 200 answer is `encryptFlowResponse(response, aesKey, iv)` sent with `content-type: text/plain`.
9. A thrown error inside step 7 → log it, answer 500 with an empty body (Meta shows the customer a generic error and counts it against the endpoint's health).
10. Nothing is written to `inbox_webhook_event` (this is a live question-and-answer, not an event to replay) and the decrypted payload is never logged whole. A hard time budget of 8 seconds: `Promise.race` against a timer that answers 500.

**The `flows` webhook field** (existing WhatsApp webhook, `ingestWhatsAppPayload`): for `change.field === "flows"`: `FLOW_STATUS_CHANGE` → set `wa_flow.status = new_status` where `meta_flow_id = flow_id`; when the new status is `BLOCKED` or `THROTTLED`, and for `ENDPOINT_ERROR_RATE`, `ENDPOINT_LATENCY`, `ENDPOINT_AVAILABILITY`, `FLOW_VERSION_EXPIRY_WARNING`, insert an owner alert `eventType: "inbox.flow_health"`, `payload: { flow_id, event, message }`, at most one per flow per event per 24 hours; outbox text: "⚠️ *WhatsApp form problem*\n{title}: {plain line}." with lines: blocked "WhatsApp has blocked it because our server was failing. Customers cannot open it."; throttled "WhatsApp is limiting it to 10 sends an hour because our server was slow or failing."; error rate / latency / availability "WhatsApp reports our server is slow or failing for this form."; expiry "Its format version is about to expire. It needs updating before then." `CLIENT_ERROR_RATE` is logged only.

**Creating the endpoint form:** `POST /:key/create` for a form with `usesEndpoint` passes `endpointUri: env.PUBLIC_API_URL + "/v1/webhooks/whatsapp-flows"` and then calls `setFlowEndpoint(cfg, id, uri, env.META_APP_ID)`; missing `META_APP_ID` or key → 503 "The secure connection is not set up on this server yet." Publishing an endpoint form additionally requires `getFlowPublicKeyStatus` to be `VALID` for every active number of that account → else 409 "Send our key to WhatsApp first (Secure connection)."

### 5.10 Phase B: the slot picker (`flow-slots.ts`)

```ts
export const SLOT_WINDOWS = ["09:00-11:00", "11:00-13:00", "13:00-15:00", "15:00-17:00", "17:00-19:00"] as const;
export const SLOT_CAPACITY = 4;          // bookings per window
export const SLOT_LEAD_MS = 3 * 3600_000; // a window must start at least 3 hours from now
export const SLOT_DAYS_AHEAD = 5;        // offer the next 5 days that have any room
export interface SlotOption { id: string; title: string }
export function openDays(db: DbExecutor, phoneNumberRowId: string, now: Date): Promise<SlotOption[]>;                    // id "2026-11-20", title "Fri 20 Nov"
export function openSlots(db: DbExecutor, phoneNumberRowId: string, day: string, now: Date): Promise<SlotOption[]>;      // id "11:00-13:00", title "11am to 1pm"
export function handleSlotFlow(db: DbExecutor, req: { action: string; screen?: string; data?: Record<string, unknown>; conversationId: string; token: string }, now: Date): Promise<Record<string, unknown>>;
```
- A window is offered when: it lies wholly inside an open period of the number's hours profile for that weekday (`inbox_hours_rule`; no profile → all five windows, Monday to Saturday); the day is not an `inbox_holiday`; it starts at least `SLOT_LEAD_MS` after `now` (Lagos time, `localParts`); and fewer than `SLOT_CAPACITY` rows exist in `wa_flow_response` with `flow_key = 'delivery_slot'`, `data->>'day' = day`, `data->>'slot' = id`.
- `handleSlotFlow`:
  - `INIT` (or `BACK` to the first screen) → `{ screen: "PICK_DAY", data: { days } }`; no days at all → `{ screen: "PICK_DAY", data: { days: [{ id: "none", title: "No times available" }], error_message: "We have no delivery times free in the next few days. Please message us and we will help." } }`.
  - `data_exchange` from `PICK_DAY` with `data.day` → `{ screen: "PICK_TIME", data: { day, day_label, slots } }`; an unknown or full day → back to `PICK_DAY` with `error_message: "That day is now full. Please choose another."`.
  - `data_exchange` from `PICK_TIME` with `data.day`, `data.slot` → re-check with `openSlots`; still free → `{ screen: "SUCCESS", data: { extension_message_response: { params: { flow_token: token, flow_key: "delivery_slot", day, slot, slot_label: "<day title>, <slot title>" } } } }`; taken → `{ screen: "PICK_TIME", data: { day, day_label, slots, error_message: "That time has just been taken. Please choose another." } }`.
  - anything else → `{ screen: "PICK_DAY", data: { days } }`.
- The booking becomes real when the `nfm_reply` arrives and `recordFlowResponse` stores it. Two customers finishing in the same second can both get the last place; the card for the later one shows an amber line "This time was already full when it arrived" (computed when building the card: more than `SLOT_CAPACITY` rows for that day and slot, and this one is not among the first four by `created_at`). Staff then offer another time.

`delivery-slot.flow.json`: `"version": "7.3"`, `"data_api_version": "3.0"`, `"routing_model": { "PICK_DAY": ["PICK_TIME"], "PICK_TIME": [] }`. Screen `PICK_DAY` (title "Choose a day"; `data: { days: array of { id, title } with an __example__ }`): `TextSubheading` "Which day suits you?", `RadioButtonsGroup` `name: "day"`, `label: "Delivery day"`, `required: true`, `data-source: "${data.days}"`, `Footer` "See times" → `data_exchange` `{ "day": "${form.day}" }`. Screen `PICK_TIME` (title "Choose a time", `terminal: true`; `data`: `day`, `day_label` strings, `slots` array): `TextSubheading` `"${data.day_label}"`, `RadioButtonsGroup` `name: "slot"`, `label: "Delivery time"`, `required: true`, `data-source: "${data.slots}"`, `TextCaption` "We will confirm your time in the chat.", `Footer` "Book this time" → `data_exchange` `{ "day": "${data.day}", "slot": "${form.slot}" }`. Registry fields: `slot_label` "Delivery time" (text). The `day` and `slot` keys are stored but not shown.

## 6. Worker

| Job | Every | Does | Lock / retry |
|---|---|---|---|
| `wa_flow_sync` (new, in `apps/worker/src/jobs/inbox-whatsapp.ts`, registered in `inbox-loop.ts`) | 60 min | For each account with `wa_flow` rows: `listFlows` → update `status`, `validation_errors`, `synced_at` on rows matched by `meta_flow_id`. A row whose flow Meta no longer lists and whose status is `DRAFT` → `last_error = "This draft no longer exists at WhatsApp."` | `withJobLock`; a failure is logged and tried next hour |

No job creates, uploads, publishes, retires or sends a form. The existing `inbox_webhook_retry` job replays `nfm_reply` and `flows` events through the same ingest code.

## 7. Screens

### 7.1 The four Phase A forms (exact screens and wording)

All use `"version": "7.3"`, no `data_api_version`, no `routing_model`, inputs directly in the layout (no `Form` wrapper), and end with `complete`. Every `complete` payload includes `"flow_key": "<key>"`.

**A. Delivery address — one screen.** Complete file `packages/domain/src/meta/flows/definitions/delivery-address.flow.json`:

```json
{
  "version": "7.3",
  "screens": [
    {
      "id": "ADDRESS",
      "title": "Delivery address",
      "terminal": true,
      "success": true,
      "layout": {
        "type": "SingleColumnLayout",
        "children": [
          { "type": "TextSubheading", "text": "Where should we deliver?" },
          { "type": "TextBody", "text": "Fill this in once and we will use it for your order." },
          {
            "type": "TextInput",
            "name": "receiver_name",
            "label": "Receiver's name",
            "input-type": "text",
            "required": true,
            "helper-text": "The person who will collect the order"
          },
          {
            "type": "TextInput",
            "name": "receiver_phone",
            "label": "Receiver's phone",
            "input-type": "phone",
            "required": true,
            "helper-text": "A number our rider can call"
          },
          {
            "type": "TextInput",
            "name": "street",
            "label": "House and street",
            "input-type": "text",
            "required": true,
            "helper-text": "For example 12 Admiralty Way"
          },
          {
            "type": "Dropdown",
            "name": "area",
            "label": "Area",
            "required": true,
            "data-source": [
              { "id": "lekki", "title": "Lekki" },
              { "id": "ajah", "title": "Ajah" },
              { "id": "victoria_island", "title": "Victoria Island" },
              { "id": "ikoyi", "title": "Ikoyi" },
              { "id": "lagos_island", "title": "Lagos Island" },
              { "id": "surulere", "title": "Surulere" },
              { "id": "yaba", "title": "Yaba" },
              { "id": "ikeja", "title": "Ikeja" },
              { "id": "maryland", "title": "Maryland" },
              { "id": "gbagada", "title": "Gbagada" },
              { "id": "magodo", "title": "Magodo" },
              { "id": "festac", "title": "Festac" },
              { "id": "other", "title": "Somewhere else in Lagos" }
            ]
          },
          {
            "type": "TextInput",
            "name": "landmark",
            "label": "Nearest landmark",
            "input-type": "text",
            "required": false,
            "helper-text": "A bus stop, junction or well-known building"
          },
          {
            "type": "TextArea",
            "name": "note",
            "label": "Note for the rider",
            "required": false,
            "helper-text": "Gate colour, floor, or the best time to come"
          },
          {
            "type": "Footer",
            "label": "Send address",
            "on-click-action": {
              "name": "complete",
              "payload": {
                "flow_key": "delivery_address",
                "receiver_name": "${form.receiver_name}",
                "receiver_phone": "${form.receiver_phone}",
                "street": "${form.street}",
                "area": "${form.area}",
                "landmark": "${form.landmark}",
                "note": "${form.note}"
              }
            }
          }
        ]
      }
    }
  ]
}
```

Checked against section 3.3: required top-level keys only; one terminal screen with a Footer; 9 components (limit 50); every label within its limit (TextInput and TextArea 20, Dropdown 20, Footer 35); helper texts under 80; 13 dropdown options (dropdown is right for 8 or more); no `null`. Meta's own validator has the last word: `validation_errors` must come back empty when the draft is created (manual check, step 2). Registry fields, in order: `receiver_name` "Receiver" (text), `receiver_phone` "Phone" (phone), `street` "House and street" (text), `area` "Area" (choice, options as above), `landmark` "Landmark" (text), `note` "Note for the rider" (longtext).

**B. Bulk-order enquiry — two screens.**

| Screen | Component | Wording / settings |
|---|---|---|
| `DETAILS`, title "Bulk order" | `TextSubheading` | "Tell us about your order" |
| | `RadioButtonsGroup` `occasion`, required | label "What is it for?"; options `event` "Party or event", `office` "Office or staff", `resale` "To sell in my shop", `other` "Something else" |
| | `TextInput` `quantity`, `input-type: "number"`, required | label "How many bottles?"; helper "A rough number is fine" |
| | `DatePicker` `needed_by`, required | label "When do you need it?"; helper "We need at least 3 days' notice" |
| | `Footer` | "Continue" → `navigate` to `CONTACT`, payload `{}` |
| `CONTACT`, title "Your details", terminal | `TextSubheading` | "How do we reach you?" |
| | `TextInput` `contact_name`, required | label "Your name" |
| | `TextInput` `location`, required | label "Delivery area"; helper "For example Ikeja or Lekki Phase 1" |
| | `TextArea` `details`, optional | label "Anything else?"; helper "Flavours, bottle size, branding, budget" |
| | `Footer` | "Send enquiry" → `complete`, payload: `flow_key: "bulk_order"`, `occasion: "${screen.DETAILS.form.occasion}"`, `quantity: "${screen.DETAILS.form.quantity}"`, `needed_by: "${screen.DETAILS.form.needed_by}"`, `contact_name: "${form.contact_name}"`, `location: "${form.location}"`, `details: "${form.details}"` |

Registry field labels: "Occasion" (choice), "Bottles" (text), "Needed by" (date; shown as "Fri 20 Nov 2026"), "Name", "Delivery area", "More details" (longtext).

**C. Report a problem — one screen `PROBLEM`, title "Report a problem", terminal.**

| Component | Wording / settings |
|---|---|
| `TextSubheading` | "We are sorry. What went wrong?" |
| `RadioButtonsGroup` `problem_type`, required | label "What is the problem?"; options `late` "Order arrived late", `wrong` "Wrong or missing item", `quality` "Taste or quality", `damaged` "Damaged or leaking", `payment` "Payment problem", `other` "Something else" |
| `TextInput` `order_number`, optional | label "Order number"; helper "If you have it. It starts with MS" |
| `TextArea` `what_happened`, required | label "What happened?"; helper "Tell us in your own words" |
| `RadioButtonsGroup` `wanted`, required | label "What would you like?"; options `replace` "A replacement", `refund` "A refund", `call` "A call from us", `just_saying` "Just letting you know" |
| `Footer` | "Send report" → `complete` with `flow_key: "complaint"` and the four fields |

Registry labels: "Problem" (choice), "Order number", "What happened" (longtext), "They would like" (choice).

**D. Pickup request — one screen `PICKUP`, title "Pickup request", terminal.**

| Component | Wording / settings |
|---|---|
| `TextSubheading` | "When will you collect?" |
| `TextBody` | "We will confirm your time in the chat." |
| `TextInput` `order_number`, optional | label "Order number"; helper "If you have it" |
| `DatePicker` `pickup_date`, required | label "Pickup day" |
| `RadioButtonsGroup` `pickup_time`, required | label "Time of day"; options `morning` "Morning, 9am to 12pm", `afternoon` "Afternoon, 12pm to 4pm", `evening` "Evening, 4pm to 7pm" |
| `TextInput` `collector_name`, required | label "Who will collect?"; helper "Name of the person coming" |
| `Footer` | "Request pickup" → `complete` with `flow_key: "pickup_request"` and the four fields |

Registry labels: "Order number", "Pickup day" (date), "Time of day" (choice), "Collected by". The form asks for a time; it does not promise one. That is why it has no endpoint.

### 7.2 Forms tab — `apps/suite/src/features/templates/forms/`

Files: `flows-api.ts` (keys `["wa-flows","list"]`, `["wa-flows","encryption"]`), `FormsTab.tsx`, `FormCard.tsx`, `PublishFormDialog.tsx`, `RetireFormDialog.tsx`, `SecureConnectionCard.tsx` (Phase B), `form-labels.ts` (+ test). Add the tab "Forms" to the tab bar spec 06 built in `TemplatesPage.tsx`; address `/templates/forms` (add the route in `router.tsx`).

Intro: "A form opens inside WhatsApp when the customer taps a button. Their answers come back into the chat as a card. These forms are built in; ask the technical lead if you need a new one."

Banner while no form is live: "WhatsApp only lets verified businesses publish forms. Until verification is done you can preview forms and send tests."

One `FormCard` per form (per account when there is more than one): title, description, a state pill and line, the questions the form asks (from the registry field labels, as a comma-separated line "Asks for: …"), and buttons by state:

| `state` | Pill | Line | Buttons |
|---|---|---|---|
| `not_created` | "Not at WhatsApp yet" (grey) | "Create it to preview and test." | "Create at WhatsApp" |
| `draft_invalid` | "Draft with errors" (red) | "WhatsApp found {n} problem(s) in this form. The technical lead needs to fix them." then each error's `message` in a list | "Upload again", "Delete draft" |
| `draft_ready` | "Draft" (amber) | "Ready to test. Publish it to use it with customers." | "Preview", "Publish", "Upload again" (only when `code_is_newer`), "Delete draft" |
| `live` | "Live" (green) | "Staff can send this form in chats." | "Preview", "Retire" |
| `live_update_waiting` | "Live, update waiting" (amber) | "A newer version of this form is ready." | "Preview", "Upload new version", "Retire" |
| `blocked` | "Blocked by WhatsApp" (red) | "WhatsApp has stopped this form because our server was failing. It cannot be sent." | "Preview" |
| `throttled` | "Limited by WhatsApp" (amber) | "Only 10 can be sent an hour until our server is healthy again." | "Preview" |
| `retired` | "Retired" (grey) | "No longer sent. Forms already sent can no longer be opened." | "Create a new copy" |

"Preview" opens Meta's preview link in a new tab. `last_error` shows in red under the line. "Upload new version" on a 409 `published_locked` shows the message and offers "Create a new copy". States: loading and error through `DataState`; no permission: "You do not have access to forms. Ask the owner to give your account the 'Templates' permission."

**Publish dialog:** title "Publish this form?"; body "Once it is live, staff can send “{title}” to customers. WhatsApp checks that the business is verified and in good standing."; input "Type the form's name to confirm"; buttons "Publish form", "Go back". Success toast "Published. Staff can now send it." Failure: the message stays in the dialog.

**Retire dialog:** title "Retire this form?"; body "Customers will no longer be able to open “{title}”, including ones already sent. This cannot be undone. You can create a new copy later."; the same confirm input; buttons "Retire form" (red), "Keep it".

**Secure connection card (Phase B, shown when the key is configured or a Phase B form exists):** title "Secure connection for live forms"; per number a row: label, and "In place" (green) for `VALID`, "Needs sending again" (red) for `MISMATCH`, "Not sent yet" (grey); button "Send our key to WhatsApp". When the key is not configured: "The technical lead has not set up the key on the server yet." and no button. Confirm before sending: "Send the public half of our key to WhatsApp for {label}? This is safe to repeat."

### 7.3 In the chat — `apps/admin/src/components/inbox/` (both apps get these)

**Composer** (`Composer.tsx`, new `FlowPicker.tsx`): a button "Send a form" (icon `ClipboardList`) beside the template button, shown when the user has `inbox.reply` and `GET /v1/inbox/flows` returns at least one form. It opens a modal titled "Send a form": a list of forms (title, description; those not live are greyed with "Not live yet", unless the user has `templates.manage`, who sees "Send as a test" when `testable`). Choosing one shows a text area "Message above the button" pre-filled with the default message (counter "/1024"), a preview bubble with the button text, and "Send form". Outside the 24-hour window the button is disabled with the hint "Forms can only be sent within 24 hours of the customer's last message. Send a template first." Calls go in `apps/admin/src/lib/inbox-api.ts` (`inboxApi.flows()`, `inboxApi.sendFlow(id, { flow_key, message, test })`, key `inboxKeys.flows = ["inbox","flows"]`).

**Timeline** (`Timeline.tsx`, new `FlowCards.tsx`):
- Outbound `flow_sent`: the normal bubble with the message text and, under it, a button-shaped row (not clickable) "📋 {cta}" and the caption "Form: {title}".
- Inbound `flow_response`: instead of the plain bubble, a card: header "📋 {title}" with a pill "New" (amber) or "Handled by {name}, {time}" (grey); a two-column list of `rows` (label in grey, value in normal text; `longtext` values wrap and keep line breaks; values are rendered as text, never as HTML); the amber slot warning when present; then buttons: "Mark as handled" (or "Mark as not handled"), "Add to notes", and for a delivery address "Save as their address". "Save as their address" opens a confirm: title "Save this address to the contact?", a "Now" / "After" pair (empty shows "(none)"), buttons "Save address", "Cancel"; success toast "Address saved to the contact."
- Pure helpers in `apps/admin/src/lib/inbox-logic.ts` with tests: `flowCardActions(response, canReply): string[]` and `formatFlowValue(kind, value): string`.
- Add `"flow"` and the preview text to `messagePreview` in `packages/shared/src/inbox.ts`: type `flow` with no body → "📋 Form sent".

## 8. Rules and edge cases

1. A form can be sent to a customer only when its current version is `PUBLISHED`. A draft can be sent only with `test: true` by someone with `templates.manage`.
2. An interactive form message obeys the 24-hour window, checked on our side before Meta is called.
3. Sending a form writes the message row as `queued` first, then calls Meta (foundation rule 9). A timeout shows as unconfirmed, exactly as other messages do.
4. Every form message carries a signed token; the token's key and conversation are checked when the endpoint is called (Phase B) and used as a fallback to identify the form when an answer arrives.
5. An answer is stored once per WhatsApp message ID. Replaying the webhook changes nothing.
6. An answer whose `response_json` cannot be parsed is still stored (as `_raw`) and shown as a card titled "Form" with one row "Answer".
7. An answer for a form we cannot identify is stored with `flow_key = 'unknown'` and shown generically; no label is added.
8. Unanswered optional fields are simply absent from the card. The card never shows `flow_token` or `flow_key`.
9. Changing a live form: try `POST /assets` on the same Flow. If Meta accepts and the form drops back to `DRAFT`, the card shows "Draft" and it must be published again (the previous messages keep working with the old content, per Meta's lifecycle page). If Meta refuses, the screen offers "Create a new copy", which makes version + 1; the old version stays live until staff publish the new one and retire the old one.
10. Publishing needs: no validation errors, the uploaded hash equal to the repo hash, and the typed name. For an endpoint form also a `VALID` key on every active number of the account.
11. Retiring the only live version needs the extra confirmation (`force`).
12. Only drafts can be deleted, at Meta and here.
13. The answer's label is added to the conversation automatically; nothing else changes without a person: no reply is sent, the contact is not edited, the conversation is not reassigned.
14. `save_address` is the only action that changes a customer row, and only on a button press with a before-and-after confirm. Ingestion never modifies an existing customer (foundation D2).
15. A complaint answer raises one owner alert with no customer details in it.
16. Erasing a customer deletes their form answers.
17. Phase B: the endpoint answers `ping` without touching the database.
18. Phase B: a bad signature is 432; undecryptable is 421; a bad, expired or wrong-form token is 427 with the customer-facing line. None of these write anything.
19. Phase B: the endpoint never logs the decrypted body, the AES key, the IV or the token; it logs action, screen and outcome only.
20. Phase B: the endpoint must answer inside 8 seconds or give up with 500; the slot queries use only indexed lookups (`idx_wa_flow_response_slot`, hours rules for one profile).
21. Phase B: a slot is never offered when it is full, in the past, inside the 3-hour lead time, outside opening hours or on a holiday; it is re-checked when the customer confirms.
22. Phase B: the private key exists only in the server environment. `GET /encryption` returns booleans and Meta's status, never key text. The public key may appear only in the request to Meta.
23. If the private key is missing, Phase B forms are hidden and the endpoint answers 503; Phase A is unaffected.
24. A `flows` webhook event for a Flow we do not hold is marked processed and ignored.
25. All four Phase A JSON files must stay valid for the registry: a unit test checks that every registry field name appears in the file's `complete` payload and that every screen named by `entryScreen` exists.
26. Works at 390 px: the card's two columns stack; the Forms tab cards are full width.

## 9. Tests

`packages/shared/src/wa-flows.test.ts`
- `registry: keys are unique, cta is 30 characters or fewer, default message is 1024 or fewer`

`packages/domain/src/meta/flows/definitions.test.ts`
- `every definition parses, has version 7.3 and a terminal screen with a Footer`
- `every screen id is upper-case letters and underscores and is not SUCCESS`
- `labels and helper texts are within the limits in section 3.3` (walk every component)
- `every registry field is in the complete payload, and the payload carries flow_key`
- `no screen has more than 50 components; the entry screen exists`
- `only delivery_slot has data_api_version and routing_model`
- `flowJsonHash is stable for the same file`

`packages/domain/src/meta/flow-token.test.ts`
- `round-trips key and conversation`
- `rejects a changed token, a wrong secret and an expired token`

`packages/domain/src/meta/flow-responses.test.ts`
- `parseFlowReply reads response_json and the token`
- `parseFlowReply survives invalid JSON`
- `flowResponseCard orders rows by the registry, maps choice ids to titles, and lists unknown keys last`
- `flowResponseCard hides flow_token and flow_key`

`packages/domain/src/inbox/inbox.test.ts` (extend)
- `buildSendPayload builds an interactive flow message for navigate and for data_exchange`
- `parseInbound gives an nfm_reply the body "Completed a form"`

`packages/domain/src/meta/flow-crypto.test.ts` (throwaway key pair made in the test)
- `decrypts a request encrypted the way Meta does` (the test encrypts with the public key, OAEP SHA-256, AES-128-GCM, tag appended)
- `encryptFlowResponse output decrypts with the flipped IV`
- `a wrong key or a tampered body throws FlowDecryptError`
- `flowPublicKeyPem derives the matching public key`

`packages/domain/src/meta/flow-slots.test.ts` (database test or with a fake executor)
- `offers only windows inside opening hours, after the lead time, not on holidays`
- `a window with four bookings is not offered`
- `handleSlotFlow: INIT gives days; a day gives slots; a free slot gives SUCCESS with the token; a full slot comes back with the message`

`packages/shared/src/inbox-templates.test.ts` and `packages/domain/src/inbox/template-send.test.ts` (extend, section 5.5a)
- `a template with one FLOW button is sendable and reports flowButtons; two FLOW buttons are not`
- `buildTemplateComponents adds the flow button with sub_type flow, a string index and the token`
- `prepareTemplateContent keeps link-button values and form buttons together in index order`

`apps/api/test/integration/wa-flows.test.ts` (Graph stub keyed by URL)
- `management routes need templates.manage`
- `create stores the Meta id, hash and validation errors, and never asks Meta to publish`
- `publish is refused with errors, with a stale upload, and with the wrong name; succeeds and reads back`
- `upload on a live form that Meta refuses returns published_locked; new-version makes version 2 with the _v2 name`
- `retire needs force when it is the only live version`
- `send: refused outside the window, refused when not live, sends flow_id, cta, token and mode, stores payload.flow`
- `send as a test uses mode draft and needs templates.manage`
- `a template with a form button sends outside the window with a token, and its answer is matched to the form`
- `a template whose form is unknown or not live is refused before Meta is called`
- `an nfm_reply webhook stores one response, sets the message body, adds the label, and a replay adds nothing`
- `the response is matched to the form through context.id, then flow_key, then the token`
- `a complaint answer raises one owner alert`
- `timeline returns flow_response rows and flow_sent`
- `actions: handled, reopen, add_note, save_address (with before and after), each audited; a hidden conversation is 404`
- `erasing the customer deletes their form answers`

`apps/api/test/integration/wa-flow-endpoint.test.ts` (Phase B; key pair generated in `beforeAll` and put in `process.env`)
- `503 without a key; 432 on a bad signature; 421 on an undecryptable body`
- `ping answers active`
- `an error notice is acknowledged`
- `427 with the customer line for an expired token and for another form's token`
- `INIT → PICK_DAY, day → PICK_TIME, slot → SUCCESS, each decryptable with the flipped IV`
- `the response is text/plain and nothing is written to inbox_webhook_event`
- `flows webhook: FLOW_STATUS_CHANGE updates the row and BLOCKED raises one alert`
- `encryption routes never return key text`

`apps/admin/src/lib/inbox-logic.test.ts` (extend): `flowCardActions` and `formatFlowValue` cases. `apps/suite/src/features/templates/forms/form-labels.test.ts`: every state has a pill and a line.

## 10. Manual check

**Phase A**, signed in as an admin tester, with a tester phone that has written to the test number in the last 24 hours:

1. Templates and forms → Forms. Four cards, all "Not at WhatsApp yet".
2. Delivery address → Create at WhatsApp. The card becomes "Draft" with no errors. (If WhatsApp lists errors, stop: the JSON needs fixing against the listed lines.) Repeat for the other three.
3. Preview each: Meta's preview opens; walk through every screen; check the wording against section 7.1.
4. Open the tester's chat → Send a form → Delivery address → Send as a test. On the phone, tap "Add address", fill it in (leave the landmark empty), send.
5. In the chat: a card "Delivery address" with five rows and a "New" pill appears within seconds; the chat gains the label `delivery-address`; the list preview reads "Completed form: Delivery address".
6. Press "Save as their address", check Now / After, confirm. The contact panel shows the address.
7. Press "Mark as handled". Reload: the pill still reads "Handled by …".
8. Send the complaint form as a test and complete it: the owner's alert arrives; the chat has the label `complaint`.
9. Sign in as a manager (no `templates.manage`): the Forms tab is not reachable; in the chat the forms show "Not live yet".
10. Publish one form. If the business is not yet verified, note WhatsApp's refusal message exactly in the pull request; the banner explains it to staff. If it publishes: send it without "test" and complete it.
11. Wait until the tester's 24 hours have passed (or use an old chat): "Send a form" is disabled with the hint.
12. In the template editor (spec 06) make a utility template with a "Form button" for a live form, submit it, and once approved send it to a chat whose 24 hours have passed. The customer can open and complete the form; the card arrives. (Needs a published form; skip and note it if step 10 was refused.)
13. Repeat steps 4 to 7 at 390 px wide.

**Phase B** (after Tes has done section 5.9 steps 1 to 5 on the server):

14. Forms → Secure connection → Send our key to WhatsApp → "In place".
15. Create the "Delivery time" form; preview it; send it as a test; on the phone the days shown are the next open days; pick a day, then a time; the card "Delivery time" arrives with the chosen slot.
16. Book the same slot four times from tester chats, then open the form again: that time is no longer listed.
17. Stop the `api` container for a minute and tap the form: WhatsApp shows its own error; start the container; the form works again. Check no key text appears in `docker logs`.

## 11. Done when

- [ ] Migration 0076, journal entry and Drizzle schema are in.
- [ ] Phase A: all four JSON files exist, pass the definition tests, and come back from Meta with no validation errors.
- [ ] Phase A: every test in section 9 except the endpoint file passes; lint, type-check, admin tests and the suite build are clean; manual steps 1 to 13 pass.
- [ ] Phase B: the endpoint tests pass; manual steps 14 to 17 pass; a search of the repository and the logs finds no key material.
- [ ] The pull request lists each [unverified] fact and what was found, and states which answer Meta gave for "can a live form be changed" (rule 9).
- [ ] A hand-off note in `docs/handoffs/` tells Tes the Phase B set-up steps (section 5.9) and the `flows` webhook field.

## 12. Out of scope

- A form builder in the suite. Forms are JSON files in the repository, changed by pull request.
- Media upload inside forms (`PhotoPicker`, `DocumentPicker`), login or payment forms, the Flows metrics API.
- Turning a bulk-order or pickup answer into a shop order automatically (blueprint stage 7).
- Enforcing delivery capacity against real orders: Phase B counts only slots booked through the form (section 14, item 4).
- Forms on Messenger or Instagram (Flows are WhatsApp only).
- Automatic sending of forms (for example after checkout). Every send is a person's action.

## 13. Work order

**Phase A**

1. Migration 0076, journal, `wa-flow.ts` schema. Build packages.
2. Registry `packages/shared/src/wa-flows.ts` with its test.
3. The four JSON files, `definitions.ts`, and the definition tests.
4. `flow-token.ts` with tests.
5. `flows.ts` (Flows API calls except the Phase B ones) with `explainFlowError`.
6. `OutboundContent` type `flow`, `buildSendPayload`, `SendInput.payloadExtra`, `messagePreview`; unit tests.
7. `flow-responses.ts`; the `nfm_reply` branch in `parseInbound` and `ingestMessage`; unit tests.
8. Routes `/v1/wa-flows` (list, create, upload, new-version, preview, publish, retire, delete-draft, sync); register in `test-app.ts`; integration tests.
9. Inbox routes: `GET /flows`, `POST /conversations/:id/flows`, timeline fields, `POST /flow-responses/:id/action`, erase; the complaint alert in `outbox.ts`; integration tests.
10. Worker job `wa_flow_sync`.
11. Suite: `flows-api.ts`, labels, `FormsTab`, `FormCard`, publish and retire dialogs, the tab and route.
12. Admin (shared) screens: `FlowPicker` in the composer, `FlowCards` in the timeline, logic helpers and tests.
13. Template form buttons (section 5.5a): `templateNeeds`, `buildTemplateComponents`, `prepareTemplateContent`, the send route, and the "Form button" in spec 06's editor; tests.
14. Manual check steps 1 to 13. Open the Phase A pull request.

**Phase B** (a second pull request)

15. Env names, `flow-crypto.ts` with tests.
16. `flow-slots.ts` with tests; `delivery-slot.flow.json`; extend the definition tests.
17. `uploadFlowPublicKey`, `getFlowPublicKeyStatus`, `setFlowEndpoint`; the encryption routes; endpoint-form rules in create and publish.
18. `webhooks-whatsapp-flows.ts`, registered in `test-app.ts`; endpoint integration tests.
19. The `flows` webhook field in ingest and the health alert.
20. Suite: `SecureConnectionCard`; the Phase B form appears in the list and the picker.
21. Hand-off note for Tes; manual check steps 14 to 17.

## 14. Open questions

1. **Can a draft form be sent to a tester before the business is verified?** Meta's pages say verification is needed to send Flows to customers and that drafts can be sent with `mode: "draft"`; they do not say whether an unverified business may do the latter. Default: build as written; if Meta refuses, Phase A is still testable through the preview link and the stubbed tests, and the pull request records the refusal.
2. **For the foundation and specs 01 and 02: WhatsApp webhooks can now arrive without `from`.** When a customer has adopted a WhatsApp username, `from` and `wa_id` are left out and only `from_user_id` (a business-scoped ID) is present. Today `ingestMessage` drops any message whose `from` is not a phone number, so such a customer's messages, form answers included, would be silently lost. This is wider than this spec. Default here: no change in 07; spec 01's identity work (`inbox_identity` with `channel = 'whatsapp'`, `external_id = from_user_id`) should cover it, and until then add a warn-level log line when a message has no `from`.
3. **Meta contradicts itself on changing a live form** (section 3.2). Default: rule 9 handles both answers.
4. **Slot capacity.** Four per two-hour window, counted only from form bookings, is a placeholder. Default: ship with constants in `flow-slots.ts`; ask the owner for the real numbers and whether delivery areas should limit the times.
5. **`data_api_version` 3.0 or 4.0.** 4.0 is recommended since Nov 2025 but its request format is not on the guide page. Default: 3.0; move to 4.0 and verify `flow_token_signature` (a JWT signed with the app secret) in a follow-up once the page is read.
6. **Delivery areas in the address form** are a fixed list of 13. Default: ship it; replace it with the shop's real delivery zones (the `zones` data behind `juice-delivery-lagos`) in a follow-up pull request, which needs a new upload of the form.
7. **Foundation D11 and rule 5 do not fit the Phase B endpoint**: it is not stored in `inbox_webhook_event` because it is a live exchange that must answer in seconds and cannot be replayed. Default: as specified in 5.9, step 10.
8. **Where the "Secure connection" set-up belongs.** It is under Forms because only forms use it. If spec 01's Channels page grows a per-number technical section, it could move there. Default: leave it under Forms.

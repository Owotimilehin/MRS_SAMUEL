# MS Staff: the phone app for the unified inbox

A React Native (Expo) app for staff to answer WhatsApp chats and take or make
phone calls from their own phone. It talks to the same API as the admin web app
(`apps/api`, routes under `/v1/inbox`).

**Status: written and type-checked, never run on a phone.** See
"What has not been tested" before anyone relies on it.

## What it does

| Screen | What staff can do |
| --- | --- |
| Sign in | Same email and password as the admin web app. |
| Inbox | Tabs Mine / Unassigned / Team / All (Team and All only for people allowed to see them), search by name or phone, filter by business number, Open/Closed toggle, unread counts. Refreshes every 10 seconds while the app is open, and straight away when a push arrives or the app comes back to the front. |
| Conversation | Messages with ticks (sent, delivered, read) and a red "Not sent" state, photos and files, call cards with recording playback plus transcript and AI summary (only for people allowed), internal notes, reply box with attach / quick replies / templates. The 24-hour WhatsApp window is shown at the top; when it is closed, free text is switched off and only templates can be sent. "More" menu: assign to me, assign to someone, unassign, close or reopen, view contact. "Call" button for people allowed to call out. |
| Contact | Name, phone, notes (editable), and every conversation with that customer. |
| Settings | "Available for calls" switch, message notification level (Mine / Everything / Off), check notifications, sign out. Signing out removes this phone's push token first, so the next person's messages don't arrive on it. |
| Calls | Incoming calls ring with the phone's own call screen (CallKit on iPhone, full-screen call notification on Android), even when the app is closed. In-app banner with Answer / Decline when the app is open. In-call screen with mute, speaker and hang up. If two people answer, the second is told "someone else already answered". |

## Running it

The calling library (Twilio Voice) is native code, so the app **does not run
in Expo Go**. You need a "development build": your own copy of the app with the
native parts compiled in. You build it once, then day-to-day JavaScript changes
reload instantly.

Everything happens inside `mobile/`. This folder is deliberately **outside** the
pnpm workspace: it has its own `package.json` and `package-lock.json`, and uses
`npm`, not `pnpm`.

```sh
cd mobile
npm ci                    # install exactly what package-lock.json says
npm run typecheck         # TypeScript, strict
npm test                  # unit tests for the pure helpers
```

### Option A: build in the cloud with EAS (recommended)

Needs an Expo account (free tier is fine to start).

```sh
npm install -g eas-cli
eas login
eas init                                   # creates the Expo project; copy the project id
eas build --profile development --platform android   # or ios
```

Install the build on your phone from the link EAS gives you, then:

```sh
EAS_PROJECT_ID=<id> EXPO_PUBLIC_API_BASE_URL=<api url> npx expo start --dev-client
```

### Option B: build on your own machine

Needs Xcode (iPhone) or Android Studio with a JDK (Android).

```sh
EAS_PROJECT_ID=<id> npx expo run:ios       # or: npx expo run:android
```

This generates `ios/` and `android/` folders. They are build output (git
ignores them); all native settings live in `app.config.ts` and
`plugins/withFcmRouter.js`.

### Settings (environment variables, none are secret)

| Name | What it is |
| --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | The API address. Defaults to `https://api.mrssamuel.com`. **Confirm this is right** (DEPLOY.md lists `api.mrssamuel.com`, but nobody has checked it from a phone). For a local API on your laptop, use your laptop's network address, not `localhost`. |
| `EAS_PROJECT_ID` | Expo project id from `eas init`. Without it the app can't get a push token. |
| `APP_VARIANT` | `development` gives a separate app ("MS Staff (dev)", bundle id `com.mrssamuel.staff.dev`) that can sit next to the real one. EAS profiles set this for you. |
| `GOOGLE_SERVICES_JSON` | Path to the Android Firebase file. In EAS, upload it as a "file" environment variable with this name. |

The bundle ids `com.mrssamuel.staff` / `com.mrssamuel.staff.dev` are placeholders.
**Pick the final ones before creating the store listings**; they can't be changed after.

## Push and call setup (one-off, done by the owner)

There are two separate kinds of push:

1. **Message notifications** (new WhatsApp message). The worker sends these through
   Expo's push service (`apps/worker/src/jobs/inbox-push.ts`). Expo needs:
   - **Android:** a Firebase project. Add an Android app with the final package
     name, download `google-services.json` (goes to EAS, never git), and upload a
     Firebase service-account key to EAS (`eas credentials` → Android → FCM V1).
   - **iPhone:** an Apple Push Notifications key (.p8). `eas credentials` can create
     and store it for you.
2. **Incoming calls.** These go straight from Twilio to the phone, not through Expo.
   Twilio needs one "Push Credential" per platform (Twilio Console → Voice →
   Credentials):
   - **iPhone:** a VoIP Services certificate from the Apple Developer site for the
     app's bundle id, uploaded to Twilio as an APN credential. Tick "sandbox"
     only for the dev build's credential.
   - **Android:** the same Firebase project's server key / service account,
     uploaded to Twilio as an FCM credential.

   Then set on the **API server** (names only here; the values are Twilio
   credential SIDs, starting `CR`):
   - `TWILIO_PUSH_CREDENTIAL_SID_IOS`
   - `TWILIO_PUSH_CREDENTIAL_SID_ANDROID`

   The app asks for its call token with `?platform=ios|android`, and the API puts
   the matching credential in it. Without these, calls still work while the app is
   open, but a closed phone won't ring.

A phone only rings when the person has "Available for calls" switched on **and**
has opened the app in the last 12 hours (the API's `MOBILE_REACHABLE_MS`). The
app checks in every time it is opened or brought to the front.

## Accounts needed

- **Apple Developer Program** (paid yearly, in the business's name) for TestFlight,
  the App Store, push keys and the VoIP certificate. Distributing only to staff
  can use TestFlight or Apple Business Manager "custom app"; it still needs this account.
- **Google Play Console** (one-off fee) for Play Store / internal testing. Android
  can also be installed straight from an EAS link without the store.
- **Expo account** for EAS builds and the push service.
- **Firebase project** (free) for Android push.
- The existing **Twilio** account (Push Credentials as above).

## How sign-in works on the phone

The app uses the same login as the admin web app: `POST /v1/auth/login` sets two
cookies that JavaScript can't read (`ms_session` for 30 minutes, `ms_refresh` for
30 days). The phone's own cookie store keeps them and sends them back. When the
API says 401, the app calls `POST /v1/auth/refresh` once and retries; if that
fails, it goes back to the sign-in screen. Every request sends a stable
`x-device-id`, so sessions and the audit log can tell phones apart.

No API change was needed for this. If on-device testing shows cookies being lost
(for example after the phone kills the app), the fallback is a small API change:
let `requireAuth` accept `Authorization: Bearer <token>`, and let login/refresh
return the tokens in the response body for the mobile app, which would then keep
them in the phone's secure storage.

## Android: one notification service for two senders

Expo (message pushes) and Twilio (call pushes) both want to receive Firebase
messages, but Android gives each message to only one of them. Twilio's would win
and drop message notifications. `plugins/withFcmRouter.js` fixes this by
switching off Twilio's receiver and adding one (`MsFirebaseMessagingService`)
that passes call pushes to Twilio and everything else to Expo. This follows
Twilio's documented "out-of-band Firebase Messaging Service" approach. It has
been generated with `expo prebuild` but **not compiled**.

## What has not been tested

Nothing here has run on a phone or simulator. What was checked:

- `npx tsc --noEmit` (strict) passes.
- `npm test`: 29 unit tests for the pure helpers pass.
- `npx expo export` bundles the JavaScript for both iOS and Android.
- `npx expo prebuild` generates both native projects with the call, push and
  Android routing changes in place.

Still to test on real phones (an iPhone is required for calls; CallKit doesn't
work in the simulator):

1. Sign in, then close and reopen the app: still signed in? Again after 30+ minutes?
2. A WhatsApp message arrives: push shows, tapping it opens the right chat. **Android especially** (the routing service above).
3. Incoming call with the app open, in the background, and fully closed; on both platforms.
4. Two staff phones ring; both answer: the second gets "someone else already answered".
5. Outgoing call from a chat; mute, speaker, Bluetooth headset, hang up.
6. Send text, photo, PDF, quick reply, and a template with variables; a chat whose 24-hour window has closed.
7. Recording playback and transcript; a person without `recordings.listen` sees no Play button.
8. Sign out: that phone stops getting pushes and calls.
9. Dark mode, small phones, large text.

## Where things are

```
app/                    screens (expo-router: the file path is the route)
  login.tsx
  (app)/_layout.tsx     signed-in shell: push set-up, call set-up, incoming-call banner
  (app)/index.tsx       inbox list
  (app)/conversation/   chat screen
  (app)/contact/        contact screen
  (app)/settings.tsx
  (app)/call.tsx        in-call screen
src/lib/
  api.ts                fetch wrapper: cookies, refresh on 401, retries, idempotency keys
  auth.tsx              session, sign in / out
  inbox-api.ts          every API call the app makes
  inbox-types.ts        API shapes (copied from apps/admin/src/lib/inbox-types.ts)
  inbox-logic.ts        pure helpers (copied from apps/admin/src/lib/inbox-logic.ts and packages/shared/src/inbox.ts)
  push.ts               message notifications
  voice.ts              Twilio calls
src/components/         timeline bubbles and cards, reply box, small UI pieces
plugins/withFcmRouter.js  Android notification routing (see above)
```

The copied files say so at the top. When the API's shapes or rules change,
update them here too.

## Versions

Expo SDK 57 (React Native 0.86), because the Twilio Voice SDK 1.8.1 is verified
up to Expo 57; Expo 58 is newer than Twilio supports. All versions are pinned
exactly and were at least two weeks old when chosen. `npx expo install --check`
lists a few newer patch releases (for example `expo` 57.0.33); they are safe to
take later with `npx expo install --fix`, then re-run the checks above.

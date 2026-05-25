# Instagram feed endpoint setup

## Required env vars

Set these on the API server (Render / local `.env`):

```
IG_BUSINESS_ACCOUNT_ID=17841...     # from GET /{page-id}?fields=instagram_business_account
IG_ACCESS_TOKEN=EAAB...             # long-lived (60-day) token
```

## Getting the values (one-time, ~10 min)

1. **Instagram must be Business or Creator** account, connected to a Facebook Page you manage.

2. Go to https://developers.facebook.com/apps → "Create App" → Business type.

3. In the app dashboard: "Add Product" → **Instagram Graph API** → Set up.

4. Open **Graph API Explorer**:
   - Select your app (top-right)
   - "Generate Access Token" with permissions: `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_insights`, `business_management`
   - Copy the short-lived token

5. Exchange for a **long-lived (60-day) token** — visit in browser:
   ```
   https://graph.facebook.com/v18.0/oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id={APP_ID}
     &client_secret={APP_SECRET}
     &fb_exchange_token={SHORT_LIVED_TOKEN}
   ```
   The `access_token` in the response is your `IG_ACCESS_TOKEN`.

6. Get the **Instagram Business Account ID** — back in Graph API Explorer with the long-lived token:
   ```
   GET /me/accounts
   ```
   Copy your page `id`, then:
   ```
   GET /{PAGE_ID}?fields=instagram_business_account
   ```
   The returned `instagram_business_account.id` is your `IG_BUSINESS_ACCOUNT_ID`.

## Token refresh

Long-lived tokens expire after 60 days. Set a reminder or implement automatic refresh by calling:
```
GET /v1/{IG_BUSINESS_ACCOUNT_ID}?fields=id&access_token={CURRENT_TOKEN}
```
At least once every ~45 days — any successful API call refreshes the token's expiry.

## Caching

The endpoint caches the feed in Redis for 30 minutes (`CACHE_KEY = ig:feed:v1`).
Graph API limit is 200 calls/hour per user — with 30-min cache we use at most 2 calls/hour even under heavy traffic.

## Endpoint

`GET /v1/public/instagram/feed` returns:

```json
{
  "data": [
    {
      "id": "17890...",
      "imageUrl": "https://scontent.cdninstagram.com/...",
      "permalink": "https://www.instagram.com/p/...",
      "caption": "Cold-pressed Sunrise Blend...",
      "isVideo": false,
      "timestamp": "2026-05-17T08:30:00+0000"
    }
  ],
  "cached": true
}
```

On error (missing env / token expired / API down) returns `{ "data": [], "error": "..." }` — the frontend falls back to bottle/fruit placeholder tiles automatically.

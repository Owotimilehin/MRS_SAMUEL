# Receipt storage — Cloudflare R2 one-time setup

The bookkeeping receipt uploads use a private R2 bucket with presigned PUT/GET.

## Bucket

1. Cloudflare dashboard → R2 → Create bucket → `mrs-samuel-receipts`.
2. Settings → CORS → add policy:

```json
[
  {
    "AllowedOrigins": ["https://admin.mrssamueljuice.com", "http://localhost:5173"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

3. R2 → Manage R2 API Tokens → Create API token → scope "Object Read & Write" on
   `mrs-samuel-receipts`. Save the Access Key ID + Secret.

## Env vars (server)

```
R2_ACCOUNT_ID=<your cloudflare account id>
R2_ACCESS_KEY_ID=<token access key id>
R2_SECRET_ACCESS_KEY=<token secret>
R2_BUCKET=mrs-samuel-receipts
```

Set on the deploy host alongside the existing `.env`. Restart the api container.

## Verification

After deploy, the owner clicks "Add expense" → attaches a JPEG. The file should land
in R2 under `expense-receipts/<yyyy>/<mm>/<uuid>.jpg`. If presign returns 503, env
vars are missing on the server (the upload endpoint reports
`service_unavailable` until the four R2 vars are populated).

## Local development

R2 is optional locally. With the vars unset, the API returns 503 from the presign
endpoint; expense create/edit/list/delete still work, just without a receipt attached.

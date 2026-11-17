# Inbox staging copy

A second copy of the app on the same server, for testing WhatsApp and calls with **test numbers** before go-live. Written 17 Nov 2026. It has not been run yet (no Docker where it was written), so treat the first start as a test.

## Start it (Tes)

1. Add DNS / Cloudflare Tunnel hostnames for staging (for example a staging admin and a staging API hostname) pointing at ports 4010 and 4001 on the server.
2. On the server, create a staging settings file next to the production one (name it `staging.env`). It must set:
   - `POSTGRES_DB=ms_staging` and a `DATABASE_URL` that ends in `/ms_staging`
   - a new `JWT_SIGNING_KEY`, different from production
   - `PUBLIC_API_URL`, `PUBLIC_ADMIN_URL`, `PUBLIC_CUSTOMER_URL` = the staging hostnames
   - the `META_*` values for the **test** number and the `TWILIO_*` values for a **test** number
   - **no** production payment, delivery, Telegram or email keys
3. Start it:
   `docker compose -p ms-staging --env-file staging.env -f docker-compose.yml -f docker-compose.staging.yml up -d --build`
4. Point the Meta test app's webhook and the Twilio test number at the staging API hostname (paths are in `docs/handoffs/2026-11-17-unified-inbox.md`).

Because the project name is `ms-staging`, it gets its own containers, network and volumes. The production stack is not touched. The deploy workflow only rebuilds production; rebuild staging by hand with the same command.

## Stop or remove

`docker compose -p ms-staging down` (add `-v` to also delete the staging database).

## Memory

The staging services are capped at about 2 GB in total. If the server has less than 4 GB free, stop staging when nobody is testing.

## Load test

`node scripts/inbox-load-test.mjs --base https://<staging-api> --secret <staging META_APP_SECRET> --number-id <test phone number id> --rate 20 --seconds 60 --streams 50 --cookie "ms_session=<a staging login cookie>"`

The script refuses to run against the production hostnames.

Local result on 17 Nov 2026 (one API process on a laptop, local Postgres): 1,200 messages at 20 a second with 50 live connections. 0 lost, 0 duplicated, 95% answered within 14 ms, about 15% of one CPU core, 264 MB of memory.

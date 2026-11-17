#!/usr/bin/env node
/**
 * Inbox load test: signed WhatsApp webhooks at a steady rate while N staff
 * hold the live-updates stream open. NEVER point this at production.
 *
 *   node scripts/inbox-load-test.mjs --base http://localhost:3021 --secret <META_APP_SECRET> \
 *     --number-id <wa_phone_number_id> --rate 20 --seconds 60 --streams 50 --cookie "ms_session=…"
 *
 * Reports webhook latency (p50/p95/p99), errors, and how many live events the
 * streams received. 5% of messages are sent twice to prove duplicates are ignored.
 */
import crypto from "node:crypto";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const base = arg("base", "http://localhost:3021");
if (/mrssamuel|mrsamuel/.test(base)) throw new Error("refusing to load-test a real host");
const secret = arg("secret");
const numberId = arg("number-id");
const rate = Number(arg("rate", "20"));
const seconds = Number(arg("seconds", "60"));
const streams = Number(arg("streams", "50"));
const cookie = arg("cookie", "");
const customers = Number(arg("customers", "200"));
if (!secret || !numberId) throw new Error("--secret and --number-id are required");

const run = crypto.randomBytes(4).toString("hex");
const lat = [];
let sent = 0, ok = 0, failed = 0, dupes = 0, events = 0, streamErrors = 0;

function payload(n) {
  const from = `23470${String(10000000 + (n % customers)).slice(-8)}`;
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "LOAD", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: numberId },
      contacts: [{ profile: { name: `Load ${n % customers}` }, wa_id: from }],
      messages: [{ from, id: `wamid.load.${run}.${n}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: `load message ${n}` } }],
    } }] }],
  });
}

async function post(body) {
  const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  const t = performance.now();
  try {
    const res = await fetch(`${base}/v1/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
    await res.arrayBuffer();
    lat.push(performance.now() - t);
    if (res.status === 200) ok++; else failed++;
  } catch { failed++; }
}

const aborts = [];
async function openStream() {
  const ac = new AbortController();
  aborts.push(ac);
  try {
    const res = await fetch(`${base}/v1/inbox/stream`, { headers: { cookie }, signal: ac.signal });
    if (!res.ok) { streamErrors++; return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      events += (dec.decode(value).match(/^event: message\.created/gm) ?? []).length;
    }
  } catch { /* aborted at the end */ }
}

if (cookie) for (let i = 0; i < streams; i++) void openStream();
await new Promise((r) => setTimeout(r, 1500));

const total = rate * seconds;
const started = performance.now();
const pending = [];
for (let n = 0; n < total; n++) {
  const due = started + (n * 1000) / rate;
  const wait = due - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const body = payload(n);
  sent++;
  pending.push(post(body));
  if (n % 20 === 0) { dupes++; pending.push(post(body)); } // Meta-style retry of the same message
}
await Promise.all(pending);
const elapsed = (performance.now() - started) / 1000;
await new Promise((r) => setTimeout(r, 3000));
for (const ac of aborts) ac.abort();

lat.sort((a, b) => a - b);
const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))].toFixed(0) : "n/a");
console.log(JSON.stringify({
  run, rate, seconds: Number(elapsed.toFixed(1)), unique_messages: sent, duplicate_posts: dupes,
  http_ok: ok, http_failed: failed, latency_ms: { p50: pct(50), p95: pct(95), p99: pct(99), max: pct(100) },
  streams: cookie ? streams : 0, stream_errors: streamErrors,
  live_events_received: events, live_events_expected: cookie ? sent * (streams - streamErrors) : 0,
}, null, 2));

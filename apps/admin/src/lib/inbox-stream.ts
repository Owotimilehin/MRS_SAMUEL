/**
 * One shared Server-Sent Events connection to GET /v1/inbox/stream for the
 * whole tab, reference-counted: it opens when the first listener subscribes and
 * closes when the last one leaves.
 *
 * Events only say *what* changed; listeners refetch over REST. After any drop
 * we reconnect with jittered backoff (refreshing the session cookie first, in
 * case the 30-minute access token expired) and emit a synthetic "reconnected"
 * event so every screen refetches whatever it may have missed.
 */
import { useEffect, useRef } from "react";
import { refreshAccessToken } from "./api.js";
import { backoffDelay } from "./inbox-logic.js";
import type { InboxEvent } from "./inbox-types.js";
import { INBOX_EVENTS } from "@ms/shared";

const STREAM_URL = "/v1/inbox/stream";
type Listener = (e: InboxEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let attempt = 0;
let hadConnection = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function emit(e: InboxEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* one bad listener must not break the others */
    }
  }
}

function handle(name: string, raw: string): void {
  let data: Partial<InboxEvent> = {};
  try {
    data = JSON.parse(raw) as Partial<InboxEvent>;
  } catch {
    /* keep empty */
  }
  emit({ ...data, event: name });
}

function scheduleReconnect(): void {
  if (retryTimer || listeners.size === 0) return;
  const delay = backoffDelay(attempt++);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (listeners.size === 0) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      window.addEventListener("online", () => scheduleReconnect(), { once: true });
      return;
    }
    void refreshAccessToken().finally(open);
  }, delay);
}

function close(): void {
  if (source) {
    source.close();
    source = null;
  }
}

function open(): void {
  if (source || listeners.size === 0 || typeof EventSource === "undefined") return;
  const es = new EventSource(STREAM_URL, { withCredentials: true });
  source = es;
  es.addEventListener("ready", () => {
    attempt = 0;
    if (hadConnection) emit({ event: "reconnected" });
    hadConnection = true;
  });
  for (const name of [...INBOX_EVENTS, "session.ended"]) {
    es.addEventListener(name, (ev) => {
      handle(name, (ev as MessageEvent<string>).data);
      // The server ends the session when permissions change: start a fresh one.
      if (name === "session.ended") {
        close();
        scheduleReconnect();
      }
    });
  }
  es.onerror = () => {
    // Take over from the browser's fixed-interval retry so we can back off and
    // renew the session cookie before trying again.
    close();
    scheduleReconnect();
  };
}

/**
 * How long the connection is kept after the last listener leaves. Moving from
 * one page to another removes the old page's listener just before the new
 * page adds its own; without this pause every page change would drop the
 * connection and could miss a message that arrived in the gap.
 */
const LINGER_MS = 2_000;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;

export function subscribeInboxEvents(l: Listener): () => void {
  if (lingerTimer) {
    clearTimeout(lingerTimer);
    lingerTimer = null;
  }
  listeners.add(l);
  open();
  return () => {
    listeners.delete(l);
    if (listeners.size > 0 || lingerTimer) return;
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      if (listeners.size > 0) return;
      close();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      attempt = 0;
      hadConnection = false;
    }, LINGER_MS);
  };
}

/** React hook: run `onEvent` for every live inbox event while mounted. */
export function useInboxEvents(onEvent: Listener, enabled = true): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    if (!enabled) return;
    return subscribeInboxEvents((e) => ref.current(e));
  }, [enabled]);
}

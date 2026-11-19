/**
 * useInboxNotifier — tells staff when a customer writes, on any admin page.
 *
 * Mounted once in the Shell. Listens to the live inbox stream (the same one the
 * Inbox screen uses; it is shared, not opened twice) and, for a customer's
 * message this person should hear about:
 *
 *   • plays a short two-note sound (if switched on for this device)
 *   • shows a desktop pop-up when the tab is in the background (if allowed)
 *   • shows a banner in the app when the tab is in front
 *   • puts the number waiting in the tab title until they come back
 *   • refreshes the unread badge in the menu straight away
 *
 * Which chats alert is the person's saved level (all / mine and unassigned /
 * none). Nothing fires for the chat they are already reading.
 */
import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useAuthUser } from "../lib/auth.js";
import { inboxApi, inboxKeys } from "../lib/inbox-api.js";
import { channelName, conversationIdFromPath, identityName, shouldAlertForEvent, titleWithCount } from "../lib/inbox-logic.js";
import {
  desktopEnabled,
  playMessageSound,
  showDesktopAlert,
  soundEnabled,
  unlockSoundOnFirstGesture,
} from "../lib/inbox-notify.js";
import { useInboxEvents } from "../lib/inbox-stream.js";
import type { InboxEvent } from "../lib/inbox-types.js";
import { toast } from "../lib/toast.js";

/** A burst of messages from one customer makes one alert, not five. */
const QUIET_MS = 3_000;

// Kept outside the hook: the Shell is rebuilt on every page change, and these
// must survive that.
/** Messages that arrived while the tab was away; shown in the tab title. */
let waiting = 0;
/** When each conversation last alerted. */
const lastAlert = new Map<string, number>();

function tabActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function useInboxNotifier(enabled: boolean): void {
  const user = useAuthUser();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const level = useQuery({
    queryKey: inboxKeys.notifyLevel,
    queryFn: inboxApi.notifyLevel,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const levelRef = useRef(level.data);
  levelRef.current = level.data;

  // Wake the audio engine on the first click, so a later alert can be heard.
  useEffect(() => (enabled ? unlockSoundOnFirstGesture() : undefined), [enabled]);

  // Take the count off the tab title when the person comes back.
  useEffect(() => {
    if (!enabled) return;
    const clear = (): void => {
      if (!tabActive() || waiting === 0) return;
      waiting = 0;
      document.title = titleWithCount(document.title, 0);
    };
    window.addEventListener("focus", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("focus", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [enabled]);

  const onEvent = useCallback(
    (e: InboxEvent) => {
      const active = tabActive();
      const ok = shouldAlertForEvent(e, {
        userId: user.id,
        // Until the saved choice has loaded, use the server's default.
        level: levelRef.current ?? "assigned",
        openConversationId: conversationIdFromPath(pathRef.current),
        tabActive: active,
      });
      if (!ok) return;
      const convId = e.conversationId!;

      void qc.invalidateQueries({ queryKey: inboxKeys.unread });

      const now = Date.now();
      if (now - (lastAlert.get(convId) ?? 0) < QUIET_MS) return;
      lastAlert.set(convId, now);

      if (soundEnabled()) playMessageSound();
      if (!active) {
        waiting += 1;
        document.title = titleWithCount(document.title, waiting);
      }

      const open = (id: string): void =>
        void navigate({ to: "/inbox/$conversationId", params: { conversationId: id } });

      // Who wrote and what, through the same permission-checked route the inbox uses.
      void inboxApi
        .conversation(convId)
        .then((c) => {
          // Spec 02: say which app the message came from.
          const app = channelName(c.channel ?? "whatsapp");
          return {
            app: app as string | null,
            title: c.customer?.name || c.customer?.phone || identityName(c.identity) || `New ${app} message`,
            body: c.lastPreview || "New message",
          };
        })
        .catch(() => ({ app: null, title: "New message", body: "Open the inbox to read it." }))
        .then(({ app, title, body }) => {
          if (active) {
            toast.info(`New ${app ? `${app} ` : ""}message from ${title}: ${body.slice(0, 80)}`);
          } else if (desktopEnabled()) {
            showDesktopAlert({ conversationId: convId, title: app ? `${title} · ${app}` : title, body: body.slice(0, 140) }, open);
          }
        });
    },
    [navigate, qc, user.id],
  );

  useInboxEvents(onEvent, enabled);
}

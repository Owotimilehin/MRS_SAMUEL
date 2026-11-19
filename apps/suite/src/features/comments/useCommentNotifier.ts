/**
 * Tells staff when a customer leaves a comment, on any suite page (suite spec
 * 03, 7). Mounted once in the SuiteShell. It listens to the same live stream as
 * the Inbox (shared, not opened twice), which only opens for people with
 * inbox.view; everyone else sees the badge refresh instead.
 *
 * The signal carries no text, so the alert only says a comment arrived.
 */
import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useAuthUser } from "@admin/lib/auth.js";
import { inboxApi, inboxKeys } from "@admin/lib/inbox-api.js";
import { desktopEnabled, playMessageSound, showDesktopAlert, soundEnabled, unlockSoundOnFirstGesture } from "@admin/lib/inbox-notify.js";
import { useInboxEvents } from "@admin/lib/inbox-stream.js";
import type { InboxEvent } from "@admin/lib/inbox-types.js";
import { toast } from "@admin/lib/toast.js";
import { commentKeys } from "./comments-api.js";
import { shouldAlertForComment, threadIdFromPath } from "./comments-logic.js";

/** Several comments on one thread in a few seconds make one alert. */
const QUIET_MS = 3_000;
const lastAlert = new Map<string, number>();

function tabActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function useCommentNotifier(enabled: boolean): void {
  const user = useAuthUser();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  // The person's saved choice for message alerts covers comments too.
  const level = useQuery({ queryKey: inboxKeys.notifyLevel, queryFn: inboxApi.notifyLevel, enabled, staleTime: 5 * 60_000, retry: false });
  const levelRef = useRef(level.data);
  levelRef.current = level.data;

  useEffect(() => (enabled ? unlockSoundOnFirstGesture() : undefined), [enabled]);

  const onEvent = useCallback(
    (e: InboxEvent) => {
      if (!e.event.startsWith("comment.")) return;
      void qc.invalidateQueries({ queryKey: commentKeys.unread });
      const active = tabActive();
      const ok = shouldAlertForComment(e, {
        userId: user.id,
        level: levelRef.current ?? "assigned",
        openThreadId: threadIdFromPath(pathRef.current),
        tabActive: active,
      });
      if (!ok || !e.id) return;
      const threadId = e.id;
      const now = Date.now();
      if (now - (lastAlert.get(threadId) ?? 0) < QUIET_MS) return;
      lastAlert.set(threadId, now);

      if (soundEnabled()) playMessageSound();
      const open = (id: string): void => void navigate({ to: "/comments/$threadId", params: { threadId: id } });
      if (active) toast.info("New comment. Open Comments to read it.");
      else if (desktopEnabled()) showDesktopAlert({ conversationId: threadId, title: "New comment", body: "Open Comments to read it." }, open);
    },
    [navigate, qc, user.id],
  );

  useInboxEvents(onEvent, enabled);
}

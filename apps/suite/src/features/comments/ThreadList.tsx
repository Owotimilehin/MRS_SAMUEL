/** The list of comment threads, newest activity first (suite spec 03, 7). */
import { Facebook, Instagram } from "lucide-react";
import { networkName } from "@ms/shared";
import { listTime } from "@admin/lib/inbox-logic.js";
import { statusChip, threadTitle } from "./comments-logic.js";
import type { ThreadSummary } from "./comments-types.js";

export function ThreadList({
  threads,
  selectedId,
  onOpen,
}: {
  threads: ThreadSummary[];
  selectedId: string | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <ul className="cmt-list">
      {threads.map((t) => {
        const Icon = t.network === "instagram" ? Instagram : Facebook;
        return (
          <li key={t.id}>
            <button
              type="button"
              className={`cmt-item${t.id === selectedId ? " is-selected" : ""}${t.unread > 0 ? " is-unread" : ""}`}
              onClick={() => onOpen(t.id)}
              aria-current={t.id === selectedId ? "true" : undefined}
            >
              <span className="cmt-item__icon" title={networkName(t.network)}>
                <Icon size={16} aria-label={networkName(t.network)} />
              </span>
              <span className="cmt-item__main">
                <span className="cmt-item__top">
                  <span className="cmt-item__author">{threadTitle(t)}</span>
                  <time dateTime={t.last_activity_at}>{listTime(t.last_activity_at)}</time>
                </span>
                <span className="cmt-item__preview">{t.preview ?? "Photo or video"}</span>
                <span className="cmt-item__chips">
                  {statusChip(t).map((chip) => (
                    <span key={chip.text} className={`cmt-chip cmt-chip--${chip.tone}`}>
                      {chip.text}
                    </span>
                  ))}
                </span>
              </span>
              {t.post.picture_url && (
                <img
                  className="cmt-item__thumb"
                  src={t.post.picture_url}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              )}
              {t.unread > 0 && <span className="cmt-item__dot" aria-label="Not read yet" />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

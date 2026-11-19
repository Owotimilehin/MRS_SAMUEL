/** The post a thread belongs to: picture, text, date and a link out (suite spec 03, 7). */
import { useState } from "react";
import { networkName } from "@ms/shared";
import { dayLabel, lagosDayKey } from "@admin/lib/inbox-logic.js";
import type { ThreadSummary } from "./comments-types.js";

const SHORT = 280;

export function PostCard({ thread }: { thread: ThreadSummary }): JSX.Element {
  const { post, network } = thread;
  const [pictureFailed, setPictureFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const name = networkName(network);
  const text = post.message ?? "";
  const long = text.length > SHORT;
  return (
    <section className="cmt-post" aria-label="The post">
      {post.picture_url && !pictureFailed && (
        // Meta's picture links expire: when one stops loading, the card simply has no picture.
        <img className="cmt-post__picture" src={post.picture_url} alt="" onError={() => setPictureFailed(true)} />
      )}
      <div className="cmt-post__body">
        {post.fetch_error ? (
          <p className="cmt-post__note">This post is no longer available on {name}.</p>
        ) : !post.fetched && !text ? (
          <p className="cmt-post__note">Loading the post…</p>
        ) : (
          text && (
            <p className="cmt-post__text">
              {open || !long ? text : `${text.slice(0, SHORT)}…`}{" "}
              {long && (
                <button type="button" className="cmt-link" onClick={() => setOpen((v) => !v)}>
                  {open ? "Show less" : "Show more"}
                </button>
              )}
            </p>
          )
        )}
        <div className="cmt-post__meta">
          {post.posted_at && <span>{dayLabel(lagosDayKey(post.posted_at))}</span>}
          {post.is_ad && <span className="cmt-chip cmt-chip--grey">On an advert</span>}
          {post.permalink_url && (
            <a href={post.permalink_url} target="_blank" rel="noreferrer">
              Open on {name}
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

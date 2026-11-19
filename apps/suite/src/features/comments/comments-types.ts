/** What /v1/social/comments answers (suite spec 03, section 5.7). */
import type { CommentActions, CommentKind, CommentSendStatus, CommentStatus, SocialNetwork } from "@ms/shared";

export interface CommentAccount {
  id: string;
  label: string;
  network: SocialNetwork;
  is_active: boolean;
  comments_ready: boolean;
  backfilled_at: string | null;
  last_error: string | null;
}

export interface ThreadSummary {
  id: string;
  network: SocialNetwork;
  account_id: string;
  account_label: string;
  account_active: boolean;
  kind: CommentKind;
  author_name: string | null;
  author_username: string | null;
  preview: string | null;
  status: CommentStatus;
  hidden_source: "suite" | "outside" | null;
  work_state: "open" | "done";
  unread: number;
  assignee_id: string | null;
  assignee_name: string | null;
  last_activity_at: string;
  reply_count: number;
  post: {
    id: string;
    message: string | null;
    picture_url: string | null;
    permalink_url: string | null;
    posted_at: string | null;
    is_ad: boolean;
    fetched: boolean;
    fetch_error: string | null;
  };
  /** Only on a thread opened by itself: why Meta could not be checked for changes, if it could not. */
  refresh_error?: string | null;
}

export interface PrivateReply {
  status: CommentSendStatus;
  body: string;
  by_name: string | null;
  at: string;
  error: string | null;
  conversation_id: string | null;
}

export interface CommentItem {
  id: string;
  external_id: string | null;
  is_root: boolean;
  from_business: boolean;
  author_name: string | null;
  author_username: string | null;
  sent_by_name: string | null;
  message: string | null;
  attachment_url: string | null;
  status: CommentStatus;
  hidden_source: "suite" | "outside" | null;
  edited: boolean;
  send_status: CommentSendStatus | null;
  error_message: string | null;
  liked_by_business: boolean;
  like_count: number | null;
  commented_at: string;
  private_reply: PrivateReply | null;
  actions: CommentActions;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  comments: CommentItem[];
}

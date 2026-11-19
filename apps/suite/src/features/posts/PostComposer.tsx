/**
 * Write or edit a post (suite spec 09, 7.2). Saving only ever makes a draft. "Schedule…"
 * and "Post now…" save the draft first and then open "Check before posting", where a
 * person reads exactly what will go out and confirms it (foundation rule 7).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { DataState } from "@admin/components/DataState.js";
import { Modal } from "@admin/components/Modal.js";
import { ApiError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { toast } from "@admin/lib/toast.js";
import {
  countHashtags,
  countMentions,
  effectiveCaption,
  networkName,
  validatePostForNetwork,
  type PostDraftShape,
  type PostProblem,
  type SocialNetwork,
  type SocialPostKind,
} from "@ms/shared";
import { ConfirmPostDialog } from "./ConfirmPostDialog.js";
import { MAX_VIDEO_BYTES, VIDEO_TOO_LARGE, prepareImageForPost, readVideoInfo } from "./image-prep.js";
import { PostPreview, ProblemList } from "./PostPreview.js";
import { UPLOAD_FAILED, postsApi, postsKeys, type PostAccount, type PostBody, type PostJson } from "./posts-api.js";
import { lagosDayTime, shownCaption } from "./posts-logic.js";
import "./posts.css";

const KINDS: { kind: SocialPostKind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "link", label: "Link" },
  { kind: "photo", label: "Photo" },
  { kind: "album", label: "Album" },
  { kind: "video", label: "Video" },
  { kind: "story", label: "Story" },
];
const EDITABLE = ["draft", "scheduled", "missed", "failed"];
const GONE_OUT = ["publishing", "published", "unknown", "removed"];
const WRONG_TYPE = "This file type can't be used in a post. Use a JPEG picture or an MP4 or MOV video.";

interface Item {
  localId: string;
  /** Set once the file is in storage. */
  key: string | null;
  uploadToken?: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  durationS: number | null;
  altText: string;
  src: string | null;
  /** 0 to 100 while uploading; null when done. */
  progress: number | null;
  error: string | null;
}

interface Form {
  accountIds: string[];
  kind: SocialPostKind;
  caption: string;
  linkUrl: string;
  /** null = use the main text. */
  overrides: Record<SocialNetwork, string | null>;
  media: Item[];
}

const EMPTY: Form = { accountIds: [], kind: "text", caption: "", linkUrl: "", overrides: { facebook: null, instagram: null }, media: [] };
let localNo = 0;
const nextLocalId = (): string => `m${++localNo}`;

function formFromPost(p: PostJson): Form {
  const override = (n: SocialNetwork): string | null => p.targets.find((t) => t.network === n && t.caption_override !== null)?.caption_override ?? null;
  return {
    accountIds: p.targets.flatMap((t) => (t.account_id ? [t.account_id] : [])),
    kind: p.kind,
    caption: p.caption,
    linkUrl: p.link_url ?? "",
    overrides: { facebook: override("facebook"), instagram: override("instagram") },
    media: p.media.map((m) => ({
      localId: nextLocalId(),
      key: m.key,
      mime: m.mime,
      bytes: m.bytes,
      width: m.width,
      height: m.height,
      durationS: m.duration_s,
      altText: m.alt_text ?? "",
      src: m.preview_url,
      progress: null,
      error: null,
    })),
  };
}

const usesMedia = (kind: SocialPostKind): boolean => kind !== "text" && kind !== "link";

export function PostComposer({ postId, initialDay, captionTools }: { postId?: string; initialDay?: string; captionTools?: ReactNode }): JSX.Element {
  const title = postId ? "Edit post" : "New post";
  const accounts = useQuery({ queryKey: postsKeys.accounts, queryFn: postsApi.accounts, refetchOnWindowFocus: false });
  const existing = useQuery({
    queryKey: postsKeys.one(postId ?? "new"),
    queryFn: () => postsApi.one(postId!),
    enabled: !!postId,
    refetchOnWindowFocus: false,
  });
  const notFound = existing.error instanceof ApiError && existing.error.status === 404;
  const post = existing.data;
  const locked = post && (!EDITABLE.includes(post.status) || post.targets.some((t) => GONE_OUT.includes(t.status)));

  return (
    <Frame title={title} crumb="Posts">
      {notFound ? (
        <div className="empty">
          <div className="empty__title">This post no longer exists.</div>
          <Link to="/posts" className="btn btn--subtle btn--sm">
            Back to posts
          </Link>
        </div>
      ) : (
        <DataState
          loading={accounts.isLoading || (!!postId && existing.isLoading)}
          error={accounts.error ?? existing.error}
          onRetry={() => {
            void accounts.refetch();
            if (postId) void existing.refetch();
          }}
        >
          {accounts.data &&
            (locked && post ? (
              <div className="empty">
                <div className="empty__title">This post has already gone out.</div>
                Edit it on the post's page.
                <div style={{ marginTop: 10 }}>
                  <Link to="/posts/$postId" params={{ postId: post.id }} className="btn btn--subtle btn--sm">
                    Open the post
                  </Link>
                </div>
              </div>
            ) : (
              (!postId || post) && (
                <Editor
                  key={post?.id ?? "new"}
                  accounts={accounts.data.data}
                  schedulingEnabled={accounts.data.scheduling_enabled}
                  initial={post ?? null}
                  {...(initialDay ? { initialDay } : {})}
                  captionTools={captionTools}
                />
              )
            ))}
        </DataState>
      )}
    </Frame>
  );
}

function Editor({
  accounts,
  schedulingEnabled,
  initial,
  initialDay,
  captionTools,
}: {
  accounts: PostAccount[];
  schedulingEnabled: boolean;
  initial: PostJson | null;
  initialDay?: string;
  captionTools?: ReactNode;
}): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(() => (initial ? formFromPost(initial) : EMPTY));
  const [saved, setSaved] = useState<PostJson | null>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "now" | "schedule">(null);
  const [confirming, setConfirming] = useState<null | { post: PostJson; mode: "now" | "schedule" }>(null);
  const [over, setOver] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const blocker = useBlocker({ condition: dirty });
  const closeConfirm = useCallback(() => setConfirming(null), []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const change = (patch: Partial<Form> | ((f: Form) => Partial<Form>)): void => {
    setForm((f) => ({ ...f, ...(typeof patch === "function" ? patch(f) : patch) }));
    setDirty(true);
  };
  const patchItem = (localId: string, patch: Partial<Item>, markDirty = true): void => {
    setForm((f) => ({ ...f, media: f.media.map((m) => (m.localId === localId ? { ...m, ...patch } : m)) }));
    if (markDirty) setDirty(true);
  };

  const chosen = accounts.filter((a) => form.accountIds.includes(a.id));
  const networks = useMemo(() => [...new Set(chosen.map((a) => a.network))], [chosen]);
  const both = networks.length === 2;
  const media = usesMedia(form.kind) ? form.media : [];
  const uploading = media.some((m) => m.progress !== null);
  const failedUpload = media.some((m) => m.error !== null);
  const ready = media.filter((m) => m.key !== null);
  const override = (n: SocialNetwork): string | null => (both ? form.overrides[n] : null);
  const shape: PostDraftShape = {
    kind: form.kind,
    caption: form.caption,
    linkUrl: form.kind === "link" ? form.linkUrl.trim() || null : null,
    media: media.map((m) => ({ mime: m.mime, bytes: m.bytes, width: m.width, height: m.height, durationS: m.durationS })),
  };
  const problemsFor = (n: SocialNetwork): PostProblem[] => validatePostForNetwork(shape, n, effectiveCaption(form.caption, override(n)));
  const blocked = networks.some((n) => problemsFor(n).some((p) => p.blocking));
  const somethingIn = form.caption.trim() !== "" || media.length > 0 || form.linkUrl.trim() !== "";
  const canSave = somethingIn && chosen.length > 0 && !uploading && !failedUpload && busy === null;
  const canApprove = canSave && !blocked;

  function body(): PostBody {
    return {
      kind: form.kind,
      caption: form.caption,
      link_url: shape.linkUrl,
      media: ready.map((m) => ({
        key: m.key!,
        ...(m.uploadToken ? { upload_token: m.uploadToken } : {}),
        mime: m.mime,
        bytes: m.bytes,
        width: m.width,
        height: m.height,
        duration_s: m.durationS,
        alt_text: m.altText.trim() || null,
      })),
      targets: chosen.map((a) => ({ account_id: a.id, caption_override: override(a.network) })),
    };
  }

  /** Saving only ever makes or updates a draft. */
  async function save(): Promise<PostJson | null> {
    try {
      const b = body();
      const out = saved ? await postsApi.update(saved.id, b, saved.updated_at) : await postsApi.create(b);
      setSaved(out);
      setDirty(false);
      qc.setQueryData(postsKeys.one(out.id), out);
      void qc.invalidateQueries({ queryKey: ["posts", "list"] });
      return out;
    } catch {
      return null; // api() has shown the reason
    }
  }

  async function saveDraft(): Promise<void> {
    setBusy("save");
    const out = await save();
    setBusy(null);
    if (out) toast.success("Draft saved.");
  }

  async function saveThenConfirm(mode: "now" | "schedule"): Promise<void> {
    setBusy(mode);
    const out = await save();
    setBusy(null);
    if (out) setConfirming({ post: out, mode });
  }

  function leaveTo(id: string): void {
    flushSync(() => setDirty(false));
    void navigate({ to: "/posts/$postId", params: { postId: id } });
  }

  // ── Files ──
  const accept = form.kind === "video" ? "video/mp4,video/quicktime" : form.kind === "story" ? "image/*,video/mp4,video/quicktime" : "image/*";
  const single = form.kind !== "album";

  async function addFiles(files: File[]): Promise<void> {
    const room = single ? 1 : Math.max(0, 10 - form.media.length);
    const picked = files.slice(0, room);
    if (files.length > room && !single) toast.info("An album can hold at most 10 pictures.");
    for (const file of picked) {
      const isVideo = file.type === "video/mp4" || file.type === "video/quicktime";
      const isPicture = file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);
      const wantsVideo = form.kind === "video" || (form.kind === "story" && isVideo);
      if ((wantsVideo && !isVideo) || (!wantsVideo && !isPicture)) {
        toast.error(form.kind === "video" ? "Videos must be MP4 or MOV." : WRONG_TYPE);
        continue;
      }
      const localId = nextLocalId();
      try {
        let blob: Blob = file;
        let info: Pick<Item, "mime" | "width" | "height" | "durationS">;
        if (wantsVideo) {
          if (file.size > MAX_VIDEO_BYTES) throw new Error(VIDEO_TOO_LARGE);
          const v = await readVideoInfo(file);
          info = { mime: file.type, width: v.width, height: v.height, durationS: v.durationS };
        } else {
          const p = await prepareImageForPost(file);
          blob = p.blob;
          info = { mime: "image/jpeg", width: p.width, height: p.height, durationS: null };
        }
        const item: Item = { localId, key: null, ...info, bytes: blob.size, altText: "", src: URL.createObjectURL(blob), progress: 0, error: null };
        setForm((f) => ({ ...f, media: single ? [item] : [...f.media, item] }));
        setDirty(true);
        try {
          const up = await postsApi.upload(blob, file.name || "upload", info.mime, (percent) => patchItem(localId, { progress: percent }, false));
          patchItem(localId, { key: up.key, uploadToken: up.upload_token, progress: null });
        } catch (err) {
          patchItem(localId, { progress: null, error: err instanceof ApiError ? err.message : UPLOAD_FAILED });
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : WRONG_TYPE);
      }
    }
  }

  function move(from: number, to: number): void {
    if (to < 0 || to >= form.media.length || from === to) return;
    change((f) => {
      const next = [...f.media];
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it!);
      return { media: next };
    });
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length > 0) void addFiles(Array.from(e.dataTransfer.files));
  }

  const counter = (text: string): string => `${text.length} characters · ${countHashtags(text)} hashtags · ${countMentions(text)} mentions`;
  const tooltip = blocked ? "Fix the problems shown in red first." : undefined;

  return (
    <div className="po-page">
      {initial?.status === "scheduled" && (
        <div className="po-strip po-strip--warn">
          This post is scheduled for {initial.scheduled_at ? lagosDayTime(initial.scheduled_at) : "later"}. If you save a change it goes back to your
          drafts and must be checked and scheduled again.
        </div>
      )}
      {accounts.length === 0 && (
        <div className="po-strip po-strip--warn">
          No Facebook Page or Instagram account is connected yet. <Link to="/channels">Connect one in Channels.</Link>
        </div>
      )}
      <div className="po-compose">
        <div className="po-form">
          <section className="card po-block">
            <h2 className="po-h">Where should this go?</h2>
            {accounts.map((a) => (
              <label key={a.id} className="po-check">
                <input
                  type="checkbox"
                  checked={form.accountIds.includes(a.id)}
                  onChange={(e) =>
                    change((f) => ({ accountIds: e.target.checked ? [...f.accountIds, a.id] : f.accountIds.filter((x) => x !== a.id) }))
                  }
                />
                <span>
                  {networkName(a.network)} — {a.label}
                  {a.network === "instagram" && a.quota && (
                    <span className="po-fine" style={{ display: "block" }}>
                      {a.quota.used} of {a.quota.total} posts used in the last 24 hours
                    </span>
                  )}
                </span>
              </label>
            ))}
            {accounts.length > 0 && chosen.length === 0 && <p className="po-fine">Tick at least one place for this post to go.</p>}
          </section>

          <section className="card po-block">
            <h2 className="po-h">What kind of post?</h2>
            <div className="po-kinds">
              {KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  className={`po-tab${form.kind === k.kind ? " po-tab--on" : ""}`}
                  aria-pressed={form.kind === k.kind}
                  onClick={() =>
                    change((f) => ({
                      kind: k.kind,
                      // Keep only the files the new kind can hold.
                      media: f.media
                        .filter((m) => (k.kind === "video" ? m.mime.startsWith("video/") : k.kind === "story" ? true : m.mime.startsWith("image/")))
                        .slice(0, k.kind === "album" ? 10 : 1),
                    }))
                  }
                >
                  {k.label}
                </button>
              ))}
            </div>
          </section>

          <section className="card po-block">
            <div className="po-label">
              <label htmlFor="po-caption">What do you want to say?</label>
              {captionTools}
            </div>
            <textarea
              id="po-caption"
              className="textarea"
              rows={5}
              maxLength={5000}
              value={form.caption}
              onChange={(e) => change({ caption: e.target.value })}
            />
            <p className="po-fine">{counter(form.caption)}</p>
            {both &&
              (["instagram", "facebook"] as const).map((n) => (
                <div key={n} className="po-block">
                  <label className="po-check">
                    <input
                      type="checkbox"
                      checked={form.overrides[n] !== null}
                      onChange={(e) => change((f) => ({ overrides: { ...f.overrides, [n]: e.target.checked ? f.caption : null } }))}
                    />
                    <span>Use different text for {networkName(n)}</span>
                  </label>
                  {form.overrides[n] !== null && (
                    <>
                      <textarea
                        className="textarea"
                        rows={4}
                        maxLength={5000}
                        aria-label={`Text for ${networkName(n)}`}
                        value={form.overrides[n] ?? ""}
                        onChange={(e) => change((f) => ({ overrides: { ...f.overrides, [n]: e.target.value } }))}
                      />
                      <p className="po-fine">{counter(form.overrides[n] ?? "")}</p>
                    </>
                  )}
                </div>
              ))}
          </section>

          {form.kind === "link" && (
            <section className="card po-block">
              <label className="field">
                <span className="field__label">Web address</span>
                <input
                  className="input"
                  type="url"
                  inputMode="url"
                  placeholder="https://www.mrssamuel.com/…"
                  value={form.linkUrl}
                  onChange={(e) => change({ linkUrl: e.target.value })}
                />
              </label>
            </section>
          )}

          {usesMedia(form.kind) && (
            <section className="card po-block">
              <h2 className="po-h">{form.kind === "video" ? "Video" : form.kind === "story" ? "Picture or video" : "Pictures"}</h2>
              <div
                className={`po-drop${over ? " po-drop--over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragFrom.current === null) setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={onDrop}
              >
                <button type="button" className="btn btn--subtle" onClick={() => fileInput.current?.click()}>
                  {form.kind === "video" ? "Add a video" : form.kind === "story" ? "Add a picture or a video" : "Add pictures"}
                </button>
                <p className="po-fine">JPEG pictures up to 8 MB. MP4 or MOV videos up to 100 MB.</p>
                <input
                  ref={fileInput}
                  type="file"
                  accept={accept}
                  multiple={!single}
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    if (files.length > 0) void addFiles(files);
                  }}
                />
              </div>
              {form.media.length > 0 && (
                <div className="po-media">
                  {form.media.map((m, i) => (
                    <div
                      key={m.localId}
                      className="po-media__item"
                      draggable={form.media.length > 1}
                      onDragStart={() => (dragFrom.current = i)}
                      onDragEnd={() => (dragFrom.current = null)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        if (dragFrom.current === null) return;
                        e.preventDefault();
                        e.stopPropagation();
                        move(dragFrom.current, i);
                        dragFrom.current = null;
                      }}
                    >
                      {m.src && m.mime.startsWith("image/") ? (
                        <img className="po-media__pic" src={m.src} alt={m.altText || `Picture ${i + 1}`} />
                      ) : m.src ? (
                        <video className="po-media__pic" src={m.src} preload="metadata" muted playsInline />
                      ) : (
                        <div className="po-media__pic" />
                      )}
                      {m.progress !== null && (
                        <>
                          <div className="po-progress" role="progressbar" aria-valuenow={m.progress} aria-valuemin={0} aria-valuemax={100}>
                            <span style={{ width: `${m.progress}%` }} />
                          </div>
                          <p className="po-fine">Uploading… {m.progress}%</p>
                        </>
                      )}
                      {m.error && <p className="field__error">{m.error}</p>}
                      {m.mime.startsWith("image/") && (
                        <input
                          className="input"
                          placeholder="Describe this picture"
                          aria-label="Describe this picture (for people who cannot see it)"
                          title="Describe this picture (for people who cannot see it)"
                          maxLength={1000}
                          value={m.altText}
                          onChange={(e) => patchItem(m.localId, { altText: e.target.value })}
                        />
                      )}
                      <div className="po-media__tools">
                        <span>
                          {form.media.length > 1 && (
                            <>
                              <button type="button" className="btn btn--subtle btn--sm" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, i - 1)}>
                                <ArrowLeft size={16} />
                              </button>{" "}
                              <button
                                type="button"
                                className="btn btn--subtle btn--sm"
                                aria-label="Move later"
                                disabled={i === form.media.length - 1}
                                onClick={() => move(i, i + 1)}
                              >
                                <ArrowRight size={16} />
                              </button>
                            </>
                          )}
                        </span>
                        <button
                          type="button"
                          className="btn btn--subtle btn--sm"
                          aria-label="Remove this file"
                          onClick={() => change((f) => ({ media: f.media.filter((x) => x.localId !== m.localId) }))}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {form.media.some((m) => m.mime.startsWith("image/")) && (
                <p className="po-fine">Describe each picture for people who cannot see it. The description is not shown on the post itself.</p>
              )}
            </section>
          )}
        </div>

        <div className="po-previews">
          {chosen.length === 0 ? (
            <div className="po-strip po-strip--note">Tick where the post should go to see how it will look.</div>
          ) : (
            chosen.map((a) => (
              <PostPreview
                key={a.id}
                network={a.network}
                label={a.label}
                kind={form.kind}
                caption={shownCaption(form.kind, form.caption, override(a.network))}
                linkUrl={shape.linkUrl}
                media={media.map((m) => ({ src: m.src, mime: m.mime, width: m.width, height: m.height }))}
                problems={problemsFor(a.network)}
              />
            ))
          )}
        </div>
      </div>

      <div className="po-foot">
        <div className="po-foot__buttons">
          <button type="button" className="btn btn--subtle" disabled={!canSave} onClick={() => void saveDraft()}>
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            className="btn btn--subtle"
            disabled={!canApprove || !schedulingEnabled}
            title={tooltip}
            onClick={() => void saveThenConfirm("schedule")}
          >
            {busy === "schedule" ? "Saving…" : "Schedule…"}
          </button>
          <button type="button" className="btn btn--primary" disabled={!canApprove} title={tooltip} onClick={() => void saveThenConfirm("now")}>
            {busy === "now" ? "Saving…" : "Post now…"}
          </button>
        </div>
        {blocked && <ProblemList problems={[{ code: "fix_first", message: "Fix the problems shown in red first.", blocking: true }]} />}
        {!schedulingEnabled && <p className="po-fine">Scheduling is switched off. The owner can turn it on in Posts → Settings.</p>}
      </div>

      {confirming && (
        <ConfirmPostDialog
          post={confirming.post}
          mode={confirming.mode}
          {...(initialDay ? { initialTime: `${initialDay}T09:00` } : {})}
          onClose={closeConfirm}
          onReload={async () => {
            try {
              const fresh = await postsApi.one(confirming.post.id);
              setSaved(fresh);
              setForm(formFromPost(fresh));
              return fresh;
            } catch {
              return null;
            }
          }}
          onDone={(done, when) => {
            setConfirming(null);
            qc.setQueryData(postsKeys.one(done.id), done);
            void qc.invalidateQueries({ queryKey: ["posts", "list"] });
            toast.success(when === "now" ? "Your post is going out now." : `Scheduled for ${done.scheduled_at ? lagosDayTime(done.scheduled_at) : "later"}.`);
            leaveTo(done.id);
          }}
        />
      )}

      {blocker.status === "blocked" && (
        <Modal title="Leave without saving?" onClose={blocker.reset} maxWidth={420}>
          <p style={{ margin: 0 }}>Your changes will be lost.</p>
          <div className="po-buttons">
            <button type="button" className="btn btn--subtle" onClick={blocker.reset}>
              Stay
            </button>
            <button type="button" className="btn btn--primary" onClick={blocker.proceed}>
              Leave
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

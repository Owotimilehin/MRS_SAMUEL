import { useEffect, useState, type FormEvent } from "react";
import { Shell } from "../../components/Shell.js";
import { Modal } from "../../components/Modal.js";
import { api, ApiError } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";

interface Post {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  bodyMd: string;
  coverUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function BlogPage(): JSX.Element {
  const [rows, setRows] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Post | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Post[] }>(`/blog`);
      setRows(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function togglePublish(p: Post): Promise<void> {
    setBusyId(p.id);
    try {
      await api(`/blog/${p.id}`, {
        method: "PATCH",
        body: JSON.stringify({ published: !p.publishedAt }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(p: Post): Promise<void> {
    if (!window.confirm(`Delete "${p.title}"? This is reversible by the DB team only.`)) return;
    setBusyId(p.id);
    try {
      await api(`/blog/${p.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Shell
      title="Blog"
      actions={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowNew(true)}>
          + New post
        </button>
      }
    >
      {error && (
        <div
          className="card"
          style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No posts yet</div>
          Click "New post" to publish the first one.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Published</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.title}</td>
                  <td style={{ fontFamily: "monospace", fontSize: 12, color: "var(--ink-soft)" }}>
                    {p.slug}
                  </td>
                  <td>
                    {p.publishedAt ? (
                      <span className="pill pill--success">Published</span>
                    ) : (
                      <span className="pill">Draft</span>
                    )}
                  </td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {p.publishedAt ? formatDateTime(p.publishedAt) : "—"}
                  </td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {formatDateTime(p.updatedAt)}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      style={{ marginRight: 6 }}
                      onClick={() => setEditing(p)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={p.publishedAt ? "btn btn--subtle btn--sm" : "btn btn--primary btn--sm"}
                      disabled={busyId === p.id}
                      onClick={() => void togglePublish(p)}
                      style={{ marginRight: 6 }}
                    >
                      {busyId === p.id ? "…" : p.publishedAt ? "Unpublish" : "Publish"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      disabled={busyId === p.id}
                      onClick={() => void remove(p)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <PostForm
          mode="create"
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            void load();
          }}
        />
      )}
      {editing && (
        <PostForm
          mode="edit"
          post={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </Shell>
  );
}

function PostForm({
  mode,
  post,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  post?: Post;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(post?.title ?? "");
  const [slug, setSlug] = useState(post?.slug ?? "");
  const [excerpt, setExcerpt] = useState(post?.excerpt ?? "");
  const [body, setBody] = useState(post?.bodyMd ?? "");
  const [coverUrl, setCoverUrl] = useState(post?.coverUrl ?? "");
  const [publish, setPublish] = useState(!!post?.publishedAt);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "create") {
        await api(`/blog`, {
          method: "POST",
          body: JSON.stringify({
            slug,
            title,
            excerpt: excerpt || null,
            body_md: body,
            cover_url: coverUrl || null,
            published: publish,
          }),
        });
      } else if (post) {
        await api(`/blog/${post.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            title,
            excerpt: excerpt || null,
            body_md: body,
            cover_url: coverUrl || null,
            published: publish,
          }),
        });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title={mode === "create" ? "New post" : `Edit · ${post?.title}`} onClose={onClose} maxWidth={720}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="field">
          <label className="field__label">Title</label>
          <input
            className="input"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (mode === "create" && (!slug || slug === slugify(title))) {
                setSlug(slugify(e.target.value));
              }
            }}
            required
          />
        </div>

        <div className="field">
          <label className="field__label">Slug</label>
          <input
            className="input"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            pattern="^[a-z0-9-]+$"
            required
            disabled={mode === "edit"}
            style={{ fontFamily: "monospace" }}
          />
          <span className="field__hint">
            Used in the URL: <code>/blog/{slug || "your-slug"}</code>. Locked after creation.
          </span>
        </div>

        <div className="field">
          <label className="field__label">Excerpt</label>
          <textarea
            className="textarea"
            rows={2}
            maxLength={500}
            value={excerpt}
            onChange={(e) => setExcerpt(e.target.value)}
            placeholder="One-line summary shown on the blog index card."
          />
        </div>

        <div className="field">
          <label className="field__label">Cover image URL (optional)</label>
          <input
            className="input"
            type="url"
            value={coverUrl}
            onChange={(e) => setCoverUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>

        <div className="field">
          <label className="field__label">Body (Markdown)</label>
          <textarea
            className="textarea"
            rows={14}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}
            placeholder={"## Heading\n\nA paragraph with **bold** and *italic* text.\n\n- Bullet one\n- Bullet two"}
          />
          <span className="field__hint">
            Supports headings (# ## ###), **bold**, *italic*, `inline code`, &gt; blockquotes,
            and ordered/unordered lists. Links: [text](url).
          </span>
        </div>

        <label
          style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginTop: 4 }}
        >
          <input
            type="checkbox"
            checked={publish}
            onChange={(e) => setPublish(e.target.checked)}
          />
          <span>
            <strong>Publish now</strong> — uncheck to save as a draft visible only to admins.
          </span>
        </label>

        {error && <div className="field__error">{error}</div>}
        <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
          {submitting ? "Saving…" : mode === "create" ? "Create post" : "Save changes"}
        </button>
      </form>
    </Modal>
  );
}

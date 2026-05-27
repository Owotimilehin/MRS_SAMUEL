import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { SiteLayout } from "../components/SiteLayout.js";
import { api } from "../lib/api.js";
import { BRAND } from "../data/menu.js";
import { Eyebrow } from "../components/ui/index.js";
import { InlineLoader } from "../components/Spinner.js";
import { Markdown } from "../lib/markdown.js";

interface Post {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body_md: string;
  cover_url: string | null;
  published_at: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-NG", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function BlogDetailPage({ slug }: { slug: string }): JSX.Element {
  const [post, setPost] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setError(null);
    void (async () => {
      try {
        const res = await api<{ data: Post }>(`/blog/${encodeURIComponent(slug)}`);
        if (!cancelled) setPost(res.data);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
          setNotFound(true);
        } else {
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <SiteLayout
      active="blog"
      meta={
        post?.excerpt
          ? {
              title: `${post.title} — Mrs. Samuel Fruit Juice`,
              description: post.excerpt,
            }
          : {
              title: post ? `${post.title} — Mrs. Samuel Fruit Juice` : "Blog — Mrs. Samuel",
            }
      }
    >
      <article className="ms-container ms-blog__article">
        {loading ? (
          <InlineLoader label="Loading post…" />
        ) : notFound ? (
          <div className="ms-specials__empty">
            <Eyebrow>Not found</Eyebrow>
            <h1 className="ms-section-title" style={{ marginBottom: 10 }}>
              That post isn't here.
            </h1>
            <p className="ms-section-sub" style={{ marginBottom: 22 }}>
              It may have been moved or unpublished. Take a look at the journal index.
            </p>
            <Link to="/blog" className="btn btn--primary">
              Back to the journal
            </Link>
          </div>
        ) : error ? (
          <div className="ms-checkout__error" role="alert">
            Couldn't load the post — {error}.
          </div>
        ) : post ? (
          <>
            <header className="ms-blog__article-head">
              <Link to="/blog" className="ms-blog__back">
                ← All posts
              </Link>
              <div className="ms-blog__date">{formatDate(post.published_at)}</div>
              <h1 className="ms-blog__article-title">{post.title}</h1>
              {post.excerpt && <p className="ms-blog__article-excerpt">{post.excerpt}</p>}
            </header>

            {post.cover_url && (
              <div className="ms-blog__article-cover">
                <img src={post.cover_url} alt="" />
              </div>
            )}

            <div className="ms-blog__article-body ms-md">
              <Markdown source={post.body_md} />
            </div>

            <footer className="ms-blog__article-foot">
              <p className="ms-section-sub">
                Enjoyed this? Share it with someone who needs better juice in their
                life — or just{" "}
                <a
                  href={`https://wa.me/${BRAND.whatsapp}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)", fontWeight: 600 }}
                >
                  message us on WhatsApp
                </a>{" "}
                and we'll send you a bottle on us.
              </p>
              <Link to="/blog" className="btn btn--ghost">
                ← Back to the journal
              </Link>
            </footer>
          </>
        ) : null}
      </article>
    </SiteLayout>
  );
}

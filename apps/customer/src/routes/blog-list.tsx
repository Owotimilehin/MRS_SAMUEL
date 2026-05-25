import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { SiteLayout } from "../components/SiteLayout.js";
import { api } from "../lib/api.js";
import { BRAND } from "../data/menu.js";
import { Eyebrow } from "../components/ui/index.js";

interface PostSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  coverUrl: string | null;
  publishedAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-NG", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function BlogListPage(): JSX.Element {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api<{ data: PostSummary[] }>("/blog");
        if (!cancelled) setPosts(res.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SiteLayout
      active="blog"
      meta={{
        title: "Blog — Mrs. Samuel Fruit Juice",
        description:
          "Recipes, wellness tips, and stories from behind the cold press. Notes from the Mrs. Samuel team in Lagos.",
      }}
    >
      <section className="ms-container ms-blog__hero">
        <Eyebrow>The journal</Eyebrow>
        <h1 className="ms-h1">
          Notes from the <span className="text-grad">cold press</span>.
        </h1>
        <p className="ms-sub" style={{ maxWidth: 560, marginTop: 14 }}>
          Recipes, ingredient deep-dives, wellness tips and the occasional argument
          about why fresh juice tastes better. New posts when we have something worth
          saying.
        </p>
      </section>

      <section className="ms-container" style={{ paddingBottom: 56 }}>
        {error && (
          <div className="ms-checkout__error" style={{ maxWidth: 520 }} role="alert">
            Couldn't load posts — {error}.
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--ink-soft)" }}>
            Loading…
          </div>
        ) : posts.length === 0 ? (
          <div className="ms-specials__empty">
            <Eyebrow>First post coming soon</Eyebrow>
            <h2 className="ms-section-title" style={{ marginBottom: 10 }}>
              The journal hasn't started yet.
            </h2>
            <p className="ms-section-sub" style={{ marginBottom: 22 }}>
              We're writing the first piece. Follow us on Instagram in the meantime —
              we'll cross-post recipes and behind-the-scenes there too.
            </p>
            <a
              href={`https://instagram.com/${BRAND.handle.replace("@", "")}`}
              target="_blank"
              rel="noreferrer"
              className="btn btn--primary"
            >
              Follow {BRAND.handle}
            </a>
          </div>
        ) : (
          <div className="ms-blog__grid">
            {posts.map((p) => (
              <Link
                key={p.id}
                to="/blog/$slug"
                params={{ slug: p.slug }}
                className="ms-blog__card"
              >
                {p.coverUrl ? (
                  <div className="ms-blog__cover">
                    <img src={p.coverUrl} alt="" loading="lazy" />
                  </div>
                ) : (
                  <div className="ms-blog__cover ms-blog__cover--placeholder" aria-hidden>
                    <span>{p.title.slice(0, 1)}</span>
                  </div>
                )}
                <div className="ms-blog__card-body">
                  <div className="ms-blog__date">{formatDate(p.publishedAt)}</div>
                  <h2 className="ms-blog__title">{p.title}</h2>
                  {p.excerpt && <p className="ms-blog__excerpt">{p.excerpt}</p>}
                  <span className="ms-blog__read">Read post →</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </SiteLayout>
  );
}

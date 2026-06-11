import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Clock } from "lucide-react";
import { getPost, posts } from "@/data/blogPosts";
import { SiteShell } from "@/components/SiteShell";
import { CLUSTERS } from "@/lib/visuals";

export const Route = createFileRoute("/blog/$slug")({
  loader: ({ params }) => {
    const p = getPost(params.slug);
    if (!p) throw notFound();
    return p;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData?.title ?? "Post"} — Mrs. Samuel Journal` },
      { name: "description", content: loaderData?.excerpt ?? "" },
      { property: "og:title", content: loaderData?.title ?? "" },
      { property: "og:description", content: loaderData?.excerpt ?? "" },
      { property: "og:type", content: "article" },
    ],
  }),
  component: Page,
  notFoundComponent: () => (
    <SiteShell>
      <div className="px-5 max-w-3xl mx-auto py-40 text-center">
        <h1 className="font-display text-5xl text-[color:var(--brand)]">Post not found</h1>
        <Link to="/blog" className="mt-6 inline-flex rounded-full bg-[color:var(--brand)] text-white px-6 py-3 text-sm font-semibold">Back to blog</Link>
      </div>
    </SiteShell>
  ),
});

function Page() {
  const p = Route.useLoaderData() as NonNullable<ReturnType<typeof getPost>>;
  const related = posts.filter((x) => x.slug !== p.slug && x.category === p.category).slice(0, 2);

  return (
    <SiteShell>
      <div className="px-5 sm:px-10 max-w-3xl mx-auto pt-32 sm:pt-36">
        <Link to="/blog" className="inline-flex items-center gap-2 text-sm font-semibold text-[color:var(--brand)]/70 hover:text-[color:var(--brand-orange)]">
          <ArrowLeft className="h-4 w-4" /> All posts
        </Link>
      </div>

      <article className="px-5 sm:px-10 max-w-3xl mx-auto pt-8 pb-16">
        <div className="text-xs font-bold uppercase tracking-[0.22em] text-[color:var(--brand-orange)]">{p.category}</div>
        <h1 className="mt-3 font-display text-4xl sm:text-6xl font-semibold tracking-tight text-[color:var(--brand)] leading-[1.05]">{p.title}</h1>
        <div className="mt-5 flex items-center gap-4 text-sm text-[color:var(--brand)]/60">
          <span>{p.author}</span>
          <span>·</span>
          <span>{p.date}</span>
          <span>·</span>
          <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {p.readMins} min read</span>
        </div>

        <div className="relative mt-10 h-72 sm:h-96 rounded-[2rem] overflow-hidden bg-[color:var(--cream)]">
          <img src={CLUSTERS[p.cover as keyof typeof CLUSTERS]} alt="" aria-hidden className="absolute inset-0 m-auto h-[88%] w-auto object-contain" />
        </div>

        <div className="prose-content mt-10 space-y-6 text-[17px] leading-[1.75] text-[color:var(--brand)]/85">
          {p.body.map((b: { type: "p" | "h" | "quote"; text: string }, i: number) => {
            if (b.type === "h") return <h2 key={i} className="font-display text-2xl sm:text-3xl text-[color:var(--brand)] mt-10">{b.text}</h2>;
            if (b.type === "quote") return (
              <blockquote key={i} className="my-8 border-l-4 border-[color:var(--brand-orange)] pl-5 font-display text-xl sm:text-2xl text-[color:var(--brand)] italic">
                "{b.text}"
              </blockquote>
            );
            return <p key={i}>{b.text}</p>;
          })}
        </div>

        <div className="mt-14 pt-8 border-t border-black/10">
          <div className="text-xs uppercase tracking-[0.22em] font-bold text-[color:var(--brand)]/60">Written by</div>
          <p className="mt-2 font-display text-2xl text-[color:var(--brand)]">{p.author}</p>
        </div>
      </article>

      {related.length > 0 && (
        <section className="px-5 sm:px-10 max-w-5xl mx-auto pb-20">
          <h2 className="font-display text-3xl text-[color:var(--brand)]">Keep reading</h2>
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-5">
            {related.map((r) => (
              <Link key={r.slug} to="/blog/$slug" params={{ slug: r.slug }} className="rounded-2xl bg-white ring-1 ring-black/5 p-6 hover:shadow-lg transition">
                <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand-orange)]">{r.category}</div>
                <h3 className="mt-2 font-display text-xl text-[color:var(--brand)]">{r.title}</h3>
                <p className="mt-2 text-sm text-[color:var(--brand)]/65 line-clamp-2">{r.excerpt}</p>
              </Link>
            ))}
          </div>
        </section>
      )}
    </SiteShell>
  );
}

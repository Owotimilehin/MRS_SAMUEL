import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { SiteShell } from "@/components/SiteShell";
import { PageHero } from "@/components/PageHero";
import clusterRoot from "@/assets/decor/cluster-root.png";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/about")({
  head: () =>
    seo({
      title: "About Mrs. Samuel — Nigeria's Freshest Cold-Pressed Juice",
      description:
        "The story of Mr. & Mrs. Samuel — how a kitchen in Lagos became one of Nigeria's freshest cold-pressed juice brands, on a mission to end Nigerian fruit waste.",
      path: "/about",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "About", path: "/about" }])],
    }),
  component: Page,
});

const dialogue: Array<{ who: "MRS" | "MR" | "BOTH"; text: string }> = [
  { who: "MRS", text: "Last year September, we started this journey with a simple vision — to create fresh, honest juice from Nigerian fruit and put it in glass on a Lagos table." },
  { who: "MR", text: "We started in our kitchen. One press. Six bottles a day. People came back the next week asking for more." },
  { who: "MRS", text: "By the third month, the kitchen wasn't enough. We moved to a proper prep room, hired two people, and stopped pretending this was a side project." },
  { who: "MR", text: "Today we press thousands of bottles a month. Same recipes. Same press. Same morning delivery." },
  { who: "BOTH", text: "But it has never been about scale. It has always been about respect — for the farmer, for the fruit, and for the person who twists the cap open." },
  { who: "MR", text: "This is more than business." },
  { who: "MRS", text: "This is about building a sustainable future for farmers, distributors, workers, and families across Nigeria." },
  { who: "MR", text: "To every fruit farmer…" },
  { who: "MRS", text: "To every farm cooperative…" },
  { who: "BOTH", text: "We invite you to partner with us." },
  { who: "MR", text: "Let's reduce waste together." },
  { who: "MRS", text: "Let's create value together." },
  { who: "BOTH", text: "Because the future of fruit processing in Nigeria is just beginning." },
];

const milestones = [
  { date: "Sep 2024", title: "First bottle", body: "Six bottles in the Samuel family kitchen. Three friends, three strangers." },
  { date: "Dec 2024", title: "First 1,000", body: "Word travelled. We started a WhatsApp delivery rota for Lagos Island." },
  { date: "Mar 2025", title: "Glass-only commitment", body: "We say no to plastic, permanently. Bottle-return programme launches." },
  { date: "Jun 2025", title: "First wholesale account", body: "A boutique hotel in Lekki adopts Sunrise Blend for guest breakfasts." },
  { date: "Jan 2026", title: "40,000 bottles served", body: "And counting. Every one of them pressed the same morning it shipped." },
  { date: "2026 →", title: "Mission scale", body: "Partnering with farm cooperatives to cut post-harvest fruit waste across Nigeria." },
];

function Page() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Our Story"
        title={<>A kitchen in Lagos.<br /><span className="text-[color:var(--brand-orange)]">A mission for Nigeria.</span></>}
        subtitle="Mrs. Samuel Fruit Juice started in September 2024 with a press, a fridge, and a refusal to put sugar in anything. This is how it grew — and where it's going."
        decor={clusterRoot}
        accent="#e85d8a"
      />

      {/* Dialogue */}
      <section className="px-5 sm:px-10 max-w-4xl mx-auto pb-20">
        <div className="space-y-4">
          {dialogue.map((d, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-30px" }}
              transition={{ duration: 0.4 }}
              className={`max-w-[85%] rounded-2xl p-5 ${
                d.who === "MRS"
                  ? "bg-[color:var(--brand-orange)]/10 mr-auto"
                  : d.who === "MR"
                  ? "bg-[color:var(--brand)]/10 ml-auto"
                  : "bg-[color:var(--brand)] text-white mx-auto text-center"
              }`}
            >
              <div className={`text-[10px] font-bold uppercase tracking-[0.22em] mb-1.5 ${
                d.who === "BOTH" ? "text-white/70" : "text-[color:var(--brand)]/60"
              }`}>
                {d.who === "MRS" ? "Mrs. Samuel" : d.who === "MR" ? "Mr. Samuel" : "Together"}
              </div>
              <p className={`font-display text-lg sm:text-xl leading-snug ${
                d.who === "BOTH" ? "text-white" : "text-[color:var(--brand)]"
              }`}>
                "{d.text}"
              </p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Timeline */}
      <section id="mission" className="px-5 sm:px-10 max-w-5xl mx-auto pb-24">
        <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-[color:var(--brand)]/70">Timeline</div>
        <h2 className="mt-3 font-display text-4xl text-[color:var(--brand)]">From one press to a movement.</h2>
        <div className="mt-10 relative pl-8 border-l-2 border-[color:var(--brand-orange)]/30">
          {milestones.map((m, i) => (
            <motion.div
              key={m.date}
              initial={{ opacity: 0, x: -12 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: i * 0.05 }}
              className="mb-10 relative"
            >
              <span className="absolute -left-[42px] top-1 h-4 w-4 rounded-full bg-[color:var(--brand-orange)] ring-4 ring-[color:var(--cream)]" />
              <div className="text-xs font-bold text-[color:var(--brand-orange)] uppercase tracking-[0.18em]">{m.date}</div>
              <h3 className="mt-1 font-display text-2xl text-[color:var(--brand)]">{m.title}</h3>
              <p className="mt-2 text-[color:var(--brand)]/70 leading-relaxed max-w-xl">{m.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Partner */}
      <section className="px-5 sm:px-10 pb-20">
        <div className="mx-auto max-w-5xl rounded-[2rem] bg-[color:var(--brand)] text-white px-8 sm:px-14 py-14 text-center">
          <h2 className="font-display text-4xl sm:text-5xl">Partner with us.</h2>
          <p className="mt-4 max-w-2xl mx-auto text-white/80">
            We're actively buying from farm cooperatives across Nigeria — including fruit that won't sell at retail. If you grow fruit, distribute it, or run a venue that wants real juice on the menu, we want to talk.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link to="/contact" className="rounded-full bg-[color:var(--brand-orange)] text-white px-6 py-3 text-sm font-semibold">Reach out</Link>
            <a href="https://wa.me/2349019512246" target="_blank" rel="noreferrer" className="rounded-full bg-white/10 text-white px-6 py-3 text-sm font-semibold hover:bg-white/20">WhatsApp us</a>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}

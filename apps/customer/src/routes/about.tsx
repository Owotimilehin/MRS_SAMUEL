import { Link } from "@tanstack/react-router";
import { SiteLayout } from "../components/SiteLayout.js";
import { BRAND } from "../data/menu.js";
import { Eyebrow } from "../components/ui/index.js";

export function AboutPage(): JSX.Element {
  return (
    <SiteLayout
      active="about"
      meta={{
        title: "About Mrs. Samuel Fruit Juice — Cold-pressed wellness from Lagos",
        description:
          "Why we built Mrs. Samuel: the story of a Lagos family bringing cold-pressed, preservative-free juice to a city that runs on heat, hustle, and hard work.",
      }}
    >
      {/* ───── Hero ───── */}
      <section className="ms-container ms-about__hero">
        <div className="ms-about__hero-text">
          <Eyebrow>Our story</Eyebrow>
          <h1 className="ms-h1">
            Juice the way your <span className="text-grad">grandmother</span> would have made it.
          </h1>
          <p className="ms-sub" style={{ maxWidth: 540, marginTop: 18 }}>
            Mrs. Samuel started in a home kitchen in Ajao Estate, Lagos — one woman, one cold-press,
            seventeen recipes she'd been perfecting for her family for decades. We bottle that same
            juice every morning, deliver it the same day, and refuse to add a single thing nobody
            recognises.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 24 }}>
            <Link to="/" className="btn btn--primary">
              See the menu
            </Link>
            <a
              href={`https://wa.me/${BRAND.whatsapp}`}
              target="_blank"
              rel="noreferrer"
              className="btn btn--ghost"
            >
              Order on WhatsApp
            </a>
          </div>
        </div>
        <div className="ms-about__hero-art" aria-hidden>
          <div className="ms-about__hero-glow" />
          <img
            src="/assets/bottle-hero.png"
            alt=""
            onError={(e) => {
              const img = e.currentTarget;
              if (img.src.endsWith("/assets/bottle-hero.png")) return;
              img.src = "/assets/bottle-hero.png";
            }}
          />
        </div>
      </section>

      {/* ───── Pillars ───── */}
      <section className="ms-container" style={{ padding: "32px 0" }}>
        <div className="ms-about__pillars">
          <Pillar
            kicker="100% Natural"
            title="Fruit. Water. That's it."
            body="No concentrates. No syrups. No 'natural flavours' from a lab in another country. Every bottle is whole fruit pressed within minutes of being cut."
          />
          <Pillar
            kicker="48-hour shelf"
            title="If it stays fresh, we didn't add enough."
            body="Real juice doesn't last a year — that's what preservatives buy you. We bottle in the morning, deliver the same day, and you drink it before the weekend."
          />
          <Pillar
            kicker="Made in Lagos"
            title="Pressed five minutes from your door."
            body="Our factory is on Asa Afariogun Street. Every order is hand-packed, hand-checked, and hand-delivered by people who live in the same city."
          />
        </div>
      </section>

      {/* ───── Why we exist ───── */}
      <section className="ms-container ms-about__essay">
        <div className="ms-about__essay-inner">
          <Eyebrow>Why fruit juice, why now</Eyebrow>
          <h2 className="ms-section-title">Lagos runs hot, fast, and on too much sugar.</h2>
          <p>
            We started Mrs. Samuel because we kept opening fridges full of bottled "juice" that
            tasted like sweetened water and had ingredient lists we couldn't read. Lagos deserves
            better. The fruit grows here. The customers care. The only thing missing was someone
            willing to do the work — every day, before sunrise — to put real juice on the table.
          </p>
          <p>
            Cold-pressing matters. It's not a marketing word. A spinning blade heats the fruit and
            destroys most of the nutrients you wanted in the first place. A hydraulic press squeezes
            without bruising — you taste the pineapple, the ginger, the carrot, separately, on the
            way to a finish that's both bright and soft. It's the difference between juice and
            sugar-water that happens to be orange.
          </p>
          <p>
            And we don't pasteurise. Pasteurisation is what lets supermarket "fresh" juice last six
            months — heated to 75°C, then sealed. Convenient. Dead. Mrs. Samuel goes in a glass
            bottle the same morning it was pressed, into a refrigerated van, and onto your shelf
            within hours. It's a smaller window, but the window is the product.
          </p>

          <h3>What's in the seventeen?</h3>
          <p>
            <strong>Carrot, pawpaw, orange, pineapple</strong> for breakfast and sunrise energy.{" "}
            <strong>Beetroot, celery, apple, ginger</strong> for the afternoon detox. Watermelon
            after the gym. Strawberry and soursop for the days you want a treat that isn't a treat.
            Seventeen blends because seventeen households told us what they needed — not seventeen
            because the marketing team thought it was a round number.
          </p>

          <h3>The promise</h3>
          <p>
            If you open a Mrs. Samuel bottle and it doesn't taste like the fruit on the label, we'll
            replace it. If it arrives late, we'll refund the delivery. If your child won't drink it,
            we'll swap it for a flavour they will. You've been buying juice your whole life — we're
            asking for the chance to be the first one that's worth telling someone about.
          </p>
        </div>
      </section>

      {/* ───── Closing CTA ───── */}
      <section className="ms-container ms-about__cta">
        <div className="ms-about__cta-card">
          <Eyebrow>Try it</Eyebrow>
          <h2 className="ms-section-title" style={{ marginBottom: 12 }}>
            Start with one bottle.
          </h2>
          <p className="ms-section-sub" style={{ maxWidth: 480, margin: "0 auto 22px" }}>
            Pick whichever sounds good. We'll deliver same-day in Lagos and you can decide whether
            we've earned the second order.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center" }}>
            <Link to="/" className="btn btn--primary">
              Browse the menu
            </Link>
            <Link to="/locations" className="btn btn--ghost">
              See where we deliver
            </Link>
          </div>
        </div>
      </section>
    </SiteLayout>
  );
}

function Pillar({
  kicker,
  title,
  body,
}: {
  kicker: string;
  title: string;
  body: string;
}): JSX.Element {
  return (
    <article className="ms-about__pillar">
      <div className="ms-about__pillar-kicker">{kicker}</div>
      <h3 className="ms-about__pillar-title">{title}</h3>
      <p className="ms-about__pillar-body">{body}</p>
    </article>
  );
}

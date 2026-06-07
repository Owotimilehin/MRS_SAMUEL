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
            Real juice was never going to be the <span className="text-grad">easy</span> way to do this.
          </h1>
          <p className="ms-sub" style={{ maxWidth: 540, marginTop: 18 }}>
            Mrs. Samuel started in a home kitchen in Ajao Estate, Lagos — one woman, one cold-press,
            and seventeen recipes she'd spent years getting right for the people she loved. We still
            bottle that same juice every morning, deliver it the same day, and refuse to put a single
            thing in it that we couldn't explain to your face.
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
            body="No concentrates. No syrups. No 'natural flavours' engineered in a lab somewhere else. Every bottle is whole fruit, pressed within minutes of being cut."
          />
          <Pillar
            kicker="48-hour shelf"
            title="If it lasts a year, ask what's keeping it alive."
            body="Real juice doesn't survive on a shelf — that's what preservatives are for. We press in the morning, deliver the same day, and trust you to drink it before the weekend."
          />
          <Pillar
            kicker="Made in Lagos"
            title="Pressed five minutes from your door."
            body="Our kitchen sits on Asa Afariogun Street. Every order is packed, checked, and delivered by people who live in the same city you do — because we do too."
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
            tasted like sweetened water with an ingredient list nobody could read out loud. Lagos
            deserved better than that. The fruit grows here. The people care here. The only thing
            missing was someone willing to wake up at 5am and do the actual work of making it real.
          </p>
          <p>
            Cold-pressing isn't a marketing word — it's a different decision at the start. A
            spinning blade heats the fruit as it cuts, and heat is the enemy of everything you
            wanted from the fruit in the first place. A hydraulic press squeezes slowly instead,
            without bruising, so you can taste the pineapple, the ginger, the carrot — each one on
            its own — on the way to a finish that's bright instead of just sweet.
          </p>
          <p>
            And we don't pasteurise. That's the step that lets supermarket "fresh" juice survive six
            months on a shelf — heat it to 75°C, seal it, done. Convenient for them. Lifeless for
            you. Ours leaves the press, goes into a glass bottle, into a refrigerated van, and onto
            your shelf within hours of being made. The window is smaller. The window is also the
            entire point.
          </p>

          <h3>What's in the seventeen?</h3>
          <p>
            <strong>Carrot, pawpaw, orange, pineapple</strong> for mornings that need a push.{" "}
            <strong>Beetroot, celery, apple, ginger</strong> for the afternoon reset. Watermelon
            for after the gym. Strawberry and soursop for the days that need a small win that isn't
            a bad decision. Seventeen blends — not because seventeen is a tidy number, but because
            that's how many it took before seventeen households stopped asking for something
            different.
          </p>

          <h3>The promise</h3>
          <p>
            If a bottle doesn't taste like the fruit on the label, we'll replace it. If it arrives
            late, we'll refund the delivery. If your child won't drink it, we'll swap it for one
            they will. You've been buying juice your whole life. We're asking for one chance to be
            the brand you actually tell someone about.
          </p>
        </div>
      </section>

      {/* ───── Milestones ───── */}
      <section className="ms-container ms-about__essay">
        <div className="ms-about__essay-inner">
          <Eyebrow>Where we are now</Eyebrow>
          <h2 className="ms-section-title">Forty thousand bottles. One belief, still standing.</h2>
          <p>
            Last September, this started with a decision that looked, from the outside, like the
            harder way to do things: press it fresh, every morning, by hand, and refuse to
            shortcut any of it. At the time, all we had was belief, passion, and the willingness
            to show up before sunrise — long nights, early mornings, and a lot of moments where
            we had to choose faith over fear.
          </p>
          <p>
            Slowly, people began to believe in what we were building. One order became many
            orders. And today, since we began, we've sold over <strong>forty thousand
            bottles</strong> — forty thousand moments shared in homes, offices, events, gyms, and
            everyday lives. For us, that's bigger than juice. It's proof that something built with
            consistency and honesty can grow.
          </p>

          <h3>The next step</h3>
          <p>
            And now, we're getting ready for our biggest step yet. In the coming weeks, we'll be
            bringing in new production machines designed to produce up to{" "}
            <strong>five thousand bottles daily</strong>. That means more growth, more
            opportunities, and more freshness for every Nigerian. What started as a dream between
            two people is becoming something much bigger than us — and this is only the beginning.
          </p>
          <p>
            We want you to be part of this journey from the very start. Because something big is
            coming, and we're just getting started. Fresh. Real. Made with purpose.
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
            Pick whichever sounds good. We'll get it to you the same day, in Lagos — and then it's
            up to the juice to earn the second order.
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

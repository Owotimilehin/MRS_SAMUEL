import { SiteLayout } from "../components/SiteLayout.js";
import { Eyebrow } from "../components/ui/index.js";

export function PrivacyPage(): JSX.Element {
  return (
    <SiteLayout
      meta={{
        title: "Privacy · Mrs. Samuel",
        description: "How Mrs. Samuel handles your data.",
      }}
    >
      <main className="ms-legal ms-container">
        <Eyebrow>Privacy</Eyebrow>
        <h1 className="ms-section-title">How we handle your details.</h1>
        <p>
          We collect the minimum we need to deliver your order: your name, phone, and delivery
          address. We never sell or share that data with anyone outside of Mrs. Samuel and the
          delivery partner handling your bottle.
        </p>
        <h2>What we store</h2>
        <ul>
          <li>Contact (name, phone, optional email) — to coordinate delivery.</li>
          <li>Delivery address + zone — used once, then kept against your order record.</li>
          <li>Payment reference — provided by OPay; we never see your card details.</li>
        </ul>
        <h2>Who sees it</h2>
        <p>
          The kitchen team, the rider for your order, and our payment processor (OPay). That's
          the entire list.
        </p>
        <h2>Questions</h2>
        <p>
          WhatsApp <a href="https://wa.me/2347067220914">+234 706 722 0914</a>.
        </p>
      </main>
    </SiteLayout>
  );
}

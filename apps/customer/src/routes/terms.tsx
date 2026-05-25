import { SiteLayout } from "../components/SiteLayout.js";
import { Eyebrow } from "../components/ui/index.js";

export function TermsPage(): JSX.Element {
  return (
    <SiteLayout meta={{ title: "Terms · Mrs. Samuel", description: "Terms of service." }}>
      <main className="ms-legal ms-container">
        <Eyebrow>Terms</Eyebrow>
        <h1 className="ms-section-title">The short version.</h1>
        <p>
          Order in Lagos, we deliver within the same day. Bottles are cold-pressed each morning
          and have a 48-hour shelf life — refrigerate immediately on arrival.
        </p>
        <h2>Cancellations and refunds</h2>
        <p>
          Cancel any time before your order is dispatched and we refund in full. Once a rider
          has picked up the order, we can't recall it, but you can refuse delivery for a full
          refund.
        </p>
        <h2>Delivery</h2>
        <p>
          Delivery fees are calculated at checkout from your address. Out-of-zone addresses are
          flagged before payment. ETAs are best-effort and dependent on Lagos traffic.
        </p>
        <h2>Liability</h2>
        <p>
          We make juice, not medical advice. Health claims on our menu are general nutrition
          information — if you have a medical condition, talk to a doctor first.
        </p>
      </main>
    </SiteLayout>
  );
}

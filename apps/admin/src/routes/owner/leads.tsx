import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api, humanizeError } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";
import { StatHero } from "../../components/StatHero.js";

interface EnquiryLead {
  id: string;
  name: string;
  phone: string;
  enquiryType: string;
  createdAt: string;
}
interface ContactMsg {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  subject: string;
  message: string;
  createdAt: string;
}

/** Friendly names for the enquiry_type slugs the storefront writes. */
const ENQUIRY_LABEL: Record<string, string> = {
  white_label: "White label",
  bulk_order: "Bulk order",
  legacy_subscription: "Subscription (retired)",
};

type Tab = "enquiries" | "contact";

export function LeadsPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>("enquiries");
  const [subs, setSubs] = useState<EnquiryLead[]>([]);
  const [contacts, setContacts] = useState<ContactMsg[]>([]);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([
        api<{ data: EnquiryLead[] }>(`/marketing/leads/enquiries`),
        api<{ data: ContactMsg[] }>(`/marketing/leads/contact`),
      ]);
      setSubs(s.data);
      setContacts(c.data);
    } catch (err) {
      toast.error(humanizeError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <Shell title="Leads" crumb="Storefront">
      <StatHero
        eyebrow="Marketing"
        title="Leads"
        sub="White-label and bulk-order enquiries, plus contact messages from the storefront."
        loading={loading}
        chips={[
          {
            label: "Sub enquiries",
            value: subs.length,
            tone: subs.length > 0 ? "danger" : "good",
          },
          {
            label: "Contact messages",
            value: contacts.length,
            tone: contacts.length > 0 ? "danger" : "good",
          },
          {
            label: "Subs this week",
            value: subs.filter((s) => s.createdAt >= new Date(Date.now() - 7 * 86_400_000).toISOString()).length,
          },
          {
            label: "Messages this week",
            value: contacts.filter((c) => c.createdAt >= new Date(Date.now() - 7 * 86_400_000).toISOString()).length,
          },
        ]}
      />
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          className={tab === "enquiries" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
          onClick={() => setTab("enquiries")}
        >
          Business enquiries ({subs.length})
        </button>
        <button
          type="button"
          className={tab === "contact" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
          onClick={() => setTab("contact")}
        >
          Contact messages ({contacts.length})
        </button>
      </div>

      

      {loading ? (
        <InlineLoader />
      ) : tab === "enquiries" ? (
        subs.length === 0 ? (
          <div className="empty">
            <div className="empty__title">No business enquiries yet</div>
            Leads appear here when a visitor asks about white labelling or a bulk order.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Enquiry</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((l) => (
                  <tr key={l.id}>
                    <td style={{ color: "var(--ink-soft)", fontSize: 13, whiteSpace: "nowrap" }}>{formatDateTime(l.createdAt)}</td>
                    <td style={{ fontWeight: 600 }}>{l.name}</td>
                    <td>
                      <a href={`tel:${l.phone}`} style={{ color: "var(--brand)" }}>{l.phone}</a>
                    </td>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{ENQUIRY_LABEL[l.enquiryType] ?? l.enquiryType}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : contacts.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No contact messages yet</div>
          Messages from the storefront contact form land here.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>From</th>
                <th>Subject</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((m) => (
                <tr key={m.id}>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13, whiteSpace: "nowrap" }}>{formatDateTime(m.createdAt)}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{m.name}</div>
                    <div style={{ fontSize: 12 }}>
                      <a href={`mailto:${m.email}`} style={{ color: "var(--brand)" }}>{m.email}</a>
                      {m.phone && <span style={{ color: "var(--ink-soft)" }}> · {m.phone}</span>}
                    </div>
                  </td>
                  <td>{m.subject}</td>
                  <td style={{ maxWidth: 420, whiteSpace: "pre-wrap", color: "var(--ink-soft)", fontSize: 13 }}>{m.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

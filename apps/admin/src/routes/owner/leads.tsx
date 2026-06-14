import { useEffect, useState } from "react";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface SubLead {
  id: string;
  name: string;
  phone: string;
  planSlug: string;
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

type Tab = "subscriptions" | "contact";

export function LeadsPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>("subscriptions");
  const [subs, setSubs] = useState<SubLead[]>([]);
  const [contacts, setContacts] = useState<ContactMsg[]>([]);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([
        api<{ data: SubLead[] }>(`/marketing/leads/subscriptions`),
        api<{ data: ContactMsg[] }>(`/marketing/leads/contact`),
      ]);
      setSubs(s.data);
      setContacts(c.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <Shell title="Leads" crumb="Storefront">
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          className={tab === "subscriptions" ? "btn btn--primary btn--sm" : "btn btn--subtle btn--sm"}
          onClick={() => setTab("subscriptions")}
        >
          Subscription enquiries ({subs.length})
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
      ) : tab === "subscriptions" ? (
        subs.length === 0 ? (
          <div className="empty">
            <div className="empty__title">No subscription enquiries yet</div>
            Leads appear here when a visitor submits interest in a plan.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Plan</th>
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
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{l.planSlug}</td>
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

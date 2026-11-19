/**
 * The contact's lead forms, shown on the inbox's contact panel (suite spec 13,
 * 7.6): which form they filled in, when, where it stands, their first three
 * answers and a link to the lead in the suite. Shown only to people with
 * leads.view, and not at all when the contact has no leads.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { LeadLink } from "../../lib/app-frame.js";
import { dayLabel, lagosDayKey } from "../../lib/inbox-logic.js";

interface ContactLead {
  id: string;
  received_at: string;
  form_name: string;
  status: "new" | "contacted" | "won" | "lost";
}

interface ContactLeadDetail extends ContactLead {
  answers: { key: string; label: string; values: string[] }[];
  erased: boolean;
}

const STATUS_LABEL: Record<ContactLead["status"], string> = { new: "New", contacted: "Contacted", won: "Won", lost: "Lost" };
const STATUS_TONE: Record<ContactLead["status"], string> = { new: "accent", contacted: "warning", won: "success", lost: "ink" };

/** Up to three of the contact's newest leads, each with its first three answers. */
async function leadsForCustomer(customerId: string): Promise<ContactLeadDetail[]> {
  const list = await api<{ data: { leads: ContactLead[] } }>(
    `/leads?customer_id=${encodeURIComponent(customerId)}&include_tests=true&status=all&limit=3`,
  );
  return Promise.all(list.data.leads.map(async (l) => (await api<{ data: ContactLeadDetail }>(`/leads/${l.id}`)).data));
}

export function LeadCards({ customerId }: { customerId: string }): JSX.Element | null {
  const q = useQuery({
    queryKey: ["leads", "customer", customerId],
    queryFn: () => leadsForCustomer(customerId),
    staleTime: 60_000,
    retry: false,
  });
  const leads = q.data ?? [];
  // Nothing is shown when there are none (or while loading, or if they could not be read).
  if (leads.length === 0) return null;
  return (
    <div>
      <div className="t-eyebrow" style={{ marginBottom: 6 }}>Lead forms</div>
      <div style={{ display: "grid", gap: 6 }}>
        {leads.map((l) => (
          <LeadCard key={l.id} lead={l} />
        ))}
      </div>
    </div>
  );
}

export function LeadCard({ lead }: { lead: ContactLeadDetail }): JSX.Element {
  return (
    <div className="card" style={{ padding: 8, fontSize: 13, display: "grid", gap: 4 }}>
      <div style={{ fontWeight: 700, overflowWrap: "anywhere" }}>Lead form: {lead.form_name}</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", color: "var(--ink-soft)" }}>
        <span>{dayLabel(lagosDayKey(lead.received_at))}</span>
        <span className={`pill pill--${STATUS_TONE[lead.status]}`}>{STATUS_LABEL[lead.status]}</span>
      </div>
      {lead.erased ? (
        <div style={{ color: "var(--ink-soft)" }}>This person asked us to delete their details.</div>
      ) : (
        lead.answers.slice(0, 3).map((a) => (
          <div key={a.key} style={{ overflowWrap: "anywhere" }}>
            <span style={{ color: "var(--ink-soft)" }}>{a.label}: </span>
            {a.values.join(", ") || "–"}
          </div>
        ))
      )}
      <LeadLink leadId={lead.id} style={{ fontSize: 13 }}>
        Open lead →
      </LeadLink>
    </div>
  );
}

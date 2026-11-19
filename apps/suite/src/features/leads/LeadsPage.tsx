/**
 * Leads (suite spec 13, 7.2): people who filled in a lead form on one of our
 * Facebook or Instagram adverts. A list with status tabs and filters; tapping
 * a lead opens its drawer at /leads/<id>.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Download, ListChecks } from "lucide-react";
import { DataState } from "@admin/components/DataState.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useAuthUser, useCan } from "@admin/lib/auth.js";
import { useInboxEvents } from "@admin/lib/inbox-stream.js";
import { toast } from "@admin/lib/toast.js";
import "@admin/components/inbox/inbox.css";
import "./leads.css";
import { leadKeys, leadsApi, type LeadFilters, type LeadRow, type LeadStatus } from "./leads-api.js";
import { emptyMessage, initials, leadName, pendingIsSlow, receivedLabel, rowSubLine, statusChip } from "./leads-logic.js";
import { LeadDrawer } from "./LeadDrawer.js";
import { LeadFormsDialog } from "./LeadFormsDialog.js";
import { LeadsReport } from "./LeadsReport.js";

const TABS: { key: LeadStatus | "all"; label: string }[] = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
  { key: "all", label: "All" },
];

export function LeadsPage({ leadId }: { leadId?: string }): JSX.Element {
  const can = useCan();
  if (!can("leads.view")) {
    return (
      <Frame title="Leads">
        <div className="card">You don&apos;t have access to leads. Ask the owner.</div>
      </Frame>
    );
  }
  return <LeadsList {...(leadId ? { leadId } : {})} />;
}

function LeadsList({ leadId }: { leadId?: string }): JSX.Element {
  const can = useCan();
  const user = useAuthUser();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [status, setStatus] = useState<LeadStatus | "all">("new");
  const [formId, setFormId] = useState("");
  const [owner, setOwner] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [showTests, setShowTests] = useState(false);
  const [formsOpen, setFormsOpen] = useState<false | "forms" | "connection">(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Search as the person types, without a request per key press.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filters: LeadFilters = {
    status,
    ...(formId ? { form_id: formId } : {}),
    ...(owner ? { assignee: owner } : {}),
    ...(q ? { q } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(showTests ? { include_tests: true } : {}),
  };
  const list = useQuery({ queryKey: leadKeys.list(filters), queryFn: () => leadsApi.list(filters), refetchInterval: 60_000 });
  const forms = useQuery({ queryKey: leadKeys.forms, queryFn: leadsApi.forms });
  const staff = useQuery({ queryKey: leadKeys.staff, queryFn: leadsApi.staff, staleTime: 5 * 60_000 });

  // A new lead announces itself as an incoming message. The live stream is only for people with inbox access.
  useInboxEvents((e) => {
    if (e.event === "message.created" || e.event === "reconnected") void qc.invalidateQueries({ queryKey: leadKeys.all });
  }, can("inbox.view"));

  const data = list.data;
  const rows = data?.leads ?? [];
  const counts = data?.counts;
  const filtered = !!(formId || owner || q || from || to);
  const tabCount = (key: LeadStatus | "all"): number | null => {
    if (!counts) return null;
    return key === "all" ? counts.new + counts.contacted + counts.won + counts.lost : counts[key];
  };

  async function retryFailed(): Promise<void> {
    setRetrying(true);
    try {
      const r = await leadsApi.retryFailed();
      toast.success(r.requeued === 1 ? "Trying 1 lead again." : `Trying ${r.requeued} leads again.`);
      await qc.invalidateQueries({ queryKey: leadKeys.all });
    } catch {
      /* toast shown by api() */
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Frame
      title="Leads"
      actions={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => setFormsOpen("forms")}>
            <ListChecks size={14} aria-hidden /> Forms
          </button>
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => setReportOpen(true)}>
            <BarChart3 size={14} aria-hidden /> Report
          </button>
          {can("inbox.export") && (
            <a className="btn btn--subtle btn--sm" href={leadsApi.exportUrl(filters)} download>
              <Download size={14} aria-hidden /> Download
            </a>
          )}
        </div>
      }
    >
      <p className="ld-sub">People who filled in a form on one of our Facebook or Instagram adverts.</p>

      {data && data.problems.failed > 0 && (
        <div className="ld-strip ld-strip--red" role="alert">
          <span>
            {data.problems.failed} {data.problems.failed === 1 ? "lead" : "leads"} arrived but Meta would not let us read them. This is usually
            the “Leads Access” setting in Meta Business Settings.
          </span>
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => setFormsOpen("connection")}>
            How to fix
          </button>
          {can("channels.manage") && (
            <button type="button" className="btn btn--primary btn--sm" disabled={retrying} onClick={() => void retryFailed()}>
              {retrying ? "Trying…" : "Try again"}
            </button>
          )}
        </div>
      )}
      {data && pendingIsSlow(data.problems) && (
        <div className="ld-strip ld-strip--amber">
          <span>
            {data.problems.pending} new {data.problems.pending === 1 ? "lead is" : "leads are"} still being fetched from Meta.
          </span>
        </div>
      )}

      <div className="ibx-tabs" role="tablist" aria-label="Lead status" style={{ flexWrap: "wrap" }}>
        {TABS.map((t) => {
          const n = tabCount(t.key);
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={status === t.key}
              className={`ibx-tab${status === t.key ? " is-active" : ""}`}
              onClick={() => setStatus(t.key)}
            >
              {t.label}
              {n !== null ? ` (${n})` : ""}
            </button>
          );
        })}
      </div>

      <div className="ld-filters">
        <label className="field">
          <span className="field__label">Form</span>
          <select className="select" value={formId} onChange={(e) => setFormId(e.target.value)}>
            <option value="">All forms</option>
            {(forms.data?.data ?? []).map((f) => (
              <option key={f.id} value={f.form_id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Owner</span>
          <select className="select" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="none">No one</option>
            {(staff.data ?? [])
              .filter((s) => s.id !== user.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">From</span>
          <input className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">To</span>
          <input className="input" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Search</span>
          <input
            className="input"
            type="search"
            placeholder="Search name, phone or email"
            value={search}
            maxLength={120}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="ld-check">
          <input type="checkbox" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} />
          Show test leads
        </label>
      </div>

      {list.error && !list.isLoading ? (
        <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
          <div>We couldn&apos;t load the leads. Check your connection and try again.</div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void list.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <DataState loading={list.isLoading} error={null} onRetry={() => void list.refetch()}>
          {rows.length === 0 ? (
            <div className="empty">
              {/* Leads exist under another tab or filter: say so, rather than "no leads yet". */}
              {emptyMessage({ forms: forms.data?.data.length ?? 0, filtered: filtered || (tabCount("all") ?? 0) > 0 })}
            </div>
          ) : (
            <div className="ld-list">
              {rows.map((l) => (
                <LeadRowCard key={l.id} lead={l} />
              ))}
            </div>
          )}
        </DataState>
      )}

      {leadId && <LeadDrawer leadId={leadId} onClose={() => void navigate({ to: "/leads" })} />}
      {formsOpen && <LeadFormsDialog startAt={formsOpen} onClose={() => setFormsOpen(false)} />}
      {reportOpen && <LeadsReport onClose={() => setReportOpen(false)} />}
    </Frame>
  );
}

function LeadRowCard({ lead }: { lead: LeadRow }): JSX.Element {
  const chip = statusChip(lead.status);
  return (
    <Link to="/leads/$leadId" params={{ leadId: lead.id }} className="card card--hoverable ld-row">
      <div style={{ minWidth: 0 }}>
        <div className="ld-row__name">{leadName(lead)}</div>
        {lead.phone && <div className="ld-row__sub">{lead.phone}</div>}
        <div className="ld-row__sub">{rowSubLine(lead)}</div>
      </div>
      <div className="ld-row__side">
        <span>{receivedLabel(lead.received_at)}</span>
        <span className="ld-row__tags">
          {lead.is_backfill && <span className="ibx-chip">Earlier lead</span>}
          <span className={`pill pill--${chip.tone}`}>{chip.label}</span>
          {lead.assignee && (
            <span className="ld-owner" title={`Owner: ${lead.assignee.name}`} aria-label={`Owner: ${lead.assignee.name}`}>
              {initials(lead.assignee.name)}
            </span>
          )}
        </span>
      </div>
    </Link>
  );
}

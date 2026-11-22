/**
 * Tasks (suite spec 15): reminders that are due, coming up, everyone's (for
 * people who assign work) and done, plus the chats that are snoozed.
 * Built to docs/design/business-suite-ui-spec.md: a segmented control for the
 * split, one table card, dotted status pills.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BellRing } from "lucide-react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { DataState } from "@admin/components/DataState.js";
import { ReminderDialog } from "@admin/components/inbox/TaskDialogs.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useAuthUser, useCan } from "@admin/lib/auth.js";
import { inboxApi, inboxKeys, type ConversationFilters, type ReminderFilter } from "@admin/lib/inbox-api.js";
import { channelName, contactName, reminderDue, staffLabel, whenLabel } from "@admin/lib/inbox-logic.js";
import type { ReminderRow } from "@admin/lib/inbox-types.js";
import "@admin/components/inbox/inbox.css";
import "./tasks.css";

type Tab = "due" | "upcoming" | "everyone" | "done" | "snoozed";

const EMPTY: Record<Tab, { title: string; hint: string }> = {
  due: { title: "Nothing due", hint: "Reminders you add on a chat or a contact show here when they fall due." },
  upcoming: { title: "Nothing coming up", hint: "Add a reminder from a chat (Remind) or from a contact's page." },
  everyone: { title: "No open reminders", hint: "Reminders anyone on the team adds show here until they are done." },
  done: { title: "Nothing done yet", hint: "Reminders you mark done are kept here." },
  snoozed: { title: "No snoozed chats", hint: "Snooze a chat to put it away until later. It comes back by itself." },
};

export function TasksPage(): JSX.Element {
  const can = useCan();
  const canAssign = can("inbox.assign");
  const [tab, setTab] = useState<Tab>("due");
  const due = useQuery({ queryKey: inboxKeys.remindersDue, queryFn: inboxApi.remindersDue, refetchInterval: 60_000 });
  const dueCount = due.data ?? 0;

  const tabs: { key: Tab; label: string }[] = [
    { key: "due", label: dueCount ? `Due (${dueCount})` : "Due" },
    { key: "upcoming", label: "Coming up" },
    ...(canAssign ? [{ key: "everyone" as const, label: "Everyone's" }] : []),
    { key: "done", label: "Done" },
    { key: "snoozed", label: "Snoozed chats" },
  ];

  return (
    <Frame title="Tasks" subtitle="Reminders to call back or follow up, and chats you put away for later">
      <div className="tk-page">
        <div className="ibx-tabs" role="tablist" aria-label="Tasks">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`ibx-tab${tab === t.key ? " is-active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "snoozed" ? <SnoozedTab /> : <ReminderTab view={tab} />}
      </div>
    </Frame>
  );
}

function Customer({ r }: { r: Pick<ReminderRow, "customer_id" | "customer_name" | "customer_phone" | "identity_name" | "conversation_id" | "channel"> }): JSX.Element {
  const who = contactName(r.customer_name, r.customer_phone, r.identity_name);
  return (
    <span className="tk-who">
      {r.conversation_id ? (
        <Link to="/inbox/$conversationId" params={{ conversationId: r.conversation_id }}>
          {who}
        </Link>
      ) : (
        <Link to="/contacts/$customerId" params={{ customerId: r.customer_id }}>
          {who}
        </Link>
      )}
      <small className="tk-meta">{r.conversation_id ? (r.channel ? `${channelName(r.channel)} chat` : "Chat") : "Contact"}</small>
    </span>
  );
}

function ReminderTab({ view }: { view: Exclude<Tab, "snoozed"> }): JSX.Element {
  const user = useAuthUser();
  const can = useCan();
  const canAssign = can("inbox.assign");
  const qc = useQueryClient();
  const filter: ReminderFilter = { view };
  const q = useQuery({ queryKey: inboxKeys.reminderList(filter), queryFn: () => inboxApi.reminders(filter), refetchInterval: 60_000 });
  const staff = useQuery({ queryKey: inboxKeys.staff, queryFn: inboxApi.staff, enabled: canAssign, staleTime: 5 * 60_000 });
  const [moving, setMoving] = useState<ReminderRow | null>(null);
  const [removing, setRemoving] = useState<ReminderRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = q.data ?? [];
  const empty = EMPTY[view];

  async function act(r: ReminderRow, fn: () => Promise<unknown>): Promise<void> {
    setBusy(r.id);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: inboxKeys.reminders });
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card tk-card">
      <DataState
        loading={q.isLoading}
        error={q.error}
        isEmpty={rows.length === 0}
        emptyTitle={empty.title}
        emptyHint={empty.hint}
        onRetry={() => void q.refetch()}
      >
        <div className="table-wrap tk-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Reminder</th>
                <th>{view === "done" ? "Done" : "Due"}</th>
                <th>For</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = reminderDue(r.due_at, r.done_at);
                const mayChange = r.assignee_id === user.id || r.created_by === user.id || canAssign;
                const mayDelete = r.created_by === user.id || canAssign;
                return (
                  <tr key={r.id}>
                    <td>
                      <Customer r={r} />
                    </td>
                    <td className="tk-note">
                      <BellRing size={14} aria-hidden />
                      <span>{r.note}</span>
                      {r.created_by && r.created_by !== r.assignee_id && (
                        <small className="tk-meta">Added by {r.created_by === user.id ? "you" : staffLabel(r.created_by_name)}</small>
                      )}
                    </td>
                    <td>
                      <span className={`pill pill--${d.tone === "neutral" ? "ink" : d.tone}`}>{d.label}</span>
                    </td>
                    <td>{r.assignee_id === user.id ? "Me" : staffLabel(r.assignee_name)}</td>
                    <td className="table__num tk-actions">
                      {mayChange && !r.done_at && (
                        <>
                          <button type="button" className="btn btn--sm btn--primary" disabled={busy === r.id} onClick={() => void act(r, () => inboxApi.updateReminder(r.id, { done: true }))}>
                            Done
                          </button>
                          <button type="button" className="btn btn--sm btn--subtle" disabled={busy === r.id} onClick={() => setMoving(r)}>
                            Move
                          </button>
                        </>
                      )}
                      {mayChange && r.done_at && (
                        <button type="button" className="btn btn--sm btn--subtle" disabled={busy === r.id} onClick={() => void act(r, () => inboxApi.updateReminder(r.id, { done: false }))}>
                          Not done
                        </button>
                      )}
                      {mayDelete && (
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          disabled={busy === r.id}
                          onClick={() => setRemoving(r)}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </DataState>
      {removing && (
        <ConfirmModal
          title="Remove this reminder?"
          confirmLabel="Remove reminder"
          busyLabel="Removing…"
          tone="danger"
          busy={busy === removing.id}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void act(removing, () => inboxApi.deleteReminder(removing.id)).then(() => setRemoving(null))}
        >
          <p>&ldquo;{removing.note}&rdquo; will be removed for everyone. This can&apos;t be undone.</p>
        </ConfirmModal>
      )}
      {moving && (
        <ReminderDialog
          editing={moving}
          meId={user.id}
          staff={staff.data ?? []}
          canAssign={canAssign}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}

function SnoozedTab(): JSX.Element {
  const qc = useQueryClient();
  const filters: ConversationFilters = { status: "snoozed", view: "all", chatsOnly: true };
  const q = useQuery({ queryKey: inboxKeys.listFirstPage(filters), queryFn: () => inboxApi.conversations(filters), refetchInterval: 60_000 });
  const rows = [...(q.data?.data ?? [])].sort((a, b) => (a.snoozed_until ?? "").localeCompare(b.snoozed_until ?? ""));
  const [busy, setBusy] = useState<string | null>(null);

  async function wake(id: string): Promise<void> {
    setBusy(id);
    try {
      await inboxApi.unsnooze(id);
      void qc.invalidateQueries({ queryKey: inboxKeys.lists });
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card tk-card">
      <DataState
        loading={q.isLoading}
        error={q.error}
        isEmpty={rows.length === 0}
        emptyTitle={EMPTY.snoozed.title}
        emptyHint={EMPTY.snoozed.hint}
        onRetry={() => void q.refetch()}
      >
        <div className="table-wrap tk-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Last message</th>
                <th>Comes back</th>
                <th>
                  <span className="sr-only">Wake</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Customer
                      r={{
                        customer_id: c.customer_id,
                        customer_name: c.customer_name,
                        customer_phone: c.customer_phone,
                        identity_name: c.identity_name ?? null,
                        conversation_id: c.id,
                        channel: c.channel ?? null,
                      }}
                    />
                  </td>
                  <td className="tk-note">{c.preview ?? "No messages yet"}</td>
                  <td>{c.snoozed_until && <span className="pill pill--accent">{whenLabel(c.snoozed_until)}</span>}</td>
                  <td className="table__num">
                    <button type="button" className="btn btn--sm btn--subtle" disabled={busy === c.id} onClick={() => void wake(c.id)}>
                      Wake now
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataState>
    </div>
  );
}

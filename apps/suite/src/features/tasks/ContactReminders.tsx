/**
 * The Reminders card on a contact's page (suite spec 15, 7.5): open reminders
 * for this contact that the viewer may see (on any of their chats in scope, and
 * contact-only ones), and "Add reminder". Shown only to people with the Inbox.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ReminderDialog } from "@admin/components/inbox/TaskDialogs.js";
import { useAuthUser, useCan } from "@admin/lib/auth.js";
import { inboxApi, inboxKeys } from "@admin/lib/inbox-api.js";
import { reminderDue, staffLabel } from "@admin/lib/inbox-logic.js";
import "./tasks.css";

export function ContactReminders({ customerId }: { customerId: string }): JSX.Element {
  const user = useAuthUser();
  const can = useCan();
  const canAssign = can("inbox.assign");
  const qc = useQueryClient();
  const filter = { customerId };
  const q = useQuery({ queryKey: inboxKeys.reminderList(filter), queryFn: () => inboxApi.reminders(filter), refetchOnWindowFocus: false });
  const staff = useQuery({ queryKey: inboxKeys.staff, queryFn: inboxApi.staff, enabled: canAssign, staleTime: 5 * 60_000 });
  const [adding, setAdding] = useState(false);
  const rows = q.data ?? [];

  async function done(id: string): Promise<void> {
    try {
      await inboxApi.updateReminder(id, { done: true });
      void qc.invalidateQueries({ queryKey: inboxKeys.reminders });
    } catch {
      /* toast shown by api() */
    }
  }

  return (
    <section className="card ct-card" aria-label="Reminders">
      <h2 className="ct-card__h">Reminders</h2>
      {q.isLoading ? (
        <p className="ct-soft">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="ct-soft">No open reminders.</p>
      ) : (
        <ul className="tk-reminders">
          {rows.map((r) => {
            const d = reminderDue(r.due_at, r.done_at);
            const mayChange = r.assignee_id === user.id || r.created_by === user.id || canAssign;
            return (
              <li key={r.id}>
                <span>
                  {r.conversation_id ? (
                    <Link to="/inbox/$conversationId" params={{ conversationId: r.conversation_id }}>
                      {r.note}
                    </Link>
                  ) : (
                    r.note
                  )}
                </span>
                <span className={`pill pill--${d.tone === "neutral" ? "ink" : d.tone}`}>{d.label}</span>
                <span className="ct-soft">{r.assignee_id === user.id ? "Me" : staffLabel(r.assignee_name)}</span>
                {mayChange && (
                  <button type="button" className="btn btn--subtle btn--sm" onClick={() => void done(r.id)}>
                    Done
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {can("contacts.view") && (
        <div>
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => setAdding(true)}>
            Add reminder
          </button>
        </div>
      )}
      {adding && (
        <ReminderDialog
          target={{ customerId }}
          meId={user.id}
          staff={staff.data ?? []}
          canAssign={canAssign}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

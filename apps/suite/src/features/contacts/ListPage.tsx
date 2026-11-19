/**
 * One list (suite spec 14, 7.5): who is on it, with rename, download and archive.
 * A list picked by hand lets you remove people; a list that fills itself shows its rules.
 */
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Archive, Download, Pencil } from "lucide-react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { DataState } from "@admin/components/DataState.js";
import { InlineLoader } from "@admin/components/Spinner.js";
import { Modal } from "@admin/components/Modal.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import { groupThousands, type ContactFilter, type ContactListView } from "@ms/shared";
import { ContactTable } from "./ContactTable.js";
import { contactKeys, contactsApi, failureText } from "./contacts-api.js";
import "./contacts.css";

type Dialog = "rename" | "download" | "archive" | "remove" | null;

export function ListPage({ listId }: { listId: string }): JSX.Element {
  const list = useQuery({ queryKey: contactKeys.listOne(listId), queryFn: () => contactsApi.listOne(listId), refetchOnWindowFocus: false });
  return (
    <Frame title={list.data?.name ?? "List"} crumb="Contacts">
      <div className="ct-page">
        <div>
          <Link to="/contacts/lists" className="ct-linkish">
            ← All lists
          </Link>
        </div>
        <DataState loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
          {list.data && <Loaded list={list.data} />}
        </DataState>
      </div>
    </Frame>
  );
}

function Loaded({ list }: { list: ContactListView }): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const manage = can("contacts.manage");
  const mayDownload = can("inbox.export");
  const smart = list.kind === "smart";
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  // A list picked by hand is read through the "On list" filter; one that fills itself through its own rules.
  const filter: ContactFilter = useMemo(() => (smart ? (list.filter ?? {}) : { list_id: list.id }), [smart, list.filter, list.id]);
  const people = useInfiniteQuery({
    queryKey: contactKeys.list(filter, "name"),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => contactsApi.list({ filter, sort: "name", cursor: pageParam }),
    getNextPageParam: (last) => last.next_cursor,
    refetchOnWindowFocus: false,
  });
  const rows = useMemo(() => (people.data?.pages ?? []).flatMap((p) => p.contacts), [people.data]);
  useEffect(() => setTicked(new Set()), [list.id]);

  const refresh = () => qc.invalidateQueries({ queryKey: contactKeys.all });
  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await work();
      setDialog(null);
      await refresh();
    } catch (err) {
      toast.error(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="ct-head">
        <h1 className="ct-head__name">{list.name}</h1>
        <span className="ct-tag">{smart ? "Fills itself" : "Picked by hand"}</span>
        {list.archived_at && <span className="ct-tag">Archived</span>}
        <span className="ct-head__phone">
          {groupThousands(list.count)} {list.count === 1 ? "person" : "people"}
        </span>
      </div>
      {list.description && <p className="ct-intro">{list.description}</p>}

      <div className="ct-toolbar">
        {manage && (
          <button type="button" className="btn btn--subtle" onClick={() => setDialog("rename")}>
            <Pencil size={14} /> Rename
          </button>
        )}
        {mayDownload && (
          <button type="button" className="btn btn--ghost" disabled={list.count === 0} onClick={() => setDialog("download")}>
            <Download size={14} /> Download
          </button>
        )}
        {manage &&
          (list.archived_at ? (
            <button type="button" className="btn btn--subtle" disabled={busy} onClick={() => void run(async () => void (await contactsApi.updateList(list.id, { archived: false })))}>
              Bring back
            </button>
          ) : (
            <button type="button" className="btn btn--subtle" onClick={() => setDialog("archive")}>
              <Archive size={14} /> Archive
            </button>
          ))}
      </div>

      {smart && (
        <section className="card ct-card" aria-label="Rules">
          <h2 className="ct-card__h">
            Rules
            {manage && (
              <button type="button" className="btn btn--subtle btn--sm" onClick={() => router.history.push(`/contacts?rules=${encodeURIComponent(list.id)}`)}>
                Change rules
              </button>
            )}
          </h2>
          <ul className="ct-lines">
            {(list.filter_lines ?? []).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="ct-soft">People join and leave this list by themselves as they start or stop matching.</p>
        </section>
      )}

      {people.isLoading ? (
        <InlineLoader />
      ) : people.error ? (
        <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
          <div className="empty__title">We couldn&apos;t load the people on this list.</div>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void people.refetch()}>
            Try again
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">Nobody is on this list yet.</div>
          {smart ? "Nobody matches its rules at the moment." : "Tick contacts on the Contacts page and press “Add to list”."}
        </div>
      ) : (
        <>
          <ContactTable
            rows={rows}
            onOpen={(id) => void navigate({ to: "/contacts/$customerId", params: { customerId: id } })}
            {...(!smart && manage
              ? {
                  selected: ticked,
                  onToggle: (id: string) =>
                    setTicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    }),
                  onToggleAll: (on: boolean) => setTicked(on ? new Set(rows.map((r) => r.id)) : new Set()),
                }
              : {})}
          />
          <div className="ct-more">
            <span>
              Showing {groupThousands(rows.length)} of {groupThousands(people.data?.pages[0]?.total ?? rows.length)}
            </span>
            {people.hasNextPage && (
              <button type="button" className="btn btn--subtle" disabled={people.isFetchingNextPage} onClick={() => void people.fetchNextPage()}>
                {people.isFetchingNextPage ? "Loading…" : "Show more"}
              </button>
            )}
          </div>
        </>
      )}

      {ticked.size > 0 && (
        <div className="ct-bar" role="region" aria-label="Selected contacts">
          <span className="ct-bar__count">{ticked.size} selected</span>
          <button type="button" className="btn btn--subtle btn--sm" disabled={ticked.size > 500} onClick={() => setDialog("remove")}>
            Remove from list
          </button>
          <button type="button" className="btn btn--subtle btn--sm" onClick={() => setTicked(new Set())}>
            Clear
          </button>
        </div>
      )}

      {dialog === "rename" && (
        <RenameDialog
          list={list}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            void refresh();
          }}
        />
      )}
      {dialog === "download" && (
        <ConfirmModal
          title="Download this list"
          confirmLabel="Download"
          busyLabel="Preparing…"
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            void run(async () => {
              await contactsApi.download({ list_id: list.id }, "contacts-list.csv");
              toast.success("Downloaded. Keep the file safe and delete it when you are done.");
            })
          }
        >
          <p style={{ margin: 0 }}>
            Download {groupThousands(list.count)} contacts as a spreadsheet? The file holds names, phone numbers, emails and addresses. Keep it safe and delete
            it when you are done.
          </p>
        </ConfirmModal>
      )}
      {dialog === "archive" && (
        <ConfirmModal
          title="Archive this list"
          confirmLabel="Archive"
          busyLabel="Archiving…"
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={() => void run(async () => void (await contactsApi.updateList(list.id, { archived: true })))}
        >
          <p style={{ margin: 0 }}>Archive “{list.name}”? It will no longer be offered for broadcasts. Nothing is deleted.</p>
        </ConfirmModal>
      )}
      {dialog === "remove" && (
        <ConfirmModal
          title="Remove from list"
          confirmLabel="Remove"
          busyLabel="Removing…"
          busy={busy}
          tone="danger"
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            void run(async () => {
              const r = await contactsApi.removeFromList(list.id, [...ticked]);
              setTicked(new Set());
              toast.success(`Removed ${r.removed} from “${list.name}”.`);
            })
          }
        >
          <p style={{ margin: 0 }}>
            Remove {ticked.size} {ticked.size === 1 ? "person" : "people"} from “{list.name}”? They stay in Contacts.
          </p>
        </ConfirmModal>
      )}
    </>
  );
}

function RenameDialog({ list, onClose, onDone }: { list: ContactListView; onClose: () => void; onDone: () => void }): JSX.Element {
  const [name, setName] = useState(list.name);
  const [description, setDescription] = useState(list.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (!name.trim()) {
      setError("Give the list a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await contactsApi.updateList(list.id, { name: name.trim(), description: description.trim() || null });
      toast.success("Saved.");
      onDone();
    } catch (err) {
      setError(failureText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Rename list" onClose={busy ? () => undefined : onClose} maxWidth={480}>
      <div className="ct-form">
        <div className="field">
          <label className="field__label" htmlFor="ct-rename-name">Name</label>
          <input id="ct-rename-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="ct-rename-desc">What is it for? (optional)</label>
          <input id="ct-rename-desc" className="input" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="ct-dialog-buttons">
        <button type="button" className="btn btn--subtle" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Contacts (suite spec 14, 7.2): everyone the business knows, in one list, with
 * search, filters, sorting, labels, lists and a download.
 *
 * It does not copy the shop admin's Customers screens: those list customers who
 * have ordered, with their full order history. This lists every customer, adds
 * reach, labels, lists and consent, and links to the shop admin for the orders.
 */
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Download, List as ListIcon, Plus, Settings, Upload } from "lucide-react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { InlineLoader } from "@admin/components/Spinner.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import { CONTACT_SORTS, groupThousands, type ContactListView, type ContactSort } from "@ms/shared";
import { AddContactDialog } from "./AddContactDialog.js";
import { AddToListDialog } from "./AddToListDialog.js";
import { ContactFilters } from "./ContactFilters.js";
import { ContactSettingsDialog } from "./ContactSettingsDialog.js";
import { ContactTable } from "./ContactTable.js";
import { LabelsDialog } from "./LabelsDialog.js";
import { SaveListDialog } from "./SaveListDialog.js";
import { contactKeys, contactsApi, failureText } from "./contacts-api.js";
import {
  EMPTY_FILTERS,
  SORT_TEXT,
  countLine,
  fromContactFilter,
  selectionLine,
  smartListProblem,
  toContactFilter,
  type FilterState,
  type Selection,
} from "./contacts-logic.js";
import "./contacts.css";

type Dialog = "add" | "settings" | "download" | "save-list" | "add-to-list" | "labels" | null;

/** What the address asked for when the page opened: a list's rules to change, or a starting filter. */
function startFromAddress(): { rules: string | null; filters: FilterState; sort: ContactSort } {
  const p = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const sort = p.get("sort");
  return {
    rules: p.get("rules"),
    filters: { ...EMPTY_FILTERS, labelIds: p.get("label") ? [p.get("label")!] : [], listId: p.get("list") ?? "" },
    sort: (CONTACT_SORTS as readonly string[]).includes(sort ?? "") ? (sort as ContactSort) : "name",
  };
}

export function ContactsPage(): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const manage = can("contacts.manage");
  const mayDownload = can("inbox.export");

  const start = useMemo(startFromAddress, []);
  const [filters, setFilters] = useState<FilterState>(start.filters);
  const [searchText, setSearchText] = useState("");
  const [sort, setSort] = useState<ContactSort>(start.sort);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [savingRules, setSavingRules] = useState(false);

  // "Change rules" on a list that fills itself opens this page with that list's rules loaded.
  const rulesList = useQuery({
    queryKey: contactKeys.listOne(start.rules ?? "none"),
    enabled: !!start.rules,
    refetchOnWindowFocus: false,
    queryFn: () => contactsApi.listOne(start.rules!),
  });
  const [rulesLoaded, setRulesLoaded] = useState(false);
  useEffect(() => {
    if (rulesList.data?.filter && !rulesLoaded) {
      setFilters(fromContactFilter(rulesList.data.filter));
      setRulesLoaded(true);
    }
  }, [rulesList.data, rulesLoaded]);
  const editingRulesOf: ContactListView | null = rulesList.data?.kind === "smart" ? rulesList.data : null;

  // The search runs 300 ms after typing stops, from 2 characters.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === searchText ? f : { ...f, q: searchText })), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const filter = useMemo(() => toContactFilter(filters), [filters]);
  const filtered = Object.keys(filter).length > 0;

  const labels = useQuery({ queryKey: contactKeys.labels, queryFn: contactsApi.labels, refetchOnWindowFocus: false });
  const lists = useQuery({ queryKey: contactKeys.lists(false), queryFn: () => contactsApi.lists(false), refetchOnWindowFocus: false });
  const list = useInfiniteQuery({
    queryKey: contactKeys.list(filter, sort),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => contactsApi.list({ filter, sort, cursor: pageParam }),
    getNextPageParam: (last) => last.next_cursor,
    refetchOnWindowFocus: false,
  });
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap((p) => p.contacts), [list.data]);
  const total = list.data?.pages[0]?.total ?? null;

  // A new filter or order starts the selection again.
  useEffect(() => {
    setTicked(new Set());
    setAllMatching(false);
  }, [filter, sort]);

  const selection: Selection | null =
    allMatching && total !== null ? { mode: "all", filter, total } : ticked.size > 0 ? { mode: "ids", ids: [...ticked] } : null;

  const open = (id: string) => void navigate({ to: "/contacts/$customerId", params: { customerId: id } });
  const refresh = () => qc.invalidateQueries({ queryKey: contactKeys.all });
  const clear = () => {
    setFilters(EMPTY_FILTERS);
    setSearchText("");
  };

  async function download(): Promise<void> {
    setDownloading(true);
    try {
      await contactsApi.download({ filter }, "contacts.csv");
      setDialog(null);
      toast.success("Downloaded. Keep the file safe and delete it when you are done.");
    } catch (err) {
      toast.error(failureText(err));
    } finally {
      setDownloading(false);
    }
  }

  async function saveRules(): Promise<void> {
    if (!editingRulesOf) return;
    const problem = smartListProblem(filters);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSavingRules(true);
    try {
      await contactsApi.updateList(editingRulesOf.id, { filter });
      await refresh();
      toast.success(`Saved the rules of “${editingRulesOf.name}”.`);
      void navigate({ to: "/contacts/lists/$listId", params: { listId: editingRulesOf.id } });
    } catch (err) {
      toast.error(failureText(err));
    } finally {
      setSavingRules(false);
    }
  }

  const saveButton = !manage ? null : editingRulesOf ? (
    <button type="button" className="btn btn--primary btn--sm" disabled={savingRules} onClick={() => void saveRules()}>
      {savingRules ? "Saving…" : `Save changes to “${editingRulesOf.name}”`}
    </button>
  ) : (
    <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDialog("save-list")}>
      Save as a list…
    </button>
  );

  return (
    <Frame title="Contacts">
      <div className="ct-page">
        <p className="ct-intro">Everyone the business knows: shop customers and people who have messaged or called.</p>

        <div className="ct-toolbar">
          {manage && (
            <button type="button" className="btn btn--primary" onClick={() => setDialog("add")}>
              <Plus size={15} /> Add contact
            </button>
          )}
          {manage && (
            <button type="button" className="btn btn--subtle" onClick={() => void navigate({ to: "/contacts/import" })}>
              <Upload size={15} /> Import
            </button>
          )}
          <button type="button" className="btn btn--subtle" onClick={() => void navigate({ to: "/contacts/lists" })}>
            <ListIcon size={15} /> Lists
          </button>
          {mayDownload && (
            <button type="button" className="btn btn--ghost" disabled={total === null || total === 0} onClick={() => setDialog("download")}>
              <Download size={15} /> Download
            </button>
          )}
          <span className="ct-toolbar__spacer" />
          {manage && (
            <button type="button" className="btn btn--icon" aria-label="STOP and START replies" title="STOP and START replies" onClick={() => setDialog("settings")}>
              <Settings size={17} />
            </button>
          )}
        </div>

        {editingRulesOf && (
          <p className="ct-note">
            You are changing the rules of the list “{editingRulesOf.name}”. Set the filters, then press “Save changes”.
          </p>
        )}

        <div className="ct-search">
          <input
            className="input"
            type="search"
            aria-label="Search contacts"
            placeholder="Search name, phone, email or @name"
            maxLength={80}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <label className="ct-sr" htmlFor="ct-sort">
            Sort by
          </label>
          <select id="ct-sort" className="select" value={sort} onChange={(e) => setSort(e.target.value as ContactSort)}>
            {CONTACT_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_TEXT[s]}
              </option>
            ))}
          </select>
        </div>

        <ContactFilters
          state={filters}
          onChange={setFilters}
          labels={labels.data ?? []}
          lists={(lists.data ?? []).filter((l) => l.kind === "static")}
          onClear={clear}
          saveButton={saveButton}
        />

        {list.isLoading ? (
          <InlineLoader />
        ) : list.error ? (
          <div className="empty" style={{ display: "grid", gap: 12, justifyItems: "center" }}>
            <div className="empty__title">We couldn&apos;t load your contacts. Check your connection and try again.</div>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void list.refetch()}>
              Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <div className="empty__title">{filtered ? "Nobody matches. Try fewer filters." : "No contacts yet."}</div>
            {filtered ? null : "They appear here when someone orders, messages or calls, or when you add them."}
          </div>
        ) : (
          <>
            <div className="ct-count">
              {countLine(total, filtered)}
              <small>Order totals can be up to a minute behind the shop.</small>
            </div>
            <ContactTable
              rows={rows}
              selected={ticked}
              onOpen={open}
              onToggle={(id) => {
                setAllMatching(false);
                setTicked((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                });
              }}
              onToggleAll={(on) => {
                setAllMatching(false);
                setTicked(on ? new Set(rows.map((r) => r.id)) : new Set());
              }}
            />
            <div className="ct-more">
              {total !== null && (
                <span>
                  Showing {groupThousands(rows.length)} of {groupThousands(total)}
                </span>
              )}
              {list.hasNextPage && (
                <button type="button" className="btn btn--subtle" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {list.isFetchingNextPage ? "Loading…" : "Show more"}
                </button>
              )}
            </div>
          </>
        )}

        {selection && (
          <div className="ct-bar" role="region" aria-label="Selected contacts">
            <span className="ct-bar__count">{selectionLine(selection)}</span>
            {selection.mode === "ids" && total !== null && total > rows.length && rows.every((r) => ticked.has(r.id)) && (
              <button type="button" className="ct-linkish" onClick={() => setAllMatching(true)}>
                Select all {groupThousands(total)} that match
              </button>
            )}
            {manage && (
              <button type="button" className="btn btn--subtle btn--sm" onClick={() => setDialog("add-to-list")}>
                Add to list
              </button>
            )}
            {manage && (
              <button
                type="button"
                className="btn btn--subtle btn--sm"
                disabled={selection.mode === "all" || ticked.size > 500}
                title={selection.mode === "all" || ticked.size > 500 ? "Labels work on up to 500 ticked contacts at a time." : undefined}
                onClick={() => setDialog("labels")}
              >
                Label
              </button>
            )}
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={() => {
                setTicked(new Set());
                setAllMatching(false);
              }}
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {dialog === "add" && (
        <AddContactDialog
          onClose={() => setDialog(null)}
          onDone={(r) => {
            setDialog(null);
            void refresh();
            if (r.created) toast.success(r.stopped ? "Added. This number asked us to stop promotions before, so they stay stopped." : "Added.");
            else toast.info(`${r.name ?? "This person"} is already a contact. Nothing was changed.`);
            open(r.id);
          }}
        />
      )}
      {dialog === "settings" && <ContactSettingsDialog onClose={() => setDialog(null)} />}
      {dialog === "download" && (
        <ConfirmModal
          title="Download contacts"
          confirmLabel="Download"
          busyLabel="Preparing…"
          busy={downloading}
          onCancel={() => setDialog(null)}
          onConfirm={() => void download()}
        >
          <p style={{ margin: 0 }}>
            Download {groupThousands(total ?? 0)} contacts as a spreadsheet? The file holds names, phone numbers, emails and addresses. Keep it safe and
            delete it when you are done.
          </p>
        </ConfirmModal>
      )}
      {dialog === "save-list" && (
        <SaveListDialog
          state={filters}
          labels={labels.data ?? []}
          total={total}
          onClose={() => setDialog(null)}
          onDone={(l) => {
            setDialog(null);
            void refresh();
            void navigate({ to: "/contacts/lists/$listId", params: { listId: l.id } });
          }}
        />
      )}
      {dialog === "add-to-list" && selection && (
        <AddToListDialog
          selection={selection}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setTicked(new Set());
            setAllMatching(false);
            void refresh();
          }}
        />
      )}
      {dialog === "labels" && selection?.mode === "ids" && (
        <LabelsDialog
          target={{ kind: "bulk", customerIds: selection.ids }}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setTicked(new Set());
            void refresh();
          }}
        />
      )}
    </Frame>
  );
}

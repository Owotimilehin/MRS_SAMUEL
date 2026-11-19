/**
 * The Forms tab of "Templates and forms" (suite spec 07, 7.2): the built-in WhatsApp forms, one card per
 * form per WhatsApp account. Creating, uploading and copying only make or change drafts, so one click is
 * enough; publishing and retiring need the form's name typed, and deleting a draft needs a yes
 * (foundation rule 7). After every action the list is read again from the server.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { ConfirmModal } from "@admin/components/ConfirmModal.js";
import { DataState } from "@admin/components/DataState.js";
import { humanizeError } from "@admin/lib/api.js";
import { toast } from "@admin/lib/toast.js";
import { TemplateFailure } from "../templates-api.js";
import { FormCard } from "./FormCard.js";
import { PublishFormDialog } from "./PublishFormDialog.js";
import { RetireFormDialog } from "./RetireFormDialog.js";
import { SecureConnectionCard } from "./SecureConnectionCard.js";
import { flowKeys, flowsApi, type FlowDto } from "./flows-api.js";
import { cardId, safePreviewUrl, showAccountLabels, versionLabel, type FormAction } from "./form-labels.js";

type Created = FlowDto & { id: string };
const failed = (err: unknown): string => (err instanceof TemplateFailure ? err.message : "Something went wrong. Please check the list before trying again.");

const without = (all: Record<string, string>, card: string): Record<string, string> =>
  Object.fromEntries(Object.entries(all).filter(([k]) => k !== card));

export function FormsTab(): JSX.Element {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: flowKeys.list, queryFn: flowsApi.list, refetchOnWindowFocus: true, refetchInterval: 30_000 });
  const forms = list.data?.data ?? [];

  const [busy, setBusy] = useState<{ card: string; action: FormAction } | null>(null);
  // Cards where WhatsApp refused to change a live form: card -> its words.
  const [locked, setLocked] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<{ kind: "publish" | "retire" | "delete"; form: Created } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const refresh = (): Promise<void> => qc.invalidateQueries({ queryKey: flowKeys.list });

  async function sync(): Promise<void> {
    setSyncing(true);
    try {
      const r = await flowsApi.sync();
      toast.success(`Synced ${r.synced} form${r.synced === 1 ? "" : "s"} from WhatsApp.`);
    } catch (err) {
      toast.error(err instanceof TemplateFailure ? err.message : "Something went wrong. Please try again.");
    } finally {
      await refresh();
      setSyncing(false);
    }
  }

  /** Open WhatsApp's own preview in a new tab. The tab is opened on the click so the browser allows it. */
  async function preview(form: Created): Promise<void> {
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const url = safePreviewUrl((await flowsApi.preview(form.id)).url);
      if (!url) throw new Error("no link");
      if (tab) tab.location.replace(url);
      else window.open(url, "_blank", "noopener");
    } catch (err) {
      tab?.close();
      toast.error(err instanceof Error && err.message === "no link" ? "WhatsApp did not give a preview link. Try again." : humanizeError(err));
    }
  }

  async function act(form: FlowDto, action: FormAction): Promise<void> {
    const card = cardId(form);
    const made = form.id === null ? null : (form as Created);
    if (action === "publish" || action === "retire" || action === "delete_draft") {
      if (made) setDialog({ kind: action === "delete_draft" ? "delete" : action, form: made });
      return;
    }
    setBusy({ card, action });
    try {
      if (action === "create") {
        await flowsApi.create(form.key, form.account.waba_id);
        toast.success("Created at WhatsApp as a draft.");
      } else if (!made) {
        return;
      } else if (action === "preview") {
        await preview(made);
      } else if (action === "new_copy") {
        await flowsApi.newVersion(made.id);
        setLocked((l) => without(l, card));
        toast.success("A new copy was created as a draft.");
      } else {
        const next = await flowsApi.upload(made.id);
        setLocked((l) => without(l, card));
        if (next.state === "draft_invalid") toast.info("Uploaded, but WhatsApp found problems in it.");
        else toast.success("Uploaded to WhatsApp.");
      }
    } catch (err) {
      if (err instanceof TemplateFailure && err.reason === "published_locked") setLocked((l) => ({ ...l, [card]: err.message }));
      else toast.error(failed(err));
    } finally {
      if (action !== "preview") await refresh();
      setBusy(null);
    }
  }

  async function deleteDraft(form: Created): Promise<void> {
    setDeleting(true);
    try {
      await flowsApi.deleteDraft(form.id);
      toast.success("Draft deleted.");
    } catch (err) {
      toast.error(failed(err));
    } finally {
      await refresh();
      setDeleting(false);
      setDialog(null);
    }
  }

  const withAccounts = showAccountLabels(forms);

  return (
    <>
      <p className="tpl-intro">
        A form opens inside WhatsApp when the customer taps a button. Their answers come back into the chat as a card. These forms are built in; ask
        the technical lead if you need a new one.
      </p>

      <div className="tpl-toolbar">
        <button type="button" className="btn btn--ghost" disabled={syncing} onClick={() => void sync()}>
          <RefreshCw size={14} /> {syncing ? "Syncing…" : "Sync from WhatsApp"}
        </button>
      </div>

      <DataState
        loading={list.isLoading}
        error={list.error}
        isEmpty={forms.length === 0}
        emptyTitle="No forms to show"
        emptyHint="Forms appear here once a WhatsApp account is connected."
        onRetry={() => void list.refetch()}
      >
        {list.data && !list.data.any_live && (
          <p className="tpl-banner tpl-banner--amber">
            WhatsApp only lets verified businesses publish forms. Until verification is done you can preview forms and send tests.
          </p>
        )}
        <ul className="tpl-forms">
          {forms.map((f) => {
            const id = cardId(f);
            return (
              <FormCard
                key={id}
                form={f}
                accountLabel={withAccounts ? f.account.label : null}
                version={versionLabel(f, forms)}
                busy={busy?.card === id ? busy.action : null}
                locked={locked[id] ?? null}
                onAction={(a) => void act(f, a)}
              />
            );
          })}
        </ul>
        <SecureConnectionCard forms={forms} />
      </DataState>

      {dialog?.kind === "publish" && (
        <PublishFormDialog
          form={dialog.form}
          onClose={() => {
            setDialog(null);
            void refresh();
          }}
          onDone={(a) => {
            setDialog(null);
            if (a.notice) toast.info(a.notice);
            else toast.success("Published. Staff can now send it.");
            void refresh();
          }}
        />
      )}
      {dialog?.kind === "retire" && (
        <RetireFormDialog
          form={dialog.form}
          onClose={() => {
            setDialog(null);
            void refresh();
          }}
          onDone={() => {
            setDialog(null);
            toast.success("Retired. It can no longer be sent.");
            void refresh();
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmModal
          title="Delete this draft?"
          confirmLabel="Delete draft"
          busyLabel="Deleting…"
          tone="danger"
          busy={deleting}
          onConfirm={() => void deleteDraft(dialog.form)}
          onCancel={() => (deleting ? undefined : setDialog(null))}
        >
          <p style={{ margin: 0 }}>The draft of “{dialog.form.title}” is removed from WhatsApp. You can create it again later.</p>
        </ConfirmModal>
      )}
    </>
  );
}

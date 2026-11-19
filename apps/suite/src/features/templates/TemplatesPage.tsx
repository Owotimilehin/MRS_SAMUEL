/**
 * Templates and forms (suite spec 06, 7.1): every WhatsApp message template, whether WhatsApp has approved
 * it, how customers are reacting, and why any were refused. The second tab, "Forms" (WhatsApp Flows,
 * suite spec 07, 7.2), lives at /templates/forms; the tabs are links between the two addresses.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, RefreshCw, Sparkles } from "lucide-react";
import { DataState } from "@admin/components/DataState.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import { FormsTab } from "./forms/FormsTab.js";
import { NewTemplateDialog } from "./NewTemplateDialog.js";
import { StarterSetDialog } from "./StarterSetDialog.js";
import { TemplateList } from "./TemplateList.js";
import { CHIPS, matchesChip, type ListChip } from "./template-labels.js";
import { TemplateFailure, templateKeys, templatesApi } from "./templates-api.js";
import "./templates.css";

const NO_ACCESS = "You do not have access to templates. Ask the owner to give your account the 'Templates' permission.";

const NO_ACCESS_FORMS = "You do not have access to forms. Ask the owner to give your account the 'Templates' permission.";

export type TemplatesTab = "messages" | "forms";

export function TemplatesPage({ tab = "messages" }: { tab?: TemplatesTab }): JSX.Element {
  const can = useCan();
  if (!can("templates.manage")) {
    return (
      <Frame title="Templates and forms">
        <div className="empty">
          <div className="empty__title">No access</div>
          {tab === "forms" ? NO_ACCESS_FORMS : NO_ACCESS}
        </div>
      </Frame>
    );
  }
  return (
    <Frame title="Templates and forms">
      <div className="tpl-page">
        <nav className="tpl-tabs" aria-label="Templates and forms">
          <Link to="/templates" className={tab === "messages" ? "is-active" : undefined} aria-current={tab === "messages" ? "page" : undefined}>
            Messages
          </Link>
          <Link to="/templates/forms" className={tab === "forms" ? "is-active" : undefined} aria-current={tab === "forms" ? "page" : undefined}>
            Forms
          </Link>
        </nav>
        {tab === "forms" ? <FormsTab /> : <MessagesTab />}
      </div>
    </Frame>
  );
}

function MessagesTab(): JSX.Element {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [chip, setChip] = useState<ListChip>("all");
  const [dialog, setDialog] = useState<"new" | "starter" | null>(null);
  const [syncing, setSyncing] = useState(false);

  const list = useQuery({ queryKey: templateKeys.list, queryFn: templatesApi.list, refetchOnWindowFocus: true, refetchInterval: 30_000 });
  const options = useQuery({ queryKey: templateKeys.options, queryFn: templatesApi.options, refetchOnWindowFocus: false });
  const rows = (list.data ?? []).filter((t) => matchesChip(t, chip));

  async function sync(): Promise<void> {
    setSyncing(true);
    try {
      const r = await templatesApi.sync();
      toast.success(`Synced ${r.synced} template${r.synced === 1 ? "" : "s"} from WhatsApp.`);
      await qc.invalidateQueries({ queryKey: templateKeys.list });
    } catch (err) {
      toast.error(err instanceof TemplateFailure ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <p className="tpl-intro">
        Templates are the only messages WhatsApp lets you send after a customer has been quiet for 24 hours. WhatsApp checks each one before you
        can use it, usually within a few minutes and at most a day.
      </p>

      <div className="tpl-toolbar">
        <button type="button" className="btn btn--primary" disabled={!options.data} onClick={() => setDialog("new")}>
          <Plus size={15} /> New template
        </button>
        <button type="button" className="btn btn--subtle" disabled={!options.data} onClick={() => setDialog("starter")}>
          <Sparkles size={15} /> Add starter set
        </button>
        <button type="button" className="btn btn--ghost" disabled={syncing} onClick={() => void sync()}>
          <RefreshCw size={14} /> {syncing ? "Syncing…" : "Sync from WhatsApp"}
        </button>
      </div>

      <div className="tpl-chips" role="group" aria-label="Show">
        {CHIPS.map((c) => (
          <button key={c.id} type="button" className={`tpl-chip${chip === c.id ? " is-on" : ""}`} aria-pressed={chip === c.id} onClick={() => setChip(c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      <DataState
        loading={list.isLoading}
        error={list.error}
        isEmpty={rows.length === 0}
        emptyTitle={chip === "all" ? "No templates yet" : "Nothing here"}
        emptyHint={chip === "all" ? "Start with the starter set. It has the messages most shops need." : "No template matches this filter."}
        onRetry={() => void list.refetch()}
      >
        <TemplateList rows={rows} />
      </DataState>
      {!list.isLoading && !list.error && (list.data ?? []).length === 0 && options.data && (
        <div className="tpl-empty-action">
          <button type="button" className="btn btn--primary" onClick={() => setDialog("starter")}>
            Add starter set
          </button>
        </div>
      )}

      {dialog === "new" && options.data && (
        <NewTemplateDialog
          options={options.data}
          onClose={() => setDialog(null)}
          onCreated={(row) => {
            setDialog(null);
            void qc.invalidateQueries({ queryKey: templateKeys.list });
            void navigate({ to: "/templates/$templateId", params: { templateId: row.id } });
          }}
        />
      )}
      {dialog === "starter" && options.data && (
        <StarterSetDialog
          options={options.data}
          onClose={() => setDialog(null)}
          onAdded={() => {
            setDialog(null);
            void qc.invalidateQueries({ queryKey: templateKeys.list });
            void qc.invalidateQueries({ queryKey: templateKeys.options });
          }}
        />
      )}
    </>
  );
}

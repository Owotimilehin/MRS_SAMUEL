/**
 * Facebook Page details (suite spec 10, section 7): the Page's public details as Facebook holds
 * them, the ones that can be changed here, and a read-only Instagram profile. Nothing reaches
 * Facebook until a person reviews the before-and-after and confirms.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DataState } from "@admin/components/DataState.js";
import { ApiError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import {
  normalisePageChanges,
  samePageValue,
  validatePageChanges,
  type PageEditable,
  type PageEditableKey,
} from "@ms/shared";
import { pageDetailsApi, pageDetailsKeys, type PageDetailsView, type SaveAnswer, type SaveFailure } from "./page-details-api.js";
import { changedKeys, followersText, lagosDateTime, partlySavedText, wasCleared } from "./page-details-logic.js";
import { InstagramProfileCard } from "./InstagramProfileCard.js";
import { LockedDetails } from "./LockedDetails.js";
import { PageDetailsForm } from "./PageDetailsForm.js";
import { RecentChanges } from "./RecentChanges.js";
import { SaveDialog } from "./SaveDialog.js";
import "./page-details.css";

export function PageDetailsPage({ accountId }: { accountId: string }): JSX.Element {
  const can = useCan();
  if (!can("channels.manage")) {
    return (
      <Frame title="Page details" crumb="Channels">
        <div className="empty">
          <div className="empty__title">No access</div>
          Ask the owner if you need to change the Page's details.
        </div>
      </Frame>
    );
  }
  return <Loaded accountId={accountId} />;
}

function Loaded({ accountId }: { accountId: string }): JSX.Element {
  const q = useQuery({ queryKey: pageDetailsKeys.view(accountId), queryFn: () => pageDetailsApi.view(accountId), refetchOnWindowFocus: false });
  const notFound = q.error instanceof ApiError && q.error.status === 404;
  const title = q.data?.account.kind === "instagram" ? "Instagram profile" : "Page details";
  return (
    <Frame title={title} crumb="Channels">
      {notFound ? (
        <div className="empty">
          <div className="empty__title">Not found</div>
          This account has no Page details.
          <div style={{ marginTop: 10 }}>
            <Link to="/channels" className="btn btn--subtle btn--sm">
              Back to Channels
            </Link>
          </div>
        </div>
      ) : (
        <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          {q.data && (q.data.account.kind === "instagram" ? <InstagramView view={q.data} /> : <PageView view={q.data} />)}
        </DataState>
      )}
    </Frame>
  );
}

function CheckedLine({ view, accountId }: { view: PageDetailsView; accountId: string }): JSX.Element {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function again(): Promise<void> {
    setBusy(true);
    try {
      qc.setQueryData<PageDetailsView>(pageDetailsKeys.view(accountId), await pageDetailsApi.view(accountId, true));
    } catch {
      /* toast shown by api() */
    } finally {
      setBusy(false);
    }
  }
  return (
    <p className="pd-fine">
      Showing what is on {view.account.kind === "instagram" ? "Instagram" : "Facebook"} now. Checked {lagosDateTime(view.read_at)}.{" "}
      <button type="button" className="pd-link" disabled={busy} onClick={() => void again()}>
        {busy ? "Checking…" : "Check again"}
      </button>
    </p>
  );
}

function InstagramView({ view }: { view: PageDetailsView }): JSX.Element {
  return (
    <div className="pd-page">
      <p className="pd-fine">
        <strong>{view.account.label}</strong> · Instagram
      </p>
      {view.instagram && <InstagramProfileCard profile={view.instagram} />}
      <CheckedLine view={view} accountId={view.account.id} />
    </div>
  );
}

const BANNER_REASON: Record<string, string> = {
  no_manage_task:
    "The suite can read this Page but is not allowed to change it. The owner needs to give the suite's system user full control of the Page in Meta Business Settings (Accounts → Pages → this Page → People).",
  inactive: "This account is switched off in Channels.",
};

function PageView({ view }: { view: PageDetailsView }): JSX.Element {
  const qc = useQueryClient();
  const id = view.account.id;
  const page = view.page!;
  const live = page.editable;
  const [edits, setEdits] = useState<Partial<PageEditable>>({});
  const [touched, setTouched] = useState<ReadonlySet<PageEditableKey>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const [banner, setBanner] = useState<{ tone: "warn" | "bad"; text: string } | null>(null);

  const form: PageEditable = { ...live, ...edits };
  const keys = changedKeys(form, live);
  const normalised = normalisePageChanges(form) as PageEditable;
  const changes: Partial<PageEditable> = {};
  for (const k of keys) (changes as Record<string, unknown>)[k] = normalised[k];
  const problemList = validatePageChanges(changes);
  const problems: Partial<Record<PageEditableKey, string[]>> = {};
  for (const p of problemList) {
    const field = p.field === "always_open" ? "hours" : p.field;
    if (touched.has(field)) (problems[field] ??= []).push(p.message);
  }
  const disabled = !view.can_edit;
  const barWhy = keys.length === 0 ? "Nothing has changed." : problemList.length > 0 ? "Fix the problems above first." : null;

  const put = (v: PageDetailsView): void => {
    qc.setQueryData<PageDetailsView>(pageDetailsKeys.view(id), v);
  };

  function onAnswer(a: SaveAnswer): void {
    put(a.view);
    void qc.invalidateQueries({ queryKey: pageDetailsKeys.history(id) });
    setReviewing(false);
    if (a.not_saved.length === 0) {
      setBanner(null);
      if (a.saved.length > 0) toast.success("Saved. Facebook now shows the new details.");
      else toast.info("Nothing needed changing.");
    } else {
      setBanner({ tone: "warn", text: partlySavedText(a.saved, a.not_saved, wasCleared(form, a.not_saved)) });
    }
    setEdits({});
    setTouched(new Set());
  }

  function onFailure(f: SaveFailure): void {
    setReviewing(false);
    void qc.invalidateQueries({ queryKey: pageDetailsKeys.history(id) });
    if (f.view?.page) {
      if (f.stale) {
        // Keep what was typed in the fields that did not clash with the new live values.
        const fresh = f.view.page.editable;
        setEdits((e) => {
          const kept: Partial<PageEditable> = {};
          for (const k of Object.keys(e) as PageEditableKey[]) {
            if (samePageValue(k, fresh[k], live[k])) (kept as Record<string, unknown>)[k] = e[k];
          }
          return kept;
        });
      }
      put(f.view);
    }
    setBanner({ tone: f.stale ? "warn" : "bad", text: f.message });
  }

  return (
    <div className="pd-page">
      <section className="card pd-card">
        {page.cover_url && <img className="pd-cover" src={page.cover_url} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
        <div className="pd-top">
          {page.picture_url && <img className="pd-avatar" src={page.picture_url} alt="" onError={(e) => (e.currentTarget.style.display = "none")} />}
          <div>
            <div className="pd-name">{page.name ?? view.account.label}</div>
            <div className="pd-fine">
              {[page.username ? `@${page.username}` : null, page.category, followersText(page.followers_count)].filter(Boolean).join(" · ")}
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              {page.is_published !== null && (
                <span className={`pd-chip ${page.is_published ? "pd-chip--saved" : "pd-chip--unknown"}`}>
                  {page.is_published ? "Published" : "Not published"}
                </span>
              )}
              {page.link && (
                <a href={page.link} target="_blank" rel="noreferrer" className="pd-link">
                  Open on Facebook
                </a>
              )}
            </div>
          </div>
        </div>
        <CheckedLine view={view} accountId={id} />
      </section>

      {!view.can_edit && view.cannot_edit_reason && BANNER_REASON[view.cannot_edit_reason] && (
        <div className="pd-strip pd-strip--warn" role="status">
          {BANNER_REASON[view.cannot_edit_reason]}
        </div>
      )}
      {banner && (
        <div className={`pd-strip pd-strip--${banner.tone}`} role={banner.tone === "bad" ? "alert" : "status"}>
          {banner.text}
        </div>
      )}

      <LockedDetails page={page} />
      <PageDetailsForm
        form={form}
        disabled={disabled}
        problems={problems}
        onChange={(next) => setEdits(next)}
        onTouch={(f) => setTouched((t) => new Set(t).add(f))}
      />
      <RecentChanges accountId={id} />

      {view.can_edit && (
        <div className="pd-bar">
          <div className="pd-bar__why" aria-live="polite">
            {barWhy}
          </div>
          <div className="pd-bar__buttons">
            <button
              type="button"
              className="btn btn--subtle"
              disabled={keys.length === 0}
              onClick={() => {
                setEdits({});
                setTouched(new Set());
              }}
            >
              Undo changes
            </button>
            <button type="button" className="btn btn--primary" disabled={barWhy !== null} onClick={() => setReviewing(true)}>
              Review and save…
            </button>
          </div>
        </div>
      )}

      {reviewing && (
        <SaveDialog
          view={view}
          live={live}
          form={form}
          keys={keys}
          changes={changes}
          onClose={() => setReviewing(false)}
          onAnswer={onAnswer}
          onFailure={onFailure}
        />
      )}
    </div>
  );
}

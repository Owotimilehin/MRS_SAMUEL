/**
 * WhatsApp business profile (suite spec 05, section 7): what customers see when they tap our
 * name in WhatsApp, read live from Meta, and the few things we may change. Nothing reaches
 * WhatsApp until a person reviews the before-and-after and confirms.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { DataState } from "@admin/components/DataState.js";
import { Modal } from "@admin/components/Modal.js";
import { ApiError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import {
  WA_PROFILE_LIMITS,
  WA_VERTICALS,
  diffWaProfile,
  normaliseWaProfile,
  validateWaProfile,
  waProfileFieldLabel,
  type WaProfileFields,
} from "@ms/shared";
import {
  waProfileApi,
  waProfileKeys,
  type WaProfileJson,
  type WaProfileView,
  type WaSaveAnswer,
  type WaSaveFailure,
} from "./whatsapp-profile-api.js";
import { ProfileConfirmDialog } from "./ProfileConfirmDialog.js";
import { Avatar, ProfilePhotoDialog } from "./ProfilePhotoDialog.js";
import "./whatsapp-profile.css";

// ── Plain wording for Meta's values (7.4). Pure, and tested. ─────────────────

export type Tone = "good" | "warn" | "bad" | "grey";
export interface Worded {
  text: string;
  tone: Tone;
}

export function nameStatusLabel(v: string | null): Worded {
  switch (v) {
    case "APPROVED":
      return { text: "Approved", tone: "good" };
    case "AVAILABLE_WITHOUT_REVIEW":
      return { text: "In use, not reviewed yet", tone: "grey" };
    case "PENDING_REVIEW":
      return { text: "Waiting for WhatsApp to review", tone: "warn" };
    case "DECLINED":
      return { text: "Refused by WhatsApp", tone: "bad" };
    case "EXPIRED":
      return { text: "Expired. The number must be set up again", tone: "bad" };
    case "NONE":
      return { text: "No name on record", tone: "grey" };
    case null:
      return { text: "Unknown", tone: "grey" };
    default:
      return { text: v, tone: "grey" };
  }
}

export function connectionLabel(v: string | null): Worded {
  if (v === null) return { text: "Unknown", tone: "grey" };
  if (v === "CONNECTED") return { text: "Connected", tone: "good" };
  return { text: `Not working normally (WhatsApp says: ${v})`, tone: "bad" };
}

export function qualityLabel(v: string | null): Worded {
  switch (v) {
    case "GREEN":
      return { text: "Good", tone: "good" };
    case "YELLOW":
      return { text: "Medium. Customers have been blocking or reporting some messages", tone: "warn" };
    case "RED":
      return { text: "Low. Slow down on templates until this improves", tone: "bad" };
    default:
      // NA, UNKNOWN, null and anything new: not rated yet.
      return { text: "Not rated yet", tone: "grey" };
  }
}

export function reachLabel(v: string | null): string {
  switch (v) {
    case "TIER_250":
      return "Up to 250 new customers a day";
    case "TIER_2K":
      return "Up to 2,000 new customers a day";
    case "TIER_10K":
      return "Up to 10,000 new customers a day";
    case "TIER_100K":
      return "Up to 100,000 new customers a day";
    case "TIER_UNLIMITED":
      return "No daily limit";
    case null:
      return "Unknown";
    default:
      return v;
  }
}

const PILL: Record<Tone, string> = { good: "pill pill--success", warn: "pill pill--warning", bad: "pill pill--danger", grey: "pill" };

function Pill({ w }: { w: Worded }): JSX.Element {
  return <span className={PILL[w.tone]}>{w.text}</span>;
}

// ── The page ─────────────────────────────────────────────────────────────────

const NO_ACCESS = "You do not have access to channel set-up. Ask the owner to give your account the 'Channels' permission.";
const EMPTY_ABOUT = "WhatsApp does not allow an empty 'about' line. Write a short line instead.";
const count = (s: string): number => [...s].length;

const fieldsOf = (p: WaProfileFields): WaProfileFields => ({
  about: p.about,
  address: p.address,
  description: p.description,
  email: p.email,
  websites: [...p.websites],
  vertical: p.vertical,
});

export function WhatsAppProfilePage({ accountId }: { accountId: string }): JSX.Element {
  const can = useCan();
  if (!can("channels.manage")) {
    return (
      <Frame title="WhatsApp business profile" crumb="Channels">
        <div className="empty">
          <div className="empty__title">No access</div>
          {NO_ACCESS}
        </div>
      </Frame>
    );
  }
  return <Loaded id={accountId} />;
}

function Loaded({ id }: { id: string }): JSX.Element {
  const q = useQuery({ queryKey: waProfileKeys.one(id), queryFn: () => waProfileApi.get(id), refetchOnWindowFocus: false });
  const err = q.error instanceof ApiError ? q.error : null;
  return (
    <Frame title="WhatsApp business profile" crumb="Channels">
      {err?.status === 403 ? (
        <div className="empty">
          <div className="empty__title">No access</div>
          {NO_ACCESS}
        </div>
      ) : err?.status === 400 || err?.status === 404 ? (
        <div className="empty">
          <div className="empty__title">{err.status === 404 ? "Not found" : "No WhatsApp"}</div>
          {err.status === 404 ? "We could not find this number." : "This number has no WhatsApp."}
        </div>
      ) : (
        <DataState loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          {q.data && <Screen view={q.data} />}
        </DataState>
      )}
    </Frame>
  );
}

function Counter({ value, max }: { value: string; max: number }): JSX.Element {
  const n = count(value);
  return <span className={n > max ? "wp-count wp-count--over" : "wp-count"}>{n}/{max}</span>;
}

function Problem({ text }: { text?: string | undefined }): JSX.Element | null {
  return text ? (
    <div className="field__error" role="alert">
      {text}
    </div>
  ) : null;
}

function Screen({ view }: { view: WaProfileView }): JSX.Element {
  const qc = useQueryClient();
  const id = view.number.id;
  const live = fieldsOf(view.profile);
  const [edits, setEdits] = useState<Partial<WaProfileFields>>({});
  const [reviewing, setReviewing] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const form: WaProfileFields = { ...live, ...edits };
  const tidy = normaliseWaProfile(form);
  const problems = validateWaProfile(tidy, { keepVertical: live.vertical });
  if (tidy.about === "" && normaliseWaProfile(live).about !== "" && !problems.about) problems.about = EMPTY_ABOUT;
  const changes = diffWaProfile(live, tidy);
  const dirty = changes.length > 0;
  const hasProblems = Object.keys(problems).length > 0;

  // Leaving with unsaved changes: the browser asks on close or reload; in-app moves ask here (7.7).
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const blocker = useBlocker({ condition: dirty });

  const setField = <K extends keyof WaProfileFields>(k: K, v: WaProfileFields[K]): void => setEdits((e) => ({ ...e, [k]: v }));
  const web = (i: 0 | 1): string => form.websites[i] ?? "";
  const setWeb = (i: 0 | 1, v: string): void => {
    const next: string[] = [web(0), web(1)];
    next[i] = v;
    setField("websites", next);
  };
  const putProfile = (p: WaProfileJson): void => {
    qc.setQueryData<WaProfileView>(waProfileKeys.one(id), { ...view, profile: p });
  };

  function onSaved(a: WaSaveAnswer): void {
    putProfile(a.profile);
    setReviewing(false);
    setEdits({});
    if (a.mismatch.length > 0) {
      setBanner(`Saved, but WhatsApp shows something different for: ${a.mismatch.map(waProfileFieldLabel).join(", ")}. Check below.`);
    } else {
      setBanner(null);
      toast.success("Saved. This is what WhatsApp now shows.");
    }
  }

  function onChangedElsewhere(f: WaSaveFailure): void {
    setReviewing(false);
    if (f.current) putProfile(f.current);
    setEdits({});
    setBanner(f.message);
  }

  /** After a timeout or a 5xx the page reloads what WhatsApp holds, so the screen shows the truth (rule 10). */
  function onUnsure(): void {
    void qc.invalidateQueries({ queryKey: waProfileKeys.one(id) });
  }

  const initials = "MS";
  const picture = view.profile.profile_picture_url;

  return (
    <div className="wp-page">
      {banner && (
        <div className="wp-strip" role="status">
          {banner}
        </div>
      )}
      <div className="wp-grid">
        <section className="card wp-card">
          <h2 className="wp-h">What customers see</h2>

          <div className="wp-photo">
            <Avatar url={picture} initials={initials} size={96} />
            <div>
              <div className="field__label">Profile photo</div>
              <button type="button" className="btn btn--subtle btn--sm" disabled={!view.photo_upload_ready} onClick={() => setPhotoOpen(true)}>
                Change photo
              </button>
              <div className="field__hint">A square JPG or PNG. Your logo works best.</div>
              {!view.photo_upload_ready && (
                <div className="field__hint" role="note">
                  Photo upload is not set up on this server yet. Change the photo in WhatsApp Manager for now.
                </div>
              )}
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="wp-about">About</label>
            <span className="field__hint">One short line under your name, like a status.</span>
            <input id="wp-about" className="input" value={form.about} onChange={(e) => setField("about", e.target.value)} />
            <Counter value={form.about} max={WA_PROFILE_LIMITS.about} />
            <Problem text={problems.about} />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="wp-description">Description</label>
            <span className="field__hint">What you sell and how to order.</span>
            <textarea id="wp-description" className="textarea" rows={4} value={form.description} onChange={(e) => setField("description", e.target.value)} />
            <Counter value={form.description} max={WA_PROFILE_LIMITS.description} />
            <Problem text={problems.description} />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="wp-address">Address</label>
            <span className="field__hint">Where customers can find you.</span>
            <textarea id="wp-address" className="textarea" rows={2} value={form.address} onChange={(e) => setField("address", e.target.value)} />
            <Counter value={form.address} max={WA_PROFILE_LIMITS.address} />
            <Problem text={problems.address} />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="wp-email">Email</label>
            <span className="field__hint">An address customers can write to.</span>
            <input id="wp-email" type="email" className="input" value={form.email} onChange={(e) => setField("email", e.target.value)} />
            <Counter value={form.email} max={WA_PROFILE_LIMITS.email} />
            <Problem text={problems.email} />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="wp-web1">Website</label>
            <span className="field__hint">Start with https://</span>
            <input id="wp-web1" className="input" inputMode="url" value={web(0)} onChange={(e) => setWeb(0, e.target.value)} />
            <Counter value={web(0)} max={WA_PROFILE_LIMITS.website} />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="wp-web2">Second website (optional)</label>
            <span className="field__hint">For example your Instagram page.</span>
            <input id="wp-web2" className="input" inputMode="url" value={web(1)} onChange={(e) => setWeb(1, e.target.value)} />
            <Counter value={web(1)} max={WA_PROFILE_LIMITS.website} />
            <Problem text={problems.websites} />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="wp-vertical">Type of business</label>
            <span className="field__hint">Helps WhatsApp describe you. Most juice shops choose Restaurant or Food and grocery.</span>
            <select id="wp-vertical" className="select" value={form.vertical} onChange={(e) => setField("vertical", e.target.value)}>
              {verticalOptions(live.vertical).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <Problem text={problems.vertical} />
          </div>

          <div className="wp-buttons">
            <button type="button" className="btn btn--primary" disabled={!dirty || hasProblems} onClick={() => setReviewing(true)}>
              Review changes
            </button>
            <button type="button" className="btn btn--ghost" disabled={!dirty} onClick={() => setEdits({})}>
              Undo changes
            </button>
          </div>
        </section>

        <SetByWhatsApp view={view} />
      </div>

      {reviewing && (
        <ProfileConfirmDialog
          numberId={id}
          live={live}
          form={form}
          rows={changes}
          onClose={() => setReviewing(false)}
          onSaved={onSaved}
          onChangedElsewhere={onChangedElsewhere}
          onUnsure={onUnsure}
        />
      )}
      {photoOpen && (
        <ProfilePhotoDialog
          numberId={id}
          currentUrl={picture}
          initials={initials}
          onClose={() => setPhotoOpen(false)}
          onDone={() => {
            setPhotoOpen(false);
            toast.success("Photo changed.");
            void qc.invalidateQueries({ queryKey: waProfileKeys.one(id) });
          }}
        />
      )}
      {blocker.status === "blocked" && (
        <Modal title="Leave without saving your changes?" onClose={blocker.reset} maxWidth={420}>
          <p style={{ margin: "0 0 14px" }}>You have changes that are not saved to WhatsApp yet.</p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn--subtle" onClick={blocker.reset}>
              Stay
            </button>
            <button type="button" className="btn btn--primary" onClick={blocker.proceed}>
              Leave
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** The offered types (7.3), plus the value already on the profile when it is not offered. */
function verticalOptions(current: string): { value: string; label: string }[] {
  const offered = WA_VERTICALS.some((v) => v.value === current);
  if (offered) return [...WA_VERTICALS];
  if (current === "UNDEFINED") return [{ value: "UNDEFINED", label: "Not set" }, ...WA_VERTICALS.filter((v) => v.value !== "")];
  return [{ value: current, label: current }, ...WA_VERTICALS];
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="wp-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function SetByWhatsApp({ view }: { view: WaProfileView }): JSX.Element {
  const s = view.status;
  const pin =
    s.pin_enabled === true
      ? "Set"
      : s.pin_enabled === false
        ? "Not set. Ask the technical lead to set one."
        : "WhatsApp does not tell us. Check in WhatsApp Manager.";
  return (
    <section className="card wp-card">
      <h2 className="wp-h">Set by WhatsApp</h2>
      <p className="wp-fine">You cannot change these here. WhatsApp sets them, or they are changed in WhatsApp Manager.</p>
      <dl className="wp-rows">
        <Row label="Phone number">{s.display_phone_number ?? view.number.e164 ?? "Unknown"}</Row>
        <Row label="Display name">
          <span>{s.display_name ?? "Unknown"}</span> <Pill w={nameStatusLabel(s.name_status)} />
        </Row>
        {s.pending_name && (
          <Row label="Name waiting for approval">
            <span>{s.pending_name}</span> <Pill w={nameStatusLabel(s.pending_name_status)} />
          </Row>
        )}
        <Row label="Connection">
          <Pill w={connectionLabel(s.status)} />
        </Row>
        <Row label="Quality">
          <Pill w={qualityLabel(s.quality_rating)} />
        </Row>
        <Row label="Daily reach">
          <div>{reachLabel(s.messaging_limit)}</div>
          <div className="wp-fine">This counts conversations you start with templates. Replies to customers are not limited.</div>
        </Row>
        <Row label="Two-step PIN">{pin}</Row>
        {s.official_account !== null && <Row label="Verified badge">{s.official_account ? "Yes" : "No"}</Row>}
      </dl>
      <div>
        <a className="btn btn--subtle btn--sm" href={view.manager_url} target="_blank" rel="noreferrer">
          Open WhatsApp Manager <ExternalLink size={14} aria-hidden />
        </a>
        <p className="wp-fine">Use WhatsApp Manager to change the display name or the two-step PIN.</p>
      </div>
    </section>
  );
}

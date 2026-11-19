/**
 * New advert (suite spec 12, 7.9). Owner, or someone the owner has given the
 * manage-ads permission, and only while "Allow adverts to be created and
 * changed from the suite" is on. Saving a draft sends nothing to Meta.
 * "Review and create…" saves, asks the server for the summary and the total,
 * and opens the confirmation. Adverts are created switched off.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AD_LIMITS, money, type AdDestination, type AdDraftSpecInput } from "@ms/shared";
import { InlineLoader } from "@admin/components/Spinner.js";
import { humanizeError } from "@admin/lib/api.js";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { toast } from "@admin/lib/toast.js";
import "@admin/components/inbox/inbox.css";
import "./ads.css";
import { adsApi, adsKeys, putPicture, type AdDraft, type DraftPreview } from "./ads-api.js";
import { destinationLabel, isoToLagosLocal, lagosLocalToIso } from "./ads-logic.js";
import { AdvertSummaryDialog, NEEDS_CHECK_TEXT } from "./AdvertSummaryDialog.js";

interface FormState {
  destination: AdDestination;
  account_id: string;
  name: string;
  headline: string;
  primary_text: string;
  description: string;
  image_key: string;
  greeting: string;
  prefilled_message: string;
  area: "nigeria" | "near_shop";
  radius_km: string;
  age_min: string;
  age_max: string;
  daily_budget: string;
  start: string;
  end: string;
  special: "" | "no" | "yes";
}

function blank(): FormState {
  const start = new Date(Date.now() + 3600_000);
  start.setMinutes(0, 0, 0);
  return {
    destination: "whatsapp",
    account_id: "",
    name: "",
    headline: "",
    primary_text: "",
    description: "",
    image_key: "",
    greeting: "",
    prefilled_message: "",
    area: "nigeria",
    radius_km: "10",
    age_min: "18",
    age_max: "65",
    daily_budget: "",
    start: isoToLagosLocal(start.toISOString()),
    end: isoToLagosLocal(new Date(start.getTime() + 7 * 86400_000).toISOString()),
    special: "",
  };
}

function fromSpec(s: AdDraftSpecInput): FormState {
  return {
    destination: s.destination,
    account_id: s.account_id,
    name: s.name,
    headline: s.headline,
    primary_text: s.primary_text,
    description: s.description ?? "",
    image_key: s.image_key,
    greeting: s.greeting,
    prefilled_message: s.prefilled_message ?? "",
    area: s.audience.area,
    radius_km: s.audience.radius_km == null ? "10" : String(s.audience.radius_km),
    age_min: String(s.audience.age_min),
    age_max: String(s.audience.age_max),
    daily_budget: String(s.daily_budget),
    start: isoToLagosLocal(s.start_at),
    end: isoToLagosLocal(s.end_at),
    special: "no",
  };
}

/** The spec to save, or the first thing still missing in plain words. */
function toSpec(f: FormState): { spec: AdDraftSpecInput } | { problem: string } {
  if (f.special !== "no") return { problem: "Answer the last question first." };
  if (!f.account_id) return { problem: "Choose where the advert should open a chat." };
  if (f.name.trim().length < AD_LIMITS.name.min) return { problem: "Give the advert a name of at least 3 letters." };
  if (!f.image_key) return { problem: "Add a picture." };
  if (!f.headline.trim() || !f.primary_text.trim()) return { problem: "Write the headline and the main text." };
  if (!f.greeting.trim()) return { problem: "Write the first message the customer sees from us." };
  if (!/^\d+$/.test(f.daily_budget.trim()) || Number(f.daily_budget) < 1) return { problem: "The daily budget must be a whole number." };
  const start = lagosLocalToIso(f.start);
  const end = lagosLocalToIso(f.end);
  if (!start || !end) return { problem: "Choose when the advert starts and ends." };
  return {
    spec: {
      destination: f.destination,
      account_id: f.account_id,
      name: f.name.trim(),
      headline: f.headline.trim(),
      primary_text: f.primary_text.trim(),
      description: f.description.trim() || null,
      image_key: f.image_key,
      greeting: f.greeting.trim(),
      prefilled_message: f.destination === "whatsapp" && f.prefilled_message.trim() ? f.prefilled_message.trim() : null,
      audience: {
        area: f.area,
        radius_km: f.area === "near_shop" ? Number(f.radius_km) : null,
        age_min: Number(f.age_min),
        age_max: Number(f.age_max),
      },
      daily_budget: Number(f.daily_budget),
      start_at: start,
      end_at: end,
      special_category: false,
    },
  };
}

function Counted({ label, help, value, max, onChange, area }: { label: string; help?: string; value: string; max: number; onChange: (v: string) => void; area?: boolean }): JSX.Element {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {area ? (
        <textarea className="input" maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input" maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      <span className="ads-count">
        {help ? `${help} · ` : ""}
        {value.length}/{max}
      </span>
    </label>
  );
}

export function AdvertForm({ draftId }: { draftId?: string }): JSX.Element {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useQuery({ queryKey: adsKeys.status, queryFn: adsApi.status });
  const destinations = useQuery({ queryKey: adsKeys.destinations, queryFn: adsApi.destinations, enabled: can("ads.manage") });
  const existing = useQuery({ queryKey: adsKeys.draft(draftId ?? ""), queryFn: () => adsApi.draft(draftId!), enabled: !!draftId, retry: false });
  const [f, setF] = useState<FormState>(blank);
  const [savedId, setSavedId] = useState<string | null>(draftId ?? null);
  const [draft, setDraft] = useState<AdDraft | null>(null);
  const [imageToken, setImageToken] = useState<string | null>(null);
  const [picture, setPicture] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "upload" | "save" | "review" | "continue">("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setF((cur) => ({ ...cur, [key]: value }));

  useEffect(() => {
    if (existing.data) {
      setDraft(existing.data);
      setF(fromSpec(existing.data.spec));
    }
  }, [existing.data]);

  const options = useMemo(() => destinations.data ?? [], [destinations.data]);
  const accounts = useMemo(() => options.find((o) => o.destination === f.destination)?.accounts ?? [], [options, f.destination]);
  useEffect(() => {
    if (!f.account_id && accounts.length === 1) set("account_id", accounts[0]!.id);
  }, [accounts, f.account_id]);

  const account = status.data?.account ?? null;
  const settings = status.data?.settings;
  const currency = account?.currency ?? "NGN";
  const locked = !!draft && (draft.status === "created" || draft.status === "creating" || draft.status === "needs_check" || !!draft.campaign_external_id);

  async function pick(file: File | null): Promise<void> {
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") return setError("The picture must be a JPEG or a PNG.");
    if (file.size > AD_LIMITS.imageMaxBytes) return setError("The picture is too large (limit 8 MB).");
    setBusy("upload");
    setError(null);
    try {
      const up = await adsApi.upload(file);
      await putPicture(up.upload_url, file);
      set("image_key", up.object_key);
      setImageToken(up.upload_token);
      setPicture(URL.createObjectURL(file));
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy("");
    }
  }

  async function save(): Promise<AdDraft | null> {
    const built = toSpec(f);
    if ("problem" in built) {
      setError(built.problem);
      return null;
    }
    setError(null);
    try {
      const saved = savedId ? await adsApi.updateDraft(savedId, built.spec, imageToken) : await adsApi.createDraft(built.spec, imageToken);
      setSavedId(saved.id);
      setDraft(saved);
      await qc.invalidateQueries({ queryKey: ["ads", "drafts"] });
      return saved;
    } catch (e) {
      setError(humanizeError(e));
      return null;
    }
  }

  async function saveDraft(): Promise<void> {
    setBusy("save");
    const saved = await save();
    setBusy("");
    if (saved) toast.success("Draft saved. Nothing has been sent to Meta.");
  }

  async function review(): Promise<void> {
    setBusy("review");
    const saved = await save();
    if (saved) {
      try {
        setPreview(await adsApi.preview(saved.id));
      } catch (e) {
        setError(humanizeError(e));
      }
    }
    setBusy("");
  }

  async function carryOn(): Promise<void> {
    if (!savedId) return;
    setBusy("continue");
    setError(null);
    try {
      finish(await adsApi.continueDraft(savedId));
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy("");
    }
  }

  function finish(result: AdDraft): void {
    setPreview(null);
    setDraft(result);
    void qc.invalidateQueries({ queryKey: adsKeys.all });
    if (result.status === "created") {
      toast.success("The advert has been created and is switched off.");
      if (result.ad_external_id) void navigate({ to: "/ads/adverts/$adId", params: { adId: result.ad_external_id } });
      else void navigate({ to: "/ads" });
    }
  }

  let body: JSX.Element;
  if (!can("ads.manage")) {
    body = <div className="card">You don&apos;t have permission to create adverts. Ask the owner.</div>;
  } else if (status.isLoading || (draftId && existing.isLoading)) {
    body = <InlineLoader />;
  } else if (!settings?.manage_enabled) {
    body = <div className="card">Creating and changing adverts is switched off. The owner can turn it on in Ads → Settings.</div>;
  } else if (draftId && existing.error) {
    body = <div className="card">{humanizeError(existing.error)}</div>;
  } else {
    const special = f.special === "yes";
    const disabled = busy !== "" || special || locked;
    body = (
      <div className="ads-split">
        <section className="card ads-form">
          {draft?.status === "failed" && draft.error_message ? (
            <div className="ads-strip ads-strip--bad">
              {draft.error_message}{" "}
              {draft.confirmed ? (
                <button type="button" className="btn btn--subtle btn--sm" disabled={busy !== ""} onClick={() => void carryOn()}>
                  {busy === "continue" ? "Working…" : "Continue"}
                </button>
              ) : null}
            </div>
          ) : null}
          {draft?.status === "needs_check" || draft?.status === "creating" ? (
            <div className="ads-strip ads-strip--warn">
              {draft.status === "needs_check" ? NEEDS_CHECK_TEXT : "This advert is being created. If nothing changes in ten minutes, press Continue and we will check what was created."}{" "}
              <button type="button" className="btn btn--subtle btn--sm" disabled={busy !== ""} onClick={() => void carryOn()}>
                {busy === "continue" ? "Working…" : "Continue"}
              </button>
            </div>
          ) : null}
          {draft?.status === "created" ? <div className="ads-strip">This advert has been created and is switched off. Open it from the Adverts list to turn it on.</div> : null}

          <label className="field">
            <span className="field__label">Where should the advert open a chat?</span>
            <select className="select" value={f.destination} disabled={locked} onChange={(e) => setF((cur) => ({ ...cur, destination: e.target.value as AdDestination, account_id: "" }))}>
              {options.map((o) => (
                <option key={o.destination} value={o.destination}>
                  {destinationLabel(o.destination)}
                </option>
              ))}
            </select>
            <select className="select" value={f.account_id} disabled={locked} onChange={(e) => set("account_id", e.target.value)}>
              <option value="">Choose…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <span className="ads-count" style={{ textAlign: "left" }}>For now the suite creates adverts that open a WhatsApp chat. For Messenger or Instagram, use Meta Ads Manager.</span>
          </label>
          <Counted label="Name (only you see this)" value={f.name} max={AD_LIMITS.name.max} onChange={(v) => set("name", v)} />
          <label className="field">
            <span className="field__label">Picture</span>
            <input type="file" accept="image/jpeg,image/png" disabled={disabled} onChange={(e) => void pick(e.target.files?.[0] ?? null)} />
            <span className="ads-count" style={{ textAlign: "left" }}>
              JPEG or PNG, up to 8 MB.{busy === "upload" ? " Uploading…" : f.image_key ? " Picture added." : ""}
            </span>
          </label>
          <Counted label="Headline" value={f.headline} max={AD_LIMITS.headline} onChange={(v) => set("headline", v)} />
          <Counted label="Main text" value={f.primary_text} max={AD_LIMITS.primaryText} onChange={(v) => set("primary_text", v)} area />
          <Counted label="Small print (optional)" value={f.description} max={AD_LIMITS.description} onChange={(v) => set("description", v)} />
          <Counted label="First message the customer sees from us" value={f.greeting} max={AD_LIMITS.greeting} onChange={(v) => set("greeting", v)} area />
          {f.destination === "whatsapp" ? (
            <Counted
              label="Message already typed for the customer (optional)"
              help="They can change it before sending."
              value={f.prefilled_message}
              max={AD_LIMITS.prefilled}
              onChange={(v) => set("prefilled_message", v)}
            />
          ) : null}
          <div className="field">
            <span className="field__label">Who should see it?</span>
            <label className="ads-check">
              <input type="radio" name="area" checked={f.area === "nigeria"} onChange={() => set("area", "nigeria")} />
              <span>Everyone in Nigeria</span>
            </label>
            {status.data?.phase_b.near_shop_available ? (
              <label className="ads-check">
                <input type="radio" name="area" checked={f.area === "near_shop"} onChange={() => set("area", "near_shop")} />
                <span>
                  People near the shop. Within{" "}
                  <input className="input" style={{ width: 70, display: "inline-block" }} inputMode="numeric" value={f.radius_km} onChange={(e) => set("radius_km", e.target.value)} aria-label="Kilometres" /> km
                </span>
              </label>
            ) : null}
            <span>
              Ages{" "}
              <input className="input" style={{ width: 70, display: "inline-block" }} inputMode="numeric" value={f.age_min} onChange={(e) => set("age_min", e.target.value)} aria-label="Youngest age" /> to{" "}
              <input className="input" style={{ width: 70, display: "inline-block" }} inputMode="numeric" value={f.age_max} onChange={(e) => set("age_max", e.target.value)} aria-label="Oldest age" />
            </span>
          </div>
          <label className="field">
            <span className="field__label">Daily budget ({currency}), whole numbers only</span>
            <input className="input" inputMode="numeric" value={f.daily_budget} onChange={(e) => set("daily_budget", e.target.value)} />
            <span className="ads-count" style={{ textAlign: "left" }}>
              {account?.min_daily != null ? `Meta's minimum for this account: ${money(account.min_daily, currency)}. ` : ""}
              Your daily cap: {money(settings.daily_cap, currency)}.
            </span>
          </label>
          <div className="ads-two">
            <label className="field">
              <span className="field__label">Starts (Lagos time)</span>
              <input className="input" type="datetime-local" value={f.start} onChange={(e) => set("start", e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Ends (Lagos time)</span>
              <input className="input" type="datetime-local" value={f.end} onChange={(e) => set("end", e.target.value)} />
            </label>
          </div>
          <p className="ads-fine">It must end at least a day after it starts and within 30 days, so the most it can spend is always a known amount.</p>
          <div className="field">
            <span className="field__label">Is this advert about jobs, housing, loans or other financial services, politics or social issues, or gambling?</span>
            <label className="ads-check">
              <input type="radio" name="special" checked={f.special === "no"} onChange={() => set("special", "no")} />
              <span>No</span>
            </label>
            <label className="ads-check">
              <input type="radio" name="special" checked={f.special === "yes"} onChange={() => set("special", "yes")} />
              <span>Yes</span>
            </label>
            {special ? (
              <div className="ads-strip ads-strip--warn">
                Adverts on these subjects have extra legal rules. Create this one in Meta Ads Manager, where Meta asks the right questions.
              </div>
            ) : null}
          </div>
          {error ? <div className="ads-strip ads-strip--bad">{error}</div> : null}
          <div className="ads-actions">
            <button type="button" className="btn btn--subtle" disabled={disabled} onClick={() => void saveDraft()}>
              {busy === "save" ? "Saving…" : "Save draft"}
            </button>
            <button type="button" className="btn btn--primary" disabled={disabled} onClick={() => void review()}>
              {busy === "review" ? "Working…" : "Review and create…"}
            </button>
          </div>
          <p className="ads-fine">Saving a draft sends nothing to Meta. An advert is always created switched off; turning it on is a separate step.</p>
        </section>
        <aside className="ads-card">
          <div className="ads-preview">
            {picture ? <img className="ads-preview__pic" src={picture} alt="" /> : <div className="ads-preview__pic" />}
            <div className="ads-preview__body">
              <div>{f.primary_text || "Main text"}</div>
              <div className="ads-name">{f.headline || "Headline"}</div>
              {f.description ? <div className="ads-sub">{f.description}</div> : null}
              <div className="ads-preview__cta">{f.destination === "whatsapp" ? "WhatsApp" : "Send message"}</div>
            </div>
          </div>
          <p className="ads-fine">A close likeness. Meta may lay it out differently.</p>
        </aside>
      </div>
    );
  }

  return (
    <Frame title={draftId ? "Advert draft" : "New advert"} crumb="Ads">
      <div className="ads-page">
        <div>
          <Link to="/ads" className="ads-link">
            ← Back to Ads
          </Link>
        </div>
        {body}
      </div>
      {preview && savedId ? (
        <AdvertSummaryDialog draftId={savedId} preview={preview} currency={currency} onClose={() => setPreview(null)} onResult={finish} />
      ) : null}
    </Frame>
  );
}

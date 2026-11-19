import { PAGE_LIMITS, type PageEditable, type PageEditableKey } from "@ms/shared";
import { PageHoursEditor } from "./PageHoursEditor.js";

export interface FormProps {
  form: PageEditable;
  onChange: (next: PageEditable) => void;
  disabled: boolean;
  /** Problems by field, already limited to fields the person has left. */
  problems: Partial<Record<PageEditableKey, string[]>>;
  onTouch: (field: PageEditableKey) => void;
}

function Problems({ list }: { list?: string[] | undefined }): JSX.Element | null {
  if (!list || list.length === 0) return null;
  return (
    <>
      {list.map((m) => (
        <div key={m} className="field__error" role="alert">
          {m}
        </div>
      ))}
    </>
  );
}

/** The editable fields (suite spec 10, section 7). */
export function PageDetailsForm({ form, onChange, disabled, problems, onTouch }: FormProps): JSX.Element {
  const set = <K extends PageEditableKey>(k: K, v: PageEditable[K]): void => onChange({ ...form, [k]: v });
  const about = form.about ?? "";
  const description = form.description ?? "";
  const address = form.address ?? { street: "", city: "", state: "", country: "", zip: "" };
  const setAddress = (part: keyof typeof address, v: string): void => set("address", { ...address, [part]: v });
  return (
    <section className="card pd-card">
      <h2 className="pd-h">Details you can change here</h2>

      <div className="field">
        <label className="field__label" htmlFor="pd-about">Short description</label>
        <span className="field__hint">One or two lines shown at the top of your Page.</span>
        <textarea id="pd-about" className="textarea" rows={2} value={about} disabled={disabled}
          onChange={(e) => set("about", e.target.value)} onBlur={() => onTouch("about")} />
        <span className={about.length > PAGE_LIMITS.aboutMax ? "pd-count pd-count--over" : "pd-count"}>{about.length} / {PAGE_LIMITS.aboutMax}</span>
        <Problems list={problems.about} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="pd-description">More about the business</label>
        <span className="field__hint">Shown in the Page's About section.</span>
        <textarea id="pd-description" className="textarea" rows={4} value={description} disabled={disabled}
          onChange={(e) => set("description", e.target.value)} onBlur={() => onTouch("description")} />
        <span className={description.length > PAGE_LIMITS.descriptionMax ? "pd-count pd-count--over" : "pd-count"}>{description.length} / {PAGE_LIMITS.descriptionMax}</span>
        <Problems list={problems.description} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="pd-phone">Phone</label>
        <span className="field__hint">Include the country code, for example +234…</span>
        <input id="pd-phone" className="input" inputMode="tel" value={form.phone ?? ""} disabled={disabled}
          onChange={(e) => set("phone", e.target.value)} onBlur={() => onTouch("phone")} />
        <Problems list={problems.phone} />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="pd-website">Website</label>
        <input id="pd-website" className="input" inputMode="url" value={form.website ?? ""} disabled={disabled}
          onChange={(e) => set("website", e.target.value)} onBlur={() => onTouch("website")} />
        <Problems list={problems.website} />
      </div>

      <div className="field">
        <span className="field__label">Emails</span>
        {form.emails.map((e, i) => (
          <div key={i} className="pd-range">
            <input className="input" type="email" aria-label={`Email ${i + 1}`} value={e} disabled={disabled}
              onChange={(ev) => set("emails", form.emails.map((x, j) => (j === i ? ev.target.value : x)))}
              onBlur={() => onTouch("emails")} />
            <button type="button" className="btn btn--subtle btn--sm" disabled={disabled}
              onClick={() => set("emails", form.emails.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <div>
          <button type="button" className="btn btn--subtle btn--sm"
            disabled={disabled || form.emails.length >= PAGE_LIMITS.emailsMax}
            onClick={() => set("emails", [...form.emails, ""])}>Add an email</button>
        </div>
        <Problems list={problems.emails} />
      </div>

      <div className="field">
        <span className="field__label">Opening hours</span>
        <span className="field__hint">Times are Lagos time. If you close after midnight, the closing time can be up to 6:00 am.</span>
        <label className="pd-switch">
          <input type="checkbox" checked={form.always_open} disabled={disabled}
            onChange={(e) => set("always_open", e.target.checked)} />
          <span>Always open</span>
        </label>
        {!form.always_open && (
          <PageHoursEditor week={form.hours} disabled={disabled} onChange={(w) => { set("hours", w); onTouch("hours"); }} />
        )}
        <Problems list={problems.hours} />
      </div>

      <div className="field">
        <span className="field__label">Address</span>
        <span className="field__hint">Shown on your Page with a map, if Facebook can find it.</span>
        <div className="pd-address">
          {([
            ["street", "Street"],
            ["city", "City"],
            ["state", "State"],
            ["country", "Country"],
            ["zip", "Postcode"],
          ] as const).map(([part, label]) => (
            <input key={part} className="input" aria-label={label} placeholder={label} value={address[part]} disabled={disabled}
              onChange={(e) => setAddress(part, e.target.value)} onBlur={() => onTouch("address")} />
          ))}
        </div>
        <Problems list={problems.address} />
      </div>
    </section>
  );
}

/**
 * The filter chips on the Contacts page (suite spec 14, 7.2): a row of chips on
 * a desktop, a "Filters" sheet on a phone.
 */
import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { CONSENT_VIEW_LABEL, CONTACT_CHANNELS, CONTACT_SOURCES, type ConsentView, type ContactListView } from "@ms/shared";
import type { LabelRow } from "./contacts-api.js";
import { CHANNEL_TEXT, anyFilterOn, sourceText, toContactFilter, type FilterState } from "./contacts-logic.js";

const ORDERED_CHOICES = ["30", "60", "90", "180", "365"];

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className={`ct-chip${active ? " is-on" : ""}`} aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  );
}

export function ContactFilters({
  state,
  onChange,
  labels,
  lists,
  onClear,
  saveButton,
}: {
  state: FilterState;
  onChange: (next: FilterState) => void;
  labels: LabelRow[];
  /** Lists picked by hand (a list that fills itself cannot be a filter). */
  lists: ContactListView[];
  onClear: () => void;
  /** Shown when any filter is on: "Save as a list…" or "Save changes to …". */
  saveButton?: JSX.Element | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<FilterState>) => onChange({ ...state, ...patch });
  const on = Object.keys(toContactFilter({ ...state, q: "" })).length;
  return (
    <section className={`card ct-filters${open ? " is-open" : ""}`} aria-label="Filters">
      <button type="button" className="btn btn--subtle btn--sm ct-filters__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SlidersHorizontal size={14} /> Filters{on > 0 ? ` (${on})` : ""}
      </button>
      <div className="ct-filters__body">
        <div className="ct-filter-row" role="group" aria-label="Reaches us by">
          <span className="ct-filter-row__label">Reaches us by</span>
          {CONTACT_CHANNELS.map((c) => (
            <Chip key={c} label={CHANNEL_TEXT[c]} active={state.channels.includes(c)} onClick={() => set({ channels: toggle(state.channels, c) })} />
          ))}
        </div>
        <div className="ct-filter-row" role="group" aria-label="Details">
          <span className="ct-filter-row__label">Details</span>
          <Chip label="Has a phone number" active={state.hasPhone} onClick={() => set({ hasPhone: !state.hasPhone })} />
          <Chip label="Has an email" active={state.hasEmail} onClick={() => set({ hasEmail: !state.hasEmail })} />
          <Chip label="Has an address" active={state.hasAddress} onClick={() => set({ hasAddress: !state.hasAddress })} />
        </div>
        <div className="ct-filter-row" role="group" aria-label="Orders">
          <span className="ct-filter-row__label">Ordered in the last</span>
          {ORDERED_CHOICES.map((d) => (
            <Chip
              key={d}
              label={`${d} days`}
              active={state.orderedWithin === d && !state.neverOrdered}
              onClick={() => set({ orderedWithin: state.orderedWithin === d ? "" : d, neverOrdered: false })}
            />
          ))}
          <input
            className="input"
            inputMode="numeric"
            aria-label="Ordered in the last (days)"
            placeholder="or days"
            value={ORDERED_CHOICES.includes(state.orderedWithin) ? "" : state.orderedWithin}
            onChange={(e) => set({ orderedWithin: e.target.value.replace(/\D/g, "").slice(0, 4), neverOrdered: false })}
          />
          <Chip label="Never ordered" active={state.neverOrdered} onClick={() => set({ neverOrdered: !state.neverOrdered, orderedWithin: "", minSpent: "" })} />
        </div>
        <div className="ct-filter-row">
          <label className="ct-filter-row__label" htmlFor="ct-min-spent">
            Spent at least ₦
          </label>
          <input
            id="ct-min-spent"
            className="input"
            inputMode="numeric"
            placeholder="20000"
            value={state.minSpent}
            onChange={(e) => set({ minSpent: e.target.value.replace(/\D/g, "").slice(0, 10), neverOrdered: false })}
          />
        </div>
        {labels.length > 0 && (
          <div className="ct-filter-row" role="group" aria-label="Label">
            <span className="ct-filter-row__label">Label</span>
            {labels.map((l) => (
              <Chip key={l.id} label={l.name} active={state.labelIds.includes(l.id)} onClick={() => set({ labelIds: toggle(state.labelIds, l.id) })} />
            ))}
          </div>
        )}
        <div className="ct-filter-row" role="group" aria-label="Came from">
          <span className="ct-filter-row__label">Came from</span>
          {CONTACT_SOURCES.map((s) => (
            <Chip key={s} label={sourceText(s)} active={state.sources.includes(s)} onClick={() => set({ sources: toggle(state.sources, s) })} />
          ))}
        </div>
        <div className="ct-filter-row" role="group" aria-label="Promotions on WhatsApp">
          <span className="ct-filter-row__label">Promotions on WhatsApp</span>
          {(Object.keys(CONSENT_VIEW_LABEL) as ConsentView[]).map((v) => (
            <Chip key={v} label={CONSENT_VIEW_LABEL[v]} active={state.consent === v} onClick={() => set({ consent: state.consent === v ? "" : v })} />
          ))}
        </div>
        {lists.length > 0 && (
          <div className="ct-filter-row">
            <label className="ct-filter-row__label" htmlFor="ct-on-list">
              On list
            </label>
            <select id="ct-on-list" className="select" value={state.listId} onChange={(e) => set({ listId: e.target.value })}>
              <option value="">Any</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {anyFilterOn(state) && (
          <div className="ct-filter-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>
              Clear filters
            </button>
            {saveButton}
          </div>
        )}
      </div>
    </section>
  );
}

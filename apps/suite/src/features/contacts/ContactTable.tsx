/**
 * The contacts table (suite spec 14, 7.2). A table on a desktop; one card per
 * contact on a phone (contacts.css). Used by the Contacts page and a list's page.
 */
import { Facebook, Instagram, MessageCircle, Phone } from "lucide-react";
import type { ContactChannel, ContactRow } from "@ms/shared";
import { CHANNEL_TEXT, lagosDate, ordersCell } from "./contacts-logic.js";

const CHANNEL_ICON: Record<ContactChannel, typeof Phone> = {
  whatsapp: MessageCircle,
  messenger: Facebook,
  instagram: Instagram,
  phone: Phone,
};

export function ContactTable({
  rows,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
}: {
  rows: ContactRow[];
  /** Ticked ids; leave out for a table with no tick-boxes. */
  selected?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: (on: boolean) => void;
  onOpen: (id: string) => void;
}): JSX.Element {
  const ticks = !!selected && !!onToggle;
  const allOn = ticks && rows.length > 0 && rows.every((r) => selected.has(r.id));
  const cell = (value: string | null | undefined): string => (value && value.trim() ? value : "—");
  return (
    <div className="table-wrap">
      <table className={`table ct-table${ticks ? "" : " ct-table--plain"}`}>
        <thead>
          <tr>
            {ticks && (
              <th className="ct-table__tick">
                <input type="checkbox" aria-label="Select the contacts shown" checked={allOn} onChange={(e) => onToggleAll?.(e.target.checked)} />
              </th>
            )}
            <th>Name</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Address</th>
            <th>Reaches us by</th>
            <th>Orders</th>
            <th>Last order</th>
            <th>Last contact</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="is-clickable" onClick={() => onOpen(r.id)}>
              {ticks && (
                <td className="ct-table__tick" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Select ${r.name ?? "this contact"}`} checked={selected.has(r.id)} onChange={() => onToggle(r.id)} />
                </td>
              )}
              <td>
                <a
                  href={`/contacts/${r.id}`}
                  className={r.name ? "ct-name" : "ct-name ct-name--none"}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpen(r.id);
                  }}
                >
                  {r.name ?? "No name"}
                </a>
                {(r.labels.length > 0 || r.consent === "stopped") && (
                  <div className="ct-pills">
                    {r.labels.map((l) => (
                      <span key={l.id} className={`ct-label ct-label--${l.colour}`}>
                        {l.name}
                      </span>
                    ))}
                    {r.consent === "stopped" && <span className="ct-stopped">Stopped promotions</span>}
                  </div>
                )}
              </td>
              <td data-label="Phone">{cell(r.phone)}</td>
              <td data-label="Email">{cell(r.email)}</td>
              <td data-label="Address">
                <span className="ct-address" title={r.address ?? undefined}>
                  {cell(r.address)}
                </span>
              </td>
              <td data-label="Reaches us by">
                {r.channels.length === 0 ? (
                  "—"
                ) : (
                  <span className="ct-channels">
                    {r.channels.map((c) => {
                      const Icon = CHANNEL_ICON[c];
                      return (
                        <span key={c} title={CHANNEL_TEXT[c]}>
                          <Icon size={16} aria-hidden="true" />
                          <span className="ct-sr">{CHANNEL_TEXT[c]}</span>
                        </span>
                      );
                    })}
                  </span>
                )}
              </td>
              <td data-label="Orders">{ordersCell(r.orders_count, r.spent_ngn)}</td>
              <td data-label="Last order">{lagosDate(r.last_order_at)}</td>
              <td data-label="Last contact">{lagosDate(r.last_contact_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

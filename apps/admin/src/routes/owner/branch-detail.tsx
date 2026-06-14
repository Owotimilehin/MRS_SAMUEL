import { useEffect, useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Shell } from "../../components/Shell.js";
import { api } from "../../lib/api.js";
import { ngn } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { toast } from "../../lib/toast.js";

interface DeliveryZone {
  name: string;
  fee_ngn: number;
}
interface Branch {
  id: string;
  name: string;
  code: string;
  address: string | null;
  phone: string | null;
  lat: string | null;
  lng: string | null;
  managerUserId: string | null;
  deliveryZones: DeliveryZone[];
  opensAt: string | null;
  closesAt: string | null;
  isActive: boolean;
}

export function BranchDetailPage({ branchId }: { branchId: string }): JSX.Element {
  const [branch, setBranch] = useState<Branch | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [opensAt, setOpensAt] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [geoStatus, setGeoStatus] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const res = await api<{ data: Branch }>(`/branches/${branchId}`);
      setBranch(res.data);
      setName(res.data.name);
      setAddress(res.data.address ?? "");
      setPhone(res.data.phone ?? "");
      setOpensAt((res.data.opensAt ?? "").slice(0, 5));
      setClosesAt((res.data.closesAt ?? "").slice(0, 5));
      setLat(res.data.lat ?? "");
      setLng(res.data.lng ?? "");
      setZones(res.data.deliveryZones);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId]);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api(`/branches/${branchId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          address: address || null,
          phone: phone || null,
          lat: lat ? Number(lat) : null,
          lng: lng ? Number(lng) : null,
          opens_at: opensAt || undefined,
          closes_at: closesAt || undefined,
          delivery_zones: zones,
        }),
      });
      toast.success("Branch saved");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Shell
      title={branch?.name ?? "Branch"}
      actions={
        <Link to="/owner/branches" className="btn btn--subtle btn--sm">
          ← All branches
        </Link>
      }
    >
      
      

      {loading || !branch ? (
        <InlineLoader />
      ) : (
        <form onSubmit={save} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 18 }}>
          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 14 }}>Details</h2>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
              <div className="field">
                <label className="field__label">Name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="field">
                <label className="field__label">Code</label>
                <input className="input" value={branch.code} disabled />
                <span className="field__hint">Code is immutable.</span>
              </div>
            </div>
            <div className="field">
              <label className="field__label">Address</label>
              <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
              <div className="field">
                <label className="field__label">Phone</label>
                <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label">Opens</label>
                <input className="input" type="time" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label">Closes</label>
                <input className="input" type="time" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />
              </div>
            </div>

            <h3 style={{ fontSize: 14, fontWeight: 700, margin: "18px 0 10px", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--ink-soft)" }}>
              Pickup coordinates · used by Bolt
            </h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "end" }}>
              <div className="field">
                <label className="field__label">Latitude</label>
                <input
                  className="input"
                  type="number"
                  step="0.000001"
                  min={-90}
                  max={90}
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                  placeholder="e.g. 6.554400"
                />
              </div>
              <div className="field">
                <label className="field__label">Longitude</label>
                <input
                  className="input"
                  type="number"
                  step="0.000001"
                  min={-180}
                  max={180}
                  value={lng}
                  onChange={(e) => setLng(e.target.value)}
                  placeholder="e.g. 3.346900"
                />
              </div>
              <button
                type="button"
                className="btn btn--subtle"
                onClick={() => {
                  if (!navigator.geolocation) {
                    setGeoStatus("Browser doesn't expose geolocation.");
                    return;
                  }
                  setGeoStatus("Locating…");
                  navigator.geolocation.getCurrentPosition(
                    (pos) => {
                      setLat(pos.coords.latitude.toFixed(6));
                      setLng(pos.coords.longitude.toFixed(6));
                      setGeoStatus("Captured. Don't forget to save.");
                    },
                    () => setGeoStatus("Couldn't get location."),
                    { enableHighAccuracy: true, timeout: 10_000 },
                  );
                }}
              >
                📍 Use my location
              </button>
            </div>
            {geoStatus && (
              <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 6 }}>
                {geoStatus}
              </div>
            )}
            <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 6 }}>
              Tip: tap "Use my location" while standing inside the branch.
              {lat && lng && (
                <>
                  {" · "}
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--accent)", fontWeight: 600 }}
                  >
                    Verify on Google Maps →
                  </a>
                </>
              )}
            </div>

            <button type="submit" className="btn btn--primary" disabled={submitting} style={{ marginTop: 16 }}>
              {submitting ? "Saving…" : "Save changes"}
            </button>
          </section>

          <section className="card">
            <h2 className="t-h2" style={{ marginBottom: 14 }}>Delivery zones</h2>
            <ZonesEditor zones={zones} onChange={setZones} />
          </section>
        </form>
      )}
    </Shell>
  );
}

function ZonesEditor({
  zones,
  onChange,
}: {
  zones: DeliveryZone[];
  onChange: (next: DeliveryZone[]) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [fee, setFee] = useState("1500");

  function add(): void {
    if (!name.trim()) return;
    onChange([...zones, { name: name.trim(), fee_ngn: Number(fee) }]);
    setName("");
    setFee("1500");
  }
  function removeAt(idx: number): void {
    onChange(zones.filter((_, i) => i !== idx));
  }

  return (
    <div>
      {zones.length === 0 ? (
        <div className="empty" style={{ padding: 18, marginBottom: 12 }}>
          No zones yet. Add one below.
        </div>
      ) : (
        <ul style={{ margin: "0 0 12px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
          {zones.map((z, i) => (
            <li
              key={`${z.name}-${i}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 12px",
                background: "var(--surface-soft)",
                borderRadius: 10,
              }}
            >
              <span style={{ fontWeight: 600 }}>{z.name}</span>
              <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span className="tabular-nums">{ngn(z.fee_ngn)}</span>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--ink-soft)", fontSize: 18 }}
                  aria-label="Remove zone"
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 8 }}>
        <input
          className="input"
          placeholder="Zone name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          type="number"
          placeholder="Fee"
          value={fee}
          onChange={(e) => setFee(e.target.value)}
        />
        <button type="button" className="btn btn--subtle btn--sm" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

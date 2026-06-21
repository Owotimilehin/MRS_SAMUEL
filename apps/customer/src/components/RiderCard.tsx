import { Phone, MapPin } from "lucide-react";
import type { ApiOrderTracking } from "@/lib/api/types";

export function RiderCard({ delivery }: { delivery: NonNullable<ApiOrderTracking["delivery"]> }) {
  return (
    <div className="rounded-2xl bg-[color:var(--cream)]/60 p-4">
      <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--brand)]/55">
        Your rider
      </div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold text-[color:var(--brand)]">
            {delivery.rider_name ?? "Assigning a rider…"}
          </div>
          <div className="text-xs text-[color:var(--brand)]/60">
            {delivery.rider_vehicle ?? "—"}
            {delivery.eta_minutes != null ? ` · ~${delivery.eta_minutes} min` : ""}
          </div>
        </div>
        <div className="flex gap-2">
          {delivery.rider_phone && (
            <a
              href={`tel:${delivery.rider_phone}`}
              className="grid h-10 w-10 place-items-center rounded-full bg-white ring-1 ring-black/10"
              aria-label="Call rider"
            >
              <Phone className="h-4 w-4 text-[color:var(--brand)]" />
            </a>
          )}
          {delivery.tracking_url && (
            <a
              href={delivery.tracking_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full bg-[color:var(--brand)] text-white px-4 text-sm font-semibold"
            >
              <MapPin className="h-4 w-4" /> Live
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

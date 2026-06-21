import { Check } from "lucide-react";
import type { JourneyStep } from "@/lib/order-journey";

function ts(at?: string): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-NG", { timeZone: "Africa/Lagos", hour: "numeric", minute: "2-digit" });
}

export function OrderTimeline({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol className="relative space-y-5">
      {steps.map((s, i) => {
        const done = s.state === "done";
        const current = s.state === "current";
        return (
          <li key={s.key} className="flex items-start gap-3" aria-current={current ? "step" : undefined}>
            <span className="relative flex flex-col items-center">
              <span className={`grid h-8 w-8 place-items-center rounded-full ring-2 transition ${
                done ? "bg-[color:var(--brand)] text-white ring-transparent"
                : current ? "bg-[color:var(--brand-orange)] text-white ring-[color:var(--brand-orange)]/30 motion-safe:animate-pulse"
                : "bg-white text-[color:var(--brand)]/30 ring-black/10"}`}>
                {done ? <Check className="h-4 w-4" /> : <span className="text-xs font-bold">{i + 1}</span>}
              </span>
              {i < steps.length - 1 && <span className={`mt-1 h-6 w-0.5 ${done ? "bg-[color:var(--brand)]" : "bg-black/10"}`} />}
            </span>
            <span className="pt-1.5">
              <span className={`block text-sm font-semibold ${current ? "text-[color:var(--brand-orange)]" : "text-[color:var(--brand)]"}`}>{s.label}</span>
              {s.at && <span className="block text-xs text-[color:var(--brand)]/50">{ts(s.at)}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

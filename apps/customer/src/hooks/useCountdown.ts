import { useEffect, useState } from "react";

export function compute(targetIso: string | null): {
  mmss: string;
  expired: boolean;
  totalMs: number;
} {
  if (!targetIso) return { mmss: "0:00", expired: true, totalMs: 0 };
  const t = Date.parse(targetIso);
  if (Number.isNaN(t)) return { mmss: "0:00", expired: true, totalMs: 0 };
  const ms = t - Date.now();
  if (ms <= 0) return { mmss: "0:00", expired: true, totalMs: 0 };
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return { mmss: `${m}:${String(s).padStart(2, "0")}`, expired: false, totalMs: ms };
}

export function useCountdown(targetIso: string | null): {
  mmss: string;
  expired: boolean;
  totalMs: number;
} {
  const [state, setState] = useState(() => compute(targetIso));
  useEffect(() => {
    setState(compute(targetIso));
    const id = setInterval(() => setState(compute(targetIso)), 1000);
    return () => clearInterval(id);
  }, [targetIso]);
  return state;
}

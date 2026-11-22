/**
 * The banner under the suite's top bar when the Meta connection is broken (red)
 * or needs attention (amber). One sentence (what it means for customers, then
 * why) and a link to Channels. Amber can be dismissed for this browser session;
 * it comes back if the problems change. Red cannot be dismissed.
 */
import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, X } from "lucide-react";
import { healthBanner } from "@ms/shared";
import { HEALTH_DISMISS_KEY, metaHealthApi, metaHealthKeys } from "./meta-health-api.js";

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(HEALTH_DISMISS_KEY);
  } catch {
    return null;
  }
}

export function MetaHealthBanner({ enabled, canOpenChannels }: { enabled: boolean; canOpenChannels: boolean }): JSX.Element | null {
  // On the Channels page itself the link would lead nowhere new.
  const onChannels = useRouterState({ select: (st) => st.location.pathname === "/channels" });
  const q = useQuery({
    queryKey: metaHealthKeys.all,
    queryFn: metaHealthApi.get,
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const banner = q.data ? healthBanner(q.data.items.map((i) => ({ ...i, alerted_at: null }))) : null;
  if (!banner) return null;
  if (banner.tone === "warning" && dismissed === banner.signature) return null;

  function dismiss(): void {
    if (!banner) return;
    try {
      window.sessionStorage.setItem(HEALTH_DISMISS_KEY, banner.signature);
    } catch {
      /* private window: dismissed until the page reloads */
    }
    setDismissed(banner.signature);
  }

  return (
    <div className={`suite-health suite-health--${banner.tone}`} role={banner.tone === "danger" ? "alert" : "status"}>
      <AlertTriangle size={17} aria-hidden="true" className="suite-health__icon" />
      <p className="suite-health__text">
        {banner.text}{" "}
        {onChannels ? null : canOpenChannels ? (
          <Link to="/channels" className="suite-health__link">
            Open Channels
          </Link>
        ) : (
          <span>Tell the owner.</span>
        )}
      </p>
      {banner.tone === "warning" && (
        <button type="button" className="suite-health__close" onClick={dismiss} aria-label="Hide this message for now">
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

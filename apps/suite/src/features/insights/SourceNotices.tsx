import { Link } from "@tanstack/react-router";
import type { SourceStatus } from "./insights-api.js";
import { FIXED } from "./insights-logic.js";

/** One line per source that has a problem, in the server's own plain words. */
export function SourceNotices({ sources, canManageChannels }: { sources: SourceStatus[]; canManageChannels: boolean }): JSX.Element | null {
  const social = sources.filter((s) => s.source === "facebook_page" || s.source === "instagram_account");
  const noneConnected = social.length > 0 && social.every((s) => s.problem?.code === "not_connected" && s.account_key === "");
  // Template figures being off is explained in the WhatsApp section, beside the owner's button.
  const problems = sources.filter((s) => s.problem && s.problem.code !== "not_enabled" && !(noneConnected && social.includes(s)));
  // The same sentence for several sources (an expired connection) is said once.
  const seen = new Set<string>();
  const lines = problems.filter((s) => {
    const key = s.problem!.code === "token" || s.problem!.code === "not_connected" ? s.problem!.message : `${s.label}|${s.problem!.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!noneConnected && lines.length === 0) return null;
  return (
    <div className="ins-notices" role="status">
      {noneConnected && (
        <div className="ins-notice">
          {FIXED.connect}{" "}
          {canManageChannels && (
            <Link to="/channels" className="ins-link">
              Open Channels
            </Link>
          )}
        </div>
      )}
      {lines.map((s) => (
        <div key={`${s.source}:${s.account_key}`} className={`ins-notice${s.problem!.code === "temporary" || s.problem!.code === "too_small" ? "" : " ins-notice--bad"}`}>
          {s.problem!.code === "token" || s.problem!.code === "not_connected" ? null : <strong>{s.label}: </strong>}
          {s.problem!.message}
        </div>
      ))}
    </div>
  );
}

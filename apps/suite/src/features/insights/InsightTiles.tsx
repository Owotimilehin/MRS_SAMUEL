import { Stat } from "@admin/components/Stat.js";
import type { SourceStatus, Tile } from "./insights-api.js";
import { FIXED, tileText } from "./insights-logic.js";

const GROUPS: { heading: string; prefix: string }[] = [
  { heading: "Facebook", prefix: "fb_" },
  { heading: "Instagram", prefix: "ig_" },
  { heading: "WhatsApp", prefix: "wa_" },
];

/** The tiles, in three labelled groups. Figures of different groups are never added together. */
export function InsightTiles({ tiles, sources, days, currency }: { tiles: Tile[]; sources: SourceStatus[]; days: number; currency: string | null }): JSX.Element {
  const pageTooSmall = sources.some((s) => s.source === "facebook_page" && s.problem?.code === "too_small");
  return (
    <div className="ins-groups">
      {GROUPS.map((g) => (
        <section key={g.heading} className="ins-group" aria-label={`${g.heading} figures`}>
          <h2 className="ins-group__title">{g.heading}</h2>
          {g.prefix === "fb_" && pageTooSmall && <p className="ins-fine">{FIXED.tooSmall}</p>}
          <div className="ins-tiles">
            {tiles
              .filter((t) => t.key.startsWith(g.prefix))
              .map((t) => {
                const text = tileText(t, { days, currency });
                return (
                  <div key={t.key} className={t.value === null ? "ins-tile is-none" : "ins-tile"}>
                    <Stat label={t.label} value={text.value} {...(text.delta ? { delta: text.delta } : {})} {...(text.hint ? { hint: text.hint } : {})} />
                  </div>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}

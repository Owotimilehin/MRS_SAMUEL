import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { ChatSetupConfig } from "@ms/shared";
import { previewModel } from "./chat-setup-logic.js";

/** A rough phone-shaped picture of the set-up. Updates as the person types. */
export function ChatPreview({
  config,
  kind,
  accountLabel,
}: {
  config: ChatSetupConfig;
  kind: "messenger" | "instagram";
  accountLabel: string;
}): JSX.Element {
  const [tab, setTab] = useState<"start" | "menu">("start");
  const m = previewModel(config, kind);
  return (
    <aside className="cs-preview" aria-label="Preview">
      <div className="cs-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "start"} className={tab === "start" ? "cs-tab cs-tab--on" : "cs-tab"} onClick={() => setTab("start")}>
          Before the first message
        </button>
        <button type="button" role="tab" aria-selected={tab === "menu"} className={tab === "menu" ? "cs-tab cs-tab--on" : "cs-tab"} onClick={() => setTab("menu")}>
          Menu
        </button>
      </div>
      <div className="cs-phone">
        <div className="cs-phone__title">{accountLabel}</div>
        <div className="cs-phone__body">
          {tab === "start" ? (
            m.empty ? (
              <div className="cs-phone__empty">Customers see an empty chat.</div>
            ) : (
              <>
                {m.greeting && <div className="cs-bubble">{m.greeting}</div>}
                {m.chips.length > 0 && (
                  <div className="cs-chips">
                    {m.chips.map((c, i) => (
                      <span key={i} className="cs-chip">
                        {c}
                      </span>
                    ))}
                  </div>
                )}
                {m.getStartedButton && <div className="cs-getstarted">Get started</div>}
              </>
            )
          ) : m.menu.length === 0 ? (
            <div className="cs-phone__empty">No menu.</div>
          ) : (
            <ul className="cs-menu">
              {m.menu.map((b, i) => (
                <li key={i}>
                  <span>{b.title || "Untitled"}</span>
                  {b.isLink && <ExternalLink size={14} aria-label="Opens a web page" />}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="cs-fine">A rough picture. The real look depends on the customer&apos;s phone and app.</p>
    </aside>
  );
}

import { useState } from "react";
import { Frame as Shell } from "../../lib/app-frame.js";
import { StatHero } from "../../components/StatHero.js";
import { SettingsNumbers, SettingsTemplates } from "../../components/inbox/SettingsNumbers.js";
import { SettingsAccess, SettingsQuickReplies, SettingsTeams } from "../../components/inbox/SettingsTeams.js";
import { SettingsHours, SettingsIvr } from "../../components/inbox/SettingsHours.js";
import "../../components/inbox/inbox.css";
import { useCan } from "../../lib/auth.js";

type Tab = "numbers" | "teams" | "access" | "hours" | "ivr" | "quick" | "templates";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "numbers", label: "Numbers" },
  { key: "teams", label: "Teams" },
  { key: "access", label: "Who can use which channel" },
  { key: "hours", label: "Hours" },
  { key: "ivr", label: "Phone menu" },
  { key: "quick", label: "Quick replies" },
  { key: "templates", label: "Templates" },
];

/** Tabs about phone calls only. The Business Suite shows them on its own Calls settings page. */
const CALL_ONLY_TABS: readonly Tab[] = ["ivr"];

export interface InboxSettingsPageProps {
  /**
   * "all" (the default, the shop admin): every tab, as always.
   * "messages" (the Business Suite): leaves out the phone-call-only tabs and
   * calls the page "Message settings"; calls have their own settings page there.
   */
  sections?: "all" | "messages";
  /** The tab to open first. Ignored if this person may not see it. */
  initialTab?: Tab;
}

export type InboxSettingsTab = Tab;

export function InboxSettingsPage({ sections = "all", initialTab }: InboxSettingsPageProps = {}): JSX.Element {
  const can = useCan();
  const tabs = TABS.filter(
    (t) => (t.key !== "access" || can("users.manage")) && (sections === "all" || !CALL_ONLY_TABS.includes(t.key)),
  );
  const [tab, setTab] = useState<Tab>(() => (initialTab && tabs.some((t) => t.key === initialTab) ? initialTab : "numbers"));
  const messagesOnly = sections === "messages";
  const title = messagesOnly ? "Message settings" : "Inbox settings";

  if (!can("inbox.settings")) {
    return (
      <Shell title={title}>
        <div className="empty">
          <div className="empty__title">No access</div>
          Ask an owner if you need to change inbox settings.
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={title} crumb={messagesOnly ? "Messages" : "Inbox"}>
      <StatHero
        eyebrow={messagesOnly ? "Messages" : "Inbox"}
        title={title}
        sub={
          messagesOnly
            ? "Business numbers, teams, opening hours and ready-made replies. Phone menu and call options are under Calls."
            : "Business numbers, teams, opening hours, phone menu and ready-made replies."
        }
      />
      <div className="ibx-tabs" role="tablist" aria-label="Settings sections" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`ibx-tab${tab === t.key ? " is-active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ibx-settings">
      {tab === "numbers" && <SettingsNumbers />}
      {tab === "teams" && <SettingsTeams />}
      {tab === "access" && can("users.manage") && <SettingsAccess />}
      {tab === "hours" && <SettingsHours />}
      {tab === "ivr" && <SettingsIvr />}
      {tab === "quick" && <SettingsQuickReplies />}
      {tab === "templates" && <SettingsTemplates />}
      </div>
    </Shell>
  );
}

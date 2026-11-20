/**
 * Call settings: the call-only parts of what used to be Inbox settings. The
 * screens are the shop admin's own (SettingsNumbers, SettingsIvr), so the
 * rules and saving work exactly as there.
 *
 * Opening hours and teams drive both chats and calls, so they stay in one
 * place, Message settings, and this page links to them.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Frame } from "@admin/lib/app-frame.js";
import { useCan } from "@admin/lib/auth.js";
import { SettingsNumbers } from "@admin/components/inbox/SettingsNumbers.js";
import { SettingsIvr } from "@admin/components/inbox/SettingsHours.js";
import { setAvailable, useVoice } from "@admin/lib/inbox-voice.js";
import "@admin/components/inbox/inbox.css";
import "./calls.css";
import { callKeys, callsApi } from "./calls-api.js";

type Tab = "numbers" | "ivr";

const TABS: { key: Tab; label: string }[] = [
  { key: "numbers", label: "Phone numbers" },
  { key: "ivr", label: "Phone menu" },
];

export function CallsSettingsPage(): JSX.Element {
  const can = useCan();
  const [tab, setTab] = useState<Tab>("numbers");
  const configured = useQuery({ queryKey: callKeys.voiceStatus, queryFn: callsApi.voiceConfigured, staleTime: 5 * 60_000, retry: false });

  if (!can("inbox.settings")) {
    return (
      <Frame title="Call settings">
        <div className="card">You don&apos;t have access to call settings. Ask the owner.</div>
      </Frame>
    );
  }

  return (
    <Frame title="Call settings" crumb="Calls">
      <p className="cl-sub">Which numbers take calls, what callers hear, and whether calls ring on this device.</p>
      <div className="cl-cards">
        {configured.data === false && (
          <section className="card">
            <h2 className="t-h2">Calling is not set up</h2>
            <p style={{ color: "var(--ink-soft)", fontSize: 13, margin: "4px 0 0" }}>
              The phone provider is not connected on this system yet, so no calls can ring or be made. You can still get the settings below
              ready.
            </p>
          </section>
        )}
        {configured.data === true && can("calls.answer") && <TakingCalls />}

        <div>
          <div className="ibx-tabs" role="tablist" aria-label="Call settings sections" style={{ marginBottom: 16, flexWrap: "wrap" }}>
            {TABS.map((t) => (
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
            {tab === "numbers" && <SettingsNumbers only="calls" />}
            {tab === "ivr" && <SettingsIvr />}
          </div>
        </div>

        <section className="card cl-link-card">
          <div>
            <h2 className="t-h2">Opening hours</h2>
            <p>
              Outside opening hours callers hear the after-hours message and can leave a voicemail. The same hours decide when chats get the
              after-hours reply, so they are kept in Message settings.
            </p>
          </div>
          <Link to="/inbox/settings" search={{ tab: "hours" }} className="btn btn--subtle btn--sm">
            Open opening hours
          </Link>
        </section>

        <section className="card cl-link-card">
          <div>
            <h2 className="t-h2">Teams</h2>
            <p>A phone menu option can ring a team. Teams also share out chats, so they are kept in Message settings.</p>
          </div>
          <Link to="/inbox/settings" search={{ tab: "teams" }} className="btn btn--subtle btn--sm">
            Open teams
          </Link>
        </section>
      </div>
    </Frame>
  );
}

/** The same "take calls" switch as the call bar at the bottom of the screen, for this device. */
function TakingCalls(): JSX.Element {
  const v = useVoice();
  return (
    <section className="card cl-link-card">
      <div>
        <h2 className="t-h2">Taking calls on this device</h2>
        <p>
          When this is on, customer calls ring here. It is the same switch as in the call bar at the bottom of the screen, and it only
          changes this device.
        </p>
      </div>
      <label className="cl-switch">
        <input
          type="checkbox"
          role="switch"
          className={`callbar__switch${v.available && v.status === "loading" ? " is-busy" : ""}`}
          checked={v.available}
          onChange={(e) => void setAvailable(e.target.checked)}
        />
        <span>{v.available ? (v.status === "loading" ? "Connecting…" : "Taking calls") : "Off"}</span>
      </label>
    </section>
  );
}

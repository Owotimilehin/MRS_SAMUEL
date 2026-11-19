import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal } from "../Modal.js";
import { inboxApi, inboxKeys } from "../../lib/inbox-api.js";
import {
  askForDesktop,
  desktopEnabled,
  desktopState,
  playMessageSound,
  setDesktopEnabled,
  setSoundEnabled,
  soundEnabled,
  type DesktopState,
} from "../../lib/inbox-notify.js";
import type { NotifyLevel } from "../../lib/inbox-types.js";
import { humanizeError } from "../../lib/api.js";
import { toast } from "../../lib/toast.js";

const LEVELS: { value: NotifyLevel; label: string; hint: string }[] = [
  { value: "assigned", label: "My chats and new ones", hint: "Chats assigned to you, and chats nobody has picked up yet." },
  { value: "all", label: "Every chat I can see", hint: "Including chats a colleague is already handling." },
  { value: "none", label: "None", hint: "No sound or pop-up. Unread counts still show." },
];

const DESKTOP_TEXT: Record<DesktopState, string> = {
  on: "Allowed in this browser.",
  ask: "Not switched on in this browser yet.",
  blocked: "Blocked in this browser. Click the padlock beside the web address, allow Notifications, then reload.",
  unsupported: "This browser cannot show pop-ups. You will still get the sound and the count on the tab.",
};

/** "Notifications" dialog, opened from the bell at the top of the conversation list. */
export function NotifySettings({ onClose }: { onClose: () => void }): JSX.Element {
  const qc = useQueryClient();
  const level = useQuery({ queryKey: inboxKeys.notifyLevel, queryFn: inboxApi.notifyLevel });
  const save = useMutation({
    mutationFn: inboxApi.setNotifyLevel,
    onSuccess: (l) => qc.setQueryData(inboxKeys.notifyLevel, l),
    onError: (err) => toast.error(`Couldn't save: ${humanizeError(err)}`),
  });

  // Per-device choices: read once, then kept in step with what is stored.
  const [sound, setSound] = useState(soundEnabled);
  const [desktop, setDesktop] = useState(desktopEnabled);
  const [state, setState] = useState<DesktopState>(desktopState);
  const current = save.variables ?? level.data ?? "assigned";

  return (
    <Modal title="Notifications" onClose={onClose} maxWidth={460}>
      <div className="ibx-notify">
        <fieldset className="ibx-notify__group">
          <legend>Tell me about</legend>
          {LEVELS.map((l) => (
            <label key={l.value} className="ibx-notify__choice">
              <input
                type="radio"
                name="notify-level"
                checked={current === l.value}
                disabled={level.isLoading || save.isPending}
                onChange={() => save.mutate(l.value)}
              />
              <span>
                <strong>{l.label}</strong>
                <small>{l.hint}</small>
              </span>
            </label>
          ))}
          <p className="ibx-notify__note">This choice follows you to every device, including the phone app.</p>
        </fieldset>

        <fieldset className="ibx-notify__group">
          <legend>On this device</legend>
          <label className="ibx-notify__choice">
            <input
              type="checkbox"
              checked={sound}
              onChange={(e) => {
                setSound(e.target.checked);
                setSoundEnabled(e.target.checked);
                if (e.target.checked) playMessageSound();
              }}
            />
            <span>
              <strong>Play a sound</strong>
              <small>Two short notes when a customer writes.</small>
            </span>
          </label>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => playMessageSound()}>
            Play the sound
          </button>

          <label className="ibx-notify__choice">
            <input
              type="checkbox"
              checked={desktop && state !== "blocked" && state !== "unsupported"}
              disabled={state === "blocked" || state === "unsupported"}
              onChange={(e) => {
                const on = e.target.checked;
                setDesktop(on);
                setDesktopEnabled(on);
                if (on && state === "ask") void askForDesktop().then(setState);
              }}
            />
            <span>
              <strong>Show a pop-up when this tab is in the background</strong>
              <small>{DESKTOP_TEXT[state]}</small>
            </span>
          </label>
          {state === "ask" && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() =>
                void askForDesktop().then((s) => {
                  setState(s);
                  if (s === "on") {
                    setDesktop(true);
                    setDesktopEnabled(true);
                  }
                })
              }
            >
              Turn on pop-ups
            </button>
          )}
        </fieldset>

        <p className="ibx-notify__note">
          Keep this site open in a tab to be alerted. While you are reading a chat, new messages in it appear without a sound.
        </p>
      </div>
    </Modal>
  );
}

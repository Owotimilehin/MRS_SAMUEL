import { useEffect, useId, useRef, useState } from "react";
import {
  ACCEPT_ATTR,
  loadCustomSound,
  removeCustomSound,
  saveCustomSound,
  validateAudioFile,
  type CustomSound,
} from "../../lib/sounds/custom.js";
import { audioContext, decodeAudio, forgetCustomSound, previewSound, stopPreview } from "../../lib/sounds/player.js";
import {
  CUSTOM_TONE,
  currentPrefs,
  saveChoice,
  STANDARD_RING,
  type SoundChoice,
  type SoundKind,
} from "../../lib/sounds/prefs.js";
import { TONES } from "../../lib/sounds/tones.js";

const KIND_TEXT: Record<SoundKind, { title: string; hint: string }> = {
  message: { title: "New message", hint: "Plays when a customer writes." },
  call: { title: "Incoming call", hint: "Repeats while a call is ringing. Stops when you answer or decline." },
};

/**
 * "Sounds" section of the notification settings: pick a tone (or upload your
 * own) and a volume, separately for new messages and incoming calls.
 * Saved on this device only.
 */
export function SoundSettings(): JSX.Element {
  // Stop any preview when the dialog closes.
  useEffect(() => () => stopPreview(), []);
  return (
    <fieldset className="ibx-notify__group ibx-sounds">
      <legend>Sounds</legend>
      <p className="ibx-notify__note">Choose what you hear on this device. Other people's choices are not affected.</p>
      <SoundRow kind="message" />
      <SoundRow kind="call" />
    </fieldset>
  );
}

function SoundRow({ kind }: { kind: SoundKind }): JSX.Element {
  const id = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [choice, setChoice] = useState<SoundChoice>(() => currentPrefs()[kind]);
  const [own, setOwn] = useState<Pick<CustomSound, "name" | "duration"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Is there an uploaded sound saved for this kind?
  useEffect(() => {
    let live = true;
    void loadCustomSound(kind).then((s) => {
      if (live) setOwn(s ? { name: s.name, duration: s.duration } : null);
    });
    return () => {
      live = false;
    };
  }, [kind]);

  const update = (next: SoundChoice): void => {
    const saved = saveChoice(kind, next)[kind];
    setChoice(saved);
  };

  const onFile = async (file: File | undefined): Promise<void> => {
    setError(null);
    setNotice(null);
    if (!file) return;
    const ctx = audioContext();
    if (!ctx) {
      setError("This browser can't play sounds, so it can't use your own file.");
      return;
    }
    setBusy(true);
    try {
      const res = await validateAudioFile(file, (data) => decodeAudio(ctx, data));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const stored = await saveCustomSound(kind, res.sound);
      if (!stored) {
        setError("This browser wouldn't save the file (it may be in private mode). Your sound is unchanged.");
        return;
      }
      forgetCustomSound(kind);
      setOwn({ name: res.sound.name, duration: res.sound.duration });
      update({ ...choice, tone: CUSTOM_TONE });
      setNotice("Saved. Your own sound is now in use.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onRemove = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    stopPreview();
    await removeCustomSound(kind);
    forgetCustomSound(kind);
    setOwn(null);
    if (choice.tone === CUSTOM_TONE) update({ ...choice, tone: kind === "call" ? STANDARD_RING : TONES[0]!.id });
  };

  const text = KIND_TEXT[kind];
  return (
    <div className="ibx-sounds__row">
      <div>
        <strong id={`${id}-t`}>{text.title}</strong>
        <small className="ibx-notify__note" style={{ display: "block" }}>
          {text.hint}
        </small>
      </div>
      <div className="ibx-sounds__controls">
        <select
          className="input"
          aria-labelledby={`${id}-t`}
          value={choice.tone === CUSTOM_TONE && !own ? (kind === "call" ? STANDARD_RING : TONES[0]!.id) : choice.tone}
          onChange={(e) => {
            const next = { ...choice, tone: e.target.value };
            update(next);
            previewSound(kind, next);
          }}
        >
          {kind === "call" && <option value={STANDARD_RING}>Standard ring</option>}
          {TONES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.id === "two-notes" && kind === "message" ? " (usual)" : ""}
            </option>
          ))}
          {own && <option value={CUSTOM_TONE}>My own sound</option>}
        </select>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => previewSound(kind, choice)}
          aria-label={`Preview the ${text.title.toLowerCase()} sound`}
        >
          ▶ Preview
        </button>
      </div>
      <label className="ibx-sounds__volume">
        <span>Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={choice.volume}
          aria-label={`${text.title} volume`}
          onChange={(e) => update({ ...choice, volume: Number(e.target.value) })}
          // Play it once the slider is let go, not on every step.
          onPointerUp={() => previewSound(kind, choice)}
        />
        <span aria-hidden>{choice.volume}%</span>
      </label>
      <div className="ibx-sounds__controls">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_ATTR}
          hidden
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Checking…" : own ? "Replace my own sound" : "Upload my own"}
        </button>
        {own && (
          <>
            <small className="ibx-notify__note">
              {own.name} ({Math.max(1, Math.round(own.duration))}s)
            </small>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void onRemove()}>
              Remove
            </button>
          </>
        )}
      </div>
      {!own && <small className="ibx-notify__note">MP3 or WAV, up to 30 seconds and 1 MB. Kept on this device only.</small>}
      {error && (
        <p role="alert" className="ibx-sounds__error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="ibx-notify__note">
          {notice}
        </p>
      )}
    </div>
  );
}

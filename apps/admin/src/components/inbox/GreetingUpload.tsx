import { useRef, useState } from "react";
import { Play, Trash2, Upload } from "lucide-react";
import { humanizeError } from "../../lib/api.js";
import { greetingContentType, greetingFileProblem } from "../../lib/inbox-logic.js";
import { settingsApi } from "../../lib/inbox-settings-api.js";
import { toast } from "../../lib/toast.js";

/**
 * Upload / preview / remove a recorded greeting (MP3 or WAV, max 5 MB) for a
 * phone menu, a menu option or a number's after-hours message. `audioKey` is
 * the storage key saved with the form; null means "read the typed text out
 * with a computer voice". The key is only stored once the form is saved.
 */
export function GreetingUpload({
  audioKey,
  onChange,
  what,
}: {
  audioKey: string | null;
  onChange: (key: string | null) => void;
  /** What the recording replaces, e.g. "the greeting" — used in the hints. */
  what: string;
}): JSX.Element {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return;
    const problem = greetingFileProblem(file);
    const type = greetingContentType(file.name, file.type);
    if (problem || !type) {
      toast.error(problem ?? "Use an MP3 or WAV file.");
      return;
    }
    setBusy(true);
    try {
      const key = await settingsApi.uploadGreeting(file, type);
      setPreview(null);
      onChange(key);
      toast.success("Recording uploaded. Save to start using it.");
    } catch (err) {
      // api() already showed its own toast for the presign step; this covers the upload itself.
      if (err instanceof Error && err.name !== "ApiError") toast.error(humanizeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function listen(): Promise<void> {
    if (!audioKey) return;
    setLoadingPreview(true);
    try {
      setPreview(await settingsApi.greetingUrl(audioKey));
    } catch (err) {
      toast.error(`Couldn't load the recording: ${humanizeError(err)}`);
    } finally {
      setLoadingPreview(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <input
        ref={input}
        type="file"
        accept=".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // let the same file be picked again
          void pick(file);
        }}
      />
      {audioKey ? (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="pill pill--success">Recording uploaded</span>
            {!preview && (
              <button type="button" className="btn btn--subtle btn--sm" disabled={loadingPreview} onClick={() => void listen()}>
                <Play size={13} /> {loadingPreview ? "Loading…" : "Listen"}
              </button>
            )}
            <button type="button" className="btn btn--subtle btn--sm" disabled={busy} onClick={() => input.current?.click()}>
              <Upload size={13} /> {busy ? "Uploading…" : "Replace"}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                onChange(null);
              }}
            >
              <Trash2 size={13} /> Remove
            </button>
          </div>
          {preview && (
            <audio controls autoPlay src={preview} style={{ width: "100%", maxWidth: 360 }} onError={() => setPreview(null)} />
          )}
          <span className="field__hint">
            Callers hear this recording for {what}. Remove it to go back to the typed text, read by a computer voice.
          </span>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            style={{ justifySelf: "start" }}
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <Upload size={13} /> {busy ? "Uploading…" : "Upload a recording (MP3 or WAV)"}
          </button>
          <span className="field__hint">
            Optional, up to 5 MB. Without a recording, the typed text is read by a computer voice.
          </span>
        </>
      )}
    </div>
  );
}

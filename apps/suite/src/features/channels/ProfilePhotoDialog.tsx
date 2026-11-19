import { useEffect, useState } from "react";
import { Modal } from "@admin/components/Modal.js";
import { WA_PROFILE_PHOTO } from "@ms/shared";
import { waProfileApi, WaSaveFailure } from "./whatsapp-profile-api.js";

export const PHOTO_WRONG_TYPE = "Use a JPG or PNG picture.";
export const PHOTO_TOO_BIG = "That picture is larger than 5 MB. Choose a smaller one.";
export const PHOTO_TOO_SMALL = "That picture is too small. Use one at least 192 pixels wide and tall.";
export const PHOTO_NOT_SQUARE = "This picture is not square. WhatsApp will crop it to a circle from the middle.";

/** The browser's checks before upload (7.6). `error` blocks; `warning` does not. Size comes first, then shape. */
export function checkPhoto(file: { type: string; size: number }, dims: { width: number; height: number } | null): {
  error: string | null;
  warning: string | null;
} {
  if (!(WA_PROFILE_PHOTO.types as readonly string[]).includes(file.type)) return { error: PHOTO_WRONG_TYPE, warning: null };
  if (file.size > WA_PROFILE_PHOTO.maxBytes) return { error: PHOTO_TOO_BIG, warning: null };
  if (!dims) return { error: null, warning: null };
  if (dims.width < WA_PROFILE_PHOTO.minSide || dims.height < WA_PROFILE_PHOTO.minSide) return { error: PHOTO_TOO_SMALL, warning: null };
  const longer = Math.max(dims.width, dims.height);
  if (Math.abs(dims.width - dims.height) / longer > 0.02) return { error: null, warning: PHOTO_NOT_SQUARE };
  return { error: null, warning: null };
}

/** A round picture that falls back to grey with initials when there is none or it will not load. */
export function Avatar({ url, initials, size }: { url: string | null; initials: string; size: number }): JSX.Element {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const style = { width: size, height: size };
  if (!url || broken) {
    return (
      <div className="wp-avatar wp-avatar--blank" style={{ ...style, fontSize: Math.round(size / 3) }} aria-hidden>
        {initials}
      </div>
    );
  }
  return <img className="wp-avatar" style={style} src={url} alt="" onError={() => setBroken(true)} />;
}

/** Choose, preview and confirm a new profile photo (spec 05, 7.6). */
export function ProfilePhotoDialog({
  numberId,
  currentUrl,
  initials,
  onClose,
  onDone,
}: {
  numberId: string;
  currentUrl: string | null;
  initials: string;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Preview the chosen file, and read its size in pixels for the checks.
  useEffect(() => {
    if (!file) {
      setPreview(null);
      setDims(null);
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    setDims(null);
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (live) setDims({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = url;
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const check = file ? checkPhoto(file, dims) : { error: null, warning: null };
  const waiting = file !== null && check.error === null && dims === null;

  async function upload(): Promise<void> {
    if (!file) return;
    setBusy(true);
    setFailure(null);
    try {
      await waProfileApi.uploadPhoto(numberId, file);
      onDone();
    } catch (err) {
      setFailure(err instanceof WaSaveFailure ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Change profile photo" onClose={busy ? () => undefined : onClose} maxWidth={520}>
      <div className="field">
        <label className="field__label" htmlFor="wp-photo-file">Choose a picture</label>
        <input
          id="wp-photo-file"
          type="file"
          accept="image/jpeg,image/png"
          disabled={busy}
          onChange={(e) => {
            setFailure(null);
            setFile(e.target.files?.[0] ?? null);
          }}
        />
      </div>
      <div className="wp-preview">
        <figure>
          <Avatar url={currentUrl} initials={initials} size={160} />
          <figcaption>Now</figcaption>
        </figure>
        {preview && check.error !== PHOTO_WRONG_TYPE && (
          <figure>
            <img className="wp-avatar" style={{ width: 160, height: 160 }} src={preview} alt="" />
            <figcaption>New</figcaption>
          </figure>
        )}
      </div>
      {check.error && (
        <div className="field__error" role="alert">
          {check.error}
        </div>
      )}
      {check.warning && (
        <div className="wp-strip" role="status">
          {check.warning}
        </div>
      )}
      {failure && (
        <div className="field__error" role="alert">
          {failure}
        </div>
      )}
      <div className="wp-dialog-buttons">
        <button type="button" className="btn btn--subtle" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={busy || !file || check.error !== null || waiting} onClick={() => void upload()}>
          {busy ? "Uploading…" : "Use this photo"}
        </button>
      </div>
    </Modal>
  );
}

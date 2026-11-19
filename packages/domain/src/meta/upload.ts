/**
 * Meta's Resumable Upload API (suite spec 05, 3.2), shared with the specs that upload
 * files to Meta (06 template header samples, 07 Flows). Opens a session, sends the
 * bytes in one POST and returns the file handle ("h").
 *
 * The call uses the system-user token. Meta's guide names a user token; if Meta
 * refuses the system-user token the caller decides what to say (spec 05, rule 12).
 */
import { graph, graphRaw, MetaApiError, type MetaConfig } from "../inbox/meta.js";

/** The file types the upload API accepts (foundation: verified in spec 05, 3.2). */
export const META_UPLOAD_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "video/mp4"] as const;

const NO_HANDLE = "Meta returned no file handle";

export async function uploadFileToMeta(
  cfg: MetaConfig,
  appId: string,
  file: { bytes: Uint8Array; mimeType: string; fileName: string },
): Promise<string> {
  const enc = encodeURIComponent;
  const n = file.bytes.byteLength;
  const session = await graph<{ id?: string }>(
    cfg,
    "POST",
    `${appId}/uploads?file_name=${enc(file.fileName)}&file_length=${n}&file_type=${enc(file.mimeType)}`,
  );
  const sessionId = session.id;
  if (!sessionId) throw new MetaApiError("Meta did not open an upload session", 502, null, true);

  const send = (offset: number): Promise<{ h?: string }> =>
    graphRaw<{ h?: string }>(cfg, "POST", sessionId, {
      authScheme: "OAuth",
      headers: { file_offset: String(offset), "content-type": "application/octet-stream" },
      body: offset === 0 ? file.bytes : file.bytes.subarray(offset),
      timeoutMs: 60_000,
    });

  let done: { h?: string };
  try {
    done = await send(0);
  } catch (err) {
    // No answer: Meta may hold some or all of the bytes. Ask where it got to, send the rest once.
    if (!(err instanceof MetaApiError) || err.delivery !== "unknown") throw err;
    const where = await graphRaw<{ file_offset?: number | string }>(cfg, "GET", sessionId, { authScheme: "OAuth" });
    const offset = Number(where.file_offset ?? 0);
    done = await send(Number.isFinite(offset) && offset >= 0 && offset <= n ? offset : 0);
  }
  if (!done.h) throw new MetaApiError(NO_HANDLE, 502, null, true);
  return done.h;
}

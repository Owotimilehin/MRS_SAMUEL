/**
 * Phase B of WhatsApp forms (suite spec 07, section 5.9): the encryption Meta uses when a form
 * talks to our data endpoint.
 *
 * The private key lives ONLY in the server's environment (WA_FLOW_PRIVATE_KEY_B64, with
 * WA_FLOW_PRIVATE_KEY_PASSPHRASE if the key has one). It is never generated here, never written to
 * the database, a log line, an audit row or an error message. The technical lead creates it by hand.
 * Without it Phase B stays switched off and Phase A is unaffected.
 */
import crypto from "node:crypto";

/** The two settings, by name. Any environment-shaped object will do (process.env, or a plain object in tests). */
export type FlowKeyEnv = Record<string, string | undefined>;

let cached: { fingerprint: string; key: crypto.KeyObject | null } | null = null;

/**
 * The private key from the environment, or null when it is not set or cannot be read as an RSA
 * private key. Parsed once per process (again only if the setting changes).
 */
export function loadFlowPrivateKey(env: FlowKeyEnv = process.env): crypto.KeyObject | null {
  const b64 = (env.WA_FLOW_PRIVATE_KEY_B64 ?? "").trim();
  if (!b64) return null;
  const passphrase = env.WA_FLOW_PRIVATE_KEY_PASSPHRASE ?? "";
  // A digest of the setting, so the setting itself is not kept a second time.
  const fingerprint = crypto.createHash("sha256").update(b64).update("\0").update(passphrase).digest("hex");
  if (cached && cached.fingerprint === fingerprint) return cached.key;
  let key: crypto.KeyObject | null = null;
  try {
    const pem = Buffer.from(b64, "base64").toString("utf8");
    const parsed = crypto.createPrivateKey(passphrase ? { key: pem, format: "pem", passphrase } : { key: pem, format: "pem" });
    key = parsed.asymmetricKeyType === "rsa" ? parsed : null;
  } catch {
    // Deliberately no detail: an error from the key parser must never reach a log.
    key = null;
  }
  cached = { fingerprint, key };
  return key;
}

/** Is the setting present at all (even if unusable)? For telling "not set" from "set but wrong". */
export function flowPrivateKeyIsSet(env: FlowKeyEnv = process.env): boolean {
  return (env.WA_FLOW_PRIVATE_KEY_B64 ?? "").trim() !== "";
}

/** The public half, in the PEM form Meta asks for. Safe to send to Meta; never the private key. */
export function flowPublicKeyPem(key: crypto.KeyObject): string {
  return crypto.createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
}

/** Thrown for anything that stops a request being decrypted. Carries no detail on purpose. */
export class FlowDecryptError extends Error {
  constructor() {
    super("could not decrypt the form request");
    this.name = "FlowDecryptError";
  }
}

export interface FlowEncryptedBody {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}

const TAG_BYTES = 16;

/**
 * Decrypt a request from WhatsApp: the AES key is RSA-OAEP (SHA-256 for the hash and MGF1) under
 * our public key; the body is AES-128-GCM with the last 16 bytes as the tag.
 */
export function decryptFlowRequest(body: FlowEncryptedBody, key: crypto.KeyObject): { payload: Record<string, unknown>; aesKey: Buffer; iv: Buffer } {
  try {
    if (typeof body?.encrypted_flow_data !== "string" || typeof body.encrypted_aes_key !== "string" || typeof body.initial_vector !== "string") {
      throw new FlowDecryptError();
    }
    const aesKey = crypto.privateDecrypt(
      { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(body.encrypted_aes_key, "base64"),
    );
    if (aesKey.length !== 16) throw new FlowDecryptError();
    const buf = Buffer.from(body.encrypted_flow_data, "base64");
    if (buf.length <= TAG_BYTES) throw new FlowDecryptError();
    const tag = buf.subarray(-TAG_BYTES);
    const data = buf.subarray(0, -TAG_BYTES);
    const iv = Buffer.from(body.initial_vector, "base64");
    if (iv.length === 0) throw new FlowDecryptError();
    const d = crypto.createDecipheriv("aes-128-gcm", aesKey, iv);
    d.setAuthTag(tag);
    const text = Buffer.concat([d.update(data), d.final()]).toString("utf8");
    const payload: unknown = JSON.parse(text);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new FlowDecryptError();
    return { payload: payload as Record<string, unknown>, aesKey, iv };
  } catch {
    throw new FlowDecryptError();
  }
}

/** Encrypt our answer: AES-128-GCM with the same key and the request IV with every bit flipped; tag appended; base64. */
export function encryptFlowResponse(response: unknown, aesKey: Buffer, iv: Buffer): string {
  const flipped = Buffer.from(iv.map((b) => ~b & 0xff));
  const c = crypto.createCipheriv("aes-128-gcm", aesKey, flipped);
  return Buffer.concat([c.update(JSON.stringify(response), "utf8"), c.final(), c.getAuthTag()]).toString("base64");
}

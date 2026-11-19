import { describe, it, expect, beforeAll } from "vitest";
import crypto from "node:crypto";
import { decryptFlowRequest, encryptFlowResponse, FlowDecryptError, flowPrivateKeyIsSet, flowPublicKeyPem, loadFlowPrivateKey } from "./flow-crypto.js";

/**
 * A throwaway key pair is made at run time; no key is ever written into this file. The helper below
 * encrypts exactly the way Meta's guide describes its own side, so the vectors are known ones.
 */
let privateKey: crypto.KeyObject;
let publicKey: crypto.KeyObject;
let privatePem: string;

function metaEncrypt(payload: unknown, pub: crypto.KeyObject, aesKey = crypto.randomBytes(16), iv = crypto.randomBytes(16)) {
  const c = crypto.createCipheriv("aes-128-gcm", aesKey, iv);
  const data = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final(), c.getAuthTag()]);
  const wrapped = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesKey);
  return {
    body: { encrypted_flow_data: data.toString("base64"), encrypted_aes_key: wrapped.toString("base64"), initial_vector: iv.toString("base64") },
    aesKey,
    iv,
  };
}

/** What the WhatsApp client does with our answer. */
function metaDecrypt(answer: string, aesKey: Buffer, iv: Buffer): unknown {
  const buf = Buffer.from(answer, "base64");
  const flipped = Buffer.from(iv.map((b) => b ^ 0xff));
  const d = crypto.createDecipheriv("aes-128-gcm", aesKey, flipped);
  d.setAuthTag(buf.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString("utf8"));
}

beforeAll(() => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

describe("form endpoint encryption (suite spec 07, section 5.9)", () => {
  it("decrypts a request encrypted the way Meta does", () => {
    const sent = { version: "3.0", action: "INIT", screen: "", data: {}, flow_token: "delivery_slot.x.1.sig" };
    const enc = metaEncrypt(sent, publicKey);
    const out = decryptFlowRequest(enc.body, privateKey);
    expect(out.payload).toEqual(sent);
    expect(out.aesKey.equals(enc.aesKey)).toBe(true);
    expect(out.iv.equals(enc.iv)).toBe(true);
    // A 12-byte IV works too (GCM's usual size).
    const twelve = metaEncrypt({ action: "ping" }, publicKey, crypto.randomBytes(16), crypto.randomBytes(12));
    expect(decryptFlowRequest(twelve.body, privateKey).payload).toEqual({ action: "ping" });
  });

  it("encryptFlowResponse output decrypts with the flipped IV", () => {
    const enc = metaEncrypt({ action: "ping" }, publicKey);
    const { aesKey, iv } = decryptFlowRequest(enc.body, privateKey);
    const answer = encryptFlowResponse({ data: { status: "active" } }, aesKey, iv);
    expect(answer).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(metaDecrypt(answer, enc.aesKey, enc.iv)).toEqual({ data: { status: "active" } });
    // It does NOT decrypt with the IV as sent: the flip is what the client expects.
    const buf = Buffer.from(answer, "base64");
    const d = crypto.createDecipheriv("aes-128-gcm", enc.aesKey, enc.iv);
    d.setAuthTag(buf.subarray(-16));
    expect(() => Buffer.concat([d.update(buf.subarray(0, -16)), d.final()])).toThrow();
    // Non-ASCII text survives.
    expect(metaDecrypt(encryptFlowResponse({ t: "₦2,500 — Ìkẹjà" }, aesKey, iv), enc.aesKey, enc.iv)).toEqual({ t: "₦2,500 — Ìkẹjà" });
  });

  it("a wrong key or a tampered body throws FlowDecryptError", () => {
    const enc = metaEncrypt({ action: "INIT" }, publicKey);
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(() => decryptFlowRequest(enc.body, other)).toThrow(FlowDecryptError);
    const flip = (b64: string, at: number): string => {
      const b = Buffer.from(b64, "base64");
      b[at] = b[at]! ^ 0x01;
      return b.toString("base64");
    };
    expect(() => decryptFlowRequest({ ...enc.body, encrypted_flow_data: flip(enc.body.encrypted_flow_data, 0) }, privateKey)).toThrow(FlowDecryptError);
    expect(() => decryptFlowRequest({ ...enc.body, encrypted_flow_data: flip(enc.body.encrypted_flow_data, Buffer.from(enc.body.encrypted_flow_data, "base64").length - 1) }, privateKey)).toThrow(FlowDecryptError);
    expect(() => decryptFlowRequest({ ...enc.body, initial_vector: flip(enc.body.initial_vector, 3) }, privateKey)).toThrow(FlowDecryptError);
    expect(() => decryptFlowRequest({ ...enc.body, encrypted_aes_key: "AAAA" }, privateKey)).toThrow(FlowDecryptError);
    expect(() => decryptFlowRequest({ ...enc.body, encrypted_flow_data: "" }, privateKey)).toThrow(FlowDecryptError);
    expect(() => decryptFlowRequest({} as never, privateKey)).toThrow(FlowDecryptError);
    // An AES key of the wrong size, and a body that is not a JSON object.
    const c = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, crypto.randomBytes(32));
    expect(() => decryptFlowRequest({ ...enc.body, encrypted_aes_key: c.toString("base64") }, privateKey)).toThrow(FlowDecryptError);
    expect(() => decryptFlowRequest(metaEncrypt([1, 2], publicKey).body, privateKey)).toThrow(FlowDecryptError);
    // The error says nothing about why.
    try {
      decryptFlowRequest({ ...enc.body, encrypted_aes_key: "AAAA" }, privateKey);
    } catch (err) {
      expect((err as Error).message).toBe("could not decrypt the form request");
    }
  });

  it("flowPublicKeyPem derives the matching public key", () => {
    const pem = flowPublicKeyPem(privateKey);
    expect(pem.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
    expect(pem).not.toContain("PRIVATE");
    expect(pem).toBe(publicKey.export({ type: "spki", format: "pem" }).toString());
    const enc = metaEncrypt({ ok: true }, crypto.createPublicKey(pem));
    expect(decryptFlowRequest(enc.body, privateKey).payload).toEqual({ ok: true });
  });

  it("loadFlowPrivateKey reads the key from the setting, with or without a passphrase, and is null when it is missing or unusable", () => {
    const b64 = Buffer.from(privatePem, "utf8").toString("base64");
    expect(loadFlowPrivateKey({})).toBeNull();
    expect(loadFlowPrivateKey({ WA_FLOW_PRIVATE_KEY_B64: "   " })).toBeNull();
    expect(flowPrivateKeyIsSet({})).toBe(false);
    const key = loadFlowPrivateKey({ WA_FLOW_PRIVATE_KEY_B64: b64 })!;
    expect(key.type).toBe("private");
    expect(flowPublicKeyPem(key)).toBe(flowPublicKeyPem(privateKey));
    // Cached: the same object comes back for the same setting.
    expect(loadFlowPrivateKey({ WA_FLOW_PRIVATE_KEY_B64: b64 })).toBe(key);

    const phrase = crypto.randomBytes(12).toString("hex");
    const locked = privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: phrase }).toString();
    const lockedB64 = Buffer.from(locked, "utf8").toString("base64");
    expect(flowPublicKeyPem(loadFlowPrivateKey({ WA_FLOW_PRIVATE_KEY_B64: lockedB64, WA_FLOW_PRIVATE_KEY_PASSPHRASE: phrase })!)).toBe(flowPublicKeyPem(privateKey));
    expect(loadFlowPrivateKey({ WA_FLOW_PRIVATE_KEY_B64: lockedB64, WA_FLOW_PRIVATE_KEY_PASSPHRASE: "wrong" })).toBeNull();
    expect(loadFlowPrivateKey({ WA_FLOW_PRIVATE_KEY_B64: lockedB64 })).toBeNull();

    expect(loadFlowPrivateKey({ WA_FLOW_PRIVATE_KEY_B64: Buffer.from("not a key").toString("base64") })).toBeNull();
    expect(flowPrivateKeyIsSet({ WA_FLOW_PRIVATE_KEY_B64: "x" })).toBe(true);
    // A key that is not RSA is refused.
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(loadFlowPrivateKey({ WA_FLOW_PRIVATE_KEY_B64: Buffer.from(ec).toString("base64") })).toBeNull();
  });
});

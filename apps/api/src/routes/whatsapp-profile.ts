/**
 * WhatsApp business profile (suite spec 05, section 5.4): read a WhatsApp number's
 * public profile and status live from Meta, change the text fields and the photo.
 * Mounted at /v1/whatsapp-profile. Nothing about the profile is stored here.
 *
 * Every route needs channels.manage. A save reaches WhatsApp only through PUT or
 * POST .../photo, each of which reads the profile back and writes an audit row
 * (foundation rule 7). The token never leaves @ms/domain: it is not read, logged,
 * stored or returned here (rule 13), and Meta's picture URL is never stored or audited.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { inboxPhoneNumber, type DbClient } from "@ms/db";
import {
  MetaApiError,
  getWaNumberStatus,
  getWaProfile,
  metaConfigFromEnv,
  setWaProfilePhoto,
  updateWaProfile,
  uploadFileToMeta,
  type MetaConfig,
  type WaProfile,
} from "@ms/domain";
import {
  WA_PROFILE_PHOTO,
  changedWaFields,
  diffWaProfile,
  normaliseWaProfile,
  validateWaProfile,
  type WaProfileFields,
} from "@ms/shared";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { writeAudit } from "../middleware/audit.js";
import { alertOnce } from "../lib/inbox-alerts.js";
import { BusinessError } from "../lib/errors.js";

const Uuid = z.string().uuid();

const NOT_SET_UP = "WhatsApp is not set up on this server.";
const NO_WHATSAPP = "This number has no WhatsApp.";
const PHOTO_NOT_SET_UP = "Photo upload is not set up on this server yet. Change the photo in WhatsApp Manager for now.";
const PHOTO_TYPE = "Use a JPG or PNG picture.";
const PHOTO_TOO_BIG = "That picture is larger than 5 MB. Choose a smaller one.";
const PHOTO_REFUSED_TOKEN = "WhatsApp would not accept the photo from here. Change the photo in WhatsApp Manager for now.";
const CHANGED_ELSEWHERE =
  "This profile was changed somewhere else since you opened it. We have loaded the latest version. Check it and make your change again.";
const EMPTY_ABOUT = "WhatsApp does not allow an empty 'about' line. Write a short line instead.";
const UNAVAILABLE =
  "WhatsApp did not answer. Nothing was changed for certain. Wait a minute, reload this page and check before trying again.";
const READ_BACK_FAILED =
  "Your change was sent to WhatsApp, but we could not read the profile back to check it. Reload this page and check before trying again.";

/** Meta codes that mean "our connection to Meta is broken": 190 token, 10/200/299 permission, 283 (foundation C2). */
const CONFIG_CODES = new Set(["190", "10", "200", "299", "283"]);
const MANAGER_URL = "https://business.facebook.com/latest/whatsapp_manager";

interface WaNumber {
  id: string;
  label: string;
  e164: string | null;
  wabaId: string | null;
  phoneNumberId: string;
}

// ── Shapes ───────────────────────────────────────────────────────────────────

function profileJson(p: WaProfile) {
  return {
    about: p.about,
    address: p.address,
    description: p.description,
    email: p.email,
    websites: p.websites,
    vertical: p.vertical,
    profile_picture_url: p.profilePictureUrl,
  };
}

function sixFields(p: WaProfileFields): WaProfileFields {
  return {
    about: p.about,
    address: p.address,
    description: p.description,
    email: p.email,
    websites: [...p.websites],
    vertical: p.vertical,
  };
}

const Text = z.string().max(10_000);
const FieldsBody = z
  .object({
    about: Text,
    address: Text,
    description: Text,
    email: Text,
    websites: z.array(Text).max(10),
    vertical: z.string().max(100),
  })
  .strict();
const PutBody = z.object({ profile: FieldsBody, expected: FieldsBody }).strict();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadNumber(db: DbClient, c: Context): Promise<WaNumber> {
  const id = Uuid.safeParse(c.req.param("numberId"));
  if (!id.success) throw new BusinessError("not_found", "not found", 404);
  const [row] = await db
    .select({
      id: inboxPhoneNumber.id,
      kind: inboxPhoneNumber.kind,
      label: inboxPhoneNumber.label,
      e164: inboxPhoneNumber.e164,
      wabaId: inboxPhoneNumber.wabaId,
      waPhoneNumberId: inboxPhoneNumber.waPhoneNumberId,
      channels: inboxPhoneNumber.channels,
    })
    .from(inboxPhoneNumber)
    .where(eq(inboxPhoneNumber.id, id.data));
  if (!row || row.kind !== "phone") throw new BusinessError("not_found", "not found", 404);
  if (!row.waPhoneNumberId || row.channels === "voice") throw new BusinessError("validation_failed", NO_WHATSAPP, 400);
  return { id: row.id, label: row.label, e164: row.e164, wabaId: row.wabaId, phoneNumberId: row.waPhoneNumberId };
}

function needConfig(): MetaConfig {
  const cfg = metaConfigFromEnv();
  if (!cfg) throw new BusinessError("service_unavailable", NOT_SET_UP, 503);
  return cfg;
}

/** The photo upload needs the Meta app's numeric ID (META_APP_ID); without it everything else still works. */
function photoAppId(cfg: MetaConfig | null): string | null {
  return cfg?.appId && /^\d+$/.test(cfg.appId) ? cfg.appId : null;
}

/** 5.3: turn a Meta failure into the error the screen shows. `reading` only changes the wording of a plain refusal. */
async function failure(db: DbClient, err: unknown, reading = false): Promise<BusinessError> {
  if (!(err instanceof MetaApiError)) throw err;
  const code = err.code ?? "";
  if (CONFIG_CODES.has(code)) {
    // One owner alert per 24 hours for the whole WhatsApp profile area (outbox case in the worker).
    await alertOnce(db, "inbox.meta_config", { account: "whatsapp_profile", area: "whatsapp_profile", code });
    return new BusinessError(
      "conflict",
      `WhatsApp would not let us in. The connection needs fixing by the technical lead. (Meta code ${code})`,
      409,
      { reason: "meta_config", meta_code: code },
    );
  }
  if (err.retryable || err.delivery === "unknown") {
    return new BusinessError("service_unavailable", UNAVAILABLE, 502, { reason: "meta_unavailable" });
  }
  return new BusinessError(
    "conflict",
    `WhatsApp refused ${reading ? "this request" : "this change"}: ${err.message}`,
    409,
    { reason: "meta_refused", meta_code: code || null, meta_message: err.message },
  );
}

/** Read the profile; Meta trouble becomes the screen's error. */
async function readProfile(db: DbClient, cfg: MetaConfig, n: WaNumber, reading = false): Promise<WaProfile> {
  try {
    return await getWaProfile(cfg, n.phoneNumberId);
  } catch (err) {
    throw await failure(db, err, reading);
  }
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
}

/** The picture type the first bytes prove, or null. */
function sniffImage(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  return null;
}

function safeFileName(raw: string | undefined, mime: "image/jpeg" | "image/png"): string {
  const ext = mime === "image/png" ? "png" : "jpg";
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return cleaned && /\.[A-Za-z0-9]{2,4}$/.test(cleaned) ? cleaned : `profile.${ext}`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function whatsappProfileRoutes(db: DbClient) {
  const r = new Hono();
  r.use("*", requireAuth());
  r.use("*", requireCapability("channels.manage"));

  /** The WhatsApp numbers, for the Channels page. No Meta call. */
  r.get("/", async (c) => {
    const rows = await db
      .select({
        id: inboxPhoneNumber.id,
        label: inboxPhoneNumber.label,
        e164: inboxPhoneNumber.e164,
        isActive: inboxPhoneNumber.isActive,
      })
      .from(inboxPhoneNumber)
      .where(
        and(
          eq(inboxPhoneNumber.kind, "phone"),
          isNotNull(inboxPhoneNumber.waPhoneNumberId),
          ne(inboxPhoneNumber.channels, "voice"),
        ),
      )
      .orderBy(asc(inboxPhoneNumber.label));
    return c.json({ data: rows.map((x) => ({ id: x.id, label: x.label, e164: x.e164, is_active: x.isActive })) });
  });

  /** Profile and status, read live. */
  r.get("/:numberId", async (c) => {
    const n = await loadNumber(db, c);
    const cfg = needConfig();
    let profile: WaProfile;
    let status: Awaited<ReturnType<typeof getWaNumberStatus>>;
    try {
      [profile, status] = await Promise.all([getWaProfile(cfg, n.phoneNumberId), getWaNumberStatus(cfg, n.phoneNumberId)]);
    } catch (err) {
      throw await failure(db, err, true);
    }

    // Keeps the Settings screen fresh. Only what Meta told us, only when it differs. Not a Meta write, not audited.
    const [stored] = await db
      .select({
        waStatus: inboxPhoneNumber.waStatus,
        qualityRating: inboxPhoneNumber.qualityRating,
        messagingLimit: inboxPhoneNumber.messagingLimit,
      })
      .from(inboxPhoneNumber)
      .where(eq(inboxPhoneNumber.id, n.id));
    const fresh: { waStatus?: string; qualityRating?: string; messagingLimit?: string } = {};
    if (status.status !== null && status.status !== stored?.waStatus) fresh.waStatus = status.status;
    if (status.qualityRating !== null && status.qualityRating !== stored?.qualityRating) fresh.qualityRating = status.qualityRating;
    if (status.messagingLimit !== null && status.messagingLimit !== stored?.messagingLimit) fresh.messagingLimit = status.messagingLimit;
    if (Object.keys(fresh).length > 0) {
      await db.update(inboxPhoneNumber).set({ ...fresh, updatedAt: new Date() }).where(eq(inboxPhoneNumber.id, n.id));
    }

    return c.json({
      data: {
        number: { id: n.id, label: n.label, e164: n.e164, waba_id: n.wabaId },
        profile: profileJson(profile),
        status: {
          display_phone_number: status.displayPhoneNumber,
          display_name: status.displayName,
          name_status: status.nameStatus,
          pending_name: status.pendingName,
          pending_name_status: status.pendingNameStatus,
          quality_rating: status.qualityRating,
          status: status.status,
          code_verification_status: status.codeVerificationStatus,
          messaging_limit: status.messagingLimit,
          pin_enabled: status.pinEnabled,
          official_account: status.officialAccount,
        },
        photo_upload_ready: photoAppId(cfg) !== null,
        manager_url: n.wabaId ? `${MANAGER_URL}/phone_numbers?waba_id=${encodeURIComponent(n.wabaId)}` : MANAGER_URL,
      },
    });
  });

  /** Save the text fields. */
  r.put("/:numberId", async (c) => {
    const n = await loadNumber(db, c);
    const body = PutBody.parse(await c.req.json().catch(() => ({})));

    // Step 1: tidy both, then check what the person wants to save.
    const profile = normaliseWaProfile(body.profile);
    const expected = normaliseWaProfile(body.expected);
    const problems = validateWaProfile(profile, { utf16: true, keepVertical: expected.vertical });
    const firstProblem = Object.values(problems)[0];
    if (firstProblem) {
      throw new BusinessError("validation_failed", firstProblem, 400, { fields: problems });
    }

    // Step 2: read what WhatsApp holds now; if it is not what the person saw, nothing is written.
    const cfg = needConfig();
    const current = await readProfile(db, cfg, n);
    if (changedWaFields(current, expected).length > 0) {
      throw new BusinessError("conflict", CHANGED_ELSEWHERE, 409, {
        reason: "changed_elsewhere",
        current: profileJson(current),
      });
    }

    // Step 3: nothing changed, nothing sent, nothing audited.
    const normalCurrent = normaliseWaProfile(current);
    const diff = diffWaProfile(normalCurrent, profile);
    if (diff.length === 0) {
      return c.json({ data: { profile: profileJson(current), changed: [], mismatch: [] } });
    }

    // Step 4: Meta refuses an empty "about" line.
    if (profile.about === "" && normalCurrent.about !== "") {
      throw new BusinessError("validation_failed", EMPTY_ABOUT, 400, { fields: { about: EMPTY_ABOUT } });
    }

    // Step 5: the one call that changes the profile.
    try {
      await updateWaProfile(cfg, n.phoneNumberId, profile);
    } catch (err) {
      const e = await failure(db, err);
      if (err instanceof MetaApiError && err.delivery === "unknown") {
        // It may have gone through: leave a trace so the change can be found (rule 7).
        await writeAudit(db, c, {
          action: "whatsapp_profile.update_unconfirmed",
          entityType: "inbox_phone_number",
          entityId: n.id,
          before: sixFields(normalCurrent),
          after: { ...sixFields(profile), result: "unknown" },
          notify: true,
        });
      }
      throw e;
    }

    // Step 6: read it back; what WhatsApp shows is what the screen shows next.
    let after: WaProfile;
    try {
      after = await getWaProfile(cfg, n.phoneNumberId);
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      await writeAudit(db, c, {
        action: "whatsapp_profile.update",
        entityType: "inbox_phone_number",
        entityId: n.id,
        before: sixFields(normalCurrent),
        after: { ...sixFields(profile), read_back: false },
        notify: true,
      });
      throw new BusinessError("service_unavailable", READ_BACK_FAILED, 502, { reason: "read_back_failed" });
    }
    const mismatch = changedWaFields(after, profile);

    // Step 7: audit before and after (six fields only: no picture address).
    await writeAudit(db, c, {
      action: "whatsapp_profile.update",
      entityType: "inbox_phone_number",
      entityId: n.id,
      before: sixFields(normalCurrent),
      after: sixFields(normaliseWaProfile(after)),
      notify: true,
    });

    return c.json({ data: { profile: profileJson(after), changed: diff.map((d) => d.field), mismatch } });
  });

  /** Replace the photo. The body is the picture itself. */
  r.post(
    "/:numberId/photo",
    bodyLimit({
      maxSize: WA_PROFILE_PHOTO.maxBytes,
      onError: (c) =>
        c.json({ error: { code: "validation_failed", message: PHOTO_TOO_BIG, details: {} } }, 413),
    }),
    async (c) => {
      const n = await loadNumber(db, c);
      const appId = photoAppId(metaConfigFromEnv());
      if (!appId) throw new BusinessError("service_unavailable", PHOTO_NOT_SET_UP, 503);

      const declared = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!(WA_PROFILE_PHOTO.types as readonly string[]).includes(declared)) {
        throw new BusinessError("validation_failed", PHOTO_TYPE, 400);
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > WA_PROFILE_PHOTO.maxBytes) throw new BusinessError("validation_failed", PHOTO_TOO_BIG, 413);
      // The first bytes decide what the picture is, whatever the browser called it.
      const mime = sniffImage(bytes);
      if (!mime) throw new BusinessError("validation_failed", PHOTO_TYPE, 400);

      const cfg = needConfig();
      const before = await readProfile(db, cfg, n);

      let handle: string;
      try {
        handle = await uploadFileToMeta(cfg, appId, { bytes, mimeType: mime, fileName: safeFileName(c.req.header("x-file-name"), mime) });
      } catch (err) {
        // Rule 12: Meta may not accept the system-user token for uploads. Say so; no owner alert.
        if (err instanceof MetaApiError && (err.code === "190" || err.code === "200")) {
          throw new BusinessError("conflict", PHOTO_REFUSED_TOKEN, 409, { reason: "upload_token_refused", meta_code: err.code });
        }
        throw await failure(db, err);
      }
      try {
        await setWaProfilePhoto(cfg, n.phoneNumberId, handle);
      } catch (err) {
        throw await failure(db, err);
      }

      let after: WaProfile | null = null;
      try {
        after = await getWaProfile(cfg, n.phoneNumberId);
      } catch (err) {
        if (!(err instanceof MetaApiError)) throw err;
      }
      await writeAudit(db, c, {
        action: "whatsapp_profile.photo_update",
        entityType: "inbox_phone_number",
        entityId: n.id,
        before: { profile_picture_url: before.profilePictureUrl ? "set" : "none" },
        after: { bytes: bytes.byteLength, mime },
        notify: true,
      });
      if (!after) throw new BusinessError("service_unavailable", READ_BACK_FAILED, 502, { reason: "read_back_failed" });
      return c.json({ data: { profile_picture_url: after.profilePictureUrl } });
    },
  );

  return r;
}

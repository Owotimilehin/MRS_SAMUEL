/**
 * WhatsApp business profile and number status (suite spec 05, section 5.2).
 *
 * The profile lives at Meta; nothing here is stored. Calls use the system-user token
 * and keep the "Could not reach WhatsApp" wording. Facts marked [unverified] in the
 * spec (clearing a field with "", the call-B field names, enum names) are not checked
 * against a real number yet.
 */
import type { WaProfileFields } from "@ms/shared";
import { graph, MetaApiError, type GraphOptions, type MetaConfig } from "../inbox/meta.js";

const WA: GraphOptions = { service: "WhatsApp" };

export interface WaProfile extends WaProfileFields {
  profilePictureUrl: string | null;
}

export interface WaNumberStatus {
  displayPhoneNumber: string | null;
  /** verified_name */
  displayName: string | null;
  nameStatus: string | null;
  /** new_display_name */
  pendingName: string | null;
  pendingNameStatus: string | null;
  qualityRating: string | null;
  status: string | null;
  codeVerificationStatus: string | null;
  /** whatsapp_business_manager_messaging_limit */
  messagingLimit: string | null;
  /** null = Meta did not tell us */
  pinEnabled: boolean | null;
  /** null = Meta did not tell us */
  officialAccount: boolean | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

const PROFILE_FIELDS = "about,address,description,email,profile_picture_url,websites,vertical";

/** Read the profile. Missing text becomes "", missing websites []; an unknown business type is returned as it is. */
export async function getWaProfile(cfg: MetaConfig, phoneNumberId: string): Promise<WaProfile> {
  const res = await graph<{ data?: Record<string, unknown>[] }>(
    cfg,
    "GET",
    `${phoneNumberId}/whatsapp_business_profile?fields=${PROFILE_FIELDS}`,
    undefined,
    WA,
  );
  const p = res?.data?.[0] ?? {};
  return {
    about: str(p["about"]),
    address: str(p["address"]),
    description: str(p["description"]),
    email: str(p["email"]),
    websites: Array.isArray(p["websites"]) ? (p["websites"] as unknown[]).filter((w): w is string => typeof w === "string") : [],
    vertical: str(p["vertical"]),
    profilePictureUrl: strOrNull(p["profile_picture_url"]),
  };
}

/**
 * Save the text fields in one POST. Always sends address, description, email, websites
 * and vertical; sends `about` only when it is not empty (Meta refuses an empty one).
 */
export async function updateWaProfile(cfg: MetaConfig, phoneNumberId: string, fields: WaProfileFields): Promise<void> {
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    address: fields.address,
    description: fields.description,
    email: fields.email,
    websites: fields.websites,
    vertical: fields.vertical,
  };
  if (fields.about !== "") body["about"] = fields.about;
  const res = await graph<{ success?: boolean }>(cfg, "POST", `${phoneNumberId}/whatsapp_business_profile`, body, WA);
  if (res?.success !== true) throw new MetaApiError("Meta did not confirm the change", 502, null, false);
}

/** Set the profile photo from a handle returned by the Resumable Upload API. */
export async function setWaProfilePhoto(cfg: MetaConfig, phoneNumberId: string, handle: string): Promise<void> {
  const res = await graph<{ success?: boolean }>(
    cfg,
    "POST",
    `${phoneNumberId}/whatsapp_business_profile`,
    { messaging_product: "whatsapp", profile_picture_handle: handle },
    WA,
  );
  if (res?.success !== true) throw new MetaApiError("Meta did not confirm the change", 502, null, false);
}

const STATUS_FIELDS_FULL =
  "display_phone_number,verified_name,name_status,new_display_name,new_name_status,quality_rating,status,code_verification_status,whatsapp_business_manager_messaging_limit";
const STATUS_FIELDS_SHORT = "display_phone_number,verified_name,quality_rating,status,code_verification_status";

/**
 * Read the number's status (read only on the suite screen). Two parallel calls: A is
 * the main field list (retried once with a short list on code 100, an unknown field);
 * B asks for the PIN and badge fields and is tolerant: if Meta refuses it, both become null.
 */
export async function getWaNumberStatus(cfg: MetaConfig, phoneNumberId: string): Promise<WaNumberStatus> {
  const callA = async (): Promise<Record<string, unknown>> => {
    try {
      return await graph<Record<string, unknown>>(cfg, "GET", `${phoneNumberId}?fields=${STATUS_FIELDS_FULL}`, undefined, WA);
    } catch (err) {
      if (!(err instanceof MetaApiError) || err.code !== "100") throw err;
      return graph<Record<string, unknown>>(cfg, "GET", `${phoneNumberId}?fields=${STATUS_FIELDS_SHORT}`, undefined, WA);
    }
  };
  const callB = async (): Promise<Record<string, unknown>> => {
    try {
      return await graph<Record<string, unknown>>(
        cfg,
        "GET",
        `${phoneNumberId}?fields=is_pin_enabled,is_official_business_account`,
        undefined,
        WA,
      );
    } catch (err) {
      if (err instanceof MetaApiError) return {};
      throw err;
    }
  };
  const [a, b] = await Promise.all([callA(), callB()]);
  return {
    displayPhoneNumber: strOrNull(a["display_phone_number"]),
    displayName: strOrNull(a["verified_name"]),
    nameStatus: strOrNull(a["name_status"]),
    pendingName: strOrNull(a["new_display_name"]),
    pendingNameStatus: strOrNull(a["new_name_status"]),
    qualityRating: strOrNull(a["quality_rating"]),
    status: strOrNull(a["status"]),
    codeVerificationStatus: strOrNull(a["code_verification_status"]),
    messagingLimit: strOrNull(a["whatsapp_business_manager_messaging_limit"]),
    pinEnabled: boolOrNull(b["is_pin_enabled"]),
    officialAccount: boolOrNull(b["is_official_business_account"]),
  };
}

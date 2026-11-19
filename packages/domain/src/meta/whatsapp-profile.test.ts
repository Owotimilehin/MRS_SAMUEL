import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getWaNumberStatus,
  getWaProfile,
  setWaProfilePhoto,
  updateWaProfile,
} from "./whatsapp-profile.js";
import { uploadFileToMeta } from "./upload.js";
import { MetaApiError } from "../inbox/meta.js";

// Never the real Graph API: every test stubs fetch. The token below is obviously fake.
const cfg = { token: "SYSTEM-USER-TEST", graphVersion: "v23.0" };
const PNID = "1098765432";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
function stub(handler: (c: Call, n: number) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = {
        url,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ?? null,
      };
      calls.push(call);
      return handler(call, calls.length - 1);
    }),
  );
  return calls;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getWaProfile", () => {
  it("getWaProfile maps data[0] and fills blanks", async () => {
    const calls = stub(() =>
      json({
        data: [
          {
            about: "Fresh juice",
            address: "1 Allen Avenue",
            email: "hello@mrssamuel.com",
            websites: ["https://www.mrssamuel.com"],
            vertical: "UNDEFINED",
            profile_picture_url: "https://pps.example.com/p.jpg",
            messaging_product: "whatsapp",
          },
        ],
      }),
    );
    const p = await getWaProfile(cfg, PNID);
    expect(p).toEqual({
      about: "Fresh juice",
      address: "1 Allen Avenue",
      description: "",
      email: "hello@mrssamuel.com",
      websites: ["https://www.mrssamuel.com"],
      vertical: "UNDEFINED",
      profilePictureUrl: "https://pps.example.com/p.jpg",
    });
    expect(calls[0]!.url).toBe(
      `https://graph.facebook.com/v23.0/${PNID}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
    );
    expect(calls[0]!.headers.authorization).toBe("Bearer SYSTEM-USER-TEST");

    stub(() => json({ data: [{}] }));
    expect(await getWaProfile(cfg, PNID)).toEqual({
      about: "",
      address: "",
      description: "",
      email: "",
      websites: [],
      vertical: "",
      profilePictureUrl: null,
    });
    stub(() => json({ data: [] }));
    expect((await getWaProfile(cfg, PNID)).websites).toEqual([]);
  });
});

describe("updateWaProfile", () => {
  const fields = {
    about: "Fresh juice",
    address: "1 Allen Avenue",
    description: "We press every juice.",
    email: "hello@mrssamuel.com",
    websites: ["https://www.mrssamuel.com"],
    vertical: "RESTAURANT",
  };

  it("updateWaProfile leaves about out when empty and always sends the other five", async () => {
    const calls = stub(() => json({ success: true }));
    await updateWaProfile(cfg, PNID, fields);
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ messaging_product: "whatsapp", ...fields });
    expect(calls[0]!.method).toBe("POST");

    await updateWaProfile(cfg, PNID, { ...fields, about: "", address: "", email: "", websites: [], vertical: "" });
    expect(JSON.parse(String(calls[1]!.body))).toEqual({
      messaging_product: "whatsapp",
      address: "",
      description: "We press every juice.",
      email: "",
      websites: [],
      vertical: "",
    });
  });

  it("throws when Meta does not answer success, and keeps Meta's refusal", async () => {
    stub(() => json({}));
    await expect(updateWaProfile(cfg, PNID, fields)).rejects.toBeInstanceOf(MetaApiError);
    stub(() => json({ error: { message: "Invalid parameter", code: 100 } }, 400));
    const err = await updateWaProfile(cfg, PNID, fields).catch((e: unknown) => e);
    expect((err as MetaApiError).code).toBe("100");
  });

  it("setWaProfilePhoto posts the handle", async () => {
    const calls = stub(() => json({ success: true }));
    await setWaProfilePhoto(cfg, PNID, "HANDLE1");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ messaging_product: "whatsapp", profile_picture_handle: "HANDLE1" });
  });
});

describe("getWaNumberStatus", () => {
  const A = {
    id: PNID,
    display_phone_number: "+234 800 000 0000",
    verified_name: "Mrs Samuel",
    name_status: "APPROVED",
    new_display_name: "Mrs Samuel Juice",
    new_name_status: "PENDING_REVIEW",
    quality_rating: "GREEN",
    status: "CONNECTED",
    code_verification_status: "VERIFIED",
    whatsapp_business_manager_messaging_limit: "TIER_250",
  };

  it("getWaNumberStatus maps the fields and the PIN and badge when Meta tells us", async () => {
    stub((c) =>
      c.url.includes("is_pin_enabled") ? json({ is_pin_enabled: false, is_official_business_account: true }) : json(A),
    );
    expect(await getWaNumberStatus(cfg, PNID)).toEqual({
      displayPhoneNumber: "+234 800 000 0000",
      displayName: "Mrs Samuel",
      nameStatus: "APPROVED",
      pendingName: "Mrs Samuel Juice",
      pendingNameStatus: "PENDING_REVIEW",
      qualityRating: "GREEN",
      status: "CONNECTED",
      codeVerificationStatus: "VERIFIED",
      messagingLimit: "TIER_250",
      pinEnabled: false,
      officialAccount: true,
    });
  });

  it("getWaNumberStatus returns nulls for pin and badge when call B is refused", async () => {
    stub((c) =>
      c.url.includes("is_pin_enabled") ? json({ error: { message: "nonexisting field", code: 100 } }, 400) : json(A),
    );
    const s = await getWaNumberStatus(cfg, PNID);
    expect(s.pinEnabled).toBeNull();
    expect(s.officialAccount).toBeNull();
    expect(s.status).toBe("CONNECTED");
  });

  it("getWaNumberStatus falls back to the short field list on code 100", async () => {
    const calls = stub((c) => {
      if (c.url.includes("is_pin_enabled")) return json({ is_pin_enabled: true, is_official_business_account: false });
      if (c.url.includes("name_status")) return json({ error: { message: "nonexisting field (name_status)", code: 100 } }, 400);
      return json({ display_phone_number: "+234 800 000 0000", verified_name: "Mrs Samuel", quality_rating: "NA", status: "CONNECTED", code_verification_status: "VERIFIED" });
    });
    const s = await getWaNumberStatus(cfg, PNID);
    expect(calls.some((c) => c.url.endsWith("fields=display_phone_number,verified_name,quality_rating,status,code_verification_status"))).toBe(true);
    expect(s).toMatchObject({
      displayName: "Mrs Samuel",
      qualityRating: "NA",
      nameStatus: null,
      pendingName: null,
      messagingLimit: null,
      pinEnabled: true,
      officialAccount: false,
    });
  });

  it("getWaNumberStatus throws when call A is refused for another reason", async () => {
    stub((c) => (c.url.includes("is_pin_enabled") ? json({}) : json({ error: { message: "token", code: 190 } }, 401)));
    await expect(getWaNumberStatus(cfg, PNID)).rejects.toMatchObject({ code: "190" });
  });
});

describe("uploadFileToMeta", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
  const file = { bytes, mimeType: "image/png", fileName: "logo file.png" };

  it("uploadFileToMeta opens a session then posts bytes with OAuth and file_offset 0", async () => {
    const calls = stub((_c, n) => (n === 0 ? json({ id: "upload:SESSION1" }) : json({ h: "HANDLE-1" })));
    const h = await uploadFileToMeta(cfg, "1234567890", file);
    expect(h).toBe("HANDLE-1");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(
      "https://graph.facebook.com/v23.0/1234567890/uploads?file_name=logo%20file.png&file_length=10&file_type=image%2Fpng",
    );
    expect(calls[0]!.headers.authorization).toBe("Bearer SYSTEM-USER-TEST");
    expect(calls[1]!.url).toBe("https://graph.facebook.com/v23.0/upload:SESSION1");
    expect(calls[1]!.headers.authorization).toBe("OAuth SYSTEM-USER-TEST");
    expect(calls[1]!.headers.file_offset).toBe("0");
    expect(calls[1]!.body).toBe(bytes);
  });

  it("uploadFileToMeta resumes once from the offset Meta reports", async () => {
    const calls = stub((_c, n) => {
      if (n === 0) return json({ id: "upload:SESSION1" });
      if (n === 1) throw new TypeError("fetch failed"); // no answer: delivery unknown
      if (n === 2) return json({ file_offset: 4 });
      return json({ h: "HANDLE-2" });
    });
    const h = await uploadFileToMeta(cfg, "1234567890", file);
    expect(h).toBe("HANDLE-2");
    expect(calls).toHaveLength(4);
    expect(calls[2]!.method).toBe("GET");
    expect(calls[2]!.headers.authorization).toBe("OAuth SYSTEM-USER-TEST");
    expect(calls[3]!.headers.file_offset).toBe("4");
    expect(Array.from(calls[3]!.body as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("uploadFileToMeta throws on a second failure, a refusal, or no handle", async () => {
    stub((_c, n) => {
      if (n === 0) return json({ id: "upload:SESSION1" });
      if (n === 2) return json({ file_offset: 0 });
      throw new TypeError("fetch failed");
    });
    await expect(uploadFileToMeta(cfg, "1234567890", file)).rejects.toMatchObject({ delivery: "unknown" });

    stub((_c, n) => (n === 0 ? json({ id: "upload:S" }) : json({ error: { message: "bad token", code: 190 } }, 401)));
    await expect(uploadFileToMeta(cfg, "1234567890", file)).rejects.toMatchObject({ code: "190" });

    stub((_c, n) => (n === 0 ? json({ id: "upload:S" }) : json({})));
    const err = await uploadFileToMeta(cfg, "1234567890", file).catch((e: unknown) => e);
    expect((err as MetaApiError).message).toBe("Meta returned no file handle");
    expect((err as MetaApiError).status).toBe(502);
  });
});

import { describe, it, expect } from "vitest";
import {
  buildImportRow,
  consentKeyword,
  contactPhoneDigits,
  csvSafeCell,
  describeContactFilter,
  firstName,
  groupThousands,
  importReason,
  importReasonCode,
  importReasonText,
  normaliseContactEmail,
  parseContactFilter,
  parseCsv,
  readContactSettings,
  suggestMapping,
  DEFAULT_CONTACT_SETTINGS,
  STOP_WORDS,
  START_WORDS,
} from "./contacts.js";

const LABEL = "11111111-1111-4111-8111-111111111111";
const LIST = "22222222-2222-4222-8222-222222222222";

describe("consentKeyword", () => {
  it("consentKeyword: STOP, stop., \"Stop\", UNSUBSCRIBE and opt out are stop; START and resume are start", () => {
    for (const s of ["STOP", "stop.", '"Stop"', "UNSUBSCRIBE", "opt out", "  Stop!  ", "“stop”", "'stop.'", "Stop all", "STOPALL", "opt-out", "optout", "remove me", "stop promo", "Stop promotions", "No more messages."]) {
      expect(consentKeyword(s), s).toBe("stop");
    }
    for (const s of ["START", "resume", "Start.", "unstop", "subscribe", "opt in", "optin", "OPT-IN"]) {
      expect(consentKeyword(s), s).toBe("start");
    }
    for (const w of STOP_WORDS) expect(consentKeyword(w)).toBe("stop");
    for (const w of START_WORDS) expect(consentKeyword(w)).toBe("start");
  });

  it("consentKeyword: a sentence containing stop, and cancel, end, quit, are not keywords", () => {
    for (const s of [
      "please stop calling the driver",
      "stop the delivery",
      "cancel",
      "end",
      "quit",
      "Cancel my order",
      "stop?",
      "don't stop",
      "stopp",
      "start my order",
      "",
      "   ",
      "no",
    ]) {
      expect(consentKeyword(s), s).toBeNull();
    }
    expect(consentKeyword(null)).toBeNull();
    expect(consentKeyword(undefined)).toBeNull();
  });
});

describe("parseCsv", () => {
  it("parseCsv reads quoted cells, doubled quotes, commas and line breaks inside quotes", () => {
    const csv = 'Name,Phone,Notes\r\n"Obi, Ada",08030000001,"Said ""yes"" twice"\r\nBola,08030000002,"Line one\nLine two"\r\n';
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual(["Name", "Phone", "Notes"]);
    expect(rows).toEqual([
      ["Obi, Ada", "08030000001", 'Said "yes" twice'],
      ["Bola", "08030000002", "Line one\nLine two"],
    ]);
  });

  it("parseCsv strips a byte-order mark and accepts LF or CR LF", () => {
    const lf = parseCsv("﻿Name,Phone\nAda,0803\nBola,0804");
    expect(lf.headers).toEqual(["Name", "Phone"]);
    expect(lf.rows).toEqual([
      ["Ada", "0803"],
      ["Bola", "0804"],
    ]);
    const crlf = parseCsv("Name,Phone\r\nAda,0803\r\n\r\nBola,0804\r\n");
    expect(crlf.rows).toEqual([
      ["Ada", "0803"],
      ["Bola", "0804"],
    ]);
  });

  it("parseCsv never throws: empty text, an unclosed quote, a lone header", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
    expect(parseCsv("Name")).toEqual({ headers: ["Name"], rows: [] });
    expect(parseCsv('Name\n"never closed')).toEqual({ headers: ["Name"], rows: [["never closed"]] });
    expect(parseCsv(undefined as unknown as string)).toEqual({ headers: [], rows: [] });
    expect(parseCsv(" Name , Phone \n a,b").headers).toEqual(["Name", "Phone"]);
  });
});

describe("suggestMapping", () => {
  it("suggestMapping maps Phone Number, E-mail, Full Name, Surname and Delivery Address", () => {
    expect(suggestMapping(["Full Name", "Phone Number", "E-mail", "Delivery Address"])).toEqual({
      name: "Full Name",
      phone: "Phone Number",
      email: "E-mail",
      address: "Delivery Address",
    });
    expect(suggestMapping(["First Name", "Surname", "Mobile", "Comment"])).toEqual({
      first_name: "First Name",
      last_name: "Surname",
      phone: "Mobile",
      notes: "Comment",
    });
  });

  it("uses a header once and takes the first that matches", () => {
    expect(suggestMapping(["WhatsApp", "Phone", "Something else"])).toEqual({ phone: "WhatsApp" });
    expect(suggestMapping([])).toEqual({});
  });
});

describe("parseContactFilter", () => {
  it("parseContactFilter refuses a search term and a list in a smart list, and never_ordered with min_spent", () => {
    expect(parseContactFilter({ q: "ada" }, { forSmartList: true })).toMatchObject({ ok: false });
    expect(parseContactFilter({ list_id: LIST }, { forSmartList: true })).toMatchObject({ ok: false });
    expect(parseContactFilter({ q: "ada", list_id: LIST }, { forSmartList: false })).toEqual({ ok: true, filter: { q: "ada", list_id: LIST } });
    const clash = parseContactFilter({ never_ordered: true, min_spent_ngn: 5000 }, { forSmartList: false });
    expect(clash).toEqual({ ok: false, error: "Those filters can't be used together." });
    expect(parseContactFilter({ never_ordered: true, ordered_within_days: 30 }, { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter({ never_ordered: true, min_orders: 1 }, { forSmartList: false }).ok).toBe(false);
    // min_spent 0 with never_ordered is allowed (it asks for nothing).
    expect(parseContactFilter({ never_ordered: true, min_spent_ngn: 0 }, { forSmartList: false }).ok).toBe(true);
    expect(parseContactFilter({}, { forSmartList: true }).ok).toBe(false);
  });

  it("drops empty parts and refuses unknown keys and wrong shapes", () => {
    expect(parseContactFilter({ q: "  ", channels: [], label_ids: [], never_ordered: false }, { forSmartList: false })).toEqual({ ok: true, filter: {} });
    expect(parseContactFilter(null, { forSmartList: false })).toEqual({ ok: true, filter: {} });
    expect(parseContactFilter({ nonsense: 1 }, { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter({ channels: ["telegram"] }, { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter({ ordered_within_days: 0 }, { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter({ ordered_within_days: 3651 }, { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter({ min_spent_ngn: -1 }, { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter({ min_orders: 1.5 }, { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter({ label_ids: ["not-a-uuid"] }, { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter({ consent: "maybe" }, { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter({ q: "a" }, { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter("x", { forSmartList: false }).ok).toBe(false);
    expect(parseContactFilter({ has_phone: false, sources: ["import", "online"] }, { forSmartList: true })).toEqual({
      ok: true,
      filter: { has_phone: false, sources: ["import", "online"] },
    });
  });
});

describe("describeContactFilter", () => {
  it("describeContactFilter writes each filter as a plain line", () => {
    expect(
      describeContactFilter({ ordered_within_days: 60, min_spent_ngn: 20000, has_phone: true }, {}),
    ).toEqual(["Has a phone number", "Ordered in the last 60 days", "Spent at least ₦20,000"]);
    expect(
      describeContactFilter(
        {
          q: "ada",
          channels: ["whatsapp", "instagram", "phone"],
          has_email: true,
          has_address: false,
          never_ordered: true,
          min_orders: 3,
          last_contact_within_days: 30,
          label_ids: [LABEL, LIST],
          sources: ["walkup_anonymous", "import"],
          consent: "stopped",
          list_id: LIST,
        },
        { [LABEL]: "Bulk buyer" },
      ),
    ).toEqual([
      "Search: “ada”",
      "Reaches us by WhatsApp, Instagram or Phone call",
      "Has an email",
      "No address",
      "Never ordered",
      "At least 3 orders",
      "In contact in the last 30 days",
      "Label: Bulk buyer or a deleted label",
      "Came from: In the shop or Imported",
      "Promotions on WhatsApp: Asked us to stop",
      "On a chosen list",
    ]);
    expect(describeContactFilter({}, {})).toEqual([]);
  });

  it("groupThousands writes the commas itself", () => {
    expect(groupThousands(0)).toBe("0");
    expect(groupThousands(999)).toBe("999");
    expect(groupThousands(1000)).toBe("1,000");
    expect(groupThousands(1234567)).toBe("1,234,567");
  });
});

describe("firstName", () => {
  it("firstName: “ada obi” → Ada; “@ada_juice”, “0803…” and empty → null; “mrs. chi-chi” → Mrs", () => {
    expect(firstName("ada obi")).toBe("Ada");
    expect(firstName("@ada_juice")).toBeNull();
    expect(firstName("08030000001")).toBeNull();
    expect(firstName("")).toBeNull();
    expect(firstName("   ")).toBeNull();
    expect(firstName(null)).toBeNull();
    expect(firstName("mrs. chi-chi")).toBe("Mrs");
    expect(firstName("  chi-chi okafor")).toBe("Chi-chi");
    expect(firstName("O'Neil")).toBe("O'Neil");
    expect(firstName("Émile")).toBe("Émile");
  });
});

describe("phones, emails and cells", () => {
  it("contactPhoneDigits gives one value for 0803…, 803… and +234803…", () => {
    expect(contactPhoneDigits("0803 000 0001")).toBe("8030000001");
    expect(contactPhoneDigits("8030000001")).toBe("8030000001");
    expect(contactPhoneDigits("+234 803 000 0001")).toBe("8030000001");
    expect(contactPhoneDigits(null)).toBe("");
  });

  it("normaliseContactEmail trims and lower-cases, null for blank, undefined for a bad one", () => {
    expect(normaliseContactEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    expect(normaliseContactEmail("")).toBeNull();
    expect(normaliseContactEmail(null)).toBeNull();
    expect(normaliseContactEmail("ada@example")).toBeUndefined();
    expect(normaliseContactEmail("ada example.com")).toBeUndefined();
  });

  it("csvSafeCell puts an apostrophe before = + - and @", () => {
    expect(csvSafeCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvSafeCell("+2348030000001")).toBe("'+2348030000001");
    expect(csvSafeCell("-1")).toBe("'-1");
    expect(csvSafeCell("@ada")).toBe("'@ada");
    expect(csvSafeCell("Ada = Obi")).toBe("Ada = Obi");
    expect(csvSafeCell(12)).toBe("12");
    expect(csvSafeCell(null)).toBe("");
  });

  it("readContactSettings falls back to the defaults", () => {
    expect(readContactSettings(null)).toEqual(DEFAULT_CONTACT_SETTINGS);
    expect(readContactSettings({ stop_confirmation: false, stop_text: "  ", start_text: "Hello again" })).toEqual({
      stop_confirmation: false,
      stop_text: DEFAULT_CONTACT_SETTINGS.stop_text,
      start_text: "Hello again",
    });
    expect(DEFAULT_CONTACT_SETTINGS.stop_confirmation).toBe(true);
  });
});

describe("import rows", () => {
  it("buildImportRow joins first and last name, normalises the phone and flags bad cells", () => {
    const row = buildImportRow(
      { First: " Ada ", Last: "Obi", Tel: "0803 000 0001", Mail: "ADA@EXAMPLE.COM", Where: "1 Test Road", Extra: "x" },
      { first_name: "First", last_name: "Last", phone: "Tel", email: "Mail", address: "Where" },
    );
    expect(row).toMatchObject({ name: "Ada Obi", phone_e164: "+2348030000001", email: "ada@example.com", address: "1 Test Road", notes: null, bad_phone: false, bad_email: false });
    const bad = buildImportRow({ Name: "Bola", Tel: "12", Mail: "nope" }, { name: "Name", phone: "Tel", email: "Mail" });
    expect(bad).toMatchObject({ name: "Bola", phone_e164: null, email: null, bad_phone: true, bad_email: true, phone_cell: "12", email_cell: "nope" });
    expect(buildImportRow({ Name: "x".repeat(200) }, { name: "Name" }).name).toHaveLength(120);
    expect(buildImportRow({}, {})).toMatchObject({ name: null, phone_e164: null, email: null });
  });

  it("importReasonText has the spec's wording for each code", () => {
    expect(importReasonText(importReason("no_contact"))).toBe("No phone number or email");
    expect(importReasonText(importReason("bad_phone", "12"))).toBe("The phone number doesn't look right: “12”");
    expect(importReasonText(importReason("bad_email", "nope"))).toBe("The email doesn't look right: “nope”");
    expect(importReasonText(importReason("duplicate_phone", 4))).toBe("Same phone number as row 4");
    expect(importReasonText(importReason("duplicate_email", 2))).toBe("Same email as row 2");
    expect(importReasonText(importReason("matched"))).toBe("Already a contact");
    expect(importReasonText(importReason("same_email", "Ada Obi"))).toBe("Same email as Ada Obi, different phone number: check for a duplicate");
    expect(importReasonText(importReason("stopped"))).toBe("Asked us to stop promotions: consent will not be recorded");
    expect(importReasonText(`${importReason("matched")}\n${importReason("stopped")}`)).toBe(
      "Already a contact. Asked us to stop promotions: consent will not be recorded",
    );
    expect(importReasonCode("bad_phone:12\nstopped")).toBe("bad_phone");
    expect(importReasonText(null)).toBe("");
    // A cell with a line break cannot break the stored form.
    expect(importReason("bad_phone", "12\n34")).toBe("bad_phone:12 34");
  });
});

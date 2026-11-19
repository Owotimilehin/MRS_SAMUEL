import { describe, expect, it } from "vitest";
import type { ConsentMethod, ContactFilter } from "@ms/shared";
import {
  EMPTY_FILTERS,
  addContactProblem,
  addToListBody,
  addressTag,
  consentHow,
  consentLine,
  consentTitle,
  countLine,
  editContactPatch,
  editContactProblem,
  editLine,
  fileProblem,
  fromContactFilter,
  importConfirmText,
  importProgressText,
  lagosDate,
  lagosToday,
  mappingProblem,
  naira,
  needsAskedAgain,
  ordersCell,
  plainDate,
  rejectionReasonText,
  selectionCount,
  selectionLine,
  smartListProblem,
  sourceStepProblem,
  toContactFilter,
  whatsappPromotions,
  type FilterState,
} from "./contacts-logic.js";

const AT = "2026-11-12T09:30:00.000Z";

describe("consent wording", () => {
  it("consent line wording for each method", () => {
    const line = (method: ConsentMethod, state: "granted" | "withdrawn", by: string | null = null) =>
      consentLine({ state, method, recorded_at: AT, recorded_by_name: by });
    expect(line("staff", "granted", "Ada")).toBe("Agreed on 12 Nov 2026 (recorded by Ada)");
    expect(line("staff", "withdrawn", null)).toBe("Asked us to stop on 12 Nov 2026 (recorded by staff)");
    expect(line("import", "granted")).toBe("Agreed on 12 Nov 2026 (from an import)");
    expect(line("keyword", "withdrawn")).toBe("Asked us to stop on 12 Nov 2026 (they replied STOP)");
    expect(line("keyword", "granted")).toBe("Agreed on 12 Nov 2026 (they replied START)");
    expect(line("whatsapp_setting", "withdrawn")).toBe("Asked us to stop on 12 Nov 2026 (they changed it in WhatsApp)");
    expect(line("meta_refusal", "withdrawn")).toBe("Asked us to stop on 12 Nov 2026 (WhatsApp told us)");
    expect(line("erase_request", "withdrawn")).toBe("Asked us to stop on 12 Nov 2026 (they asked us to delete their history)");
    expect(line("carried_over", "withdrawn")).toBe("Asked us to stop on 12 Nov 2026 (from an earlier record of the same number)");
    expect(line("merge", "withdrawn")).toBe("Asked us to stop on 12 Nov 2026 (from a merged contact)");
    expect(consentLine(null)).toBe("Not asked yet");
    expect(consentLine(undefined)).toBe("Not asked yet");
    expect(consentHow("keyword", "withdrawn", "ignored")).toBe("they replied STOP");
  });

  it("names each channel and purpose, and finds the WhatsApp promotions row", () => {
    expect(consentTitle("whatsapp", "marketing")).toBe("WhatsApp promotions");
    expect(consentTitle("sms", "service")).toBe("SMS order and service messages");
    expect(consentTitle("phone", "marketing")).toBe("Phone calls promotions");
    const rows = [
      { channel: "email", purpose: "marketing", state: "granted" },
      { channel: "whatsapp", purpose: "service", state: "granted" },
      { channel: "whatsapp", purpose: "marketing", state: "withdrawn" },
    ];
    expect(whatsappPromotions(rows)).toBe(rows[2]);
    expect(whatsappPromotions(rows.slice(0, 2))).toBeNull();
  });

  it("asks for the tick only when a stop is being turned back into a yes", () => {
    expect(needsAskedAgain({ state: "withdrawn" }, "granted")).toBe(true);
    expect(needsAskedAgain({ state: "withdrawn" }, "withdrawn")).toBe(false);
    expect(needsAskedAgain({ state: "granted" }, "granted")).toBe(false);
    expect(needsAskedAgain(null, "granted")).toBe(false);
  });
});

describe("a contact row", () => {
  it("address tag wording", () => {
    expect(addressTag("saved")).toBe("Saved address");
    expect(addressTag("last_delivery")).toBe("From their last delivery");
    expect(addressTag(null)).toBe("");
    expect(addressTag(undefined)).toBe("");
  });

  it("writes dates in Lagos time and money in naira without the browser's help", () => {
    // 23:30 UTC on the 18th is 00:30 on the 19th in Lagos.
    expect(lagosDate("2026-11-18T23:30:00.000Z")).toBe("19 Nov 2026");
    expect(lagosDate("2026-01-01T00:00:00.000Z")).toBe("1 Jan 2026");
    expect(lagosDate(null)).toBe("—");
    expect(lagosDate("not a date")).toBe("—");
    expect(plainDate("2026-11-01")).toBe("1 Nov 2026");
    expect(plainDate("")).toBe("—");
    expect(lagosToday(new Date("2026-11-18T23:30:00.000Z"))).toBe("2026-11-19");
    expect(naira(20000)).toBe("₦20,000");
    expect(naira(0)).toBe("₦0");
    expect(naira(null)).toBe("₦0");
    expect(ordersCell(3, 20000)).toBe("3 · ₦20,000");
    expect(ordersCell(0, 0)).toBe("—");
  });

  it("counts contacts in plain words", () => {
    expect(countLine(128, false)).toBe("128 contacts");
    expect(countLine(1, false)).toBe("1 contact");
    expect(countLine(12, true)).toBe("12 contacts match");
    expect(countLine(1, true)).toBe("1 contact matches");
    expect(countLine(1204, true)).toBe("1,204 contacts match");
    expect(countLine(null, true)).toBe("");
  });

  it("says who changed what", () => {
    expect(editLine({ by_name: "Ada", action: "contacts.update", changed: ["email", "address"] })).toBe("Ada changed the email and address");
    expect(editLine({ by_name: "Ada", action: "contacts.update", changed: ["name", "email", "notes"] })).toBe("Ada changed the name, email and notes");
    expect(editLine({ by_name: null, action: "inbox.contact_update", changed: ["name"] })).toBe("Someone changed the name");
    expect(editLine({ by_name: "Ada", action: "contacts.create", changed: [] })).toBe("Ada added this contact");
    expect(editLine({ by_name: "Ada", action: "contacts.import_fill", changed: ["email"] })).toBe("An import by Ada filled in the email");
    expect(editLine({ by_name: "Ada", action: "inbox.contact_erase", changed: [] })).toBe("Ada erased their conversation history");
  });
});

describe("filters", () => {
  const LABEL = "11111111-1111-4111-8111-111111111111";
  const LIST = "22222222-2222-4222-8222-222222222222";

  it("filter chips to ContactFilter and back", () => {
    const state: FilterState = {
      q: "  ada ",
      channels: ["whatsapp", "phone"],
      hasPhone: true,
      hasEmail: false,
      hasAddress: true,
      orderedWithin: "60",
      neverOrdered: false,
      minSpent: "20,000",
      labelIds: [LABEL],
      sources: ["online", "import"],
      consent: "agreed",
      listId: LIST,
    };
    const filter: ContactFilter = {
      q: "ada",
      channels: ["whatsapp", "phone"],
      has_phone: true,
      has_address: true,
      ordered_within_days: 60,
      min_spent_ngn: 20000,
      label_ids: [LABEL],
      sources: ["online", "import"],
      consent: "agreed",
      list_id: LIST,
    };
    expect(toContactFilter(state)).toEqual(filter);
    expect(toContactFilter(fromContactFilter(filter))).toEqual(filter);
    expect(fromContactFilter(filter)).toMatchObject({ q: "ada", hasPhone: true, hasEmail: false, orderedWithin: "60", minSpent: "20000", consent: "agreed" });
    // Nothing set sends nothing.
    expect(toContactFilter(EMPTY_FILTERS)).toEqual({});
    expect(fromContactFilter({})).toEqual(EMPTY_FILTERS);
  });

  it("leaves out a one-letter search, bad numbers, and filters that cannot go with Never ordered", () => {
    expect(toContactFilter({ ...EMPTY_FILTERS, q: "a" })).toEqual({});
    expect(toContactFilter({ ...EMPTY_FILTERS, orderedWithin: "0" })).toEqual({});
    expect(toContactFilter({ ...EMPTY_FILTERS, orderedWithin: "abc", minSpent: "-5" })).toEqual({});
    expect(toContactFilter({ ...EMPTY_FILTERS, neverOrdered: true, orderedWithin: "30", minSpent: "5000" })).toEqual({ never_ordered: true });
    expect(toContactFilter({ ...EMPTY_FILTERS, minSpent: "₦ 50 000" })).toEqual({ min_spent_ngn: 50000 });
  });

  it("says why a set of chips cannot be a list that keeps itself up to date", () => {
    expect(smartListProblem({ ...EMPTY_FILTERS, hasPhone: true })).toBeNull();
    expect(smartListProblem({ ...EMPTY_FILTERS, q: "ada", hasPhone: true })).toBe(
      "Clear the search box first. A list that keeps itself up to date can only use filters.",
    );
    expect(smartListProblem({ ...EMPTY_FILTERS, listId: LIST })).toContain("can't be built from another list");
    expect(smartListProblem(EMPTY_FILTERS)).toBe("Choose at least one filter first.");
  });

  it("select-all sends the filter, not IDs", () => {
    const filter: ContactFilter = { never_ordered: true };
    const all = { mode: "all" as const, filter, total: 1204 };
    expect(addToListBody(all)).toEqual({ filter });
    expect(addToListBody(all)).not.toHaveProperty("customer_ids");
    expect(selectionCount(all)).toBe(1204);
    expect(selectionLine(all)).toBe("All 1,204 that match selected");
    const some = { mode: "ids" as const, ids: ["a", "b"] };
    expect(addToListBody(some)).toEqual({ customer_ids: ["a", "b"] });
    expect(selectionLine(some)).toBe("2 selected");
  });
});

describe("import", () => {
  it("import step is blocked until phone or email is mapped", () => {
    expect(mappingProblem({ name: "Name" })).toBe("Choose the column that holds the phone number or the email.");
    expect(mappingProblem({})).toBe("Choose the column that holds the phone number or the email.");
    expect(mappingProblem({ phone: "Tel" })).toBeNull();
    expect(mappingProblem({ email: "Mail", name: "Name" })).toBeNull();
    expect(mappingProblem({ phone: "Tel", notes: "Tel" })).toBe("The column “Tel” is chosen twice. Use each column once.");
  });

  it("rejection reason wording for each code", () => {
    expect(rejectionReasonText("no_contact")).toBe("No phone number or email");
    expect(rejectionReasonText("bad_phone")).toBe("The phone number doesn't look right");
    expect(rejectionReasonText("bad_email")).toBe("The email doesn't look right");
    expect(rejectionReasonText("duplicate_phone")).toBe("Same phone number as another row");
    expect(rejectionReasonText("duplicate_email")).toBe("Same email as another row");
  });

  it("checks the file before it is sent", () => {
    const csv = { name: "list.csv", size: 100 };
    expect(fileProblem({ name: "list.xlsx", size: 100 }, "a,b")).toBe("That file is not a CSV. In Excel or Google Sheets choose “Save as” or “Download” and pick CSV.");
    expect(fileProblem(csv, null)).toBe("We couldn't read this file. Save it again as “CSV UTF-8”.");
    expect(fileProblem(csv, "   ")).toBe("This file is empty.");
    expect(fileProblem(csv, "Name�,Phone")).toBe("We couldn't read this file. Save it again as “CSV UTF-8”.");
    expect(fileProblem({ name: "LIST.CSV", size: 100 }, "Name,Phone\nAda,0700")).toBeNull();
  });

  it("asks for the source, and for how, what and when once everyone is said to have agreed", () => {
    const base = { sourceLabel: "order book", consentYes: false, consentMethod: "", consentWording: "", consentDate: "", hasPhoneColumn: true };
    expect(sourceStepProblem(base)).toBeNull();
    expect(sourceStepProblem({ ...base, sourceLabel: " " })).toBe("Say where you got this list.");
    expect(sourceStepProblem({ ...base, consentYes: true })).toBe("Say how these people agreed.");
    expect(sourceStepProblem({ ...base, consentYes: true, consentMethod: "Paper form" })).toBe("Say what these people were told.");
    expect(sourceStepProblem({ ...base, consentYes: true, consentMethod: "Paper form", consentWording: "Offers" })).toBe("Say when these people agreed.");
    expect(sourceStepProblem({ ...base, consentYes: true, consentMethod: "Paper form", consentWording: "Offers", consentDate: "2026-11-01" })).toBeNull();
    expect(sourceStepProblem({ ...base, consentYes: true, hasPhoneColumn: false })).toContain("need a phone number column");
  });

  it("says what will happen before saving, and what happened after", () => {
    expect(importConfirmText(5, 3, false)).toBe("Import 8 contacts? 5 will be new. 3 are already contacts and will not be changed.");
    expect(importConfirmText(0, 1, true)).toBe("Import 1 contact? 0 will be new. 1 is already a contact and will not be changed, except for missing details.");
    const v = { applied: 40, total: 120, added: 5, already: 3 };
    expect(importProgressText({ ...v, status: "previewed" })).toBe("Nothing has been saved yet.");
    expect(importProgressText({ ...v, status: "applying" })).toBe("Saving… 40 of 120.");
    expect(importProgressText({ ...v, status: "applied" })).toBe("Done. 5 new contacts added, 3 already here.");
    expect(importProgressText({ ...v, status: "failed" })).toBe("The import stopped part-way: 40 of 120 rows were saved. Nothing was saved twice. Tell Tes.");
  });
});

describe("forms", () => {
  it("add contact: needs a phone or an email, and refuses what does not look right", () => {
    const base = { phone: "", email: "", sourceLabel: "order book", consentYes: false, consentWording: "" };
    expect(addContactProblem(base)).toBe("Add a phone number or an email.");
    expect(addContactProblem({ ...base, phone: "123" })).toBe("That phone number doesn't look right. Use a number like 0803 123 4567.");
    expect(addContactProblem({ ...base, email: "nope" })).toBe("That email doesn't look right.");
    expect(addContactProblem({ ...base, phone: "0700 555 0001", sourceLabel: "" })).toBe("Say where you got these details.");
    expect(addContactProblem({ ...base, email: "ada@example.test", consentYes: true, consentWording: "Yes" })).toBe("Add a phone number to record promotions on WhatsApp.");
    expect(addContactProblem({ ...base, phone: "0700 555 0001", consentYes: true })).toBe("Say what the customer agreed to.");
    expect(addContactProblem({ ...base, phone: "0700 555 0001" })).toBeNull();
  });

  it("edit contact: sends only what changed", () => {
    const before = { name: "Ada Obi", email: "ada@example.test", saved_address: null, notes: null };
    expect(editContactProblem({ name: " ", email: "" })).toBe("Enter a name.");
    expect(editContactProblem({ name: "Ada", email: "nope" })).toBe("That email doesn't look right.");
    expect(editContactProblem({ name: "Ada", email: "" })).toBeNull();
    expect(editContactPatch(before, { name: "Ada Obi", email: "ada@example.test", address: "", notes: "" })).toEqual({});
    expect(editContactPatch(before, { name: " Ada O. ", email: "", address: " 1 Test Road ", notes: "likes zobo" })).toEqual({
      name: "Ada O.",
      email: null,
      address: "1 Test Road",
      notes: "likes zobo",
    });
    expect(editContactPatch({ ...before, saved_address: "1 Test Road" }, { name: "Ada Obi", email: "ada@example.test", address: "", notes: "" })).toEqual({ address: null });
  });
});

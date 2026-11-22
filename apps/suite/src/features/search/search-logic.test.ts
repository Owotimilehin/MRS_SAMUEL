import { describe, expect, it } from "vitest";
import { contactPhoneDigits } from "@ms/shared";
import {
  MIN_CHARS,
  PER_GROUP,
  allowedKinds,
  buildGroups,
  chatItem,
  contactItem,
  flatItems,
  inboxQuery,
  looksLikePhone,
  moveIndex,
  optionId,
  postItem,
  postMatches,
  searchText,
  type ChatHit,
  type ContactHit,
  type PostHit,
} from "./search-logic.js";

const chat = (over: Partial<ChatHit> = {}): ChatHit => ({
  id: "c1",
  customer_name: "Tolu Adeyemi",
  customer_phone: "+2348031234567",
  identity_name: null,
  preview: "Is the mango juice in stock?",
  number_label: "Main line",
  ...over,
});
const contact = (over: Partial<ContactHit> = {}): ContactHit => ({
  id: "k1",
  name: "Tolu Adeyemi",
  phone: "+2348031234567",
  email: "tolu@example.com",
  handles: [],
  ...over,
});
const post = (over: Partial<PostHit> = {}): PostHit => ({
  id: "p1",
  caption: "Fresh mango juice this weekend",
  status: "draft",
  scheduled_at: null,
  updated_at: "2026-11-20T10:00:00.000Z",
  targets: [{ published_at: null, caption_override: null }],
  ...over,
});

describe("who sees which group", () => {
  it("follows the capabilities, in display order", () => {
    expect(allowedKinds(["social.publish", "inbox.view", "contacts.view"])).toEqual(["chats", "contacts", "posts"]);
    expect(allowedKinds(["contacts.view"])).toEqual(["contacts"]);
    expect(allowedKinds(["inbox.view", "social.comments"])).toEqual(["chats"]);
    expect(allowedKinds([])).toEqual([]);
  });

  it("buildGroups drops groups the person may not see, even when results came back", () => {
    const groups = buildGroups({ chats: [chat()], contacts: [contact()], posts: [post()] }, ["contacts"]);
    expect(groups.map((g) => g.kind)).toEqual(["contacts"]);
  });
});

describe("what is searched", () => {
  it("needs at least two characters, ignoring spaces", () => {
    expect(MIN_CHARS).toBe(2);
    expect(searchText("")).toBeNull();
    expect(searchText("  a  ")).toBeNull();
    expect(searchText(" to ")).toBe("to");
    expect(searchText("tolu   adeyemi")).toBe("tolu adeyemi");
  });

  it("knows a phone number when it sees one", () => {
    expect(looksLikePhone("0803 123 4567")).toBe(true);
    expect(looksLikePhone("+234 803-123-4567")).toBe(true);
    expect(looksLikePhone("(0803) 123")).toBe(true);
    expect(looksLikePhone("803")).toBe(false); // too short to be a phone search
    expect(looksLikePhone("Tolu 0803")).toBe(false);
    expect(looksLikePhone("mango")).toBe(false);
  });

  it("a phone typed as 0803…, +234803… or 234803… is the same chat search", () => {
    const forms = ["08031234567", "+2348031234567", "2348031234567", "0803 123 4567", "+234 803 123 4567"];
    const sent = forms.map(inboxQuery);
    expect(new Set(sent)).toEqual(new Set(["8031234567"]));
    // ...and it is found inside the number as stored (+234…), as the Inbox list matches digits.
    expect("2348031234567".includes(sent[0]!)).toBe(true);
    // The same digits the Contacts search uses (contactPhoneDigits), so both groups agree.
    for (const f of forms) expect(inboxQuery(f)).toBe(contactPhoneDigits(f));
  });

  it("a partial phone still matches the same way", () => {
    expect(inboxQuery("0803123")).toBe("803123");
    expect(inboxQuery("+234803123")).toBe("803123");
    expect(inboxQuery("234803123")).toBe("803123");
  });

  it("names and words go as typed", () => {
    expect(inboxQuery("Tolu")).toBe("Tolu");
    expect(inboxQuery("@tolu_a")).toBe("@tolu_a");
  });
});

describe("how rows read", () => {
  it("a chat shows the customer, their phone and the last message", () => {
    expect(chatItem(chat())).toEqual({
      kind: "chats",
      id: "c1",
      title: "Tolu Adeyemi",
      detail: "+2348031234567 · Is the mango juice in stock?",
      href: "/inbox/c1",
    });
  });

  it("a chat with no name falls back to the Meta name, then the phone", () => {
    expect(chatItem(chat({ customer_name: null, identity_name: "@tolu" })).title).toBe("@tolu");
    const byPhone = chatItem(chat({ customer_name: null, identity_name: null, preview: null }));
    expect(byPhone.title).toBe("+2348031234567");
    expect(byPhone.detail).toBe("Main line"); // the phone is not repeated
    expect(chatItem(chat({ customer_name: " ", customer_phone: null, preview: null, number_label: null })).title).toBe("Unknown customer");
  });

  it("a contact shows name, then phone and email", () => {
    expect(contactItem(contact())).toMatchObject({ title: "Tolu Adeyemi", detail: "+2348031234567 · tolu@example.com", href: "/contacts/k1" });
    expect(contactItem(contact({ name: null, email: null }))).toMatchObject({ title: "+2348031234567", detail: "" });
    expect(contactItem(contact({ name: null, phone: null, email: null, handles: ["@tolu"] })).title).toBe("@tolu");
  });

  it("a post shows the start of its text and its status", () => {
    const row = postItem(post({ caption: "A".repeat(100) }));
    expect(row.title).toBe(`${"A".repeat(70)}…`);
    expect(row.detail.startsWith("Draft · Edited")).toBe(true);
    expect(row.href).toBe("/posts/p1");
    expect(postItem(post({ caption: "  " })).title).toBe("No text");
  });

  it("ids are escaped in links", () => {
    expect(chatItem(chat({ id: "a/b" })).href).toBe("/inbox/a%2Fb");
  });

  it("post text matches in the caption or a per-account text, any case", () => {
    expect(postMatches(post(), "MANGO")).toBe(true);
    expect(postMatches(post({ caption: "Pineapple", targets: [{ published_at: null, caption_override: "Mango for Facebook" }] }), "mango")).toBe(true);
    expect(postMatches(post({ caption: "Pineapple" }), "mango")).toBe(false);
  });
});

describe("grouping", () => {
  it("keeps the order chats, contacts, posts and at most five a group", () => {
    const many = Array.from({ length: 8 }, (_, i) => contact({ id: `k${i}` }));
    const groups = buildGroups({ posts: [post()], contacts: many, chats: [chat()] }, ["chats", "contacts", "posts"]);
    expect(groups.map((g) => g.label)).toEqual(["Chats", "Contacts", "Posts"]);
    expect(groups[1]!.items).toHaveLength(PER_GROUP);
  });

  it("leaves out empty groups and keeps a failed one so it can say so", () => {
    const groups = buildGroups({ chats: [], contacts: new Error("boom"), posts: [post()] }, ["chats", "contacts", "posts"]);
    expect(groups.map((g) => [g.kind, g.failed])).toEqual([
      ["contacts", true],
      ["posts", false],
    ]);
  });

  it("nothing found is no groups at all", () => {
    expect(buildGroups({ chats: [], contacts: [], posts: [] }, ["chats", "contacts", "posts"])).toEqual([]);
  });

  it("flatItems walks the rows top to bottom across groups", () => {
    const groups = buildGroups({ chats: [chat({ id: "c1" }), chat({ id: "c2" })], posts: [post({ id: "p1" })] }, ["chats", "posts"]);
    expect(flatItems(groups).map((i) => i.id)).toEqual(["c1", "c2", "p1"]);
  });

  it("option ids are unique across kinds", () => {
    expect(optionId({ kind: "chats", id: "x" })).not.toBe(optionId({ kind: "posts", id: "x" }));
  });
});

describe("keyboard highlight", () => {
  it("down from nothing goes to the first row, up from nothing to the last", () => {
    expect(moveIndex(-1, 1, 4)).toBe(0);
    expect(moveIndex(-1, -1, 4)).toBe(3);
  });

  it("moves one row and wraps round", () => {
    expect(moveIndex(0, 1, 4)).toBe(1);
    expect(moveIndex(3, 1, 4)).toBe(0);
    expect(moveIndex(0, -1, 4)).toBe(3);
  });

  it("no rows means nothing highlighted; a stale index is reset", () => {
    expect(moveIndex(2, 1, 0)).toBe(-1);
    expect(moveIndex(9, 1, 3)).toBe(0);
  });
});

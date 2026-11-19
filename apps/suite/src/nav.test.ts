import { describe, expect, it } from "vitest";
import { activeNavTo, firstAllowedPage } from "./nav.js";

const LINKS = ["/inbox", "/contacts", "/inbox/reports", "/channels", "/templates", "/inbox/settings"] as const;

describe("suite menu", () => {
  it("lights Inbox for the list and for an open conversation", () => {
    expect(activeNavTo("/inbox", LINKS)).toBe("/inbox");
    expect(activeNavTo("/inbox/7f3c-conversation", LINKS)).toBe("/inbox");
  });
  it("lights Reports and Settings on their own pages, not Inbox", () => {
    expect(activeNavTo("/inbox/reports", LINKS)).toBe("/inbox/reports");
    expect(activeNavTo("/inbox/settings", LINKS)).toBe("/inbox/settings");
  });
  it("lights nothing on a page outside the menu", () => {
    expect(activeNavTo("/login", LINKS)).toBeNull();
    expect(activeNavTo("/inboxes", LINKS)).toBeNull();
  });
});

describe("where a person lands", () => {
  it("goes to the first menu page they may see", () => {
    expect(firstAllowedPage(["inbox.view", "channels.manage"])).toBe("/inbox");
    expect(firstAllowedPage(["inbox.reports", "inbox.settings"])).toBe("/inbox/reports");
    expect(firstAllowedPage(["channels.manage", "inbox.settings"])).toBe("/channels");
    expect(firstAllowedPage(["orders.view"])).toBeNull();
  });
  it("lights Channels on its page", () => {
    expect(activeNavTo("/channels", LINKS)).toBe("/channels");
  });
  it("lights Templates and forms on its list and on a template's editor", () => {
    expect(activeNavTo("/templates", LINKS)).toBe("/templates");
    expect(activeNavTo("/templates/7f3c-template", LINKS)).toBe("/templates");
    expect(firstAllowedPage(["templates.manage", "inbox.settings"])).toBe("/templates");
    expect(firstAllowedPage(["templates.manage"])).toBe("/templates");
  });
  it("a person with only contacts.view lands on /contacts", () => {
    expect(firstAllowedPage(["contacts.view"])).toBe("/contacts");
    expect(firstAllowedPage(["contacts.view", "inbox.reports"])).toBe("/contacts");
    // With inbox access too, the inbox still comes first.
    expect(firstAllowedPage(["contacts.view", "inbox.view"])).toBe("/inbox");
  });
  it("lights Contacts on the list, a contact, the lists and the import page", () => {
    expect(activeNavTo("/contacts", LINKS)).toBe("/contacts");
    expect(activeNavTo("/contacts/7f3c-customer", LINKS)).toBe("/contacts");
    expect(activeNavTo("/contacts/lists", LINKS)).toBe("/contacts");
    expect(activeNavTo("/contacts/lists/7f3c-list", LINKS)).toBe("/contacts");
    expect(activeNavTo("/contacts/import", LINKS)).toBe("/contacts");
  });
});

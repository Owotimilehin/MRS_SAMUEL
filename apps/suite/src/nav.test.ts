import { describe, expect, it } from "vitest";
import { activeNavTo, firstAllowedPage } from "./nav.js";

const LINKS = ["/inbox", "/comments", "/inbox/reports", "/channels", "/templates", "/inbox/settings"] as const;

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
  it("keeps Templates and forms lit on the Forms tab", () => {
    expect(activeNavTo("/templates/forms", LINKS)).toBe("/templates");
  });
  it("lights Comments on its list and on an open thread, and someone with only Comments lands there", () => {
    expect(activeNavTo("/comments", LINKS)).toBe("/comments");
    expect(activeNavTo("/comments/7f3c-thread", LINKS)).toBe("/comments");
    expect(firstAllowedPage(["social.comments"])).toBe("/comments");
    expect(firstAllowedPage(["social.comments", "inbox.view"])).toBe("/inbox");
    expect(firstAllowedPage(["social.comments", "inbox.reports"])).toBe("/comments");
  });
});

describe("the Catalogue page (suite spec 08)", () => {
  const WITH_CATALOGUE = ["/inbox", "/catalogue", "/inbox/reports", "/channels", "/inbox/settings"] as const;
  it("lights Catalogue on its page", () => {
    expect(activeNavTo("/catalogue", WITH_CATALOGUE)).toBe("/catalogue");
  });
  it("is where someone with only the catalogue permission lands", () => {
    expect(firstAllowedPage(["catalogue.manage"])).toBe("/catalogue");
    expect(firstAllowedPage(["catalogue.manage", "inbox.reports"])).toBe("/catalogue");
    expect(firstAllowedPage(["inbox.view", "catalogue.manage"])).toBe("/inbox");
  });
});

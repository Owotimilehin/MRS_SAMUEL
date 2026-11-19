import { describe, expect, it } from "vitest";
import { activeNavTo, firstAllowedPage } from "./nav.js";

const LINKS = ["/inbox", "/inbox/reports", "/channels", "/inbox/settings"] as const;

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
});

describe("Insights in the menu (suite spec 11)", () => {
  const WITH_INSIGHTS = ["/inbox", "/insights", "/inbox/reports", "/channels", "/inbox/settings"] as const;
  it("lights Insights on its page and leaves the others alone", () => {
    expect(activeNavTo("/insights", WITH_INSIGHTS)).toBe("/insights");
    expect(activeNavTo("/inbox/reports", WITH_INSIGHTS)).toBe("/inbox/reports");
    expect(activeNavTo("/inbox", WITH_INSIGHTS)).toBe("/inbox");
  });
  it("is where someone with only insights.view lands, and sits above Reports", () => {
    expect(firstAllowedPage(["insights.view"])).toBe("/insights");
    expect(firstAllowedPage(["inbox.reports", "insights.view"])).toBe("/insights");
    expect(firstAllowedPage(["inbox.view", "insights.view"])).toBe("/inbox");
    expect(firstAllowedPage(["inbox.reports"])).toBe("/inbox/reports");
  });
});

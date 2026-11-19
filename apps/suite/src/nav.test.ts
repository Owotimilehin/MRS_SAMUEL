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

describe("the Ads page (suite spec 12)", () => {
  const WITH_ADS = ["/inbox", "/catalogue", "/ads", "/inbox/reports", "/channels", "/inbox/settings"] as const;
  it("lights Ads on its page, on one advert and on the new-advert form", () => {
    expect(activeNavTo("/ads", WITH_ADS)).toBe("/ads");
    expect(activeNavTo("/ads/adverts/120000000000001", WITH_ADS)).toBe("/ads");
    expect(activeNavTo("/ads/new", WITH_ADS)).toBe("/ads");
  });
  it("is where someone with only the see-ad-results permission lands", () => {
    expect(firstAllowedPage(["ads.view"])).toBe("/ads");
    expect(firstAllowedPage(["ads.view", "inbox.reports"])).toBe("/ads");
    expect(firstAllowedPage(["catalogue.manage", "ads.view"])).toBe("/catalogue");
    // The manage permission alone opens no page: reading results needs ads.view.
    expect(firstAllowedPage(["ads.manage"])).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { activeNavTo, firstAllowedPage } from "./nav.js";

const LINKS = ["/inbox", "/comments", "/contacts", "/leads", "/inbox/reports", "/channels", "/templates", "/inbox/settings"] as const;

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
  it("lights Leads on the list and on an open lead, and someone with only leads.view lands there", () => {
    expect(activeNavTo("/leads", LINKS)).toBe("/leads");
    expect(activeNavTo("/leads/5d0c-lead", LINKS)).toBe("/leads");
    expect(firstAllowedPage(["leads.view"])).toBe("/leads");
    expect(firstAllowedPage(["leads.view", "inbox.reports"])).toBe("/leads");
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

describe("posts in the menu (suite spec 09)", () => {
  const WITH_POSTS = ["/inbox", "/posts", "/inbox/reports", "/channels", "/inbox/settings"] as const;
  it("lights Posts for the list, a new post and an open post", () => {
    expect(activeNavTo("/posts", WITH_POSTS)).toBe("/posts");
    expect(activeNavTo("/posts/new", WITH_POSTS)).toBe("/posts");
    expect(activeNavTo("/posts/7f3c-post/edit", WITH_POSTS)).toBe("/posts");
  });
  it("someone who may only publish posts lands on Posts", () => {
    expect(firstAllowedPage(["social.publish"])).toBe("/posts");
    expect(firstAllowedPage(["inbox.view", "social.publish"])).toBe("/inbox");
    expect(firstAllowedPage(["social.publish", "inbox.reports"])).toBe("/posts");
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

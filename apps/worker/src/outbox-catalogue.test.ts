import { describe, it, expect } from "vitest";
import { format } from "./outbox.js";
import { storefrontBase } from "./jobs/catalogue.js";

// Ruling 9.2.10: the catalogue alert has its own wording, never raw text.
describe("owner alert for the catalogue (suite spec 08)", () => {
  it("gives Meta's code and reason and links to the Catalogue page", () => {
    const m = format({
      eventType: "catalogue.sync_blocked",
      payload: { account: "123456789012345", code: "200", message: "(#200) Permissions error" },
    });
    expect(m.text).toContain("*Catalogue sync stopped*");
    expect(m.text).toContain("Meta refused our access (200): (#200) Permissions error");
    expect(m.text).toContain("/catalogue");
    expect(m.text).not.toContain("catalogue.sync_blocked");
  });
});

describe("storefront address for catalogue links", () => {
  it("uses PUBLIC_CUSTOMER_URL, else the admin address with www, without a trailing slash", () => {
    expect(storefrontBase({ PUBLIC_CUSTOMER_URL: "https://shop.example.com/" })).toBe("https://shop.example.com");
    expect(storefrontBase({ PUBLIC_ADMIN_URL: "https://admin.example.com" })).toBe("https://www.example.com");
    expect(storefrontBase({})).toBe("https://www.mrssamuel.com");
  });
});

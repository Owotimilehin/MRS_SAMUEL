import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { contactFilterSql, listMembersSql } from "./filter.js";
import { uuidArray } from "./summary.js";

/**
 * The pure parts of the contacts domain. The database tests the spec lists for
 * this file (matching, consent, the summary, each filter) need a real Postgres
 * and live in apps/api/test/integration/contacts-domain.test.ts.
 */

const dialect = new PgDialect();
const NOW = new Date("2026-11-19T12:00:00Z");
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

describe("uuidArray", () => {
  it("sends the ids as one parameter and leaves out anything that is not a uuid", () => {
    const q = dialect.sqlToQuery(uuidArray([ID_A, "x'); drop --", ID_B, ID_A]));
    expect(q.sql).toBe("$1::uuid[]");
    expect(q.params).toEqual([`{${ID_A},${ID_B}}`]);
    expect(dialect.sqlToQuery(uuidArray([])).params).toEqual(["{}"]);
  });
});

describe("contactFilterSql", () => {
  it("is `true` for an empty filter", () => {
    expect(dialect.sqlToQuery(contactFilterSql({}, NOW)).sql).toBe("true");
  });

  it("never puts a person's text into the SQL itself: every value is a parameter", () => {
    const typed = "o'brien%_\\";
    const q = dialect.sqlToQuery(
      contactFilterSql({ q: typed, channels: ["whatsapp"], sources: ["online", "import"], label_ids: [ID_A], list_id: ID_B, min_spent_ngn: 5000 }, NOW),
    );
    expect(q.sql).not.toContain("brien");
    expect(q.sql).not.toContain(ID_A);
    // The wildcard characters a person typed are escaped, so they match only themselves.
    expect(q.params).toContain("%o'brien\\%\\_\\\\%");
    expect(q.params).toContain(5000);
  });

  it("searches the phone digits only from four digits up, without a leading 234 or 0", () => {
    const long = dialect.sqlToQuery(contactFilterSql({ q: "+234 700 555 0101" }, NOW));
    expect(long.sql).toContain("s.phone_digits LIKE");
    expect(long.params).toContain("%7005550101%");
    const short = dialect.sqlToQuery(contactFilterSql({ q: "ada 12" }, NOW));
    expect(short.sql).not.toContain("s.phone_digits LIKE");
    expect(dialect.sqlToQuery(contactFilterSql({ q: "@Ada_Juice" }, NOW)).params).toContain("%ada\\_juice%");
  });

  it("counts days back from the `now` it is given, not from the clock", () => {
    const q = dialect.sqlToQuery(contactFilterSql({ ordered_within_days: 60, last_contact_within_days: 1 }, NOW));
    expect(q.params).toEqual(["2026-09-20T12:00:00.000Z", "2026-11-18T12:00:00.000Z"]);
  });
});

describe("listMembersSql", () => {
  it("a static list reads its member rows; a smart list reads its filter and no member rows", () => {
    const fixed = dialect.sqlToQuery(listMembersSql({ id: ID_A, kind: "static", filter: null }, NOW));
    expect(fixed.sql).toContain("contact_list_member");
    expect(fixed.sql).toContain("contact_summary"); // only members who are still contacts
    const smart = dialect.sqlToQuery(listMembersSql({ id: ID_A, kind: "smart", filter: { never_ordered: true } }, NOW));
    expect(smart.sql).not.toContain("contact_list_member");
    expect(smart.sql).toContain("s.orders_count = 0");
  });
});

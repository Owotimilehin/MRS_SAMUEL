import { describe, it, expect } from "vitest";
import * as schema from "../src/schema/index";

describe("schema exports", () => {
  it("exports adminUser and session tables", () => {
    expect(schema.adminUser).toBeDefined();
    expect(schema.session).toBeDefined();
  });

  it("exports idempotencyKey and auditLog tables", () => {
    expect(schema.idempotencyKey).toBeDefined();
    expect(schema.auditLog).toBeDefined();
  });
});

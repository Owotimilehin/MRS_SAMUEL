import { describe, it, expect } from "vitest";
import * as schema from "../src/schema/index";
import { packagingMaterialKind } from "../src/schema/packaging-material";

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

describe("packaging material kind", () => {
  it("includes straw as a kind", () => {
    expect(packagingMaterialKind.enumValues).toContain("straw");
  });
});

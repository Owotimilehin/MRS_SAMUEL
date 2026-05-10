import { describe, it, expect } from "vitest";
import * as schema from "../src/schema/index.js";

describe("schema exports", () => {
  it("exports adminUser and session tables", () => {
    expect(schema.adminUser).toBeDefined();
    expect(schema.session).toBeDefined();
  });
});

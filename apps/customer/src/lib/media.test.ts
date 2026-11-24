import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEBP_TWINS, webpSrc } from "./media";

const MEDIA = join(__dirname, "../../public/media");
const files = (ext: string) =>
  ["bottles", "decor"].flatMap((dir) =>
    readdirSync(join(MEDIA, dir))
      .filter((f) => f.endsWith(ext))
      .map((f) => `${dir}/${f.slice(0, -ext.length)}`),
  );

describe("webp twins", () => {
  it("lists exactly the .webp files in public/media", () => {
    expect([...WEBP_TWINS].sort()).toEqual(files(".webp").sort());
  });

  it("keeps the original PNG for every twin (database, admin and Meta use it)", () => {
    for (const name of WEBP_TWINS) expect(existsSync(join(MEDIA, `${name}.png`)), name).toBe(true);
  });
});

describe("webpSrc", () => {
  it("swaps a known /media PNG for its WebP twin", () => {
    expect(webpSrc("/media/bottles/bottle-green.png")).toBe("/media/bottles/bottle-green.webp");
    expect(webpSrc("https://mrssamuel.com/media/decor/cluster-root.png")).toBe(
      "/media/decor/cluster-root.webp",
    );
  });

  it("leaves anything else alone", () => {
    expect(webpSrc("/media/bottles/new-upload.png")).toBe("/media/bottles/new-upload.png");
    expect(webpSrc("https://cdn/bottle.png")).toBe("https://cdn/bottle.png");
    expect(webpSrc("/assets/bottle-sunrise-abc.webp")).toBe("/assets/bottle-sunrise-abc.webp");
  });
});

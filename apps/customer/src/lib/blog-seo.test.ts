import { describe, expect, it } from "vitest";
import { extractFaqs, pickRelatedProducts } from "./blog-seo";

describe("extractFaqs", () => {
  it("reads each ### question and its answer until the next ## heading", () => {
    const md = [
      "Intro paragraph.",
      "",
      "## Frequently asked questions",
      "",
      "### Is it good for a cold?",
      "",
      "It **may help** ease symptoms. See [our juice](/juices/ginger-spark).",
      "",
      "Talk to your doctor.",
      "",
      "### When should I drink it?",
      "",
      "- In the morning",
      "",
      "## Sources",
      "",
      "### Not a question",
      "Ignored.",
    ].join("\n");
    expect(extractFaqs(md)).toEqual([
      {
        q: "Is it good for a cold?",
        a: "It may help ease symptoms. See our juice. Talk to your doctor.",
      },
      { q: "When should I drink it?", a: "In the morning" },
    ]);
  });

  it("returns [] without an FAQ section", () => {
    expect(extractFaqs("## Benefits\n\n### One\n\nText")).toEqual([]);
  });

  it("skips questions with no answer", () => {
    expect(extractFaqs("## FAQ\n\n### Empty?\n\n### Real?\n\nYes.")).toEqual([
      { q: "Real?", a: "Yes." },
    ]);
  });
});

describe("pickRelatedProducts", () => {
  const products = [
    { id: "orange", name: "Orange", ingredients: ["Orange"] },
    { id: "pure-green", name: "Pure Green", ingredients: ["Cucumber", "Celery", "Apple"] },
    { id: "ginger-spark", name: "Ginger Spark", ingredients: ["Pineapple", "Ginger", "Lemon"] },
    { id: "pineapple", name: "Pineapple", ingredients: ["Pineapple"] },
  ];

  it("ranks products whose name and ingredients appear in the post", () => {
    const got = pickRelatedProducts("Pineapple and ginger juice benefits", products, 2).map(
      (p) => p.id,
    );
    expect(got).toEqual(["ginger-spark", "pineapple"]);
  });

  it("fills with the incoming order when nothing matches", () => {
    expect(pickRelatedProducts("Kunu aya", products, 2).map((p) => p.id)).toEqual([
      "orange",
      "pure-green",
    ]);
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { StatHero } from "./StatHero.js";

describe("StatHero", () => {
  it("renders eyebrow, title, sub", () => {
    render(<StatHero eyebrow="Stock" title="Inventory" sub="On-hand stock." />);
    expect(screen.getByText("Stock")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inventory" })).toBeInTheDocument();
    expect(screen.getByText("On-hand stock.")).toBeInTheDocument();
  });

  it("renders one chip per chip prop with label + value, applies tone class", () => {
    render(
      <StatHero
        eyebrow="Stock"
        title="Inventory"
        sub="x"
        chips={[
          { label: "Cans on hand", value: 120 },
          { label: "Low-stock SKUs", value: 3, tone: "danger" },
        ]}
      />,
    );
    expect(screen.getByText("Cans on hand")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    const lowChip = screen.getByText("Low-stock SKUs").closest(".hero-chip");
    expect(lowChip).toHaveClass("hero-chip--danger");
  });

  it("renders shimmer placeholders when loading", () => {
    const { container } = render(
      <StatHero eyebrow="x" title="y" sub="z" loading chips={[{ label: "A", value: 0 }]} />,
    );
    expect(container.querySelectorAll(".hero-chip.is-loading").length).toBe(1);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

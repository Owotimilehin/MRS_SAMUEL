// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { RouteErrorComponent } from "./RouteErrorComponent.js";

describe("RouteErrorComponent", () => {
  it("shows a friendly message and a working retry button", () => {
    const reset = vi.fn();
    render(<RouteErrorComponent error={new Error("boom")} reset={reset} />);
    expect(screen.getByText(/couldn't load this screen/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("never renders the raw error message to staff", () => {
    render(<RouteErrorComponent error={new Error("TypeError: x is undefined")} reset={() => {}} />);
    expect(screen.queryByText(/TypeError/)).not.toBeInTheDocument();
  });
});

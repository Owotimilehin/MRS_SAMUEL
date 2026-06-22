// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DataState } from "./DataState.js";

describe("DataState", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows children when loaded with data", () => {
    render(<DataState loading={false} error={null} onRetry={() => {}}><p>hello</p></DataState>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
  it("shows a retry button on error and calls onRetry", () => {
    const onRetry = vi.fn();
    render(<DataState loading={false} error={new Error("x")} onRetry={onRetry}><p>hello</p></DataState>);
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });
  it("shows the empty state when isEmpty", () => {
    render(<DataState loading={false} error={null} isEmpty emptyTitle="Nothing here" onRetry={() => {}}><p>hello</p></DataState>);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });
});

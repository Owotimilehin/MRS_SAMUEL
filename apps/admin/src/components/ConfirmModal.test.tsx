// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConfirmModal } from "./ConfirmModal.js";

describe("ConfirmModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders title, summary children, and confirm label", () => {
    render(
      <ConfirmModal
        title="Send transfer"
        confirmLabel="Send transfer"
        busyLabel="Sending…"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        <div>Summary body</div>
      </ConfirmModal>,
    );
    expect(screen.getByRole("heading", { name: "Send transfer" })).toBeInTheDocument();
    expect(screen.getByText("Summary body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send transfer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("fires onConfirm and onCancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmModal
        title="t" confirmLabel="Go" busyLabel="…"
        onConfirm={onConfirm} onCancel={onCancel}
      >
        <div>x</div>
      </ConfirmModal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows busyLabel and disables both buttons when busy", () => {
    render(
      <ConfirmModal
        title="t" confirmLabel="Go" busyLabel="Working…" busy
        onConfirm={() => {}} onCancel={() => {}}
      >
        <div>x</div>
      </ConfirmModal>,
    );
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

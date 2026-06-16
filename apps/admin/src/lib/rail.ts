/**
 * Expand/collapse state for the admin side rail.
 *
 * The rail has three presentations driven by viewport width (see index.css):
 *   ≥1280   full rail with text labels, always in the grid — never overlaid
 *   1024–1279 (md)  76px icon-only rail; "open" overlays a 272px text drawer
 *   <1024 (small)   rail hidden off-canvas; "open" slides the text drawer in
 *
 * `open` controls that overlay drawer. The user's last *explicit* toggle is
 * remembered per device so an md tablet can default back to the expanded
 * drawer on reload. We only ever restore an open rail at md width — restoring
 * a full-screen drawer over content on a phone (or on desktop, where there is
 * no overlay) would be wrong.
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "ms-admin-rail-open";

/** Matches the md range where the rail is icon-only and the drawer overlays. */
function isMdWidth(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(min-width: 1024px) and (max-width: 1279px)").matches;
}

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function writePreference(open: boolean): void {
  try {
    window.localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    /* storage may be unavailable (private mode) — toggle still works in-session */
  }
}

export interface RailState {
  /** Whether the overlay drawer is currently shown. */
  open: boolean;
  /**
   * Flip the drawer from the rail's chevron. This is the only action that
   * persists the choice, so navigating/dismissing never erases the preference.
   */
  toggle: () => void;
  /** Open the drawer transiently (header hamburger) without persisting. */
  show: () => void;
  /** Close the drawer transiently (scrim, Esc, nav-link tap) without persisting. */
  close: () => void;
}

export function useRailOpen(): RailState {
  const [open, setOpen] = useState<boolean>(() => isMdWidth() && readPreference());

  // Esc closes the drawer wherever it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      writePreference(next);
      return next;
    });
  }, []);

  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  return { open, toggle, show, close };
}

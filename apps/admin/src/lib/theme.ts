/**
 * Light / dark choice for the shop admin + till. "system" follows the device.
 * The choice is a per-device convenience, so it lives in localStorage; when
 * storage is blocked the app simply follows the device.
 */
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "ms-theme";

export function readTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    /* storage blocked: the choice still applies for this visit */
  }
  applyTheme(choice);
}

/** system → light → dark → system */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return choice === "system" ? "light" : choice === "light" ? "dark" : "system";
}

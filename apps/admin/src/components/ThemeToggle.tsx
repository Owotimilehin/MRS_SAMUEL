import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { nextTheme, readTheme, saveTheme, type ThemeChoice } from "../lib/theme.js";

const LABEL: Record<ThemeChoice, string> = {
  system: "Theme: same as this device",
  light: "Theme: light",
  dark: "Theme: dark",
};

/** Header button: cycles device → light → dark. */
export function ThemeToggle(): JSX.Element {
  const [choice, setChoice] = useState<ThemeChoice>(() => readTheme());
  const Icon = choice === "light" ? Sun : choice === "dark" ? Moon : Monitor;
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`${LABEL[choice]}. Change theme`}
      title={LABEL[choice]}
      onClick={() => {
        const n = nextTheme(choice);
        saveTheme(n);
        setChoice(n);
      }}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

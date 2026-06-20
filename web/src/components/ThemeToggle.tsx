import { Moon, Sun } from "lucide-react";
import type { Theme } from "../theme.js";

interface ThemeToggleProps {
  readonly theme: Theme;
  onToggle(): void;
}

export function ThemeToggle({ theme, onToggle }: ThemeToggleProps): JSX.Element {
  const isDark = theme === "dark";
  return (
    <button
      className="theme-toggle"
      onClick={onToggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={isDark}
    >
      {isDark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
      <span>{isDark ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}

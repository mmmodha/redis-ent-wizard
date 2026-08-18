"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "rew-theme";

// Mirrors the pre-paint script in layout.tsx, which has already set data-theme.
function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(currentTheme());
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private browsing can reject storage; the class change still applies.
    }
    setTheme(next);
  }

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {/* Rendered only after mount so it cannot disagree with the real theme */}
      <span aria-hidden>{mounted ? (theme === "dark" ? "☀" : "☾") : "◐"}</span>
      <span>{mounted ? (theme === "dark" ? "Light" : "Dark") : "Theme"}</span>
    </button>
  );
}

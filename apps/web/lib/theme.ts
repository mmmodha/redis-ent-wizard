export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "rew-theme";
export const DEFAULT_THEME: Theme = "dark";

/** First visit and unknown stored values use dark. Only an explicit "light" opt-out is kept. */
export function resolveTheme(stored: string | null | undefined): Theme {
  return stored === "light" ? "light" : DEFAULT_THEME;
}

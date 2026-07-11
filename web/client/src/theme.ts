// Runtime theme management. The app has one design language (editorial) in two
// modes selected by data-theme on <html>: 'light' (the base) and 'dark'.
// Switching is instant (no reload) and persists to localStorage. Default is
// light, which is also the bare-:root first-paint mirror, so an unset or corrupt
// stored value degrades cleanly.

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
};

export const DEFAULT_THEME: Theme = 'light';
const STORAGE_KEY = 'loa-theme';

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // localStorage can throw in private mode / sandboxed frames; fall back.
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Persisting is best-effort; the applied theme still holds for this session.
  }
}

// Read the stored theme and apply it. Call once, as early as possible, so the
// document is themed before first paint.
export function initTheme(): Theme {
  const theme = getStoredTheme();
  applyTheme(theme);
  return theme;
}

/**
 * Project-owned OverlayScrollbars theme.
 *
 * The class is intentionally independent of OverlayScrollbars' built-in
 * light/dark themes. Semantic tokens in theme-colors.css react to the root
 * theme, so changing the class at runtime would create a second visual
 * contract and can briefly expose the library defaults during a theme switch.
 */
export const SCROLLBAR_THEME_CLASS = "os-theme-deep-student" as const;

export type ScrollbarThemeClass = typeof SCROLLBAR_THEME_CLASS;

/** @internal — retained for compatibility; the project theme is now static. */
export function subscribeHtmlThemeChange(_listener: () => void): () => void {
  return () => {};
}

/** @internal — compatibility export for source-contract tests. */
export function getHtmlTheme(): ScrollbarThemeClass {
  return SCROLLBAR_THEME_CLASS;
}

/** @internal — compatibility export for SSR source-contract tests. */
export function getHtmlThemeServerSnapshot(): ScrollbarThemeClass {
  return SCROLLBAR_THEME_CLASS;
}

export function useScrollbarTheme(): ScrollbarThemeClass {
  return SCROLLBAR_THEME_CLASS;
}

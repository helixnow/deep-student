import { useSyncExternalStore } from "react";

/**
 * Subscribes to `<html data-theme>` mutations and returns the matching
 * OverlayScrollbars theme class name. Theme color itself is bridged via
 * CSS variables in theme-colors.css (`--os-handle-bg` → `var(--scrollbar-thumb)`),
 * so this hook only flips the class — colors transition instantly via CSS.
 *
 * Moved from study-ui into the main app so DeepStudent no longer depends on
 * the `@study-ui` alias for its scroll primitive.
 */
export type ScrollbarThemeClass = "os-theme-dark" | "os-theme-light";

/** @internal — exported only for tests; do not import from app code. */
export function subscribeHtmlThemeChange(listener: () => void): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

/** @internal — exported only for tests; do not import from app code. */
export function getHtmlTheme(): ScrollbarThemeClass {
  if (typeof document === "undefined") return "os-theme-light";
  return document.documentElement.dataset.theme === "dark"
    ? "os-theme-dark"
    : "os-theme-light";
}

/** @internal — exported only for tests; do not import from app code. */
export function getHtmlThemeServerSnapshot(): ScrollbarThemeClass {
  return "os-theme-light";
}

export function useScrollbarTheme(): ScrollbarThemeClass {
  return useSyncExternalStore(
    subscribeHtmlThemeChange,
    getHtmlTheme,
    getHtmlThemeServerSnapshot,
  );
}

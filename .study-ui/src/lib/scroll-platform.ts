/**
 * Runtime detection of scroll-related platform traits. Pure module — no React,
 * no DOM mutation. Safe to call in SSR (returns all-false).
 *
 * @see .planning/research/ARCHITECTURE.md §3 for decision rationale.
 */
export interface ScrollPlatform {
  readonly isIOSWebView: boolean;
  readonly isTauri: boolean;
  readonly isTouchPrimary: boolean;
  /** iOS defaults to native scrollbars to preserve rubber-band + inertia. */
  readonly preferNativeScrollbars: boolean;
}

const EMPTY: ScrollPlatform = {
  isIOSWebView: false,
  isTauri: false,
  isTouchPrimary: false,
  preferNativeScrollbars: false,
};

export function detectScrollPlatform(): ScrollPlatform {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return EMPTY;
  }

  const ua = navigator.userAgent ?? "";
  const isIOS =
    /iP(hone|ad|od)/.test(ua) ||
    (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);

  const isTauri = "__TAURI_INTERNALS__" in window;

  let isTouchPrimary = false;
  try {
    isTouchPrimary = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  } catch {
    // matchMedia may throw in sandboxed test envs; treat as false.
  }

  return {
    isIOSWebView: isIOS,
    isTauri,
    isTouchPrimary,
    preferNativeScrollbars: isIOS,
  };
}

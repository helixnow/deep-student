/**
 * Runtime detection of scroll-related platform traits. Pure module — no React,
 * no DOM mutation. Safe to call in SSR (returns all-false).
 *
 * Moved from study-ui into the main app so DeepStudent no longer depends on
 * the `@study-ui` alias for its scroll primitive.
 */
export interface ScrollPlatform {
  readonly isIOSWebView: boolean;
  readonly isTauri: boolean;
  readonly isTouchPrimary: boolean;
  /** macOS desktop (WebKit or Chromium) — native scrollbars never jump on track click. */
  readonly isMac: boolean;
  /** iOS defaults to native scrollbars to preserve rubber-band + inertia. */
  readonly preferNativeScrollbars: boolean;
}

const EMPTY: ScrollPlatform = {
  isIOSWebView: false,
  isTauri: false,
  isTouchPrimary: false,
  isMac: false,
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

  const isMac =
    /Mac|iPhone|iPad|iPod/.test(ua) ||
    (typeof navigator.platform === "string" && /Mac|iPhone|iPad|iPod/.test(navigator.platform));

  return {
    isIOSWebView: isIOS,
    isTauri,
    isTouchPrimary,
    isMac,
    preferNativeScrollbars: isIOS,
  };
}

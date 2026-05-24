import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectScrollPlatform } from "./scroll-platform";

describe("detectScrollPlatform", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns all-false when navigator is unavailable (SSR)", () => {
    vi.stubGlobal("navigator", undefined);

    const platform = detectScrollPlatform();

    expect(platform).toEqual({
      isIOSWebView: false,
      isTauri: false,
      isTouchPrimary: false,
      preferNativeScrollbars: false,
    });
  });

  it("detects iPhone UA as iOS WebView and prefers native scrollbars", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: true }) as MediaQueryList);

    const platform = detectScrollPlatform();

    expect(platform.isIOSWebView).toBe(true);
    expect(platform.preferNativeScrollbars).toBe(true);
  });

  it("detects iPadOS (MacIntel + touch points > 1) as iOS WebView", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: false }) as MediaQueryList);

    const platform = detectScrollPlatform();

    expect(platform.isIOSWebView).toBe(true);
    expect(platform.preferNativeScrollbars).toBe(true);
  });

  it("does not flag Windows Chrome as iOS", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      platform: "Win32",
      maxTouchPoints: 0,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: false }) as MediaQueryList);

    const platform = detectScrollPlatform();

    expect(platform.isIOSWebView).toBe(false);
    expect(platform.preferNativeScrollbars).toBe(false);
  });

  it("detects Tauri via __TAURI_INTERNALS__ sentinel on window", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/605",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    vi.stubGlobal("matchMedia", () => ({ matches: false }) as MediaQueryList);

    const originalWindow = globalThis.window as Window & typeof globalThis;
    (originalWindow as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      const platform = detectScrollPlatform();
      expect(platform.isTauri).toBe(true);
    } finally {
      delete (originalWindow as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it("flags coarse-pointer environments as touch-primary", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({ matches: query.includes("coarse") }) as MediaQueryList,
    );

    const platform = detectScrollPlatform();

    expect(platform.isTouchPrimary).toBe(true);
  });

  it("treats matchMedia throwing as non-touch (sandboxed envs)", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh)",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    vi.stubGlobal("matchMedia", () => {
      throw new Error("blocked");
    });

    const platform = detectScrollPlatform();

    expect(platform.isTouchPrimary).toBe(false);
  });
});

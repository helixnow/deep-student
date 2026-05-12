import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getHtmlTheme,
  getHtmlThemeServerSnapshot,
  subscribeHtmlThemeChange,
  useScrollbarTheme,
} from "./scroll-theme";

describe("useScrollbarTheme", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("returns os-theme-light when data-theme is missing", () => {
    const { result } = renderHook(() => useScrollbarTheme());
    expect(result.current).toBe("os-theme-light");
  });

  it("returns os-theme-light when data-theme=light", () => {
    document.documentElement.dataset.theme = "light";
    const { result } = renderHook(() => useScrollbarTheme());
    expect(result.current).toBe("os-theme-light");
  });

  it("returns os-theme-dark when data-theme=dark", () => {
    document.documentElement.dataset.theme = "dark";
    const { result } = renderHook(() => useScrollbarTheme());
    expect(result.current).toBe("os-theme-dark");
  });

  it("reacts to light → dark switch via MutationObserver", async () => {
    document.documentElement.dataset.theme = "light";
    const { result } = renderHook(() => useScrollbarTheme());
    expect(result.current).toBe("os-theme-light");

    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      // MutationObserver schedules the callback; let the microtask run.
      await Promise.resolve();
    });

    expect(result.current).toBe("os-theme-dark");
  });

  it("reacts to dark → light switch via MutationObserver", async () => {
    document.documentElement.dataset.theme = "dark";
    const { result } = renderHook(() => useScrollbarTheme());
    expect(result.current).toBe("os-theme-dark");

    await act(async () => {
      document.documentElement.dataset.theme = "light";
      await Promise.resolve();
    });

    expect(result.current).toBe("os-theme-light");
  });

  it("disconnects the observer on unmount", () => {
    document.documentElement.dataset.theme = "light";
    const { result, unmount } = renderHook(() => useScrollbarTheme());
    expect(result.current).toBe("os-theme-light");

    unmount();

    // After unmount, mutating the attribute must not throw (observer released).
    expect(() => {
      document.documentElement.dataset.theme = "dark";
    }).not.toThrow();
  });

  it("getHtmlTheme returns os-theme-light on the server (document undefined)", () => {
    vi.stubGlobal("document", undefined);
    try {
      expect(getHtmlTheme()).toBe("os-theme-light");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("subscribeHtmlThemeChange returns a noop unsubscribe on the server", () => {
    vi.stubGlobal("document", undefined);
    try {
      const unsubscribe = subscribeHtmlThemeChange(() => {
        throw new Error("listener should never fire on the server");
      });
      expect(typeof unsubscribe).toBe("function");
      expect(() => unsubscribe()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getHtmlThemeServerSnapshot returns the light theme as the SSR default", () => {
    expect(getHtmlThemeServerSnapshot()).toBe("os-theme-light");
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  REDUCED_TRANSPARENCY_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  WINDOW_BACKGROUND_STORAGE_KEY,
  createThemeBootScript,
  getReducedTransparencySnapshot,
  getStoredThemePreference,
  getStoredWindowBackgroundPreference,
  getThemeDataset,
  resolveThemePreference,
  setStoredThemePreference,
  setStoredWindowBackgroundPreference,
  type ThemePreference,
  type WindowBackgroundPreference,
} from "./theme.ts";

type MemoryStorage = {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
};

function createMemoryStorage(
  initialThemeValue?: ThemePreference,
  initialWindowBackgroundValue?: WindowBackgroundPreference,
): MemoryStorage {
  const store = new Map<string, string>();

  if (initialThemeValue && initialThemeValue !== "system") {
    store.set(THEME_STORAGE_KEY, initialThemeValue);
  }

  if (initialWindowBackgroundValue && initialWindowBackgroundValue !== "translucent") {
    store.set(WINDOW_BACKGROUND_STORAGE_KEY, initialWindowBackgroundValue);
  }

  return {
    getItem(key) {
      return store.get(key) ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

test("resolves effective theme from user preference and system theme", () => {
  assert.equal(resolveThemePreference("light", "dark"), "light");
  assert.equal(resolveThemePreference("dark", "light"), "dark");
  assert.equal(resolveThemePreference("system", "dark"), "dark");
  assert.equal(resolveThemePreference("system", "light"), "light");
});

test("builds bootstrap-safe dataset values for HTML state", () => {
  assert.deepEqual(getThemeDataset("system", "dark"), {
    theme: "dark",
    themePreference: "system",
    windowBackground: "translucent",
  });
  assert.deepEqual(getThemeDataset("light", "dark", "opaque"), {
    theme: "light",
    themePreference: "light",
    windowBackground: "opaque",
  });
});

test("reads and writes local theme overrides through storage helpers", () => {
  const storage = createMemoryStorage();

  assert.equal(getStoredThemePreference(storage), "system");

  setStoredThemePreference(storage, "dark");
  assert.equal(storage.getItem(THEME_STORAGE_KEY), "dark");
  assert.equal(getStoredThemePreference(storage), "dark");

  setStoredThemePreference(storage, "system");
  assert.equal(storage.getItem(THEME_STORAGE_KEY), null);
  assert.equal(getStoredThemePreference(storage), "system");
});

test("reads and writes local window background overrides through storage helpers", () => {
  const storage = createMemoryStorage();

  assert.equal(getStoredWindowBackgroundPreference(storage), "translucent");

  setStoredWindowBackgroundPreference(storage, "opaque");
  assert.equal(storage.getItem(WINDOW_BACKGROUND_STORAGE_KEY), "opaque");
  assert.equal(getStoredWindowBackgroundPreference(storage), "opaque");

  setStoredWindowBackgroundPreference(storage, "translucent");
  assert.equal(storage.getItem(WINDOW_BACKGROUND_STORAGE_KEY), null);
  assert.equal(getStoredWindowBackgroundPreference(storage), "translucent");
});

test("boot script persists an opaque window background choice before React mounts", () => {
  const document = {
    documentElement: {
      dataset: {} as Record<string, string>,
      style: {
        colorScheme: "light",
      },
    },
  };

  const localStorage = createMemoryStorage(undefined, "opaque");
  const window = {
    matchMedia: () => ({
      matches: false,
    }),
  };

  vm.runInNewContext(createThemeBootScript(), {
    document,
    localStorage,
    window,
  });

  assert.equal(document.documentElement.dataset.windowBackground, "opaque");
});

test("boot script applies resolved theme before React mounts", () => {
  const document = {
    documentElement: {
      dataset: {} as Record<string, string>,
      style: {
        colorScheme: "light",
      },
    },
  };

  const localStorage = createMemoryStorage("dark");
  const window = {
    matchMedia: () => ({
      matches: false,
    }),
  };

  vm.runInNewContext(createThemeBootScript(), {
    document,
    localStorage,
    window,
  });

  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(document.documentElement.dataset.themePreference, "dark");
  assert.equal(document.documentElement.style.colorScheme, "dark");
});

test("reads reduced transparency from a window-like media query runtime", () => {
  assert.equal(
    getReducedTransparencySnapshot({
      matchMedia(query: string) {
        return {
          matches: query === REDUCED_TRANSPARENCY_MEDIA_QUERY,
        } as MediaQueryList;
      },
    }),
    true,
  );

  assert.equal(
    getReducedTransparencySnapshot({
      matchMedia() {
        return {
          matches: false,
        } as MediaQueryList;
      },
    }),
    false,
  );
});

test("boot script exposes reduced-transparency state so runtime fallback can guard native effects", () => {
  const script = createThemeBootScript();

  assert.match(
    script,
    /prefers-reduced-transparency: reduce/u,
    "theme bootstrap should observe prefers-reduced-transparency for explicit runtime guards",
  );
  assert.match(
    script,
    /dataset\.reducedTransparency/u,
    "theme bootstrap should persist reduced transparency state to document dataset",
  );
});

test("theme module defines explicit reduced-transparency helper exports for runtime/native fallback", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./theme.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /export const REDUCED_TRANSPARENCY_MEDIA_QUERY/u,
    "theme module should export REDUCED_TRANSPARENCY_MEDIA_QUERY for runtime guards",
  );
  assert.match(
    source,
    /export function getReducedTransparencySnapshot/u,
    "theme module should export getReducedTransparencySnapshot to drive native fallback decisions",
  );
});

test("theme dataset type stays internal to theme module", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./theme.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /export type ThemeDataset/u);
});

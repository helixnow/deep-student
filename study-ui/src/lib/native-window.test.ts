import assert from "node:assert/strict";
import test from "node:test";

import { applyNativeWindowAppearance, getNativeWindowAppearance } from "./native-window.ts";

test("maps opaque mode to a solid theme-matched native background", () => {
  assert.deepEqual(
    getNativeWindowAppearance({
      platform: "macos",
      resolvedTheme: "light",
      windowBackgroundPreference: "opaque",
    }),
    {
      backgroundColor: {
        alpha: 255,
        blue: 249,
        green: 249,
        red: 249,
      },
      effectPresets: [],
      effectSettings: null,
      fallbackBackgroundColor: {
        alpha: 255,
        blue: 249,
        green: 249,
        red: 249,
      },
    },
  );

  assert.deepEqual(
    getNativeWindowAppearance({
      platform: "windows",
      resolvedTheme: "dark",
      windowBackgroundPreference: "opaque",
    }),
    {
      backgroundColor: {
        alpha: 255,
        blue: 24,
        green: 24,
        red: 24,
      },
      effectPresets: [],
      effectSettings: null,
      fallbackBackgroundColor: {
        alpha: 255,
        blue: 24,
        green: 24,
        red: 24,
      },
    },
  );
});

test("maps translucent mode to macOS window background material and a mica-first Windows chain", () => {
  assert.deepEqual(
    getNativeWindowAppearance({
      platform: "macos",
      resolvedTheme: "dark",
      windowBackgroundPreference: "translucent",
    }),
    {
      backgroundColor: {
        alpha: 0,
        blue: 24,
        green: 24,
        red: 24,
      },
      effectPresets: ["macos-window-background"],
      effectSettings: {
        state: "followsWindowActiveState",
      },
      fallbackBackgroundColor: {
        alpha: 255,
        blue: 24,
        green: 24,
        red: 24,
      },
    },
  );

  assert.deepEqual(
    getNativeWindowAppearance({
      platform: "windows",
      resolvedTheme: "light",
      windowBackgroundPreference: "translucent",
    }),
    {
      backgroundColor: {
        alpha: 214,
        blue: 249,
        green: 249,
        red: 249,
      },
      effectPresets: ["windows-mica", "windows-blur"],
      effectSettings: {
        color: {
          alpha: 214,
          blue: 249,
          green: 249,
          red: 249,
        },
      },
      fallbackBackgroundColor: {
        alpha: 255,
        blue: 249,
        green: 249,
        red: 249,
      },
    },
  );
});

test("keeps followsWindowActiveState scoped to macOS translucent effects only", () => {
  const macosTranslucent = getNativeWindowAppearance({
    platform: "macos",
    resolvedTheme: "light",
    windowBackgroundPreference: "translucent",
  });
  const windowsTranslucent = getNativeWindowAppearance({
    platform: "windows",
    resolvedTheme: "light",
    windowBackgroundPreference: "translucent",
  });
  const otherTranslucent = getNativeWindowAppearance({
    platform: "other",
    resolvedTheme: "light",
    windowBackgroundPreference: "translucent",
  });

  assert.equal(macosTranslucent.effectSettings?.state, "followsWindowActiveState");
  assert.equal("state" in (windowsTranslucent.effectSettings ?? {}), false);
  assert.equal(otherTranslucent.effectSettings, null);
  assert.deepEqual(otherTranslucent.backgroundColor, {
    alpha: 255,
    blue: 249,
    green: 249,
    red: 249,
  });
});

test("maps macOS translucent mode to an explicit solid fallback when reduced transparency is enabled", () => {
  assert.deepEqual(
    getNativeWindowAppearance({
      platform: "macos",
      resolvedTheme: "dark",
      windowBackgroundPreference: "translucent",
      reducedTransparency: true,
    }),
    {
      backgroundColor: {
        alpha: 255,
        blue: 24,
        green: 24,
        red: 24,
      },
      effectPresets: [],
      effectSettings: null,
      fallbackBackgroundColor: {
        alpha: 255,
        blue: 24,
        green: 24,
        red: 24,
      },
    },
  );

  assert.deepEqual(
    getNativeWindowAppearance({
      platform: "windows",
      resolvedTheme: "dark",
      windowBackgroundPreference: "translucent",
      reducedTransparency: true,
    }).effectPresets,
    ["windows-mica", "windows-blur"],
  );
});

test("applies opaque mode by clearing native effects after setting the window color", async () => {
  const calls: Array<[string, unknown?]> = [];

  const result = await applyNativeWindowAppearance(
    {
      platform: "macos",
      resolvedTheme: "light",
      windowBackgroundPreference: "opaque",
    },
    {
      getRuntime: async () => ({
        effectMap: {
          macosWindowBackground: "windowBackground",
          macosContentBackground: "contentBackground",
          macosSidebar: "sidebar",
          windowsBlur: "blur",
          windowsMica: "mica",
          windowsTabbed: "tabbed",
        },
        window: {
          clearEffects: async () => {
            calls.push(["clearEffects"]);
          },
          setBackgroundColor: async (color) => {
            calls.push(["setBackgroundColor", color]);
          },
          setEffects: async (effects) => {
            calls.push(["setEffects", effects]);
          },
        },
      }),
    },
  );

  assert.equal(result, "applied");
  assert.deepEqual(calls, [
    [
      "setBackgroundColor",
      {
        alpha: 255,
        blue: 249,
        green: 249,
        red: 249,
      },
    ],
    ["clearEffects"],
  ]);
});

test("applies translucent windows mode with a mica-first strategy", async () => {
  const calls: Array<[string, unknown?]> = [];

  const result = await applyNativeWindowAppearance(
    {
      platform: "windows",
      resolvedTheme: "dark",
      windowBackgroundPreference: "translucent",
    },
    {
      getRuntime: async () => ({
        effectMap: {
          macosWindowBackground: "windowBackground",
          macosContentBackground: "contentBackground",
          macosSidebar: "sidebar",
          windowsBlur: "blur",
          windowsMica: "mica",
          windowsTabbed: "tabbed",
        },
        window: {
          clearEffects: async () => {
            calls.push(["clearEffects"]);
          },
          setBackgroundColor: async (color) => {
            calls.push(["setBackgroundColor", color]);
          },
          setEffects: async (effects) => {
            calls.push(["setEffects", effects]);
          },
        },
      }),
    },
  );

  assert.equal(result, "applied");
  assert.deepEqual(calls, [
    [
      "setBackgroundColor",
      {
        alpha: 156,
        blue: 24,
        green: 24,
        red: 24,
      },
    ],
    [
      "setEffects",
      {
        color: {
          alpha: 156,
          blue: 24,
          green: 24,
          red: 24,
        },
        effects: ["mica"],
      },
    ],
  ]);
});

test("falls back from mica to blur on Windows when the preferred effect is unavailable", async () => {
  const calls: Array<[string, unknown?]> = [];
  let effectAttempt = 0;

  const result = await applyNativeWindowAppearance(
    {
      platform: "windows",
      resolvedTheme: "light",
      windowBackgroundPreference: "translucent",
    },
    {
      getRuntime: async () => ({
        effectMap: {
          macosWindowBackground: "windowBackground",
          macosContentBackground: "contentBackground",
          macosSidebar: "sidebar",
          windowsBlur: "blur",
          windowsMica: "mica",
          windowsTabbed: "tabbed",
        },
        window: {
          clearEffects: async () => {
            calls.push(["clearEffects"]);
          },
          setBackgroundColor: async (color) => {
            calls.push(["setBackgroundColor", color]);
          },
          setEffects: async (effects) => {
            calls.push(["setEffects", effects]);
            effectAttempt += 1;
            if (effectAttempt === 1) {
              throw new Error("mica unsupported");
            }
          },
        },
      }),
    },
  );

  assert.equal(result, "applied");
  assert.deepEqual(calls, [
    [
      "setBackgroundColor",
      {
        alpha: 214,
        blue: 249,
        green: 249,
        red: 249,
      },
    ],
    [
      "setEffects",
      {
        color: {
          alpha: 214,
          blue: 249,
          green: 249,
          red: 249,
        },
        effects: ["mica"],
      },
    ],
    [
      "setEffects",
      {
        color: {
          alpha: 214,
          blue: 249,
          green: 249,
          red: 249,
        },
        effects: ["blur"],
      },
    ],
  ]);
});

test("clears effects and restores an opaque background if every Windows translucent effect fails", async () => {
  const calls: Array<[string, unknown?]> = [];

  const result = await applyNativeWindowAppearance(
    {
      platform: "windows",
      resolvedTheme: "dark",
      windowBackgroundPreference: "translucent",
    },
    {
      getRuntime: async () => ({
        effectMap: {
          macosWindowBackground: "windowBackground",
          macosContentBackground: "contentBackground",
          macosSidebar: "sidebar",
          windowsBlur: "blur",
          windowsMica: "mica",
          windowsTabbed: "tabbed",
        },
        window: {
          clearEffects: async () => {
            calls.push(["clearEffects"]);
          },
          setBackgroundColor: async (color) => {
            calls.push(["setBackgroundColor", color]);
          },
          setEffects: async (effects) => {
            calls.push(["setEffects", effects]);
            throw new Error("effect unsupported");
          },
        },
      }),
    },
  );

  assert.equal(result, "fallback");
  assert.deepEqual(calls, [
    [
      "setBackgroundColor",
      {
        alpha: 156,
        blue: 24,
        green: 24,
        red: 24,
      },
    ],
    [
      "setEffects",
      {
        color: {
          alpha: 156,
          blue: 24,
          green: 24,
          red: 24,
        },
        effects: ["mica"],
      },
    ],
    [
      "setEffects",
      {
        color: {
          alpha: 156,
          blue: 24,
          green: 24,
          red: 24,
        },
        effects: ["blur"],
      },
    ],
    ["clearEffects"],
    [
      "setBackgroundColor",
      {
        alpha: 255,
        blue: 24,
        green: 24,
        red: 24,
      },
    ],
  ]);
});

test("applies translucent macOS mode with window background material and active-state effect settings", async () => {
  const calls: Array<[string, unknown?]> = [];

  const result = await applyNativeWindowAppearance(
    {
      platform: "macos",
      resolvedTheme: "light",
      windowBackgroundPreference: "translucent",
    },
    {
      getRuntime: async () => ({
        effectMap: {
          macosWindowBackground: "windowBackground",
          macosContentBackground: "contentBackground",
          macosSidebar: "sidebar",
          windowsBlur: "blur",
          windowsMica: "mica",
          windowsTabbed: "tabbed",
        },
        window: {
          clearEffects: async () => {
            calls.push(["clearEffects"]);
          },
          setBackgroundColor: async (color) => {
            calls.push(["setBackgroundColor", color]);
          },
          setEffects: async (effects) => {
            calls.push(["setEffects", effects]);
          },
        },
      }),
    },
  );

  assert.equal(result, "applied");
  assert.deepEqual(calls, [
    [
      "setBackgroundColor",
      {
        alpha: 0,
        blue: 249,
        green: 249,
        red: 249,
      },
    ],
    [
      "setEffects",
      {
        effects: ["windowBackground"],
        state: "followsWindowActiveState",
      },
    ],
  ]);
});

test("clears effects and restores an opaque background if the macOS translucent effect fails", async () => {
  const calls: Array<[string, unknown?]> = [];

  const result = await applyNativeWindowAppearance(
    {
      platform: "macos",
      resolvedTheme: "dark",
      windowBackgroundPreference: "translucent",
    },
    {
      getRuntime: async () => ({
        effectMap: {
          macosWindowBackground: "windowBackground",
          macosContentBackground: "contentBackground",
          macosSidebar: "sidebar",
          windowsBlur: "blur",
          windowsMica: "mica",
          windowsTabbed: "tabbed",
        },
        window: {
          clearEffects: async () => {
            calls.push(["clearEffects"]);
          },
          setBackgroundColor: async (color) => {
            calls.push(["setBackgroundColor", color]);
          },
          setEffects: async (effects) => {
            calls.push(["setEffects", effects]);
            throw new Error("effect unsupported");
          },
        },
      }),
    },
  );

  assert.equal(result, "fallback");
  assert.deepEqual(calls, [
    [
      "setBackgroundColor",
      {
        alpha: 0,
        blue: 24,
        green: 24,
        red: 24,
      },
    ],
    [
      "setEffects",
      {
        effects: ["windowBackground"],
        state: "followsWindowActiveState",
      },
    ],
    ["clearEffects"],
    [
      "setBackgroundColor",
      {
        alpha: 255,
        blue: 24,
        green: 24,
        red: 24,
      },
    ],
  ]);
});

test("applies the reduced-transparency fallback on macOS without leaving native effects active", async () => {
  const calls: Array<[string, unknown?]> = [];

  const result = await applyNativeWindowAppearance(
    {
      platform: "macos",
      resolvedTheme: "light",
      windowBackgroundPreference: "translucent",
      reducedTransparency: true,
    },
    {
      getRuntime: async () => ({
        effectMap: {
          macosWindowBackground: "windowBackground",
          macosContentBackground: "contentBackground",
          macosSidebar: "sidebar",
          windowsBlur: "blur",
          windowsMica: "mica",
          windowsTabbed: "tabbed",
        },
        window: {
          clearEffects: async () => {
            calls.push(["clearEffects"]);
          },
          setBackgroundColor: async (color) => {
            calls.push(["setBackgroundColor", color]);
          },
          setEffects: async (effects) => {
            calls.push(["setEffects", effects]);
          },
        },
      }),
    },
  );

  assert.equal(result, "fallback");
  assert.deepEqual(calls, [
    [
      "setBackgroundColor",
      {
        alpha: 255,
        blue: 249,
        green: 249,
        red: 249,
      },
    ],
    ["clearEffects"],
  ]);
});

test("treats translucent mode on other platforms as an explicit solid fallback", async () => {
  const calls: Array<[string, unknown?]> = [];

  const result = await applyNativeWindowAppearance(
    {
      platform: "other",
      resolvedTheme: "light",
      windowBackgroundPreference: "translucent",
    },
    {
      getRuntime: async () => ({
        effectMap: {
          macosWindowBackground: "windowBackground",
          macosContentBackground: "contentBackground",
          macosSidebar: "sidebar",
          windowsBlur: "blur",
          windowsMica: "mica",
          windowsTabbed: "tabbed",
        },
        window: {
          clearEffects: async () => {
            calls.push(["clearEffects"]);
          },
          setBackgroundColor: async (color) => {
            calls.push(["setBackgroundColor", color]);
          },
          setEffects: async (effects) => {
            calls.push(["setEffects", effects]);
          },
        },
      }),
    },
  );

  assert.equal(result, "fallback");
  assert.deepEqual(calls, [
    [
      "setBackgroundColor",
      {
        alpha: 255,
        blue: 249,
        green: 249,
        red: 249,
      },
    ],
    ["clearEffects"],
  ]);
});

test("skips native work when the Tauri runtime is unavailable", async () => {
  const result = await applyNativeWindowAppearance(
    {
      platform: "other",
      resolvedTheme: "light",
      windowBackgroundPreference: "opaque",
    },
    {
      getRuntime: async () => null,
    },
  );

  assert.equal(result, "skipped");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldSyncNativeWindowBackgroundPreference,
  syncNativeWindowBackgroundPreference,
} from "./native-window-preference.ts";

test("does not sync the native window background on the first observed preference", () => {
  assert.equal(shouldSyncNativeWindowBackgroundPreference(null, "translucent"), false);
});

test("does not sync the native window background when the preference value is unchanged", () => {
  assert.equal(
    shouldSyncNativeWindowBackgroundPreference("translucent", "translucent"),
    false,
  );
});

test("syncs the native window background when the preference changes after mount", () => {
  assert.equal(shouldSyncNativeWindowBackgroundPreference("translucent", "opaque"), true);
});

test("invokes the native window background preference command inside Tauri", async () => {
  const calls: Array<[string, unknown]> = [];

  const result = await syncNativeWindowBackgroundPreference("opaque", {
    hasTauriRuntime: () => true,
    invoke: async (command, payload) => {
      calls.push([command, payload]);
      return undefined;
    },
  });

  assert.equal(result, "synced");
  assert.deepEqual(calls, [["set_window_background_preference", { preference: "opaque" }]]);
});

test("skips the native bridge outside Tauri", async () => {
  const result = await syncNativeWindowBackgroundPreference("translucent", {
    hasTauriRuntime: () => false,
    invoke: async () => {
      throw new Error("invoke should not run outside Tauri");
    },
  });

  assert.equal(result, "skipped");
});

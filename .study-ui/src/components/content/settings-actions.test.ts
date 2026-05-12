import assert from "node:assert/strict";
import test from "node:test";

import { SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME } from "./settings-actions.ts";

test("settings surface action buttons share the same rounded hover treatment", () => {
  assert.match(SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME, /h-11/);
  assert.match(SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME, /rounded-2xl/);
  assert.match(SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME, /px-4\.5/);
  assert.match(SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME, /text-sm/);
  assert.match(SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME, /border-\[color:var\(--button-outline-border\)\]/);
  assert.match(SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME, /bg-\[var\(--button-outline-bg\)\]/);
  assert.match(SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME, /hover:bg-\[var\(--button-outline-hover-bg\)\]/);
  assert.match(SETTINGS_SURFACE_ACTION_BUTTON_CLASS_NAME, /active:bg-\[var\(--button-outline-active-bg\)\]/);
});

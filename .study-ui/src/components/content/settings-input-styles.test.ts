import assert from "node:assert/strict";
import test from "node:test";

import { SETTINGS_SURFACE_INPUT_CLASS_NAME } from "./settings-input-styles.ts";

test("settings surface inputs share the same taller field geometry as action buttons", () => {
  assert.match(SETTINGS_SURFACE_INPUT_CLASS_NAME, /h-11/);
  assert.match(SETTINGS_SURFACE_INPUT_CLASS_NAME, /rounded-2xl/);
  assert.match(SETTINGS_SURFACE_INPUT_CLASS_NAME, /px-4\.5/);
  assert.match(SETTINGS_SURFACE_INPUT_CLASS_NAME, /text-sm/);
});

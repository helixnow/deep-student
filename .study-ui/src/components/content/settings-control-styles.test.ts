import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SETTINGS_SWITCH_CONTROL_CLASS_NAME } from "./settings-control-styles.ts";

test("settings switch control shell keeps a visible surfaced capsule in light mode", () => {
  assert.match(SETTINGS_SWITCH_CONTROL_CLASS_NAME, /min-h-11/);
  assert.match(SETTINGS_SWITCH_CONTROL_CLASS_NAME, /rounded-2xl/);
  assert.match(SETTINGS_SWITCH_CONTROL_CLASS_NAME, /border border-border\/70/);
  assert.match(SETTINGS_SWITCH_CONTROL_CLASS_NAME, /bg-background\/80/);
  assert.doesNotMatch(SETTINGS_SWITCH_CONTROL_CLASS_NAME, /shadow-\[/);
});

test("appearance settings wraps the window background switch in the shared surfaced shell", async () => {
  const source = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /className=\{cn\(SETTINGS_SWITCH_CONTROL_CLASS_NAME, controlSurfaceClassName\)\}[\s\S]*?<Switch/u);
});

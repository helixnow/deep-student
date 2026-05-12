import assert from "node:assert/strict";
import test from "node:test";

import { getVisibleSettingsPanelSections } from "./settings-panel.ts";

test("maps the general tab to the compact everyday preferences stack", () => {
  assert.deepEqual(getVisibleSettingsPanelSections("general"), ["general"]);
});

test("maps the appearance tab to its dedicated visual preferences section", () => {
  assert.deepEqual(getVisibleSettingsPanelSections("appearance"), ["appearance"]);
});

test("keeps models, tools, advanced, and about grouped into the new system settings structure", () => {
  assert.deepEqual(getVisibleSettingsPanelSections("models"), ["model-service", "model-assign"]);
  assert.deepEqual(getVisibleSettingsPanelSections("tools"), ["memory", "privacy", "shortcuts"]);
  assert.deepEqual(getVisibleSettingsPanelSections("advanced"), ["developer", "data-governance"]);
  assert.deepEqual(getVisibleSettingsPanelSections("about"), ["about"]);
  assert.deepEqual(getVisibleSettingsPanelSections("demo"), ["demo"]);
});


test("settings panel module keeps section union and appearance checks internal", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./settings-panel.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /export type SettingsPanelSection/u);
  assert.doesNotMatch(source, /export function shouldShowAppearanceSettings/u);
});

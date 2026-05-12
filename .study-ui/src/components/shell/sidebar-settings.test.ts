import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SETTINGS_BACK_BUTTON_LABEL,
  SETTINGS_NAV_ITEM_LABEL_CLASS_NAME,
} from "./sidebar-settings.ts";

test("settings back button points users back to the home view with sidebar-consistent hover affordance", () => {
  assert.equal(SETTINGS_BACK_BUTTON_LABEL, "返回主页");
});

test("settings nav labels stay black in light mode and readable in dark mode", () => {
  assert.equal(SETTINGS_NAV_ITEM_LABEL_CLASS_NAME, "settings-nav-item-label");
});

test("settings nav label utility follows the app data-theme selector", async () => {
  const source = await readFile(new URL("../../styles/app.css", import.meta.url), "utf8");

  assert.match(source, /\.settings-nav-item-label\s*\{[\s\S]*color:\s*var\(--color-sidebar-foreground\);/);
  assert.match(source, /\[data-theme="dark"\]\s+\.settings-nav-item-label\s*\{[\s\S]*color:\s*var\(--color-sidebar-foreground\);/);
});

test("sidebar settings reuses the shared quiet hover affordance without legacy translucent helper wrappers", async () => {
  const source = await readFile(new URL("./Sidebar.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /className="text-sidebar-muted hover:bg-interactive-hover hover:text-sidebar-foreground"/u,
  );
  assert.match(
    source,
    /isActive[\s\S]*"rounded-2xl text-sidebar-foreground hover:bg-interactive-hover hover:text-sidebar-foreground"/u,
  );
  assert.match(source, /onClick=\{isActive \? undefined : \(\) => handleSelectSettingsTab\(item\.id\)\}/u);
  assert.doesNotMatch(source, /sidebarHoverSurfaceClassName/u);
  assert.doesNotMatch(source, /sidebarNavMotionClassName/u);
  assert.doesNotMatch(source, /hover:bg-sidebar-hover/);
  assert.match(source, /SETTINGS_NAV_ITEM_LABEL_CLASS_NAME/);
});


test("sidebar settings keeps only live constants and drops dead style helpers", async () => {
  const source = await readFile(new URL("./sidebar-settings.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /SETTINGS_BACK_BUTTON_CLASS_NAME/u);
});

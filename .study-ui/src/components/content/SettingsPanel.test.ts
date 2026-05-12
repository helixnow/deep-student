import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("settings choice controls keep neutral hover and selected fills without marketing emphasis", async () => {
  const source = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /function ChoiceChip[\s\S]*min-h-11[\s\S]*rounded-2xl[\s\S]*px-4\.5/u);
  assert.match(source, /function ChoiceChip[\s\S]*selected\s*\?\s*"bg-interactive-selected text-foreground/u);
  assert.match(source, /function ChoiceChip[\s\S]*hover:bg-interactive-hover/u);
  assert.doesNotMatch(source, /function PaletteCard/u);
  assert.doesNotMatch(source, /hover:-translate-y/u);
});

test("settings panel uses compact preference rows instead of oversized showcase sections", async () => {
  const source = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /function SettingsRow[\s\S]*px-5 py-4/u);
  assert.match(source, /function SettingsSection[\s\S]*rounded-2xl/u);
  assert.match(
    source,
    /<select[\s\S]*aria-label="语言设置"[\s\S]*value=\{settings\.language\}[\s\S]*SETTINGS_SURFACE_INPUT_CLASS_NAME[\s\S]*appearance-none[\s\S]*pr-11/u,
  );
  assert.match(source, /<CaretDown[\s\S]*size=\{16\}[\s\S]*weight="bold"/u);
  assert.doesNotMatch(source, /<Tabs\s+value=\{settings\.language\}/u);
  assert.doesNotMatch(source, /rounded-\[28px\]/u);
  assert.doesNotMatch(source, /rounded-\[30px\]/u);
});

test("settings inputs align to the same 44px field rhythm as adjacent action buttons", async () => {
  const source = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{[\s\S]*SETTINGS_SURFACE_INPUT_CLASS_NAME[\s\S]*\} from "\.\/settings-input-styles"/u);
  assert.match(source, /<Input[\s\S]*aria-label="顶部栏顶部边距高度"[\s\S]*className=\{cn\(SETTINGS_SURFACE_INPUT_CLASS_NAME, "pr-12"\)\}/u);
  assert.match(source, /<Input[\s\S]*aria-label="记忆根文件夹"[\s\S]*className=\{SETTINGS_SURFACE_INPUT_CLASS_NAME\}/u);
  assert.match(source, /<Input[\s\S]*aria-label="默认分类"[\s\S]*className=\{SETTINGS_SURFACE_INPUT_CLASS_NAME\}/u);
  assert.doesNotMatch(source, /type="color"/u);
  assert.doesNotMatch(source, /SETTINGS_SURFACE_COLOR_INPUT_CLASS_NAME/u);
});

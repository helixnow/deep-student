import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shell icon buttons use the compact toolbar control treatment", async () => {
  const source = await readFile(new URL("./ShellButton.tsx", import.meta.url), "utf8");

  assert.match(source, /icon:\s*cn\(buttonToneClassNames\.ghost, buttonSizeClassNames\.icon, "justify-center"\)/);
  assert.doesNotMatch(source, /hover:bg-interactive-hover/);
});

test("shell nav buttons keep the same restrained rounded geometry", async () => {
  const source = await readFile(new URL("./ShellButton.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{[^}]*buttonBaseClassName[^}]*buttonSizeClassNames[^}]*buttonToneClassNames[^}]*\} from "@\/components\/ui\/button";/);
  assert.match(source, /const shellNavBaseClassName =/);
  assert.match(source, /nav:\s*"border-transparent bg-transparent text-muted-foreground flex min-h-\[2\.75rem\] lg:min-h-9 w-full min-w-0 justify-start gap-2\.5 overflow-hidden rounded-2xl px-2\.5 py-1\.5 text-left text-sm font-normal"/);
  assert.doesNotMatch(source, /md:min-h-9/);
  assert.doesNotMatch(source, /text-\[15px\]/);
  assert.match(source, /buttonToneClassNames\.ghost/);
});


test("shell button keeps its internal type aliases private", async () => {
  const source = await readFile(new URL("./ShellButton.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /export type ShellButtonVariant/u);
  assert.doesNotMatch(source, /export type ShellButtonSize/u);
  assert.doesNotMatch(source, /export type ShellButtonProps/u);
});

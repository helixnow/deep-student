import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dialog and sheet close controls use the shared interactive hover fill", async () => {
  const [dialogSource, sheetSource] = await Promise.all([
    readFile(new URL("./dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("./sheet.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(dialogSource, /hover:bg-interactive-hover/);
  assert.match(sheetSource, /hover:bg-interactive-hover/);
  assert.doesNotMatch(dialogSource, /hover:bg-accent/);
  assert.doesNotMatch(sheetSource, /hover:bg-accent/);
});

test("dialog and sheet overlays use the shared overlay token without extra blur styling", async () => {
  const [dialogSource, sheetSource] = await Promise.all([
    readFile(new URL("./dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("./sheet.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(dialogSource, /bg-overlay/);
  assert.match(sheetSource, /bg-overlay/);
  assert.doesNotMatch(dialogSource, /backdrop-blur-sm/);
  assert.doesNotMatch(sheetSource, /backdrop-blur-sm/);
  assert.match(dialogSource, /rounded-2xl/);
  assert.doesNotMatch(dialogSource, /rounded-3xl/);
});

test("tooltip drops zoom animations and keeps a compact neutral surface", async () => {
  const tooltipSource = await readFile(new URL("./tooltip.tsx", import.meta.url), "utf8");

  assert.match(tooltipSource, /rounded-lg/);
  assert.doesNotMatch(tooltipSource, /zoom-in-95/);
  assert.doesNotMatch(tooltipSource, /zoom-out-95/);
});

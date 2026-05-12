import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("textarea keeps a touch-safe minimum height and semantic interaction states", async () => {
  const source = await readFile(new URL("./textarea.tsx", import.meta.url), "utf8");

  assert.match(source, /min-h-28/);
  assert.match(source, /placeholder:text-muted-foreground/);
  assert.match(source, /focus-visible:ring-2/);
  assert.match(source, /disabled:cursor-not-allowed/);
  assert.match(source, /disabled:opacity-50/);
  assert.doesNotMatch(source, /min-h-9/);
  assert.doesNotMatch(source, /min-h-10/);
});

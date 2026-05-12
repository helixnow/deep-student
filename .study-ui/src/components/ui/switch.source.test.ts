import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const switchPath = path.join(__dirname, "switch.tsx");

test("switch relies on semantic tokens instead of hardcoded neutral colors", () => {
  const source = readFileSync(switchPath, "utf8");

  assert.match(source, /h-\[var\(--touch-target-size\)\] w-\[3\.25rem\]/);
  assert.match(source, /size-7/);
  assert.match(source, /bg-input/);
  assert.match(source, /data-\[state=checked\]:bg-primary/);
  assert.match(source, /data-\[state=checked\]:translate-x-\[1\.125rem\]/);
  assert.doesNotMatch(source, /h-8 w-\[3\.25rem\]/);
  assert.doesNotMatch(source, /h-10 w-16/);
  assert.doesNotMatch(source, /size-8/);
  assert.doesNotMatch(source, /translate-x-7/);
  assert.doesNotMatch(source, /bg-black\/12/);
  assert.doesNotMatch(source, /dark:bg-white\/16/);
  assert.doesNotMatch(source, /rgba\(/);
});

test("switch thumb keeps a simple motion profile without custom easing", () => {
  const source = readFileSync(switchPath, "utf8");

  assert.match(source, /transition-transform duration-150/);
  assert.doesNotMatch(source, /cubic-bezier/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sidebarUpdateBadgePath = path.join(__dirname, "SidebarUpdateBadge.tsx");

test("sidebar update badge uses the prominent color treatment instead of a secondary fill", () => {
  const source = readFileSync(sidebarUpdateBadgePath, "utf8");

  assert.match(source, /bg-primary/u);
  assert.match(source, /text-primary-foreground/u);
  assert.doesNotMatch(source, /bg-secondary/u);
  assert.doesNotMatch(source, /text-secondary-foreground/u);
});

test("sidebar update badge uses a more aggressive capsule radius", () => {
  const source = readFileSync(sidebarUpdateBadgePath, "utf8");

  assert.match(source, /rounded-full/u);
  assert.doesNotMatch(source, /rounded-lg/u);
});

test("sidebar update badge keeps the shared chrome rhythm but uses a slightly smaller label size", () => {
  const source = readFileSync(sidebarUpdateBadgePath, "utf8");

  assert.match(source, /text-xs/u);
  assert.match(source, /font-medium/u);
  assert.match(source, /leading-none/u);
  assert.doesNotMatch(source, /text-sm/u);
});

test("sidebar update badge trims both vertical and horizontal padding for a tighter compact capsule", () => {
  const source = readFileSync(sidebarUpdateBadgePath, "utf8");

  assert.match(source, /h-6/u);
  assert.match(source, /px-2/u);
  assert.doesNotMatch(source, /h-\[1\.625rem\]/u);
  assert.doesNotMatch(source, /px-2\.5/u);
});

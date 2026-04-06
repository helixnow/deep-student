import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("button primitive uses 44px touch targets on mobile and compacts on desktop", async () => {
  const source = await readFile(new URL("./button.tsx", import.meta.url), "utf8");

  assert.match(source, /rounded-\[var\(--button-radius\)\]/);
  assert.match(source, /h-11 px-\[var\(--button-padding-x\)\] md:h-\[var\(--button-height\)\]/);
  assert.match(source, /h-\[var\(--button-icon-size\)\] w-\[var\(--button-icon-size\)\] rounded-\[var\(--button-radius\)\]/);
  assert.doesNotMatch(source, /rounded-lg/);
  assert.doesNotMatch(source, /h-9 px-4/);
});

test("button outline variant keeps a real border and near-surface fill", async () => {
  const source = await readFile(new URL("./button.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /outline:\s*"[^"]*border-\[color:var\(--button-outline-border\)\][^"]*bg-\[var\(--button-outline-bg\)\][^"]*hover:bg-\[var\(--button-outline-hover-bg\)\]/,
  );
  assert.doesNotMatch(source, /outline:\s*"[^"]*bg-background\/92/);
});

test("button primary variant uses dedicated theme tokens instead of generic utility colors", async () => {
  const source = await readFile(new URL("./button.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /primary:\s*"[^"]*border-\[color:var\(--button-prominent-border\)\][^"]*bg-\[var\(--button-prominent-bg\)\][^"]*hover:bg-\[var\(--button-prominent-hover-bg\)\]/,
  );
  assert.doesNotMatch(source, /primary:\s*"[^"]*bg-primary/);
});

test("button exports shared shell-facing geometry tokens", async () => {
  const source = await readFile(new URL("./button.tsx", import.meta.url), "utf8");

  assert.match(source, /export const buttonBaseClassName =/);
  assert.match(source, /export const buttonSizeClassNames =/);
  assert.match(source, /export const buttonToneClassNames =/);
});

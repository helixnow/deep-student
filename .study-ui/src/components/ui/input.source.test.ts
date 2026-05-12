import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("input uses a 44px touch target on mobile and compacts on desktop", async () => {
  const source = await readFile(new URL("./input.tsx", import.meta.url), "utf8");

  assert.match(source, /h-11/);
  assert.match(source, /lg:h-10/);
  assert.doesNotMatch(source, /md:h-10/);
  assert.doesNotMatch(source, /h-10 w-full rounded-xl bg-input px-3 py-2/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dropdown menu items expose a visible keyboard focus ring", async () => {
  const source = await readFile(new URL("./dropdown-menu.tsx", import.meta.url), "utf8");

  assert.match(source, /focus-visible:ring-2/);
  assert.match(source, /focus-visible:ring-ring/);
});

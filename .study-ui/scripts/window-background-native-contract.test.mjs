import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const capabilityPath = path.join(process.cwd(), "src-tauri/capabilities/default.json");

test("desktop capability allows native window background updates", async () => {
  const capability = JSON.parse(await readFile(capabilityPath, "utf8"));

  assert.equal(capability.windows.includes("main"), true);
  assert.equal(capability.permissions.includes("core:window:allow-set-background-color"), true);
  assert.equal(capability.permissions.includes("core:window:allow-set-effects"), true);
});

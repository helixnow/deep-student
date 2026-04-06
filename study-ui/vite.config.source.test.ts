import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viteConfigPath = path.join(__dirname, "vite.config.ts");

test("vite build defines manual chunks for heavy shared libraries", () => {
  const source = readFileSync(viteConfigPath, "utf8");

  assert.match(source, /manualChunks:\s*\{/u);
  assert.match(source, /radix:\s*\[/u);
  assert.match(source, /icons:\s*\["@phosphor-icons\/react"\]/u);
  assert.match(source, /tauri:\s*\["@tauri-apps\/api"\]/u);
});

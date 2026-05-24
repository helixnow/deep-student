import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoPanelPath = path.join(__dirname, "SettingsDemoPanel.tsx");

test("settings demo header frame uses the calmer shared material treatment", () => {
  const source = readFileSync(demoPanelPath, "utf8");

  assert.match(source, /<Card className="border-border\/70 bg-background\/90 shadow-sm shadow-black\/5">/u);
  assert.match(source, /<Surface key=\{item\.label\} className="min-w-28 rounded-2xl border border-border\/70 bg-secondary\/78 px-3 py-2 shadow-sm shadow-black\/5">/u);
  assert.doesNotMatch(source, /bg-card\/98/u);
});

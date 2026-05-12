import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const macosConfigPath = path.join(__dirname, "tauri.macos.conf.json");

test("macOS window config keeps native overlay chrome while preserving translucent startup capability", () => {
  const source = readFileSync(macosConfigPath, "utf8");

  assert.match(source, /"decorations": true/u);
  assert.match(source, /"titleBarStyle": "Overlay"/u);
  assert.match(source, /"hiddenTitle": true/u);
  assert.match(source, /"transparent": true/u);
  assert.doesNotMatch(source, /"trafficLightPosition"/u);
  assert.doesNotMatch(source, /"windowEffects"/u);
  assert.doesNotMatch(source, /"titleBarStyle": "Transparent"/u);
  assert.doesNotMatch(source, /"decorations": false/u);
  assert.doesNotMatch(source, /"transparent": false/u);
});

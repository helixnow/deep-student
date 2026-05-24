import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const providerPath = path.join(__dirname, "AppSettingsProvider.tsx");

test("app settings provider applies the sidebar glass strength as a document variable", () => {
  const source = readFileSync(providerPath, "utf8");

  assert.match(source, /--app-sidebar-glass-alpha-shift/u);
  assert.match(source, /settings\.sidebarGlassIntensity/u);
  assert.match(source, /getSidebarGlassAlphaShift\(settings\.sidebarGlassIntensity\)/u);
});

test("app settings provider writes the macOS font smoothing mode into the document dataset", () => {
  const source = readFileSync(providerPath, "utf8");

  assert.match(source, /dataset\.fontSmoothing/u);
  assert.match(source, /settings\.macosNativeFontSmoothing/u);
  assert.match(source, /macos-native/u);
  assert.match(source, /macos-grayscale/u);
});

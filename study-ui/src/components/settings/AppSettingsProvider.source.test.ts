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

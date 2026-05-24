import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, "App.tsx");

test("app keeps mobile drawer and desktop sidebar collapsed state separate", () => {
  const source = readFileSync(appPath, "utf8");

  assert.match(source, /const \[mobileSidebarOpen, setMobileSidebarOpen\] = useState\(false\);/u);
  assert.match(source, /const \[sidebarCollapsed, setSidebarCollapsed\] = useState\(false\);/u);
  assert.match(source, /const toggleMobileSidebar = \(\) => setMobileSidebarOpen\(\(open\) => !open\);/u);
  assert.match(source, /const toggleSidebarCollapsed = \(\) => setSidebarCollapsed\(\(collapsed\) => !collapsed\);/u);
  assert.match(source, /mobileSidebarOpen=\{mobileSidebarOpen\}/u);
  assert.match(source, /sidebarCollapsed=\{sidebarCollapsed\}/u);
  assert.match(source, /onToggleMobileSidebar=\{toggleMobileSidebar\}/u);
  assert.match(source, /onToggleSidebarCollapsed=\{toggleSidebarCollapsed\}/u);
  assert.doesNotMatch(source, /\bisSidebarOpen\b/u);
  assert.doesNotMatch(source, /\bsetIsSidebarOpen\b/u);
});

test("settings entry opens the relevant sidebar states without merging their meanings", () => {
  const source = readFileSync(appPath, "utf8");

  assert.match(
    source,
    /const openSettings = \(\) => \{\s*setCurrentMode\("settings"\);\s*setMobileSidebarOpen\(true\);\s*setSidebarCollapsed\(false\);\s*\};/u,
  );
});

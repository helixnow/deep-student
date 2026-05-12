import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demoPanelPath = path.join(__dirname, "SettingsDemoPanel.tsx");
const demoDataPath = path.join(__dirname, "settings-demo-data.ts");
const demoSectionsPath = path.join(__dirname, "settings-demo-sections.tsx");
const demoFixturesPath = path.join(__dirname, "../../lib/demo-fixtures.tsx");

test("settings demo panel exists and documents the requested controls", () => {
  assert.equal(existsSync(demoPanelPath), true);

  const source = existsSync(demoPanelPath) ? readFileSync(demoPanelPath, "utf8") : "";
  const dataSource = readFileSync(demoDataPath, "utf8");

  for (const label of [
    "Button",
    "Input",
    "Textarea",
    "Typography / Font Weight",
    "Switch",
    "Select / Combobox Example",
    "Dialog",
    "Sheet / Drawer",
    "Tabs",
    "Tooltip",
    "Dropdown / Menu",
    "Sidebar",
    "Card / ListItem Example",
    "Empty / Skeleton / Toast Mock",
  ]) {
    assert.match(dataSource, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(source, /Surface/);
  assert.doesNotMatch(source, /MiniSurface/);
});

test("settings demo panel includes a dedicated state regression board", () => {
  const source = readFileSync(demoPanelPath, "utf8");
  const sectionsSource = readFileSync(demoSectionsPath, "utf8");
  const dataSource = readFileSync(demoDataPath, "utf8");

  assert.equal(existsSync(demoDataPath), true);
  assert.equal(existsSync(demoSectionsPath), true);
  assert.match(source, /from "\.\/settings-demo-data"/);
  assert.match(source, /from "\.\/settings-demo-sections"/);
  assert.match(dataSource, /title: "状态回归检查"/);
  assert.match(sectionsSource, /Hover 状态/);
  assert.match(sectionsSource, /Disabled 状态/);
  assert.match(sectionsSource, /Error 状态/);
  assert.match(sectionsSource, /Loading 状态/);
  assert.match(sectionsSource, /回归检查建议/);
  assert.match(source, /<StateRegressionSection[\s\S]*title=\{demoSectionMeta\.stateRegression\.title\}/);
  assert.match(source, /description=\{demoSectionMeta\.stateRegression\.description\}/);
});

test("settings demo panel includes a dedicated typography system section", () => {
  const source = readFileSync(demoPanelPath, "utf8");
  const sectionsSource = readFileSync(demoSectionsPath, "utf8");
  const dataSource = readFileSync(demoDataPath, "utf8");

  assert.match(source, /TypographySection/);
  assert.match(source, /<TypographySection[\s\S]*title=\{demoSectionMeta\.typography\.title\}/);
  assert.match(source, /description=\{demoSectionMeta\.typography\.description\}/);
  assert.match(dataSource, /title: "Typography \/ Font Weight"/);
  assert.match(sectionsSource, /Display/);
  assert.match(sectionsSource, /Type Scale/);
  assert.match(sectionsSource, /Regular/);
  assert.match(sectionsSource, /Semibold/);
  assert.match(sectionsSource, /--app-font-family/);
});

test("settings demo panel renders feedback preview as a dedicated settings-style section", () => {
  const source = readFileSync(demoPanelPath, "utf8");
  const dataSource = readFileSync(demoDataPath, "utf8");

  assert.match(source, /<FeedbackPatternsSection[\s\S]*title=\{demoSectionMeta\.feedback\.title\}/);
  assert.match(source, /description=\{demoSectionMeta\.feedback\.description\}/);
  assert.match(dataSource, /title: "Empty \/ Skeleton \/ Toast Mock"/);
});

test("settings demo panel renders card list item and modal preview sections as dedicated sections", () => {
  const source = readFileSync(demoPanelPath, "utf8");

  assert.match(source, /<CardListItemSection[\s\S]*title=\{demoSectionMeta\.cardListItem\.title\}/);
  assert.match(source, /<DialogSection[\s\S]*title=\{demoSectionMeta\.dialog\.title\}/);
  assert.match(source, /<SheetSection[\s\S]*title=\{demoSectionMeta\.sheet\.title\}/);
});

test("settings demo panel cleans up toast timers and keeps toast preview scoped", () => {
  const source = readFileSync(demoPanelPath, "utf8");

  assert.match(source, /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*clearTimeout\(toastTimerRef\.current\)/);
  assert.doesNotMatch(source, /pointer-events-none fixed bottom-6 right-6 z-50/);
});

test("settings demo panel uses shared demo fixtures for sidebar previews", () => {
  const source = readFileSync(demoPanelPath, "utf8");

  assert.equal(existsSync(demoFixturesPath), true);
  assert.match(source, /from "@\/lib\/demo-fixtures"/);
  assert.match(source, /demoSidebarPreviewFolders/u);
  assert.match(source, /folderItems=\{demoSidebarPreviewFolders\}/u);
  assert.doesNotMatch(source, /const sidebarPreviewItems/);
  assert.doesNotMatch(source, /const sidebarPreviewFolders/);
  assert.doesNotMatch(source, /const sidebarPreviewThreads/);
});

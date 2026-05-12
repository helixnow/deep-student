import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, "App.tsx");
const sidebarDataPath = path.join(__dirname, "lib", "sidebar-data.tsx");

test("settings navigation keeps the compact system-preferences groups and restores the demo page", () => {
  const source = readFileSync(sidebarDataPath, "utf8");

  for (const pattern of [
    /id: "general"/,
    /label: "通用"/,
    /id: "appearance"/,
    /label: "外观"/,
    /id: "models"/,
    /label: "模型"/,
    /id: "tools"/,
    /label: "工具"/,
    /id: "advanced"/,
    /label: "高级"/,
    /id: "about"/,
    /label: "关于"/,
    /id: "demo"/,
    /label: "组件 Demo"/,
  ]) {
    assert.match(source, pattern);
  }
});

test("app lazily loads the large app and settings surfaces", () => {
  const source = readFileSync(appPath, "utf8");

  assert.match(source, /const SettingsPanel = React\.lazy\(\(\) =>[\s\S]*import\("@\/components\/content\/SettingsPanel"\)[\s\S]*default: module\.SettingsPanel/u);
  assert.match(source, /const ThreadCanvas = React\.lazy\(\(\) =>[\s\S]*import\("@\/components\/content\/ThreadCanvas"\)[\s\S]*default: module\.ThreadCanvas/u);
  assert.match(source, /<React\.Suspense fallback=\{<AppSurfaceFallback \/>\}>/u);
  assert.doesNotMatch(source, /import \{ SettingsPanel \} from "@\/components\/content\/SettingsPanel";/u);
  assert.doesNotMatch(source, /import \{ ThreadCanvas \} from "@\/components\/content\/ThreadCanvas";/u);
});

test("app keeps sidebar folder order in local state and wires a reorder callback into the shell", () => {
  const source = readFileSync(appPath, "utf8");

  assert.match(source, /const \[orderedFolderItems, setOrderedFolderItems\] = useState\(sidebarFolderItems\);/u);
  assert.match(source, /const handleReorderFolders = \(sourceFolderId: string, targetFolderId: string\) => \{/u);
  assert.match(source, /setOrderedFolderItems\(\(current\) => \{/u);
  assert.match(source, /const sourceIndex = current\.findIndex\(\(item\) => item\.id === sourceFolderId\);/u);
  assert.match(source, /const targetIndex = current\.findIndex\(\(item\) => item\.id === targetFolderId\);/u);
  assert.match(source, /next\.splice\(targetIndex, 0, movedFolder\);/u);
  assert.match(source, /folderItems=\{orderedFolderItems\}/u);
  assert.match(source, /onReorderFolders=\{handleReorderFolders\}/u);
});


test("sidebar data keeps support types internal to the module", () => {
  const source = readFileSync(sidebarDataPath, "utf8");

  assert.doesNotMatch(source, /export type SidebarFolderItem/u);
  assert.doesNotMatch(source, /export type SettingsNavItem/u);
  assert.doesNotMatch(source, /export type ThreadItem/u);
});

test("home sidebar demo data includes folders and explicit pinned conversation metadata", () => {
  const source = readFileSync(sidebarDataPath, "utf8");

  assert.match(source, /export const sidebarFolderItems:/u);
  assert.match(source, /count:\s*threadItems\.filter/u);
  assert.match(source, /folderId:\s*"[a-z-]+"/u);
  assert.match(source, /pinned:\s*true/u);
});

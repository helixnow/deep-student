import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const appPath = path.resolve(process.cwd(), "src/App.tsx");

describe("App sidebar update badge source", () => {
  it("guards the desktop shell update badge behind updater visibility state", () => {
    const source = readFileSync(appPath, "utf8");

    assert.match(source, /function SidebarUpdateBadge\(\{/u);
    assert.match(source, /visible:\s*boolean;/u);
    assert.match(source, /onClick:\s*\(\)\s*=>\s*void;/u);
    assert.match(source, /downloading:\s*boolean;/u);
    assert.match(source, /if\s*\(!visible\)\s*return null;/u);
    assert.match(
      source,
      /<DesktopSidebarAccessory[\s\S]*updateVisible=\{!updater\.checking && updater\.available && !!updater\.info\}[\s\S]*onUpdate=\{\(\) => void updater\.performUpdateAction\(\)\}[\s\S]*updateDownloading=\{updater\.downloading\}/u,
    );
  });

  it("hides the update badge immediately once the desktop sidebar collapses", () => {
    const source = readFileSync(appPath, "utf8");

    assert.match(
      source,
      /<SidebarUpdateBadge[\s\S]*visible=\{updateVisible && !collapsed\}[\s\S]*onClick=\{onUpdate\}[\s\S]*downloading=\{updateDownloading\}/u,
    );
  });

  it("uses an icon-only loading state instead of the 下载中 label", () => {
    const source = readFileSync(appPath, "utf8");

    assert.doesNotMatch(source, /\{downloading \? '下载中' : '更新'\}/u);
    assert.match(source, /downloading\s*\?\s*<CircleNotch[\s\S]*animate-spin/u);
  });
});

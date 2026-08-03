import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const appPath = path.resolve(process.cwd(), "src/App.tsx");
const sidebarPath = path.resolve(process.cwd(), "src/components/ModernSidebar.tsx");

describe("sidebar update badge source", () => {
  it("passes updater state to the sidebar instead of the desktop titlebar", () => {
    const source = readFileSync(appPath, "utf8");

    assert.match(
      source,
      /<ModernSidebar[\s\S]*updater=\{updater\}/u,
    );
    assert.doesNotMatch(source, /function SidebarUpdateBadge\(\{/u);
    assert.doesNotMatch(source, /updateVisible=\{updateBadgeVisible\}/u);
  });

  it("keeps the sidebar update badge behind updater visibility state", () => {
    const source = readFileSync(sidebarPath, "utf8");

    assert.match(
      source,
      /const shouldShowUpdateBadge = Boolean\([\s\S]*!sidebarCollapsed && updater && !updater\.checking && updater\.available && updater\.info/u,
    );
    assert.match(source, /data-slot="sidebar-update-badge"/u);
    assert.match(source, /void updater\.performUpdateAction\(\)/u);
  });

  it("uses an icon-only loading state instead of the 下载中 label", () => {
    const source = readFileSync(sidebarPath, "utf8");

    assert.doesNotMatch(source, /\{downloading \? '下载中' : '更新'\}/u);
    assert.match(source, /updater\?\.downloading\s*\?\s*\([\s\S]*<CircleNotch[\s\S]*animate-spin/u);
    assert.match(source, /:\s*t\('sidebar:update\.short'\)/u);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = '/Users/ba7mlv/Documents/ui/study-ui';

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('window background preference drives distinct opaque and translucent shell classes', () => {
  const appChrome = read('src/components/shell/AppChrome.tsx');
  const sidebar = read('src/components/shell/Sidebar.tsx');
  const shellHelpers = read('src/lib/app-shell.ts');

  assert.equal(
    appChrome.includes('getShellBackdropClass(desktopPlatform, titlebarMode, windowBackgroundPreference)'),
    true,
    'AppChrome should keep using the shared shell backdrop helper for opaque and translucent modes',
  );
  assert.equal(
    sidebar.includes('getSidebarSurfaceClass(windowBackgroundPreference)'),
    true,
    'Sidebar should source opaque and translucent surface classes from the shared shell helper',
  );
  assert.equal(
    shellHelpers.includes('windowBackgroundPreference === "opaque"'),
    true,
    'shell helpers should still keep opaque and translucent sidebar surface behavior distinct',
  );
  assert.equal(shellHelpers.includes('bg-[color:var(--shell-sidebar-surface)]'), true, 'translucent sidebar surface should use the dedicated sidebar glass token');
  assert.equal(shellHelpers.includes('bg-[color:var(--shell-panel-strong)]'), true, 'main content surface should use the stronger shell panel token');
  assert.equal(shellHelpers.includes('bg-[color:var(--shell-backdrop)]'), true, 'shell backdrop should use the dedicated shell backdrop token');
});

test('settings appearance surfaces keep solid panels and describe the glass-sidebar toggle clearly', () => {
  const settingsPanel = read('src/components/content/SettingsPanel.tsx');

  assert.equal(
    settingsPanel.includes('bg-[color:var(--shell-panel)]'),
    true,
    'Settings cards should use solid panel background',
  );
  assert.equal(
    settingsPanel.includes('bg-background/98'),
    true,
    'Settings controls should use near-opaque background',
  );
  assert.equal(
    settingsPanel.includes('毛玻璃侧边栏'),
    true,
    'Settings copy should present the switch as a glass-sidebar toggle instead of a generic solid window toggle',
  );
  assert.equal(
    settingsPanel.includes('开启后使用系统毛玻璃侧边栏（Windows 为系统材质）'),
    true,
    'Settings copy should explain that enabling the switch uses native glass/sidebar material',
  );
  assert.equal(
    settingsPanel.includes('关闭后使用纯色侧边栏'),
    true,
    'Settings copy should explain that disabling the switch returns to the solid appearance',
  );
  assert.equal(
    settingsPanel.includes('系统减少透明度或材质不可用时会自动回退'),
    true,
    'Settings copy should still explain the automatic reduced-transparency fallback',
  );
  assert.equal(
    settingsPanel.includes('使用更实的窗口外观'),
    false,
    'Old generic solid-window label should be removed',
  );
  assert.equal(
    settingsPanel.includes('checked={windowBackgroundPreference === "translucent"}'),
    true,
    'The glass-sidebar switch should read as enabled when the translucent/native-material mode is active',
  );
  assert.equal(
    settingsPanel.includes('使用毛玻璃侧边栏'),
    false,
    'The label should be tightened to a shorter system-style phrase',
  );
});

test('reduced transparency stays token-driven instead of adding web blur layers', () => {
  const styles = read('src/styles/app.css');

  assert.equal(
    styles.includes('@media (prefers-reduced-transparency: reduce)'),
    true,
    'app styles should opt into prefers-reduced-transparency',
  );
  assert.equal(
    styles.includes('color-mix(in oklab, var(--shell-backdrop)'),
    true,
    'reduced transparency should strengthen existing shell tokens',
  );
  assert.equal(
    styles.includes('backdrop-filter'),
    false,
    'app styles should not add a new global backdrop-filter stack',
  );
});

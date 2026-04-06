import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsPanelPath = path.join(__dirname, "SettingsPanel.tsx");
const settingsNavPath = path.join(__dirname, "SettingsNav.tsx");
const settingsStatsPanelPath = path.join(__dirname, "SettingsStatsPanel.tsx");
const statsPanelDataPath = path.join(__dirname, "stats-panel-data.ts");
const sidebarDataPath = path.join(__dirname, "../../lib/sidebar-data.tsx");
const settingsPanelLibPath = path.join(__dirname, "../../lib/settings-panel.ts");

test("settings panel keeps the requested settings controls while adopting a quieter structure", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  for (const label of [
    "语言设置",
    "全局界面缩放（实验）",
    "全局字体",
    "字体大小",
    "外观 / 主题",
    "侧边栏毛玻璃强度",
    "记忆系统",
    "匿名错误报告",
    "顶部栏顶部边距高度",
    "打开统一调试面板",
    "复制内容过滤",
    "数据流向说明",
    "前往数据治理",
  ]) {
    assert.equal(source.includes(label), true, `missing label: ${label}`);
  }
});

test("settings panel keeps the narrow grouped preferences layout without a duplicated page header", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.match(source, /data-slot="settings-page-header"/u);
  assert.match(source, /data-slot="settings-content-column"/u);
  assert.match(source, /data-slot="settings-section-group"/u);
  assert.match(source, /max-w-\[46rem\]/u);
});

test("settings panel does not render a duplicated right-side settings title nav", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.doesNotMatch(source, /<SettingsNav/u);
  assert.doesNotMatch(source, /activeLabel:\s*string/u);
});

test("settings cleanup removes the obsolete settings nav file and active label helper", () => {
  assert.equal(existsSync(settingsNavPath), false);

  const sidebarSource = readFileSync(sidebarDataPath, "utf8");
  assert.doesNotMatch(sidebarSource, /export function getActiveSettingsLabel/u);
});

test("settings cleanup removes the obsolete stats panel files and appearance helper", () => {
  assert.equal(existsSync(settingsStatsPanelPath), false);
  assert.equal(existsSync(statsPanelDataPath), false);

  const settingsPanelLibSource = readFileSync(settingsPanelLibPath, "utf8");
  assert.doesNotMatch(settingsPanelLibSource, /export function shouldShowAppearanceSettings/u);
  assert.doesNotMatch(settingsPanelLibSource, /export type SettingsPanelSection/u);
});

test("settings panel avoids repeating sidebar labels as section titles for single-section pages", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.match(source, /const settingsPageMeta:/u);
  assert.match(source, /general:\s*\{[\s\S]*title:\s*"通用"/u);
  assert.match(source, /appearance:\s*\{[\s\S]*title:\s*"外观"/u);
  assert.doesNotMatch(source, /<SettingsSection\s+[\s\S]*title="通用"/u);
  assert.doesNotMatch(source, /<SettingsSection\s+[\s\S]*title="外观"/u);
});

test("settings panel removes oversized showcase headings and decorative palette gradients", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.doesNotMatch(source, /text-\[2rem\]/u);
  assert.doesNotMatch(source, /linear-gradient\(/u);
  assert.doesNotMatch(source, /组件与状态预览/u);
});

test("appearance panel removes both palette selection and self color customization", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  for (const label of ["主题调色板", "柔和默认", "极光蓝", "森林绿", "纸纹质感"]) {
    assert.equal(source.includes(label), false, `unexpected palette label: ${label}`);
  }

  assert.equal(source.includes("自选色"), false, "unexpected label: 自选色");
});

test("appearance panel exposes a compact slider for sidebar glass strength", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.match(source, /title="侧边栏毛玻璃强度"/u);
  assert.match(source, /开启后生效；数值越高，毛玻璃越明显。/u);
  assert.match(source, /aria-label="侧边栏毛玻璃强度"/u);
  assert.match(source, /type="range"/u);
  assert.match(source, /disabled=\{windowBackgroundPreference !== "translucent"\}/u);
  assert.match(source, /SIDEBAR_GLASS_INTENSITY_RANGE\.min/u);
  assert.match(source, /SIDEBAR_GLASS_INTENSITY_RANGE\.max/u);
  assert.match(source, /SIDEBAR_GLASS_INTENSITY_RANGE\.step/u);
  assert.match(source, /updateSetting\("sidebarGlassIntensity", Number\(event\.currentTarget\.value\)\)/u);
});

test("settings panel explains why preview-only actions stay disabled", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.match(source, /引擎对比和新增入口会在真实引擎配置页接入后开放，当前先保持只读预览。/u);
});

test("settings panel page header and inline controls use normalized type and radius classes", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.match(source, /<header data-slot="settings-page-header"/u);
  assert.match(source, /text-xl font-semibold text-foreground/u);
  assert.doesNotMatch(source, /text-\[15px\]/u);
  assert.doesNotMatch(source, /rounded-\[20px\]/u);
  assert.doesNotMatch(source, /rounded-\[15px\]/u);
  assert.doesNotMatch(source, /rounded-\[24px\]/u);
});

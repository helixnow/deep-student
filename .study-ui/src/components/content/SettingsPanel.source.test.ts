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
const oldSettingsContentWidthPattern = new RegExp(["max-w", "[46rem]"].join("-").replace("[", "\\[").replace("]", "\\]"), "u");
const mobileSurfaceForkPattern = new RegExp(`${["MobileSettings", "Panel"].join("")}|${["MobileThread", "Canvas"].join("")}`, "u");

test("settings panel keeps the requested settings controls while adopting a quieter structure", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  for (const label of [
    "语言设置",
    "全局界面缩放（实验）",
    "全局字体",
    "字体大小",
    "外观 / 主题",
    "macOS 原生字体平滑",
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
  assert.match(source, /const settingsContentColumnStyle = \{[\s\S]*maxWidth: "var\(--workspace-max-width\)"/u);
  assert.match(source, /style=\{settingsContentColumnStyle\}/u);
  assert.doesNotMatch(source, oldSettingsContentWidthPattern);
});

test("settings panel does not render a duplicated right-side settings title nav", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.doesNotMatch(source, /<SettingsNav/u);
  assert.doesNotMatch(source, /activeLabel:\s*string/u);
  assert.doesNotMatch(source, mobileSurfaceForkPattern);
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

test("appearance panel shows a real theme material preview instead of palette chips", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.match(source, /title="当前主题预览"/u);
  assert.match(source, /data-slot="settings-theme-preview"/u);
  assert.match(source, /data-slot="settings-theme-preview-sidebar"/u);
  assert.match(source, /data-slot="settings-theme-preview-panel"/u);
  assert.match(source, /data-slot="settings-theme-preview-action"/u);
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

test("appearance panel exposes a dedicated macOS native font smoothing toggle", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.match(source, /title="macOS 原生字体平滑"/u);
  assert.match(source, /macOS 下优先跟随系统默认字体平滑策略，不再全局强制 antialiased/u);
  assert.match(source, /ariaLabel="切换 macOS 原生字体平滑"/u);
  assert.match(source, /checked=\{settings\.macosNativeFontSmoothing\}/u);
  assert.match(source, /updateSetting\("macosNativeFontSmoothing", checked\)/u);
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

test("settings panel uses a native language dropdown while keeping theme tabs compact", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.match(source, /<select[\s\S]*aria-label="语言设置"[\s\S]*value=\{settings\.language\}[\s\S]*onChange=\{\(event\) => updateSetting\("language", event\.currentTarget\.value as AppLanguage\)\}/u);
  assert.match(source, /className=\{cn\([\s\S]*SETTINGS_SURFACE_INPUT_CLASS_NAME,[\s\S]*appearance-none[\s\S]*pr-11[\s\S]*focus-visible:ring-2 focus-visible:ring-ring/u);
  assert.match(source, /languageOptions\.map\(\(option\) => \(\s*<option[\s\S]*key=\{option\.value\}[\s\S]*value=\{option\.value\}/u);
  assert.match(source, /<CaretDown[\s\S]*aria-hidden="true"[\s\S]*size=\{16\}[\s\S]*weight="bold"[\s\S]*text-muted-foreground/u);
  assert.doesNotMatch(source, /<Tabs\s+value=\{settings\.language\}/u);
  assert.doesNotMatch(source, /<TabsList[\s\S]*aria-label="语言设置"/u);
  assert.match(source, /grid h-auto w-full grid-cols-3 rounded-2xl px-1 py-1/u);
  assert.match(source, /className="min-h-\[var\(--touch-target-size\)\] gap-2 rounded-xl px-3 text-sm font-medium lg:min-h-9 lg:px-4\.5"/u);
  assert.doesNotMatch(source, /md:min-h-9/u);
});

test("appearance theme selector uses Phosphor icons", () => {
  const source = readFileSync(settingsPanelPath, "utf8");
  const phosphorImport = source.match(/import \{[\s\S]*?\} from "@phosphor-icons\/react";/u)?.[0] ?? "";

  assert.match(phosphorImport, /\bSun\b/u);
  assert.match(phosphorImport, /\bMoon\b/u);
  assert.match(phosphorImport, /\bDesktop\b/u);
  assert.match(source, /title="外观 \/ 主题"[\s\S]*description="使用浅色、深色，或匹配系统设置"/u);
  assert.match(source, /<Sun size=\{20\} weight="regular" \/>[\s\S]*浅色/u);
  assert.match(source, /<Moon size=\{20\} weight="regular" \/>[\s\S]*深色/u);
  assert.match(source, /<Desktop size=\{20\} weight="regular" \/>[\s\S]*系统默认/u);
});

test("settings switch rows expose row-level touch targets without rewriting the global switch primitive", () => {
  const source = readFileSync(settingsPanelPath, "utf8");
  const switchSource = readFileSync(path.join(__dirname, "../ui/switch.tsx"), "utf8");

  assert.match(source, /import \{ type CSSProperties, type ReactNode, useId \} from "react";/u);
  assert.match(source, /function SettingsSwitchRow/u);
  assert.match(source, /data-slot="settings-switch-row"/u);
  assert.match(source, /min-h-\[var\(--touch-target-size\)\]/u);
  assert.match(source, /htmlFor=\{switchId\}/u);
  assert.match(source, /id=\{switchId\}/u);

  for (const label of [
    "毛玻璃侧边栏",
    "调试日志",
    "显示消息请求体",
    "持久化调试日志",
    "自动创建子文件夹",
    "隐私模式",
    "匿名错误报告",
  ]) {
    assert.match(source, new RegExp(`<SettingsSwitchRow[\\s\\S]*title="${label}"`, "u"));
  }

  assert.match(switchSource, /h-\[var\(--touch-target-size\)\]/u);
  assert.doesNotMatch(switchSource, /settings-switch-row|useId/u);
});

test("embedding dimensions degrade to compact definition cards while preserving a desktop table", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.match(source, /data-slot="embedding-dimensions-cards" className="grid gap-3 lg:hidden"/u);
  assert.match(source, /<dl className="grid gap-3 text-sm">/u);
  assert.match(source, /<dt className="text-muted-foreground">\{label\}<\/dt>/u);
  assert.match(source, /data-slot="embedding-dimensions-table"/u);
  assert.match(source, /className="hidden overflow-hidden rounded-3xl border border-border\/70 bg-background\/90 shadow-sm shadow-black\/5 lg:block"/u);

  for (const label of ["维度", "关联模型", "数据集", "数据量", "类型", "状态"]) {
    assert.equal(source.includes(label), true, `missing compact dimension label: ${label}`);
  }
});

test("settings preview dialogs use viewport-safe sizing and compact padding", () => {
  const source = readFileSync(settingsPanelPath, "utf8");

  assert.match(source, /max-h-\[calc\(100dvh-var\(--layout-safe-area-top\)-var\(--layout-safe-area-bottom\)-1\.5rem\)\]/u);
  assert.match(source, /overflow-y-auto rounded-2xl/u);
  assert.match(source, /px-4 py-4 sm:px-6 sm:py-5/u);
  assert.match(source, /px-4 py-4 sm:px-6 sm:py-6/u);
  assert.match(source, /text-xl sm:text-2xl/u);
});

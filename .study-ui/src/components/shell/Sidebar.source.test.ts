import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sidebarPath = path.join(__dirname, "Sidebar.tsx");

test("sidebar exposes codex-style primary, conversation, and footer regions", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /aria-label="工作区主入口"/u);
  assert.match(source, /aria-label="会话分组"/u);
  assert.match(source, /aria-label="侧边栏底部"/u);
  assert.doesNotMatch(source, /aria-label="文件夹导航"/u);
});

test("sidebar primary entries keep only conversation and learning-resource launchers", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /label: "新对话", icon: <ChatCenteredText size=\{18\} \/>/u);
  assert.match(source, /label: "学习资源", icon: <Books size=\{18\} \/>/u);
  assert.match(source, /label: "待办", icon: <CheckSquare size=\{18\} \/>/u);
  assert.doesNotMatch(source, /label: "技能"/u);
  assert.doesNotMatch(source, /MagicWand/u);
  assert.doesNotMatch(source, /label: "新线程"/u);
  assert.doesNotMatch(source, /label: "自动化"/u);
});

test("new conversation launcher is an action without a selected state", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(
    source,
    /\{ id: "new-conversation", label: "新对话", icon: <ChatCenteredText size=\{18\} \/>, active: false \}/u,
  );
  assert.doesNotMatch(
    source,
    /\{ id: "new-conversation", label: "新对话", icon: <ChatCenteredText size=\{18\} \/>, active: true \}/u,
  );
});

test("new conversation launcher can reveal a macOS desktop shortcut on hover", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /showNewConversationShortcut\?: boolean;/u);
  assert.match(source, /function NewConversationShortcutHint\(\)/u);
  assert.match(source, />\s*⌘N\s*<\/kbd>/u);
  assert.match(source, /showNewConversationShortcut = false/u);
  assert.match(source, /const showShortcut = showNewConversationShortcut && item\.id === "new-conversation";/u);
  assert.match(source, /showShortcut && "group\/new-conversation-action"/u);
  assert.match(source, /group-hover\/new-conversation-action:opacity-100/u);
  assert.match(source, /group-focus-visible\/new-conversation-action:opacity-100/u);
  assert.match(source, /lg:inline-flex/u);
  assert.match(source, /\{showShortcut \? <NewConversationShortcutHint \/> : null\}/u);
});

test("sidebar primary entries tighten desktop density without reducing the mobile touch target", () => {
  const source = readFileSync(sidebarPath, "utf8");
  const primaryStart = source.indexOf("primaryItems.map((item) => {");
  const primaryEnd = source.indexOf("{threadGroups.pinned.length > 0 ?", primaryStart);

  assert.notEqual(primaryStart, -1);
  assert.notEqual(primaryEnd, -1);

  const primaryBlock = source.slice(primaryStart, primaryEnd);

  assert.match(
    primaryBlock,
    /"w-full rounded-2xl bg-interactive-selected text-sidebar-foreground lg:min-h-8 lg:gap-2 lg:py-1"/u,
  );
  assert.match(
    primaryBlock,
    /"rounded-2xl text-sidebar-foreground hover:bg-interactive-hover hover:text-sidebar-foreground lg:min-h-8 lg:gap-2 lg:py-1"/u,
  );
  assert.doesNotMatch(primaryBlock, /md:min-h-/u);
});

test("sidebar section labels stay quiet instead of dashboard-style uppercase tags", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /text-\[11px\] font-normal text-sidebar-muted/u);
  assert.doesNotMatch(source, /uppercase/u);
  assert.doesNotMatch(source, /tracking-/u);
});

test("active rows rely on the filled selection surface only, without a leading indicator", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.doesNotMatch(source, /h-4 w-1 shrink-0 rounded-full bg-primary/u);
  assert.doesNotMatch(source, /activeIndicatorClassName/u);
  assert.doesNotMatch(source, /border-l/u);
  assert.doesNotMatch(source, /shadow-sm shadow-black\/5/u);
});

test("active thread row uses only a filled muted surface without border or shadow", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(
    source,
    /item\.active\s*\?\s*"w-full rounded-2xl bg-interactive-selected text-sidebar-foreground"/u,
  );
});

test("active settings row uses the same quiet filled selection logic without border or shadow", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(
    source,
    /isActive\s*\?\s*"w-full rounded-2xl bg-interactive-selected text-sidebar-foreground cursor-default"/u,
  );
  assert.doesNotMatch(source, /shadow-sm shadow-black\/5/u);
  assert.doesNotMatch(source, /border border-sidebar-border\/70/u);
});

test("settings entry stays in a quiet footer zone without a divider line", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /className="mt-auto px-2 pb-2 pt-1\.5"/u);
  assert.doesNotMatch(source, /border-t border-sidebar-border\/80/u);
});

test("app mode footer keeps the settings entry reachable", () => {
  const source = readFileSync(sidebarPath, "utf8");
  const footerStart = source.indexOf('<div aria-label="侧边栏底部"');
  const footerEnd = source.indexOf("</aside>", footerStart);

  assert.notEqual(footerStart, -1);
  assert.notEqual(footerEnd, -1);

  const footerBlock = source.slice(footerStart, footerEnd);

  assert.match(footerBlock, /currentMode === "app"/u);
  assert.match(footerBlock, /data-slot="sidebar-app-settings-action"/u);
  assert.match(footerBlock, /onClick=\{handleOpenSettings\}/u);
  assert.match(footerBlock, /GearSix size=\{18\}/u);
  assert.match(footerBlock, />设置</u);
  assert.doesNotMatch(footerBlock, /border-t border-sidebar-border\/80/u);
});

test("sidebar section labels do not have an extra divider line above them", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.doesNotMatch(source, /aria-hidden="true"[\s\S]*h-px w-full shrink-0/u);
});

test("settings mode does not render a category label above settings navigation", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.doesNotMatch(source, /设置分类/u);
});

test("sidebar app mode uses grouped data instead of a single flat threadItems map", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /primaryItems/u);
  assert.match(source, /threadGroups\.pinned/u);
  assert.match(source, /recentFolders\.map/u);
  assert.doesNotMatch(source, /threadItems\.map/u);
});

test("sidebar conversation rows surface folder provenance and a pin affordance for priority threads", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /PushPinSimple/u);
  assert.match(source, /item\.pinned/u);
  assert.match(source, /folderLabelById\.get\(item\.folderId\)/u);
  assert.match(source, /tabular-nums/u);
});

test("pinned threads render before workspace and folder sections in app mode", () => {
  const source = readFileSync(sidebarPath, "utf8");
  const workspaceIndex = source.indexOf('aria-label="工作区主入口"');
  const pinnedSectionIndex = source.indexOf('aria-label="置顶会话"');
  const recentIndex = source.indexOf("最近");

  assert.notEqual(workspaceIndex, -1);
  assert.notEqual(pinnedSectionIndex, -1);
  assert.notEqual(recentIndex, -1);
  assert.ok(workspaceIndex < pinnedSectionIndex);
  assert.ok(pinnedSectionIndex < recentIndex);
});

test("thread folder provenance stays lightweight text instead of a filled capsule", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /<span className="truncate">\{folderLabelById\.get\(item\.folderId\) \?\? "未分类"\}<\/span>/u);
  assert.doesNotMatch(source, /inline-flex max-w-28 items-center truncate rounded-full bg-sidebar-accent px-2 py-0\.5/u);
});

test("recent threads are organized under collapsible folder rows instead of a standalone folder block", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /expandedFolderIds/u);
  assert.match(source, /toggleFolder/u);
  assert.match(source, /aria-expanded=\{isExpanded\}/u);
  assert.match(source, /CaretRight/u);
  assert.match(source, /pl-4/u);
  assert.doesNotMatch(source, /<p className=\{sectionLabelClassName\}>文件夹<\/p>/u);
});

test("recent folder groups tighten desktop density without shrinking mobile touch targets", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /<section className="space-y-0\.5">[\s\S]*<div className="space-y-0\.5">/u);
  assert.match(source, /className=\{\s*isCurrentFolder[\s\S]*lg:min-h-8 lg:gap-2 lg:py-1/u);
  assert.match(source, /className=\{\s*item\.active[\s\S]*lg:min-h-8 lg:gap-2 lg:py-1/u);
  assert.doesNotMatch(source, /md:min-h-8/u);
});

test("sidebar can close compact drawer after meaningful navigation selections", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /closeOnSelect\?: boolean;/u);
  assert.match(source, /closeOnSelect = false/u);
  assert.match(
    source,
    /const closeSidebarAfterSelection = \(\) => \{\s*if \(closeOnSelect\) \{\s*onToggleSidebar\(\);\s*\}\s*\};/u,
  );
  assert.match(
    source,
    /const handleReturnToApp = \(\) => \{\s*onReturnToApp\(\);\s*closeSidebarAfterSelection\(\);\s*\};/u,
  );
  assert.match(
    source,
    /const handleOpenSettings = \(\) => \{\s*onOpenSettings\(\);\s*closeSidebarAfterSelection\(\);\s*\};/u,
  );
  assert.match(
    source,
    /const handleSelectSettingsTab = \(tabId: string\) => \{\s*onSelectSettingsTab\(tabId\);\s*closeSidebarAfterSelection\(\);\s*\};/u,
  );
  assert.match(source, /onClick=\{closeSidebarAfterSelection\}/u);
  assert.match(source, /onClick=\{handleReturnToApp\}/u);
  assert.match(source, /onClick=\{handleOpenSettings\}/u);
  assert.match(source, /onClick=\{isActive \? undefined : \(\) => handleSelectSettingsTab\(item\.id\)\}/u);
});

test("folder disclosure stays open and does not trigger compact drawer close", () => {
  const source = readFileSync(sidebarPath, "utf8");
  const toggleFolderStart = source.indexOf("const toggleFolder = (folderId: string) => {");
  const toggleFolderEnd = source.indexOf("return (", toggleFolderStart);

  assert.notEqual(toggleFolderStart, -1);
  assert.notEqual(toggleFolderEnd, -1);

  const toggleFolderBlock = source.slice(toggleFolderStart, toggleFolderEnd);

  assert.doesNotMatch(toggleFolderBlock, /closeSidebarAfterSelection/u);
  assert.match(source, /onClick=\{\(\) => toggleFolder\(folder\.id\)\}/u);
});

test("folder disclosure keeps motion subtle with icon rotation and a compact collapse transition", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /transition-transform duration-150 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none/u);
  assert.match(source, /transition-\[grid-template-rows,opacity\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none/u);
  assert.match(source, /grid-rows-\[1fr\]/u);
  assert.match(source, /grid-rows-\[0fr\]/u);
  assert.match(source, /overflow-hidden/u);
});

test("folder rows drop the static count badge and only reveal an add affordance on hover", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /import \{[\s\S]*Plus,[\s\S]*\} from "@phosphor-icons\/react";/u);
  assert.match(source, /Plus size=\{12\}/u);
  assert.match(source, /group-hover:opacity-100/u);
  assert.match(source, /group-focus-visible:opacity-100/u);
  assert.doesNotMatch(source, /<span>\{folder\.items\.length\}<\/span>/u);
  assert.doesNotMatch(source, /inline-flex min-w-6 items-center justify-center rounded-full bg-sidebar-accent/u);
});

test("recent section header drops the trailing total count for a cleaner rail", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /<p className=\{sectionLabelClassName\}>最近<\/p>/u);
  assert.match(source, /<div className="px-3">\s*<p className=\{sectionLabelClassName\}>最近<\/p>\s*<\/div>/u);
  assert.doesNotMatch(source, /<span className="text-\[11px\] font-normal tabular-nums text-sidebar-muted">\{threadGroups\.recent\.length\}<\/span>/u);
});

test("conversation rows keep a tighter rhythm and pin recent timestamps to the far right", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /<span className="min-w-0 flex-1 space-y-0\.5">[\s\S]*<PushPinSimple/u);
  assert.match(source, /<span className="flex items-center gap-2 leading-4">/u);
  assert.match(source, /className="flex min-w-0 items-center gap-1\.5 text-\[11px\] font-normal text-sidebar-muted leading-4"/u);
  assert.match(source, /<span className="flex min-w-0 flex-1 items-center justify-between gap-2">/u);
  assert.match(source, /<span className="min-w-0 flex-1 truncate leading-4">\{item\.title\}<\/span>/u);
  assert.match(source, /className="shrink-0 text-\[11px\] font-normal tabular-nums text-sidebar-muted leading-4"/u);
  assert.doesNotMatch(source, /className="block text-\[11px\] font-normal tabular-nums text-sidebar-muted leading-4"/u);
});

test("pinned rows rely on the pin icon instead of a dedicated section label", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /aria-label="置顶会话"/u);
  assert.match(source, /<PushPinSimple size=\{12\} weight="fill" className="text-sidebar-muted" \/>/u);
  assert.doesNotMatch(source, /<p className=\{sectionLabelClassName\}>置顶<\/p>/u);
});

test("conversation rows keep only the title line and drop the secondary change preview copy", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.doesNotMatch(source, /ClockCounterClockwise/u);
  assert.doesNotMatch(source, /detail\?\.(change|preview)/u);
  assert.doesNotMatch(source, /不再展开成 dashboard 卡片/u);
  assert.doesNotMatch(source, /继续收敛当前布局语法与输入区节奏/u);
});

test("sidebar touch targets stay at least 44px tall on compact screens", () => {
  const source = readFileSync(sidebarPath, "utf8");
  const shellButtonSource = readFileSync(path.join(__dirname, "ShellButton.tsx"), "utf8");

  assert.match(shellButtonSource, /min-h-\[2\.75rem\][\s\S]*text-(?:\[\d+px\]|sm)/u);
  assert.match(shellButtonSource, /lg:min-h-9/u);
  assert.doesNotMatch(shellButtonSource, /md:min-h-9/u);
  assert.match(source, /<ShellButton/u);
});

test("sidebar width stays one notch tighter than the earlier 280px rail", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /className\?: string;/u);
  assert.match(source, /w-68 shrink-0/u);
  assert.match(source, /className,\s*$/mu);
  assert.match(source, /getSidebarSurfaceClass\(windowBackgroundPreference\),[\s\S]*className,/u);
  assert.doesNotMatch(source, /w-70 shrink-0/u);
});

test("sidebar top control row uses the shared native titlebar height instead of a fixed 52px band", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /getSidebarHeaderHeight\(titlebarMode\)/u);
  assert.doesNotMatch(source, /className="relative h-13 shrink-0 pr-4"/u);
});

test("sidebar top control row keeps the same surface color as the sidebar under native transparent traffic lights", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /getSidebarSurfaceClass/u);
  assert.match(source, /titlebarMode === "native-transparent"/u);
  assert.match(source, /className=\{cn\("relative shrink-0 pr-4", sidebarHeaderSurfaceClass\)\}/u);
  assert.doesNotMatch(source, /getTitlebarSurfaceClass/u);
});

test("sidebar native transparent header no longer owns the traffic-light accessory cluster", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(source, /import \{ SidebarUpdateBadge \} from "\.\/SidebarUpdateBadge";/u);
  assert.match(
    source,
    /titlebarMode === "frameless"/u,
  );
  assert.doesNotMatch(
    source,
    /currentMode === "app" && titlebarMode !== "native-overlay" && !showFloatingSidebarToggle/u,
  );
});

test("sidebar frameless header keeps the collapse toggle before the update badge", () => {
  const source = readFileSync(sidebarPath, "utf8");

  assert.match(
    source,
    /currentMode === "app" && titlebarMode === "frameless" && !showFloatingSidebarToggle \? \(\s*<div className="pointer-events-auto flex items-center gap-1\.5">[\s\S]*<ShellButton[\s\S]*aria-label="收起侧边栏"[\s\S]*<SidebarSimple size=\{18\} weight="regular" \/>[\s\S]*<\/ShellButton>[\s\S]*<SidebarUpdateBadge className="shrink-0" \/>[\s\S]*<\/div>/u,
  );
});

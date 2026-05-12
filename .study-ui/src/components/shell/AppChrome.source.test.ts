import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appChromePath = path.join(__dirname, "AppChrome.tsx");
const oldSettingsScrollPaddingPattern = new RegExp(["px-6 pb-10", "md:px-20"].join(" "), "u");

test("main content pane keeps translucency subtle instead of glassy", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const mainWorkspaceSurfaceClass = getMainWorkspaceSurfaceClass\(windowBackgroundPreference\);/u);
  assert.doesNotMatch(source, /backdrop-blur-xl/u);
});

test("main pane exposes a lightweight visible app header instead of only a drag hotspot", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const mainDragHotspotHeight = mainAreaTopOffset \+ headerTopInset \+ 46;/u);
  assert.match(source, /import \{ Titlebar \} from "\.\/Titlebar";/u);
  assert.match(source, /const appHeaderTitle = "新对话";/u);
  assert.match(source, /<Titlebar[\s\S]*variant="app"/u);
  assert.match(source, /appHeaderTitle/u);
  assert.doesNotMatch(source, /style=\{\{ paddingTop: mainAreaTopOffset \}\}/u);
  assert.match(source, /<div className="box-border flex h-full min-h-0 flex-col">/u);
});

test("app header keeps the title on the left and a dedicated actions group on the right", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /<h1 className="hidden truncate text-sm font-medium text-foreground sm:block">/u);
  assert.match(source, /data-slot="app-header-actions"/u);
  assert.match(source, /className="pointer-events-auto flex shrink-0 items-center gap-2 text-muted-foreground"/u);
  assert.match(source, /desktopPlatform=\{desktopPlatform\}/u);
  assert.match(source, /titlebarMode=\{titlebarMode\}/u);
});

test("desktop app header reserves environment, mode, status, and diff summary affordances", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const showDesktopHeaderStatus = !isCompactViewport;/u);
  assert.match(source, /\{showDesktopHeaderStatus \? \(/u);
  assert.match(source, />\s*本地环境\s*</u);
  assert.match(source, />\s*提交模式\s*</u);
  assert.match(source, /data-slot="app-header-status-icon"/u);
  assert.match(source, /data-slot="app-header-diff-summary"/u);
  assert.match(source, />\s*\+12\s*</u);
  assert.match(source, />\s*-3\s*</u);
});

test("compact app header hides desktop status noise while keeping a core action", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const showCompactHeaderActions = isCompactViewport;/u);
  assert.match(source, /<h1 className="hidden truncate text-sm font-medium text-foreground sm:block">/u);
  assert.match(
    source,
    /\{showCompactHeaderActions \? \(\s*<ShellButton[\s\S]*aria-label="新建对话"[\s\S]*<NotePencil size=\{18\} weight="regular" \/>[\s\S]*<\/ShellButton>\s*\) : null\}/u,
  );
  assert.match(
    source,
    /\{showDesktopHeaderStatus \? \(\s*<>[\s\S]*data-slot="app-header-status-icon"[\s\S]*data-slot="app-header-diff-summary"[\s\S]*<\/>\s*\) : null\}/u,
  );
});

test("settings mode exposes the current destination in the main content region", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const activeSettingsItem = settingsNavItems\.find\(\(item\) => item\.id === activeSettingsTab\);/u);
  assert.match(source, /const settingsPageTitle = activeSettingsItem\?\.label \?\? "设置";/u);
  assert.match(source, /aria-label=\{currentMode === "settings" \? `设置 - \$\{settingsPageTitle\}` : undefined\}/u);
});

test("app header stays lightweight without an extra card, divider, or heavy background bar", () => {
  const source = readFileSync(appChromePath, "utf8");
  const appTitlebarBlock = source.match(/<Titlebar[\s\S]*variant="app"[\s\S]*<\/Titlebar>/u)?.[0] ?? "";

  assert.match(source, /<Titlebar[\s\S]*variant="app"/u);
  assert.match(source, /<Titlebar[\s\S]*windowBackgroundPreference=\{windowBackgroundPreference\}/u);
  assert.notEqual(appTitlebarBlock, "");
  assert.doesNotMatch(appTitlebarBlock, /border-b/u);
  assert.doesNotMatch(appTitlebarBlock, /bg-card\/96/u);
  assert.doesNotMatch(appTitlebarBlock, /shadow-(md|lg|xl)/u);
});

test("desktop sidebar uses a quiet width transition instead of JS-driven overlay choreography", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const isDockedSidebarExpanded = shouldRenderDockedSidebar && isSidebarVisible;/u);
  assert.match(source, /transition-\[width\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none/u);
  assert.doesNotMatch(source, /data-floating-sidebar-closing-layer/u);
  assert.doesNotMatch(source, /DOCKED_SIDEBAR_EXIT_MS/u);
  assert.doesNotMatch(source, /setShowDockedSidebarClosingLayer/u);
  assert.doesNotMatch(source, /window\.setTimeout/u);
});

test("desktop docked sidebar keeps motion on a single inner surface with a subtle nonlinear slide", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /data-floating-sidebar-layer/u);
  assert.match(source, /const dockedSidebarSurfaceClass = getNavigationSurfaceClass\(windowBackgroundPreference\);/u);
  assert.match(source, /className=\{cn\(/u);
  assert.match(source, /dockedSidebarSurfaceClass/u);
  assert.match(
    source,
    /<div[\s\S]*data-floating-sidebar-layer[\s\S]*transition-\[width\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none/u,
  );
  assert.match(source, /transition-\[transform,opacity\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none/u);
  assert.match(source, /isDockedSidebarExpanded \? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0"/u);
});

test("app chrome consumes the shared responsive layout policy", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /import \{ getAppLayoutPolicy \} from "@\/lib\/app-layout-policy";/u);
  assert.match(
    source,
    /import \{[\s\S]*getBrowserResponsiveEnvironment,[\s\S]*getServerResponsiveEnvironment,[\s\S]*subscribeResponsiveEnvironment,[\s\S]*\} from "@\/lib\/responsive-env";/u,
  );
  assert.match(
    source,
    /const responsiveEnvironment = useSyncExternalStore\(\s*subscribeResponsiveEnvironment,\s*getBrowserResponsiveEnvironment,\s*getServerResponsiveEnvironment,\s*\);/u,
  );
  assert.match(source, /const layoutPolicy = useMemo\(\s*\(\) => getAppLayoutPolicy\(responsiveEnvironment\),\s*\[responsiveEnvironment\],\s*\);/u);
  assert.match(source, /const isCompactViewport = layoutPolicy\.isCompact;/u);
  assert.match(source, /const shouldRenderDrawerSidebar = layoutPolicy\.sidebarMode === "drawer";/u);
  assert.match(source, /const shouldRenderDockedSidebar = layoutPolicy\.sidebarMode === "docked";/u);
  assert.doesNotMatch(source, /max-width: 767px/u);
  assert.doesNotMatch(source, /compactViewportQuery/u);
  assert.doesNotMatch(source, /subscribeCompactViewport/u);
  assert.doesNotMatch(source, /getCompactViewport/u);
});

test("app chrome routes split sidebar state by the active sidebar mode", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /mobileSidebarOpen: boolean;/u);
  assert.match(source, /sidebarCollapsed: boolean;/u);
  assert.match(source, /onToggleMobileSidebar: \(\) => void;/u);
  assert.match(source, /onToggleSidebarCollapsed: \(\) => void;/u);
  assert.match(
    source,
    /const isSidebarVisible = shouldRenderDrawerSidebar\s*\?\s*mobileSidebarOpen\s*:\s*!sidebarCollapsed \|\| shouldPinSidebarOpen;/u,
  );
  assert.match(
    source,
    /const handleToggleSidebar = \(\) => \{\s*if \(shouldRenderDrawerSidebar\) \{\s*onToggleMobileSidebar\(\);\s*return;\s*\}\s*onToggleSidebarCollapsed\(\);\s*\};/u,
  );
  assert.doesNotMatch(source, /\bisSidebarOpen\b/u);
  assert.doesNotMatch(source, /\bonToggleSidebar: \(\) => void;/u);
});

test("new conversation shortcut hint is limited to macOS docked desktop sidebar", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(
    source,
    /const showMacDesktopNewConversationShortcut =\s*desktopPlatform === "macos" && shouldRenderDockedSidebar && layoutPolicy\.density === "desktop";/u,
  );
  assert.match(source, /showNewConversationShortcut=\{false\}/u);
  assert.match(source, /showNewConversationShortcut=\{showMacDesktopNewConversationShortcut\}/u);
});

test("shell root exposes responsive policy and sidebar state datasets", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /data-form-factor=\{layoutPolicy\.formFactor\}/u);
  assert.match(source, /data-sidebar-mode=\{layoutPolicy\.sidebarMode\}/u);
  assert.match(source, /data-density=\{layoutPolicy\.density\}/u);
  assert.match(source, /data-shell-mode=\{layoutPolicy\.shellMode\}/u);
  assert.match(source, /data-compact=\{layoutPolicy\.isCompact \? "true" : "false"\}/u);
  assert.match(source, /data-sidebar-visible=\{isSidebarVisible \? "true" : "false"\}/u);
  assert.match(source, /data-sidebar-collapsed=\{isDockedSidebarExpanded \? "false" : "true"\}/u);
  assert.match(source, /data-platform=\{desktopPlatform\}/u);
});

test("compact viewports present the sidebar through the shared sheet drawer", () => {
  const source = readFileSync(appChromePath, "utf8");
  const closeOnSelectContracts = source.match(/closeOnSelect=\{shouldRenderDrawerSidebar\}/gu) ?? [];

  assert.match(
    source,
    /import \{[\s\S]*Sheet,[\s\S]*SheetClose,[\s\S]*SheetContent,[\s\S]*SheetDescription,[\s\S]*SheetTitle,[\s\S]*\} from "@\/components\/ui\/sheet";/u,
  );
  assert.match(source, /\{shouldRenderDrawerSidebar \? \(/u);
  assert.match(source, /<Sheet[\s\S]*open=\{shouldRenderDrawerSidebar && isSidebarVisible\}/u);
  assert.match(source, /<SheetContent side="left" className="w-\[min\(92vw,19rem\)\] border-r p-0 \[&>button\]:hidden"/u);
  assert.match(source, /<SheetTitle className="sr-only">侧边栏<\/SheetTitle>/u);
  assert.match(source, /<SheetDescription className="sr-only">[\s\S]*移动端侧边栏/u);
  assert.match(source, /<Sidebar[\s\S]*className="w-full"[\s\S]*closeOnSelect=\{shouldRenderDrawerSidebar\}/u);
  assert.equal(closeOnSelectContracts.length, 2);
});

test("phone settings are presented as a real sheet instead of replacing the main page", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const shouldRenderMobileSettingsSheet = layoutPolicy\.formFactor === "phone";/u);
  assert.match(source, /const isMobileSettingsSheetOpen = currentMode === "settings" && shouldRenderMobileSettingsSheet;/u);
  assert.match(source, /const shouldShowAppSurface = currentMode === "app" \|\| isMobileSettingsSheetOpen;/u);
  assert.match(
    source,
    /const handleMobileSettingsSheetOpenChange = \(open: boolean\) => \{\s*if \(!open\) \{\s*resetMobileSettingsDrag\(\);\s*onReturnToApp\(\);\s*\}\s*\};/u,
  );
  assert.match(source, /<Sheet open=\{isMobileSettingsSheetOpen\} onOpenChange=\{handleMobileSettingsSheetOpenChange\}>/u);
  assert.match(source, /useRef, useState, useSyncExternalStore/u);
  assert.match(source, /const mobileSettingsDragStartYRef = useRef<number \| null>\(null\);/u);
  assert.match(source, /const mobileSettingsDragOffsetRef = useRef\(0\);/u);
  assert.match(source, /const \[mobileSettingsDragOffset, setMobileSettingsDragOffset\] = useState\(0\);/u);
  assert.match(source, /const \[isMobileSettingsDragging, setIsMobileSettingsDragging\] = useState\(false\);/u);
  assert.match(source, /const handleMobileSettingsDragStart = \(event: React\.PointerEvent<HTMLDivElement>\) => \{[\s\S]*setPointerCapture\(event\.pointerId\);[\s\S]*\};/u);
  assert.match(source, /const handleMobileSettingsDragMove = \(event: React\.PointerEvent<HTMLDivElement>\) => \{[\s\S]*Math\.max\(0, event\.clientY - mobileSettingsDragStartYRef\.current\)[\s\S]*\};/u);
  assert.match(source, /const handleMobileSettingsDragEnd = \(event: React\.PointerEvent<HTMLDivElement>\) => \{[\s\S]*mobileSettingsDragOffsetRef\.current > 96[\s\S]*onReturnToApp\(\);[\s\S]*\};/u);
  assert.match(source, /<SheetContent[\s\S]*side="bottom"[\s\S]*data-slot="mobile-settings-sheet"[\s\S]*overlayClassName="bg-\[rgba\(17,17,17,0\.4\)\]"[\s\S]*h-\[min\(86dvh,calc\(100dvh-0\.5rem\)\)\][\s\S]*max-h-\[calc\(100dvh-0\.5rem\)\][\s\S]*rounded-t-\[24px\][\s\S]*bg-\[#FFFFFF\][\s\S]*text-\[#111111\][\s\S]*\[&>button\]:hidden/u);
  assert.match(source, /style=\{[\s\S]*transform: `translateY\(\$\{mobileSettingsDragOffset\}px\)`[\s\S]*transition: isMobileSettingsDragging \? "none" : undefined/u);
  assert.match(source, /data-slot="mobile-settings-sheet-drag-zone"[\s\S]*onPointerDown=\{handleMobileSettingsDragStart\}[\s\S]*onPointerMove=\{handleMobileSettingsDragMove\}[\s\S]*onPointerUp=\{handleMobileSettingsDragEnd\}/u);
  assert.match(source, /data-slot="mobile-settings-sheet-drag-handle" className="h-1 w-12 rounded-full bg-\[#C9CDD6\]"/u);
  assert.match(source, /data-slot="mobile-settings-sheet-header"[\s\S]*border-b border-\[rgba\(17,17,17,0\.08\)\]/u);
  assert.match(source, /<SheetTitle[\s\S]*系统设置[\s\S]*<\/SheetTitle>/u);
  assert.match(source, /<SheetDescription className="text-xs font-medium leading-5 text-\[#5C5C5F\]">[\s\S]*应用偏好与数据选项/u);
  assert.match(source, /<SheetClose asChild>[\s\S]*aria-label="关闭系统设置"[\s\S]*active:scale-\[0\.97\][\s\S]*focus-visible:ring-\[rgba\(0,113,227,0\.5\)\][\s\S]*<X size=\{20\} weight="regular" \/>/u);
  assert.match(source, /data-slot="mobile-settings-sheet-nav-rail"[\s\S]*className="relative shrink-0 bg-white py-2"/u);
  assert.match(
    source,
    /data-slot="mobile-settings-sheet-nav"[\s\S]*aria-label="移动端设置分类"[\s\S]*snap-x[\s\S]*gap-2[\s\S]*overflow-x-auto[\s\S]*px-5[\s\S]*py-1[\s\S]*\[-webkit-overflow-scrolling:touch\][\s\S]*\[scrollbar-width:none\][\s\S]*\[&::-webkit-scrollbar\]:hidden/u,
  );
  assert.match(source, /settingsNavItems\.map\(\(item\) => \{[\s\S]*activeSettingsTab === item\.id/u);
  assert.match(source, /data-slot=\{`mobile-settings-sheet-nav-\$\{item\.id\}`\}/u);
  assert.match(source, /onClick=\{isActiveMobileSettingsTab \? undefined : \(\) => onSelectSettingsTab\(item\.id\)\}/u);
  assert.match(source, /className=\{cn\([\s\S]*snap-start[\s\S]*shrink-0[\s\S]*rounded-\[14px\][\s\S]*px-3\.5[\s\S]*active:scale-\[0\.97\]/u);
  assert.match(source, /<span className="flex size-5 items-center justify-center \[&_svg\]:size-4">\{item\.icon\}<\/span>/u);
  assert.match(source, /active:scale-\[0\.97\] focus-visible:ring-2 focus-visible:ring-\[rgba\(0,113,227,0\.5\)\]/u);
  assert.match(source, /isActiveMobileSettingsTab[\s\S]*\? "bg-\[#EEF0F4\] text-\[#111111\] shadow-none"[\s\S]*: "bg-transparent text-\[#3A3A3C\] hover:bg-\[#EEF0F4\]"/u);
  assert.doesNotMatch(source, /border-\[rgba\(17,17,17,0\.08\)\] bg-white text-\[#3A3A3C\]/u);
  assert.match(source, /data-slot="mobile-settings-sheet-nav-edge"[\s\S]*bg-gradient-to-l from-white via-white\/85 to-transparent/u);
  assert.match(source, /data-slot="mobile-settings-sheet-scroll"[\s\S]*viewportClassName="px-5 pb-\[calc\(1\.25rem\+var\(--safe-area-bottom\)\)\] pt-4"/u);
  assert.match(source, /data-slot="mobile-settings-sheet-real-content"[\s\S]*\[--touch-target-size:var\(--control-height-touch\)\][\s\S]*\[--workspace-max-width:100%\][\s\S]*\[&_\[data-slot=settings-page-header\]\]:hidden[\s\S]*\{settingsContent\}/u);
  assert.doesNotMatch(source, /data-slot="mobile-settings-sheet-real-content"[\s\S]*data-theme="light"/u);
  assert.doesNotMatch(source, /data-slot="mobile-settings-sheet-real-content"[\s\S]*\[--background:#F5F5F7\]/u);
  assert.doesNotMatch(source, /data-slot="mobile-settings-sheet-real-content"[\s\S]*\[--primary:#0071E3\]/u);
  assert.match(source, /\[&_input\[type=range\]\]:min-h-11/u);
  assert.doesNotMatch(source, /mobileSettingsSheetTabs/u);
  assert.doesNotMatch(source, /账号管理/u);
  assert.doesNotMatch(source, /数据管理/u);
  assert.doesNotMatch(source, /overlayClassName="bg-\[rgba\(0,0,0,0\.72\)\]"/u);
  assert.doesNotMatch(source, /data-theme="dark"/u);
  assert.doesNotMatch(source, /bg-\[#26272b\]/u);
  assert.doesNotMatch(source, /mobileSettingsLanguageOptions/u);
  assert.doesNotMatch(source, /data-slot="mobile-settings-sheet-theme-light"/u);
  assert.doesNotMatch(source, /updateSetting\("language", event\.currentTarget\.value as AppLanguage\)/u);
  assert.match(source, /\{shouldShowAppSurface \? \(/u);
});

test("non-overlay shells keep a compact in-app sidebar toggle without overlay positioning", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const showFloatingSidebarToggle = false;/u);
  assert.match(source, /const showResizeHandles = titlebarMode === "frameless" && hasTauriRuntime\(\);/u);
  assert.match(source, /const collapsedSidebarToggleTop = mainAreaTopOffset \+ headerTopInset \+ 6;/u);
  assert.match(source, /!isSidebarVisible \? \(/u);
  assert.match(source, /getOverlayLeadingInset/u);
  assert.match(source, /getMacTitlebarControlTopInset/u);
  assert.match(
    source,
    /const sidebarToggleAccessoryOffset =\s*isCompactViewport \? 16 : titlebarMode === "native-transparent" \? getOverlayLeadingInset\(titlebarMode\) : 16;/u,
  );
  assert.match(
    source,
    /const sharedTrafficLightsAccessory =\s*desktopPlatform === "macos" && titlebarMode === "native-transparent" && !isCompactViewport && currentMode === "app"/u,
  );
  assert.doesNotMatch(source, /shouldShowInlineSidebarToggle/u);
  assert.doesNotMatch(source, /floatingSidebarTogglePosition/u);
});

test("compact leading sidebar accessory starts at the mobile edge without the update badge", () => {
  const source = readFileSync(appChromePath, "utf8");
  const accessoryStart = source.indexOf('data-slot="compact-leading-sidebar-accessory"');
  const accessoryEnd = source.indexOf("const sharedTrafficLightsAccessoryContent", accessoryStart);

  assert.notEqual(accessoryStart, -1);
  assert.notEqual(accessoryEnd, -1);

  const accessoryBlock = source.slice(accessoryStart, accessoryEnd);
  assert.match(source, /const sidebarToggleAccessoryOffset =\s*isCompactViewport \? 16/u);
  assert.match(accessoryBlock, /data-slot="compact-leading-sidebar-accessory"/u);
  assert.match(accessoryBlock, /isCompactViewport && "rounded-full bg-card\/85 shadow-sm shadow-black\/5 hover:bg-card"/u);
  assert.match(accessoryBlock, /\{isCompactViewport \? <List size=\{21\} weight="regular" \/> : isSidebarVisible \? <SidebarFrameWithLeftRailIcon \/> : <SidebarFrameIcon \/>\}/u);
  assert.match(accessoryBlock, /\{!isCompactViewport \? <SidebarUpdateBadge className="shrink-0" \/> : null\}/u);
});

test("desktop sidebar toggle changes between plain frame and left-rail frame states", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const toggleLabel = "切换边栏";/u);
  assert.doesNotMatch(source, /const toggleLabel = isSidebarVisible \? "收起侧边栏" : "展开侧边栏";/u);
  assert.match(source, /function SidebarFrameIcon\(\)/u);
  assert.match(source, /function SidebarFrameWithLeftRailIcon\(\)/u);
  assert.match(source, /isSidebarVisible \? <SidebarFrameWithLeftRailIcon \/> : <SidebarFrameIcon \/>/u);
  assert.match(source, /<rect x="32" y="48" width="192" height="160" rx="14" \/>/u);
  assert.match(source, /<path d="M88 48v160" \/>/u);
  assert.doesNotMatch(source, /<SidebarDockIcon \/>/u);
  assert.doesNotMatch(source, /m154 96-32 32 32 32/u);
  assert.doesNotMatch(source, /m122 96 32 32-32 32/u);
});

test("macOS traffic lights accessory lives on the shared chrome layer immediately to the right of the lights", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /import \{ SidebarUpdateBadge \} from "\.\/SidebarUpdateBadge";/u);
  assert.match(source, /import \{[\s\S]*List,[\s\S]*NotePencil,[\s\S]*Pulse,[\s\S]*\} from "@phosphor-icons\/react";/u);
  assert.match(
    source,
    /const sidebarToggleAccessoryContent = \(\s*<div data-slot="compact-leading-sidebar-accessory" className="flex items-center gap-1\.5">[\s\S]*<ShellButton[\s\S]*aria-label=\{toggleLabel\}[\s\S]*\{isCompactViewport \? <List size=\{21\} weight="regular" \/> : isSidebarVisible \? <SidebarFrameWithLeftRailIcon \/> : <SidebarFrameIcon \/>\}[\s\S]*<\/ShellButton>[\s\S]*\{!isCompactViewport \? <SidebarUpdateBadge className="shrink-0" \/> : null\}[\s\S]*<\/div>\s*\);/u,
  );
  assert.match(
    source,
    /const sharedTrafficLightsAccessoryWidth =\s*isDockedSidebarExpanded\s*\?\s*APP_LAYOUT_TOKENS\.FLOATING_SIDEBAR_WIDTH - sidebarToggleAccessoryOffset - 16\s*:\s*sharedTrafficLightsAccessoryInset - sidebarToggleAccessoryOffset;/u,
  );
  assert.match(
    source,
    /const sharedTrafficLightsAccessoryContent = \(\s*<div[\s\S]*className="flex items-center justify-between pr-1\.5 transition-\[width\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none"[\s\S]*style=\{\{\s*width: sharedTrafficLightsAccessoryWidth\s*\}\}[\s\S]*<div className="flex items-center">[\s\S]*<ShellButton[\s\S]*aria-label=\{toggleLabel\}[\s\S]*\{isSidebarVisible \? <SidebarFrameWithLeftRailIcon \/> : <SidebarFrameIcon \/>\}[\s\S]*<\/ShellButton>[\s\S]*<div[\s\S]*aria-hidden=\{isSidebarVisible\}[\s\S]*transition-\[width,opacity,margin-left\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none[\s\S]*!isSidebarVisible \? "ml-1\.5 w-\[calc\(var\(--button-icon-size\)\+0\.125rem\)\] opacity-100" : "ml-0 w-0 opacity-0"[\s\S]*transition-\[transform,opacity\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none[\s\S]*!isSidebarVisible \? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0"[\s\S]*<ShellButton[\s\S]*tabIndex=\{!isSidebarVisible \? undefined : -1\}[\s\S]*aria-label="新建对话"[\s\S]*<NotePencil size=\{18\} weight="regular" \/>[\s\S]*<\/ShellButton>[\s\S]*<\/div>[\s\S]*<\/div>[\s\S]*<SidebarUpdateBadge className="shrink-0" \/>[\s\S]*<\/div>\s*\);/u,
  );
  assert.match(
    source,
    /const sharedTrafficLightsAccessory =[\s\S]*<div data-slot="traffic-lights-accessory"/u,
  );
  assert.match(source, /<div className="pointer-events-auto">\{sharedTrafficLightsAccessoryContent\}<\/div>/u);
  assert.match(
    source,
    /style=\{\{\s*left: sidebarToggleAccessoryOffset,\s*top: getMacTitlebarControlTopInset\(titlebarMode\),\s*\}\}/u,
  );
  assert.match(source, /leadingAccessory=\{sharedTrafficLightsAccessory \? null : sidebarToggleAccessory\}/u);
  assert.match(
    source,
    /const titlebarAccessoryInset =\s*sidebarToggleAccessoryOffset \+ APP_LAYOUT_TOKENS\.MAC_TITLE_LEADING_OFFSET_AFTER_TOGGLE;/u,
  );
  assert.match(
    source,
    /const sharedTrafficLightsAccessoryInset =\s*titlebarAccessoryInset \+\s*APP_LAYOUT_TOKENS\.MAC_TITLE_LEADING_OFFSET_AFTER_TOGGLE \+\s*APP_LAYOUT_TOKENS\.MAC_TITLEBAR_CONTROL_SIZE;/u,
  );
  assert.match(
    source,
    /const titlebarLeadingInset =\s*!isDockedSidebarExpanded\s*\?\s*sharedTrafficLightsAccessory\s*\?\s*sharedTrafficLightsAccessoryInset\s*:\s*sidebarToggleAccessory\s*\?\s*titlebarAccessoryInset\s*:\s*0\s*:\s*0;/u,
  );
  assert.match(source, /leadingInset=\{titlebarLeadingInset\}/u);
  assert.match(source, /<div className="flex min-w-0 items-center">/u);
  assert.doesNotMatch(source, /titlebarTitleShift/u);
  assert.doesNotMatch(source, /translateX\(/u);
  assert.match(source, /sharedTrafficLightsAccessory/u);
});

test("traffic lights accessory shifts the update badge instead of flashing it during sidebar toggles", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /transition-\[width\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none/u);
  assert.match(source, /transition-\[width,opacity,margin-left\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none/u);
  assert.match(source, /transition-\[transform,opacity\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none/u);
  assert.match(source, /tabIndex=\{!isSidebarVisible \? undefined : -1\}/u);
  assert.doesNotMatch(source, /animate-presence|framer-motion|scale-95|scale-100/u);
});

test("traffic lights accessory stretches to the sidebar edge so the update badge sits on the right rail", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const sharedTrafficLightsAccessoryWidth =\s*isDockedSidebarExpanded/u);
  assert.match(source, /APP_LAYOUT_TOKENS\.FLOATING_SIDEBAR_WIDTH - sidebarToggleAccessoryOffset - 16/u);
  assert.match(source, /className="flex items-center justify-between pr-1\.5 transition-\[width\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none"/u);
  assert.match(source, /style=\{\{\s*width: sharedTrafficLightsAccessoryWidth\s*\}\}/u);
});

test("settings scroll region accounts for safe-area insets without adding route transition effects", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /data-platform=\{desktopPlatform\}/u);
  assert.match(source, /const settingsScrollPaddingTop = `calc\(\$\{mainDragHotspotHeight \+ 28\}px \+ var\(--safe-area-top\)\)`;/u);
  assert.match(source, /const settingsScrollPaddingBottom = `calc\(2\.5rem \+ var\(--safe-area-bottom\)\)`;/u);
  assert.match(source, /const settingsScrollPaddingLeft = "calc\(var\(--page-gutter-inline\) \+ var\(--layout-safe-area-left\)\)";/u);
  assert.match(source, /const settingsScrollPaddingRight = "calc\(var\(--page-gutter-inline\) \+ var\(--layout-safe-area-right\)\)";/u);
  assert.match(source, /paddingBottom: settingsScrollPaddingBottom/u);
  assert.match(source, /paddingLeft: settingsScrollPaddingLeft/u);
  assert.match(source, /paddingRight: settingsScrollPaddingRight/u);
  assert.match(source, /paddingTop: settingsScrollPaddingTop/u);
  assert.doesNotMatch(source, oldSettingsScrollPaddingPattern);
  assert.doesNotMatch(source, /animate-presence|framer-motion/u);
});

test("main pane seam is owned by the rounded workspace surface", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const splitSeamClass = getSplitSeamClass\(windowBackgroundPreference\);/u);
  assert.doesNotMatch(
    source,
    /<div\s+aria-hidden="true"\s+className=\{cn\("pointer-events-none absolute inset-y-0 z-30 w-px", splitSeamClass\)\}\s+style=\{\{ left: APP_LAYOUT_TOKENS.FLOATING_SIDEBAR_WIDTH \}\}\s*\/>/u,
  );
  assert.doesNotMatch(source, /absolute inset-y-0 left-0 z-20 w-px/u);
  assert.match(source, /isDockedSidebarExpanded && splitSeamClass/u);
  assert.doesNotMatch(source, /before:.*shadow/u);
  assert.doesNotMatch(source, /after:.*shadow/u);
});

test("visible left corners use a codex-like rounded workspace rim over the navigation gutter", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /import \{[\s\S]*getNavigationSurfaceClass,[\s\S]*\} from "@\/lib\/app-shell";/u);
  assert.match(source, /const mainWorkspaceChromeClass = getNavigationSurfaceClass\(windowBackgroundPreference\);/u);
  assert.match(
    source,
    /<main[\s\S]*className=\{cn\([\s\S]*isDockedSidebarExpanded && mainWorkspaceChromeClass[\s\S]*\}/u,
  );
  assert.match(
    source,
    /<div[\s\S]*className=\{cn\([\s\S]*mainWorkspaceSurfaceClass,[\s\S]*isDockedSidebarExpanded && "rounded-tl-\[var\(--radius-page\)\] rounded-bl-\[var\(--radius-page\)\] border-l"/u,
  );
  assert.doesNotMatch(source, /rounded-tr-\[var\(--radius-page\)\]|rounded-br-\[var\(--radius-page\)\]/u);
  assert.doesNotMatch(source, /ml-px rounded-tl-\[var\(--radius-section\)\]/u);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appChromePath = path.join(__dirname, "AppChrome.tsx");

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

  assert.match(source, /<h1 className="truncate text-sm font-medium text-foreground">/u);
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

  assert.match(source, /<Titlebar[\s\S]*variant="app"/u);
  assert.match(source, /<Titlebar[\s\S]*windowBackgroundPreference=\{windowBackgroundPreference\}/u);
  assert.doesNotMatch(source, /border-b/u);
  assert.doesNotMatch(source, /bg-card/u);
  assert.doesNotMatch(source, /shadow-(sm|md|lg|xl)/u);
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

  assert.match(source, /import \{ Sheet, SheetContent \} from "@\/components\/ui\/sheet";/u);
  assert.match(source, /\{shouldRenderDrawerSidebar \? \(/u);
  assert.match(source, /<Sheet[\s\S]*open=\{shouldRenderDrawerSidebar && isSidebarVisible\}/u);
  assert.match(source, /<SheetContent side="left" className="w-\[min\(92vw,19rem\)\] border-r p-0"/u);
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
    /const sidebarToggleAccessoryOffset =\s*titlebarMode === "native-transparent" \? getOverlayLeadingInset\(titlebarMode\) : 16;/u,
  );
  assert.match(
    source,
    /const sharedTrafficLightsAccessory =\s*desktopPlatform === "macos" && titlebarMode === "native-transparent" && !isCompactViewport && currentMode === "app"/u,
  );
  assert.doesNotMatch(source, /shouldShowInlineSidebarToggle/u);
  assert.doesNotMatch(source, /floatingSidebarTogglePosition/u);
});

test("macOS traffic lights accessory lives on the shared chrome layer immediately to the right of the lights", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /import \{ SidebarUpdateBadge \} from "\.\/SidebarUpdateBadge";/u);
  assert.match(source, /import \{ NotePencil, Pulse \} from "@phosphor-icons\/react";/u);
  assert.match(
    source,
    /const sidebarToggleAccessoryContent = \(\s*<div className="flex items-center gap-1\.5">[\s\S]*<ShellButton[\s\S]*aria-label=\{toggleLabel\}[\s\S]*<SidebarDockIcon \/>[\s\S]*<\/ShellButton>[\s\S]*<SidebarUpdateBadge className="shrink-0" \/>[\s\S]*<\/div>\s*\);/u,
  );
  assert.match(
    source,
    /const sharedTrafficLightsAccessoryWidth =\s*isDockedSidebarExpanded\s*\?\s*APP_LAYOUT_TOKENS\.FLOATING_SIDEBAR_WIDTH - sidebarToggleAccessoryOffset - 16\s*:\s*sharedTrafficLightsAccessoryInset - sidebarToggleAccessoryOffset;/u,
  );
  assert.match(
    source,
    /const sharedTrafficLightsAccessoryContent = \(\s*<div[\s\S]*className="flex items-center justify-between pr-1\.5 transition-\[width\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none"[\s\S]*style=\{\{\s*width: sharedTrafficLightsAccessoryWidth\s*\}\}[\s\S]*<div className="flex items-center">[\s\S]*<ShellButton[\s\S]*aria-label=\{toggleLabel\}[\s\S]*<SidebarDockIcon \/>[\s\S]*<\/ShellButton>[\s\S]*<div[\s\S]*aria-hidden=\{isSidebarVisible\}[\s\S]*transition-\[width,opacity,margin-left\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none[\s\S]*!isSidebarVisible \? "ml-1\.5 w-\[calc\(var\(--button-icon-size\)\+0\.125rem\)\] opacity-100" : "ml-0 w-0 opacity-0"[\s\S]*transition-\[transform,opacity\] duration-200 ease-\[cubic-bezier\(0\.25,0\.1,0\.25,1\)\] motion-reduce:transition-none[\s\S]*!isSidebarVisible \? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0"[\s\S]*<ShellButton[\s\S]*tabIndex=\{!isSidebarVisible \? undefined : -1\}[\s\S]*aria-label="新建对话"[\s\S]*<NotePencil size=\{18\} weight="regular" \/>[\s\S]*<\/ShellButton>[\s\S]*<\/div>[\s\S]*<\/div>[\s\S]*<SidebarUpdateBadge className="shrink-0" \/>[\s\S]*<\/div>\s*\);/u,
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
  assert.match(source, /style=\{\{ paddingBottom: settingsScrollPaddingBottom, paddingTop: settingsScrollPaddingTop \}\}/u);
  assert.doesNotMatch(source, /animate-presence|framer-motion/u);
});

test("main pane seam uses one continuous divider instead of before after corner patches", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /const splitSeamClass = getSplitSeamClass\(windowBackgroundPreference\);/u);
  assert.doesNotMatch(
    source,
    /<div\s+aria-hidden="true"\s+className=\{cn\("pointer-events-none absolute inset-y-0 z-30 w-px", splitSeamClass\)\}\s+style=\{\{ left: APP_LAYOUT_TOKENS.FLOATING_SIDEBAR_WIDTH \}\}\s*\/>/u,
  );
  assert.match(
    source,
    /<main[\s\S]*>\s*\{isDockedSidebarExpanded \? \(\s*<div[\s\S]*className=\{cn\("pointer-events-none absolute inset-y-0 left-0 z-20 w-px", splitSeamClass\)\}/u,
  );
  assert.doesNotMatch(source, /before:.*shadow/u);
  assert.doesNotMatch(source, /after:.*shadow/u);
});

test("visible left corners use a thin navigation-toned gutter instead of rounding the same-color surface directly", () => {
  const source = readFileSync(appChromePath, "utf8");

  assert.match(source, /import \{[\s\S]*getNavigationSurfaceClass,[\s\S]*\} from "@\/lib\/app-shell";/u);
  assert.match(source, /const mainWorkspaceChromeClass = getNavigationSurfaceClass\(windowBackgroundPreference\);/u);
  assert.match(
    source,
    /<main[\s\S]*className=\{cn\([\s\S]*isDockedSidebarExpanded && mainWorkspaceChromeClass[\s\S]*\}/u,
  );
  assert.match(
    source,
    /<div[\s\S]*className=\{cn\([\s\S]*mainWorkspaceSurfaceClass,[\s\S]*isDockedSidebarExpanded && "ml-px rounded-tl-\[var\(--radius-section\)\] rounded-bl-\[var\(--radius-section\)\]"/u,
  );
  assert.doesNotMatch(source, /rounded-tr-\[var\(--radius-section\)\]|rounded-br-\[var\(--radius-section\)\]/u);
});

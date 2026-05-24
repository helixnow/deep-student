import test from "node:test";
import assert from "node:assert/strict";

import {
  APPLE_ALIGNMENT_KEYWORDS,
  APPLE_ALIGNMENT_LAYERS,
  APP_LAYOUT_TOKENS,
  detectDesktopPlatform,
  getFloatingSidebarTogglePosition,
  getFloatingSidebarLayout,
  getHeaderTopInset,
  getHeaderRightPadding,
  getMainPaneContentOffset,
  getMainWorkspaceSurfaceClass,
  getNavigationSurfaceClass,
  shouldShowCustomWindowControls,
  getMainAreaTopOffset,
  getOverlayLeadingInset,
  getSidebarHeaderHeight,
  getSplitSeamClass,
  getSidebarSurfaceClass,
  getShellBackdropClass,
  getTitlebarSurfaceClass,
  getTitlebarMode,
} from "./app-shell.ts";

test("defines the shell layers in window chrome, navigation, workspace order", () => {
  assert.deepEqual(APPLE_ALIGNMENT_LAYERS, ["window chrome", "navigation", "workspace"]);
});

test("locks the Apple alignment keywords to the approved quiet desktop set", () => {
  assert.deepEqual(APPLE_ALIGNMENT_KEYWORDS, [
    "unified",
    "quiet",
    "task-first",
    "material-light",
    "native rhythm",
  ]);
});

test("uses the requested macOS and Windows safe zone tokens", () => {
  assert.equal(APP_LAYOUT_TOKENS.MAC_SAFE_ZONE, 40);
  assert.equal(APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_TOP_INSET, 14);
  assert.equal(APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_VISUAL_SIZE, 14);
  assert.equal(APP_LAYOUT_TOKENS.MAC_TITLEBAR_CONTROL_SIZE, 32);
  assert.equal(APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_TRAILING_EDGE, 64);
  assert.equal(APP_LAYOUT_TOKENS.MAC_TOGGLE_LEADING_OFFSET_FROM_TRAFFIC_LIGHTS, 12);
  assert.equal(APP_LAYOUT_TOKENS.MAC_TITLE_LEADING_OFFSET_AFTER_TOGGLE, 40);
  assert.equal(APP_LAYOUT_TOKENS.WIN_SAFE_ZONE, 120);
});

test("reserves a modest chrome offset above the unified toolbar on each desktop mode", () => {
  assert.equal(getMainAreaTopOffset(true, "native-overlay"), 12);
  assert.equal(getMainAreaTopOffset(false, "native-overlay"), 12);
  assert.equal(getMainAreaTopOffset(false, "native-transparent"), 6);
  assert.equal(getMainAreaTopOffset(false, "frameless"), 6);
});

test("keeps a soft shell backdrop behind translucent chrome on every platform", () => {
  assert.equal(getShellBackdropClass("macos", "native-overlay", "translucent"), "bg-[color:var(--shell-backdrop)]");
  assert.equal(getShellBackdropClass("macos", "native-transparent", "translucent"), "bg-[color:var(--shell-backdrop)]");
  assert.equal(getShellBackdropClass("macos", "native-overlay", "opaque"), "bg-background");
  assert.equal(getShellBackdropClass("windows", "frameless", "translucent"), "bg-[color:var(--shell-backdrop)]");
});

test("keeps header right padding aligned with each platform chrome", () => {
  assert.equal(getHeaderRightPadding("windows", "frameless"), 120);
  assert.equal(getHeaderRightPadding("macos", "native-overlay"), 24);
  assert.equal(getHeaderRightPadding("macos", "native-transparent"), 24);
});

test("shows custom window controls only for Windows frameless chrome", () => {
  assert.equal(shouldShowCustomWindowControls("windows", "frameless"), true);
  assert.equal(shouldShowCustomWindowControls("macos", "native-overlay"), false);
  assert.equal(shouldShowCustomWindowControls("macos", "native-transparent"), false);
});

test("adds a quiet titlebar inset so toolbar content sits on a shared baseline", () => {
  assert.equal(getHeaderTopInset(true, "native-overlay"), 8);
  assert.equal(getHeaderTopInset(false, "native-overlay"), 8);
  assert.equal(getHeaderTopInset(true, "native-transparent"), 6);
  assert.equal(getHeaderTopInset(true, "frameless"), 6);
});

test("keeps a horizontal safe inset for macOS traffic lights", () => {
  assert.equal(getOverlayLeadingInset("native-overlay"), 76);
  assert.equal(getOverlayLeadingInset("native-transparent"), 76);
  assert.equal(getOverlayLeadingInset("frameless"), 0);
});

test("keeps the docked sidebar width stable without a floating edge inset", () => {
  assert.equal(APP_LAYOUT_TOKENS.FLOATING_SIDEBAR_WIDTH, 272);
  assert.deepEqual(getFloatingSidebarLayout("native-overlay"), {
    edgeInset: 0,
    surfaceClassName: "w-68 shrink-0",
  });
  assert.deepEqual(getFloatingSidebarLayout("native-transparent"), {
    edgeInset: 0,
    surfaceClassName: "w-68 shrink-0",
  });
  assert.deepEqual(getFloatingSidebarLayout("frameless"), {
    edgeInset: 0,
    surfaceClassName: "w-68 shrink-0",
  });
});

test("keeps a shared left inset between the source list and unified toolbar", () => {
  assert.equal(getMainPaneContentOffset(true), 16);
  assert.equal(getMainPaneContentOffset(false), 0);
});

test("keeps the macOS sidebar control row on the native traffic-light centerline", () => {
  const nativeTrafficLightCenterline =
    APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_TOP_INSET +
    APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_VISUAL_SIZE / 2;
  const nativeTransparentControlCenterline =
    (getSidebarHeaderHeight("native-transparent") - APP_LAYOUT_TOKENS.MAC_TITLEBAR_CONTROL_SIZE) / 2 +
    APP_LAYOUT_TOKENS.MAC_TITLEBAR_CONTROL_SIZE / 2;

  assert.equal(getSidebarHeaderHeight("native-transparent"), 42);
  assert.equal(getSidebarHeaderHeight("native-overlay"), 52);
  assert.equal(getSidebarHeaderHeight("frameless"), 52);
  assert.equal(nativeTransparentControlCenterline, nativeTrafficLightCenterline);
});

test("keeps native transparent leading content outside the traffic-light zone", () => {
  assert.ok(
    getOverlayLeadingInset("native-transparent") >=
      APP_LAYOUT_TOKENS.MAC_TRAFFIC_LIGHTS_TRAILING_EDGE +
        APP_LAYOUT_TOKENS.MAC_TOGGLE_LEADING_OFFSET_FROM_TRAFFIC_LIGHTS,
  );
});

test("app titlebar keeps a dedicated shell titlebar surface instead of falling into the main workspace fill", () => {
  assert.equal(getNavigationSurfaceClass("opaque"), "bg-sidebar");
  assert.equal(getNavigationSurfaceClass("translucent"), "bg-[color:var(--shell-panel)]");
  assert.equal(getTitlebarSurfaceClass("opaque"), "bg-background");
  assert.equal(getTitlebarSurfaceClass("translucent"), "bg-[color:var(--shell-titlebar)]");
  assert.equal(getSidebarSurfaceClass("translucent"), getNavigationSurfaceClass("translucent"));
});

test("keeps main workspace and seam semantics separate from navigation chrome", () => {
  assert.equal(getMainWorkspaceSurfaceClass("opaque"), "bg-background");
  assert.equal(getMainWorkspaceSurfaceClass("translucent"), "bg-[color:var(--shell-panel-strong)]");
  assert.equal(getSplitSeamClass("opaque"), "border-sidebar-border/80");
  assert.equal(getSplitSeamClass("translucent"), "border-sidebar-border/55");
});

test("keeps sidebar surface classes flat when returning to a docked rail", () => {
  assert.equal(
    getSidebarSurfaceClass("opaque"),
    "bg-sidebar",
  );
  assert.equal(getSidebarSurfaceClass("translucent"), "bg-[color:var(--shell-panel)]");
});

test("allows an explicit titlebar inset override for developer debugging", () => {
  assert.equal(getHeaderTopInset(true, "native-overlay", 24), 24);
  assert.equal(getHeaderTopInset(false, "native-transparent", 18), 18);
  assert.equal(getHeaderTopInset(false, "native-transparent", 0), 0);
  assert.equal(getHeaderTopInset(false, "frameless", 18), 18);
  assert.equal(getHeaderTopInset(false, "frameless", 0), 0);
  assert.equal(getHeaderTopInset(false, "native-overlay", 0), 0);
});

test("pins the sidebar toggle on the traffic-light centerline with breathing room", () => {
  assert.deepEqual(getFloatingSidebarTogglePosition("native-overlay"), {
    top: 5,
    left: 76,
  });
  assert.equal(getFloatingSidebarTogglePosition("native-transparent"), null);
  assert.equal(getFloatingSidebarTogglePosition("frameless"), null);
});

test("uses native transparent titlebars on macOS and frameless chrome on Windows", () => {
  assert.equal(getTitlebarMode("macos"), "native-transparent");
  assert.equal(getTitlebarMode("windows"), "frameless");
});

test("detects desktop platforms from navigator hints", () => {
  assert.equal(
    detectDesktopPlatform({
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)",
    }),
    "macos",
  );
  assert.equal(
    detectDesktopPlatform({
      platform: "Win32",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    }),
    "windows",
  );
});


test("app shell keeps floating sidebar layout as an internal type", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./app-shell.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /export type FloatingSidebarLayout/u);
});

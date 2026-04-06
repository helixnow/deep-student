import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const titlebarPath = path.join(__dirname, "Titlebar.tsx");

test("app titlebar uses the same surface as the main workspace while native transparent macOS utility chrome keeps its own surface", () => {
  const source = readFileSync(titlebarPath, "utf8");

  assert.match(source, /getMainWorkspaceSurfaceClass/u);
  assert.match(source, /getTitlebarSurfaceClass/u);
  assert.match(source, /windowBackgroundPreference: WindowBackgroundMode;/u);
  assert.match(source, /const titlebarSurfaceClass =/u);
  assert.match(source, /variant === "app"/u);
  assert.match(source, /getMainWorkspaceSurfaceClass\(windowBackgroundPreference\)/u);
  assert.match(source, /desktopPlatform === "macos" && titlebarMode === "native-transparent"/u);
  assert.match(source, /getTitlebarSurfaceClass\(windowBackgroundPreference\)/u);
  assert.doesNotMatch(source, /border-b/u, "should not have bottom border");
});

test("titlebar eases leading inset through padding instead of animating text transforms", () => {
  const source = readFileSync(titlebarPath, "utf8");

  assert.match(source, /const headerPaddingLeft = \(variant === "app" \? 20 : 24\) \+ leadingInset;/u);
  assert.match(source, /const headerContentClassName = cn\(/u);
  assert.match(
    source,
    /shouldUseNativeTransparentChromeAlignment \? "items-start" : "items-center"/u,
  );
  assert.match(source, /paddingLeft: headerPaddingLeft/u);
  assert.doesNotMatch(source, /transition-transform/u);
  assert.doesNotMatch(source, /translateX\(/u);
});

test("native transparent app chrome anchors its title row to the same control line as the leading accessory", () => {
  const source = readFileSync(titlebarPath, "utf8");

  assert.match(
    source,
    /const shouldUseNativeTransparentChromeAlignment =\s*desktopPlatform === "macos" && titlebarMode === "native-transparent";/u,
  );
  assert.match(
    source,
    /const headerContentTop =\s*shouldUseNativeTransparentChromeAlignment\s*\?\s*getMacTitlebarControlTopInset\(titlebarMode\)\s*:\s*headerTopInset;/u,
  );
  assert.match(source, /paddingTop: headerContentTop/u);
  assert.match(
    source,
    /<div className=\{cn\("flex min-w-0 flex-1 items-center justify-between gap-4", shouldUseNativeTransparentChromeAlignment && "min-h-8"\)\}>/u,
  );
});

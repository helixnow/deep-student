import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appStylesPath = path.join(__dirname, "app.css");

test("shared shell tokens use soft rims instead of fully transparent borders", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /--border:\s*oklch\([^\n]+\/ 0\.08\);/u);
  assert.match(source, /--shell-rim:\s*oklch\([^\n]+\/ 0\.08\);/u);
  assert.doesNotMatch(source, /--border:\s*transparent;/u);
});

test("translucent window mode defines a dedicated shell palette instead of reusing opaque whites", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /\[data-window-background="translucent"\]\s*\{[\s\S]*--shell-surface:\s*#[0-9A-Fa-f]{6};/u);
  assert.match(source, /\[data-theme="dark"\]\[data-window-background="translucent"\]\s*\{[\s\S]*--shell-surface:\s*#[0-9A-Fa-f]{6};/u);
  assert.doesNotMatch(source, /--shell-surface:\s*rgba\(244,\s*244,\s*244,\s*0\.85\)/u);
});

test("light translucent shell palette keeps the warmer native split-view contrast", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /\[data-window-background="translucent"\]\s*\{[\s\S]*--sidebar:\s*#F2F2EE;/u);
  assert.match(source, /\[data-window-background="translucent"\]\s*\{[\s\S]*--shell-backdrop:\s*#E8E9E4;/u);
  assert.match(source, /\[data-window-background="translucent"\]\s*\{[\s\S]*--shell-panel:\s*#F2F3EF;/u);
  assert.match(source, /\[data-window-background="translucent"\]\s*\{[\s\S]*--shell-panel-strong:\s*#FBFBF8;/u);
  assert.match(source, /\[data-window-background="translucent"\]\s*\{[\s\S]*--shell-titlebar:\s*#ECEDE8;/u);
});

test("reduced transparency mode strengthens the shell tokens and stops relying on transparent roots", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /@media\s*\(prefers-reduced-transparency: reduce\)\s*\{[\s\S]*--shell-backdrop:\s*color-mix\(/u);
  assert.match(source, /@media\s*\(prefers-reduced-transparency: reduce\)\s*\{[\s\S]*--shell-panel:\s*color-mix\(/u);
  assert.match(source, /@media\s*\(prefers-reduced-transparency: reduce\)\s*\{[\s\S]*--shell-panel-strong:\s*color-mix\(/u);
  assert.match(source, /@media\s*\(prefers-reduced-transparency: reduce\)\s*\{[\s\S]*--shell-titlebar:\s*color-mix\(/u);
  assert.match(source, /@media\s*\(prefers-reduced-transparency: reduce\)\s*\{[\s\S]*--shell-float:\s*color-mix\(/u);
  assert.match(source, /@media\s*\(prefers-reduced-transparency: reduce\)\s*\{[\s\S]*--overlay:\s*color-mix\(/u);
  assert.match(source, /@media\s*\(prefers-reduced-transparency: reduce\)\s*\{[\s\S]*html\[data-window-background="translucent"\][\s\S]*background:\s*var\(--shell-backdrop\);/u);
  assert.doesNotMatch(source, /backdrop-blur-/u);
  assert.doesNotMatch(source, /@media\s*\(prefers-reduced-transparency: reduce\)\s*\{[\s\S]*backdrop-filter:/u);
});

test("light theme hover and selected tokens use separate neutral steps for clear state hierarchy", () => {
  const source = readFileSync(appStylesPath, "utf8");

  const hoverMatch = source.match(/:root\s*\{[\s\S]*--interactive-hover:\s*(#[0-9A-Fa-f]{6});/u);
  const selectedMatch = source.match(/:root\s*\{[\s\S]*--interactive-selected:\s*(#[0-9A-Fa-f]{6});/u);

  assert.ok(hoverMatch, "expected light theme hover token");
  assert.ok(selectedMatch, "expected light theme selected token");
  assert.notEqual(hoverMatch?.[1], selectedMatch?.[1]);
  assert.match(source, /\[data-theme="dark"\]\s*\{[\s\S]*--interactive-hover:\s*rgba\(255, 255, 255, 0\.08\);/u);
  assert.match(source, /\[data-theme="dark"\]\s*\{[\s\S]*--interactive-selected:\s*rgba\(255, 255, 255, 0\.14\);/u);
});

test("primary action colors keep readable foreground contrast in both themes", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /:root\s*\{[\s\S]*--primary:\s*oklch\(0\.52 0\.16 257\.8\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--primary-foreground:\s*#FAFBFF;/u);
  assert.match(source, /\[data-theme="dark"\]\s*\{[\s\S]*--primary:\s*oklch\(0\.78 0\.09 255\.4\);/u);
  assert.match(source, /\[data-theme="dark"\]\s*\{[\s\S]*--primary-foreground:\s*#101827;/u);
});

test("selection token is defined directly in both themes without runtime palette injection", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /:root\s*\{[\s\S]*--app-selection:\s*rgba\([^)]+\);/u);
  assert.match(source, /\[data-theme="dark"\]\s*\{[\s\S]*--app-selection:\s*rgba\([^)]+\);/u);
});

test("button-specific tokens define compact sizing and dedicated material states in both themes", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /:root\s*\{[\s\S]*--button-height:\s*2rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--button-radius:\s*9px;/u);
  assert.match(source, /:root\s*\{[\s\S]*--button-prominent-bg:\s*color-mix\(/u);
  assert.match(source, /:root\s*\{[\s\S]*--button-outline-border:\s*color-mix\(/u);
  assert.match(source, /\[data-theme="dark"\]\s*\{[\s\S]*--button-prominent-bg:\s*color-mix\(/u);
  assert.match(source, /\[data-theme="dark"\]\s*\{[\s\S]*--button-outline-border:\s*color-mix\(/u);
});

test("light theme focus ring and safe-area tokens stay explicit in the shared style layer", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /:root\s*\{[\s\S]*--ring:\s*oklch\([^\n]+\/ 0\.34\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--safe-area-top:\s*env\(safe-area-inset-top, 0px\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--safe-area-bottom:\s*env\(safe-area-inset-bottom, 0px\);/u);
});

test("translucent shell tokens add a Windows-specific mapping on top of the macOS baseline", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /\[data-platform="windows"\]\[data-window-background="translucent"\]\s*\{[\s\S]*--shell-backdrop:\s*#[0-9A-Fa-f]{6};/u);
  assert.match(source, /\[data-platform="windows"\]\[data-window-background="translucent"\]\s*\{[\s\S]*--shell-panel:\s*#[0-9A-Fa-f]{6};/u);
  assert.match(source, /\[data-theme="dark"\]\[data-platform="windows"\]\[data-window-background="translucent"\]\s*\{[\s\S]*--shell-panel-strong:\s*#[0-9A-Fa-f]{6};/u);
});

test("legacy .custom-scrollbar utility is removed in favor of the unified ScrollArea primitive (milestone v1.1 Phase 4)", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.doesNotMatch(source, /\.custom-scrollbar\s*\{/u);
  assert.doesNotMatch(source, /\.custom-scrollbar::-webkit-scrollbar/u);
});

test("overlayscrollbars variables bridge to the project scrollbar palette so theme switches update overlay colors via CSS variables alone", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /--os-handle-bg:\s*var\(--scrollbar-thumb\);/u);
  assert.match(source, /--os-handle-bg-hover:\s*var\(--scrollbar-thumb-hover\);/u);
  assert.match(source, /--os-handle-bg-active:\s*var\(--scrollbar-thumb-hover\);/u);
  assert.match(source, /--os-size:\s*6px;/u);
  assert.match(source, /--os-handle-min-size:\s*36px;/u);
  assert.match(source, /--os-handle-border-radius:\s*999px;/u);
  assert.match(source, /--scrollbar-overlay-z:\s*20;/u);
});

test("native scrollbar fallback is self-contained and reuses the project scrollbar tokens without depending on .custom-scrollbar", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /\.scroll-area--native\s*\{[\s\S]*scrollbar-width:\s*thin;/u);
  assert.match(source, /\.scroll-area--native\s*\{[\s\S]*scrollbar-color:\s*var\(--scrollbar-thumb\)\s*transparent;/u);
  assert.match(source, /\.scroll-area--native\s*\{[\s\S]*scrollbar-gutter:\s*stable;/u);
  assert.match(source, /\.scroll-area--native::-webkit-scrollbar\s*\{[\s\S]*width:\s*6px;[\s\S]*height:\s*6px;/u);
  assert.match(source, /\.scroll-area--native::-webkit-scrollbar-thumb\s*\{[\s\S]*background:\s*var\(--scrollbar-thumb\);/u);
  assert.match(source, /\.scroll-area--native::-webkit-scrollbar-thumb:hover\s*\{[\s\S]*background:\s*var\(--scrollbar-thumb-hover\);/u);
});

test("print media keeps overlayscrollbars viewports unclipped so window.print shows full content", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /@media print\s*\{[\s\S]*\[data-overlayscrollbars-viewport\]\s*\{[\s\S]*overflow:\s*visible\s*!important;/u);
  assert.match(source, /@media print\s*\{[\s\S]*\[data-overlayscrollbars-viewport\]\s*\{[\s\S]*height:\s*auto\s*!important;/u);
  assert.match(source, /@media print\s*\{[\s\S]*\[data-overlayscrollbars-viewport\]\s*\{[\s\S]*max-height:\s*none\s*!important;/u);
});

test("unified ui whitelist locks the allowed radii, type steps, shadows, and control heights", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /:root\s*\{[\s\S]*--radius-control:\s*0\.5rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--radius-panel:\s*0\.75rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--radius-section:\s*1rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--radius-page:\s*1\.5rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--font-step-11:\s*0\.6875rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--font-step-12:\s*0\.75rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--font-step-14:\s*0\.875rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--font-step-16:\s*1rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--font-step-18:\s*1\.125rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--font-step-20:\s*1\.25rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--font-step-24:\s*1\.5rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--shadow-surface:\s*0 16px 32px rgba\(15, 23, 42, 0\.05\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--shadow-popover:\s*0 18px 36px rgba\(15, 23, 42, 0\.08\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--control-height-compact:\s*2rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--control-height-touch:\s*2\.75rem;/u);
});

test("composer focus shadow stays in light theme and drops out in dark theme", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /:root\s*\{[\s\S]*--composer-focus-shadow-color:\s*rgb\(from var\(--interactive-hover\) r g b \/ 0\.92\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--shadow-composer-focus:\s*0 6px 14px var\(--composer-focus-shadow-color\);/u);
  assert.match(source, /\[data-theme="dark"\]\s*\{[\s\S]*--shadow-composer-focus:\s*none;/u);
  assert.doesNotMatch(source, /\[data-theme="dark"\]\s*\{[\s\S]*--composer-focus-shadow-color:/u);
});

test("composer border keeps a lighter rim in dark theme without changing the light theme baseline", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /:root\s*\{[\s\S]*--composer-border:\s*#E9E9E9;/u);
  assert.match(source, /\[data-theme="dark"\]\s*\{[\s\S]*--composer-border:\s*rgba\(255, 255, 255, 0\.08\);/u);
});

test("composer divider stays visible in light theme and disappears in dark theme", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /:root\s*\{[\s\S]*--composer-divider:\s*color-mix\(/u);
  assert.match(source, /\[data-theme="dark"\]\s*\{[\s\S]*--composer-divider:\s*transparent;/u);
});

test("page-level layout tokens distinguish navigation, workspace, and composer surfaces", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /:root\s*\{[\s\S]*--layout-nav-width:\s*var\(--sidebar-width\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--workspace-max-width:\s*44rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--composer-max-width:\s*44rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--composer-min-height:\s*5rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--composer-border:\s*#E9E9E9;/u);
  assert.match(source, /:root\s*\{[\s\S]*--composer-divider:\s*color-mix\(/u);
  assert.match(source, /@theme inline\s*\{[\s\S]*--color-composer-border:\s*var\(--composer-border\);/u);
});

test("root layout tokens define shared names for gutters, sidebar, safe-area, composer, and touch sizing", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /:root\s*\{[\s\S]*--layout-safe-area-top:\s*var\(--safe-area-top\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--layout-safe-area-right:\s*var\(--safe-area-right\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--layout-safe-area-bottom:\s*var\(--safe-area-bottom\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--layout-safe-area-left:\s*var\(--safe-area-left\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--layout-viewport-height:\s*calc\(100dvh - var\(--layout-safe-area-top\) - var\(--layout-safe-area-bottom\)\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--page-gutter-inline:\s*2rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--page-gutter-block:\s*1\.5rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--sidebar-mode:\s*docked;/u);
  assert.match(source, /:root\s*\{[\s\S]*--sidebar-width:\s*17rem;/u);
  assert.match(source, /:root\s*\{[\s\S]*--composer-bottom-offset:\s*calc\(1rem \+ var\(--layout-safe-area-bottom\)\);/u);
  assert.match(source, /:root\s*\{[\s\S]*--touch-target-size:\s*var\(--control-height-compact\);/u);
});

test("body font smoothing no longer hardcodes grayscale antialiasing and instead follows the macOS preference dataset", () => {
  const source = readFileSync(appStylesPath, "utf8");
  const baseBodyRuleMatch = source.match(/body\s*\{[\s\S]*?text-rendering:\s*optimizeLegibility;[\s\S]*?\n\s*\}/u);

  assert.ok(baseBodyRuleMatch, "expected to find the shared base body rule");
  assert.doesNotMatch(baseBodyRuleMatch?.[0] ?? "", /-webkit-font-smoothing:\s*antialiased;/u);
  assert.match(source, /\[data-font-smoothing="macos-native"\]\s*body\s*\{[\s\S]*-webkit-font-smoothing:\s*auto;/u);
  assert.match(source, /\[data-font-smoothing="macos-native"\]\s*body\s*\{[\s\S]*-moz-osx-font-smoothing:\s*auto;/u);
  assert.match(source, /\[data-font-smoothing="macos-grayscale"\]\s*body\s*\{[\s\S]*-webkit-font-smoothing:\s*antialiased;/u);
  assert.match(source, /\[data-font-smoothing="macos-grayscale"\]\s*body\s*\{[\s\S]*-moz-osx-font-smoothing:\s*grayscale;/u);
});

test("responsive datasets override the same layout token names instead of creating mobile-specific token families", () => {
  const source = readFileSync(appStylesPath, "utf8");

  assert.match(source, /\[data-form-factor="phone"\]\s*\{[\s\S]*--page-gutter-inline:\s*1rem;/u);
  assert.match(source, /\[data-form-factor="phone"\]\s*\{[\s\S]*--workspace-max-width:\s*100%;/u);
  assert.match(source, /\[data-form-factor="phone"\]\s*\{[\s\S]*--composer-max-width:\s*calc\(100vw/u);
  assert.match(source, /\[data-form-factor="phone"\]\s*\{[\s\S]*--composer-bottom-offset:\s*calc\(max\(1\.5rem, var\(--layout-safe-area-bottom\)\) \+ 0\.5rem\);/u);
  assert.match(source, /\[data-form-factor="tablet"\]\s*\{[\s\S]*--page-gutter-inline:\s*1\.5rem;/u);
  assert.match(source, /\[data-form-factor="tablet"\]\s*\{[\s\S]*--workspace-max-width:\s*48rem;/u);
  assert.match(source, /\[data-form-factor="desktop"\]\s*\{[\s\S]*--page-gutter-inline:\s*2rem;/u);
  assert.match(source, /\[data-sidebar-mode="drawer"\]\s*\{[\s\S]*--sidebar-mode:\s*drawer;/u);
  assert.match(source, /\[data-sidebar-mode="drawer"\]\s*\{[\s\S]*--sidebar-width:\s*min\(92vw, 19rem\);/u);
  assert.match(source, /\[data-sidebar-mode="docked"\]\s*\{[\s\S]*--sidebar-mode:\s*docked;/u);
  assert.match(source, /\[data-density="touch"\]\s*\{[\s\S]*--touch-target-size:\s*var\(--control-height-touch\);/u);
  assert.doesNotMatch(source, /--mobile-(page|workspace|composer|sidebar|touch)/u);
  assert.doesNotMatch(source, /--tablet-(page|workspace|composer|sidebar|touch)/u);
});

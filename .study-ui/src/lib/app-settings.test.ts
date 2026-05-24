import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_APP_SETTINGS,
  SIDEBAR_GLASS_INTENSITY_RANGE,
  getSidebarGlassAlphaShift,
  normalizeAppSettings,
} from "./app-settings.ts";

test("defaults no longer persist an app palette setting", () => {
  assert.equal(Object.hasOwn(DEFAULT_APP_SETTINGS, "themePalette"), false);
});

test("legacy palette settings are ignored during normalization", () => {
  const normalized = normalizeAppSettings({
    themePalette: "custom",
  });

  assert.equal(Object.hasOwn(normalized, "themePalette"), false);
});

test("normalization still keeps unrelated interface settings intact", () => {
  const normalized = normalizeAppSettings({
    language: "en-US",
    interfaceScale: 110,
    fontFamily: "serif",
    fontSizeScale: 95,
    macosNativeFontSmoothing: false,
  });

  assert.equal(normalized.language, "en-US");
  assert.equal(normalized.interfaceScale, 110);
  assert.equal(normalized.fontFamily, "serif");
  assert.equal(normalized.fontSizeScale, 95);
  assert.equal(normalized.macosNativeFontSmoothing, false);
});

test("defaults include a dedicated sidebar glass intensity setting", () => {
  assert.equal(DEFAULT_APP_SETTINGS.sidebarGlassIntensity, 100);
  assert.equal(SIDEBAR_GLASS_INTENSITY_RANGE.max, 180);
});

test("defaults prefer macOS native font smoothing", () => {
  assert.equal(DEFAULT_APP_SETTINGS.macosNativeFontSmoothing, true);
});

test("macOS font smoothing normalization preserves explicit booleans and rejects invalid values", () => {
  assert.equal(
    normalizeAppSettings({ macosNativeFontSmoothing: false }).macosNativeFontSmoothing,
    false,
  );
  assert.equal(
    normalizeAppSettings({ macosNativeFontSmoothing: "legacy" }).macosNativeFontSmoothing,
    true,
  );
});

test("sidebar glass intensity snaps into the supported range during normalization", () => {
  const normalized = normalizeAppSettings({
    sidebarGlassIntensity: SIDEBAR_GLASS_INTENSITY_RANGE.max + 7,
  });

  assert.equal(normalized.sidebarGlassIntensity, SIDEBAR_GLASS_INTENSITY_RANGE.max);
});

test("sidebar glass alpha shift stays neutral at default and becomes visibly stronger at the edges", () => {
  assert.equal(getSidebarGlassAlphaShift(100), 0);
  assert.equal(getSidebarGlassAlphaShift(80), 0.12);
  assert.equal(getSidebarGlassAlphaShift(140), -0.26);
  assert.equal(getSidebarGlassAlphaShift(180), -0.34);
});

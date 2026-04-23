import test from "node:test";
import assert from "node:assert/strict";

import {
  createResponsiveEnvironment,
  getBrowserResponsiveEnvironment,
  getFormFactor,
  getServerResponsiveEnvironment,
  isCompactWidth,
  RESPONSIVE_BREAKPOINTS,
} from "./responsive-env.ts";

test("defines the canonical responsive breakpoint values", () => {
  assert.deepEqual(RESPONSIVE_BREAKPOINTS, {
    phoneMax: 639,
    tabletMin: 640,
    tabletMax: 1023,
    desktopMin: 1024,
    compactMax: 1023,
  });
});

test("classifies phone, tablet, and desktop form factors at locked boundaries", () => {
  assert.equal(getFormFactor(639), "phone");
  assert.equal(getFormFactor(640), "tablet");
  assert.equal(getFormFactor(767), "tablet");
  assert.equal(getFormFactor(768), "tablet");
  assert.equal(getFormFactor(1023), "tablet");
  assert.equal(getFormFactor(1024), "desktop");
});

test("treats every width below 1024 as compact", () => {
  assert.equal(isCompactWidth(639), true);
  assert.equal(isCompactWidth(640), true);
  assert.equal(isCompactWidth(767), true);
  assert.equal(isCompactWidth(768), true);
  assert.equal(isCompactWidth(1023), true);
  assert.equal(isCompactWidth(1024), false);
});

test("creates compact webview and desktop window environments from explicit inputs", () => {
  assert.deepEqual(createResponsiveEnvironment({ width: 390, inputMode: "coarse" }), {
    width: 390,
    formFactor: "phone",
    isCompact: true,
    inputMode: "coarse",
    shellMode: "compact-webview",
  });

  assert.deepEqual(createResponsiveEnvironment({ width: 1280, inputMode: "fine" }), {
    width: 1280,
    formFactor: "desktop",
    isCompact: false,
    inputMode: "fine",
    shellMode: "desktop-window",
  });
});

test("returns a desktop-safe server environment when browser APIs are unavailable", () => {
  assert.deepEqual(getServerResponsiveEnvironment(), {
    width: 1024,
    formFactor: "desktop",
    isCompact: false,
    inputMode: "fine",
    shellMode: "desktop-window",
  });
});

test("keeps snapshots referentially stable for useSyncExternalStore", () => {
  assert.equal(getServerResponsiveEnvironment(), getServerResponsiveEnvironment());
  assert.equal(getBrowserResponsiveEnvironment(), getServerResponsiveEnvironment());
});

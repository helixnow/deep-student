// TODO(phase 3.x): Wire up Playwright Component Tests in study-ui/. At the
// time of writing, only the root repository has a playwright-ct.config.ts;
// study-ui uses Vitest + jsdom exclusively. Re-enable these tests once
// study-ui gets its own playwright-ct.config.ts (tracked as SCRL-F-05
// tooling in REQUIREMENTS.md — see .planning/research/SUMMARY.md §QLT).
//
// Until then, the tests are kept as structured fixmes so the intent
// is preserved and the file shape is ready to activate by dropping
// `.fixme` and wiring `@playwright/experimental-ct-react` mounts.

import { expect, test } from "@playwright/test";

test.fixme(
  "ScrollArea: scrollbar hides after pointer leaves and fades in on scroll (hide-delay 700ms)",
  async ({ page }) => {
    // Mount <ScrollArea scrollHideDelay={700}> with tall content.
    // Assert: os-scrollbar starts visible, hides 700ms after pointerleave,
    // reappears within one frame of wheel event.
    expect(page).toBeTruthy();
  },
);

test.fixme(
  "ScrollArea: drag-thumb moves viewport scrollTop proportionally (drag-thumb)",
  async ({ page }) => {
    // Mount <ScrollArea> with overflowing content. Locate .os-scrollbar-handle,
    // simulate mouse.down → move(+100px) → up. Assert scrollTop increased.
    expect(page).toBeTruthy();
  },
);

test.fixme(
  "ScrollArea: iOS fallback renders native scrollbars (no OverlayScrollbars DOM)",
  async ({ page }) => {
    // Mount <ScrollArea nativeScrollbars>. Assert data-native-scrollbars="true"
    // and no [data-overlayscrollbars-viewport] in the tree.
    expect(page).toBeTruthy();
  },
);

# Statistics Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the missing `数据统计` settings panel and populate it with the provided session, token, trend, heatmap, model, and module metrics.

**Architecture:** Keep the stats content as static typed data in a dedicated module, map the `stats` tab to a new visible section, and render the panel inside `SettingsPanel` using existing `Surface`/card styling. Verify the behavior with a failing `settings-panel` test first so the new tab wiring is covered by TDD.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS v4, Node test runner.

---

### Task 1: Wire stats tab visibility

**Files:**
- Modify: `src/lib/settings-panel.test.ts`
- Modify: `src/lib/settings-panel.ts`

**Step 1: Write the failing test**

Add a test asserting `getVisibleSettingsPanelSections("stats")` returns `["stats"]` and `shouldShowAppearanceSettings("stats")` stays `false`.

**Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types src/lib/settings-panel.test.ts`

Expected: FAIL because the `stats` tab is not mapped yet.

**Step 3: Write minimal implementation**

Add `"stats"` to `SettingsPanelSection` and return `["stats"]` when `activeTab === "stats"`.

**Step 4: Run test to verify it passes**

Run: `node --test --experimental-strip-types src/lib/settings-panel.test.ts`

Expected: PASS.

### Task 2: Add static stats data and panel UI

**Files:**
- Create: `src/components/content/stats-panel-data.ts`
- Modify: `src/components/content/SettingsPanel.tsx`

**Step 1: Add typed data**

Create static constants for overview cards, activity trend, heatmap, model distribution, and module distribution using the provided values.

**Step 2: Implement the panel**

Render a new stats section in `SettingsPanel` using existing surfaces and Tailwind tokens. Keep charts lightweight with CSS bars/columns rather than introducing a chart library.

**Step 3: Keep layout responsive**

Ensure the overview cards, trend chart, and distribution blocks reflow cleanly on narrow widths.

### Task 3: Verify the implementation

**Files:**
- Verify: `src/lib/settings-panel.ts`
- Verify: `src/lib/settings-panel.test.ts`
- Verify: `src/components/content/SettingsPanel.tsx`
- Verify: `src/components/content/stats-panel-data.ts`

**Step 1: Run diagnostics**

Run LSP diagnostics on all modified files and fix any errors.

**Step 2: Run tests**

Run: `node --test --experimental-strip-types src/lib/settings-panel.test.ts`

**Step 3: Run lint and build**

Run: `npm run lint` and `npm run build`

Expected: all commands succeed.

# Settings Demo Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a new demo page inside Settings that showcases the requested UI controls and patterns.

**Architecture:** Extend the existing settings tab model with a new `demo` tab, keep the current sidebar-driven settings shell, and render the demo content through a dedicated `SettingsDemoPanel` component. Reuse existing UI primitives where available, add thin new primitives only when needed, and keep interactions local to the demo page.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS v4, Radix UI primitives, node:test

---

### Task 1: Add red tests for the new settings demo tab

**Files:**
- Modify: `src/lib/settings-panel.test.ts`
- Create: `src/components/content/SettingsDemoPanel.source.test.ts`
- Create: `src/App.demo.source.test.ts`

**Step 1: Write the failing test**
- Assert `getVisibleSettingsPanelSections("demo")` returns `["demo"]`.
- Assert the app settings nav source includes a `demo` tab.
- Assert a dedicated demo panel source file exists and references the requested control labels.

**Step 2: Run test to verify it fails**
Run: `node --test src/lib/settings-panel.test.ts src/components/content/SettingsDemoPanel.source.test.ts src/App.demo.source.test.ts`
Expected: FAIL because the demo section and component do not exist yet.

**Step 3: Write minimal implementation**
- Add the `demo` settings tab type and nav item.
- Add demo section mapping in `src/lib/settings-panel.ts`.
- Create the `SettingsDemoPanel` component.

**Step 4: Run test to verify it passes**
Run: `node --test src/lib/settings-panel.test.ts src/components/content/SettingsDemoPanel.source.test.ts src/App.demo.source.test.ts`
Expected: PASS.

### Task 2: Build the demo page UI

**Files:**
- Modify: `src/components/content/SettingsPanel.tsx`
- Create: `src/components/content/SettingsDemoPanel.tsx`
- Create: `src/components/ui/textarea.tsx`
- Create: `src/components/ui/sheet.tsx`
- Create: `src/components/ui/dropdown-menu.tsx`
- Create: `src/components/ui/tooltip.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Write the failing test**
- Reuse the source-based demo panel test so it requires all requested control families.

**Step 2: Run test to verify it fails**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
Expected: FAIL until the demo panel content is added.

**Step 3: Write minimal implementation**
- Render grouped cards for Button, Input, Textarea, Select/Combobox, Dialog, Sheet/Drawer, Tabs, Tooltip, Dropdown/Menu, Sidebar, Card/ListItem, Empty/Skeleton/Toast.
- Keep the visual language aligned with the existing settings shell.

**Step 4: Run test to verify it passes**
Run: `node --test src/components/content/SettingsDemoPanel.source.test.ts`
Expected: PASS.

### Task 3: Verify integration quality

**Files:**
- Modify as needed based on lint output

**Step 1: Run targeted verification**
Run: `npm run lint`
Expected: exit 0.

**Step 2: Run build verification if needed**
Run: `npm run build`
Expected: exit 0.

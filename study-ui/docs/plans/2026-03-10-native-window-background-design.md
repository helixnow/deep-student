# Native Window Background Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the existing "使用不透明窗口背景" setting control the native Tauri window material so opaque mode removes OS translucency instead of only changing CSS.

**Architecture:** Keep the existing theme/localStorage model as the single source of truth. Add a small client-side bridge that derives the native window appearance from the resolved theme and the window background preference, then applies it through Tauri's window API only when the app is running inside Tauri. Update desktop capabilities so the app is allowed to change background color and window effects at runtime.

**Tech Stack:** React 19, TypeScript, Tauri 2 window API, Node test runner.

---

### Task 1: Define native appearance behavior

**Files:**
- Create: `src/lib/native-window.ts`
- Test: `src/lib/native-window.test.ts`

**Step 1: Write the failing test**
- Assert opaque mode clears native effects and picks a solid theme-matched background color.
- Assert translucent mode applies a platform-specific effect and keeps a theme-matched fallback color.

**Step 2: Run test to verify it fails**
- Run: `node --test --experimental-strip-types src/lib/native-window.test.ts`
- Expected: FAIL because the module does not exist yet.

**Step 3: Write minimal implementation**
- Add pure helpers that map `{ platform, theme, windowBackgroundPreference }` into native background color and effect instructions.
- Add an async function that loads `@tauri-apps/api/window` only inside Tauri and applies the derived instructions.

**Step 4: Run test to verify it passes**
- Run: `node --test --experimental-strip-types src/lib/native-window.test.ts`
- Expected: PASS.

### Task 2: Wire theme changes into the native window

**Files:**
- Modify: `src/components/theme/theme-provider.tsx`
- Test: `src/lib/native-window.test.ts`

**Step 1: Write the failing test**
- Extend tests to cover that the native bridge can be called with resolved theme and preference without requiring a browser-only dependency.

**Step 2: Run test to verify it fails**
- Run the same targeted test command and confirm the new expectation fails.

**Step 3: Write minimal implementation**
- Call the native sync helper inside the theme effect after dataset/localStorage updates.

**Step 4: Run test to verify it passes**
- Re-run the targeted test command.

### Task 3: Allow the Tauri window commands

**Files:**
- Modify: `src-tauri/capabilities/default.json`
- Create: `scripts/window-background-native-contract.test.mjs`

**Step 1: Write the failing test**
- Assert the desktop capability includes `core:window:allow-set-background-color` and `core:window:allow-set-effects`.

**Step 2: Run test to verify it fails**
- Run: `node --test scripts/window-background-native-contract.test.mjs`
- Expected: FAIL because permissions are missing.

**Step 3: Write minimal implementation**
- Add the required window permissions.

**Step 4: Run test to verify it passes**
- Re-run the targeted test command.

### Task 4: Verify the full change

**Files:**
- Verify only.

**Step 1: Run focused tests**
- `node --test --experimental-strip-types src/lib/native-window.test.ts`
- `node --test scripts/window-background-native-contract.test.mjs`
- `npm run test:theme`

**Step 2: Run repo verification**
- `npm run lint`
- `npm run build`

**Step 3: Review runtime caveats**
- Confirm the helper no-ops outside Tauri and that macOS/Windows both receive explicit native instructions.

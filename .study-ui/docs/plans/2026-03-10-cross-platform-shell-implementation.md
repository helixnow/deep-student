# Cross-Platform Study Shell Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the old Next.js shell with a Vite-powered Tauri desktop UI that matches the provided demo and treats desktop/mobile safe areas as first-class layout constraints.

**Architecture:** Use a single React SPA rendered by Vite and loaded by Tauri 2. Keep the navigation model, platform-safe titlebar spacing, and page metadata in a typed shell config so the desktop sidebar, mobile rail, and header stay in sync.

**Tech Stack:** Tauri 2, React 19.2, TypeScript, Vite, Tailwind CSS v4, shadcn-style button primitive.

---

### Task 1: Toolchain migration

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `eslint.config.mjs`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/vite-env.d.ts`
- Modify: `src-tauri/tauri.conf.json`

**Step 1: Write the failing test**

Use the existing shell config test to keep route and platform logic stable while swapping the frontend toolchain.

**Step 2: Run test to verify it fails**

Run: `npm run test:shell`
Expected: PASS before migration so the config baseline is known.

**Step 3: Write minimal implementation**

Replace Next.js scripts and config with Vite, align Tauri dev/build URLs, and update lint/type tooling for a standalone React SPA.

**Step 4: Run test to verify it passes**

Run: `npm run test:shell`
Expected: PASS after migration.

### Task 2: New SPA shell

**Files:**
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/styles/app.css`
- Modify: `src/components/layout/page-sections.tsx`
- Modify: `src/components/layout/system-settings-workspace.tsx`
- Modify: `src/components/layout/shell-icons.tsx`
- Modify: `src/lib/study-shell.ts`

**Step 1: Write the failing test**

Keep the platform inset and route-selection test green while the new SPA shell takes over rendering.

**Step 2: Run test to verify it fails**

Run: `npm run build`
Expected: FAIL until the new SPA entrypoint and styles exist.

**Step 3: Write minimal implementation**

Build a single-page shell with a desktop sidebar, a compact mobile rail, a route-aware header, a bottom composer, and a system settings workspace aligned with the demo.

**Step 4: Run test to verify it passes**

Run: `npm run build`
Expected: PASS.

### Task 3: Retire obsolete Next entrypoints

**Files:**
- Delete: `src/app`
- Delete: `next-env.d.ts`
- Delete: `next.config.ts`
- Delete: `src/components/layout/topbar.tsx`
- Delete: `src/components/layout/main-layout.tsx`
- Delete: `src/components/theme-toggle.tsx`

**Step 1: Write the failing test**

Run lint against the migrated project to surface stale Next-only imports and entrypoints.

**Step 2: Run test to verify it fails**

Run: `npm run lint`
Expected: FAIL or warn until the stale files are removed from the new app surface.

**Step 3: Write minimal implementation**

Remove the obsolete Next shell files so only the Vite/Tauri app is part of the active frontend.

**Step 4: Run test to verify it passes**

Run: `npm run lint`
Expected: PASS.

### Task 4: Final verification

**Files:**
- Modify as needed based on verification output

**Step 1: Run focused tests**

Run: `npm run test:shell`
Expected: PASS.

**Step 2: Run lint**

Run: `npm run lint`
Expected: PASS.

**Step 3: Run production build**

Run: `npm run build`
Expected: PASS.

**Step 4: Run Rust/Tauri validation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

**Step 5: Run desktop bundle build**

Run: `npm run tauri:build -- --debug`
Expected: PASS and produce a macOS `.app` bundle.

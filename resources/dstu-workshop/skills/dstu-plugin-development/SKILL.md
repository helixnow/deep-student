---
name: dstu-plugin-development
description: Create or modify a dstu plugin using real SDK discovery, managed source files, iterative built-in compilation/repair, hot installation and durable rollback.
---

# dstu plugin development

<!-- RUST-FIX(RF-P3-workshop-compiler): shipped progressive plugin-development guidance. -->

Discuss requirements first. Merely opening the workshop never sends a message or creates code. Once the user describes a requirement, complete the loop autonomously: discover, write, compile, repair, validate and stage the candidate.
Use dstu_plugin_api_list and dstu_plugin_api_read before choosing services, UI slots or props.
Use the SDK and templates from the resources category; do not guess extension points.

1. Propose a small useful plugin with dstu_plugin_propose_install and autoGenerate: true when the user has requested creation. Omit `pluginId` when creating a new plugin (the Host assigns `workshop.plugin-<uuid>` automatically); only pass an existing `workshop.plugin-...` `pluginId` when modifying an existing managed workshop plugin. Include abilities, data scope,
   changes and one observable acceptance criterion. This creates a confirmation card, not an installation.
2. The explicit creation request (autoGenerate) or user Create click starts generation, not installation. The Host may perform up to three compile/test-Host repair passes, feeding exact diagnostics back to the Agent. Write only the exact source root
   supplied by the Host. Never touch profiles, application bundles, SDK files or installed releases.
3. Start with learning-tool (Host + UI) or host-tool. Preserve the Host-assigned plugin id. Change
   package and module versions together. Default export a normal HostPlugin; do not invent a loader.
4. Use TypeScript/TSX. The application compiles it; do not run npm/pnpm, download dependencies,
   execute package scripts or expect tools installed on the learner's computer.
5. UI code uses React.createElement JSX compilation, external react, react-dom, @deepstudent/ui
   and i18next only. Host and UI share one package version. Scope services to the plugin id.
   Register effects inside apply and clean up with ctx.effect. Use SDK components and theme variables;
   never override global selectors or modify the app HTML. Components receive data/callback props.
6. Run dstu_plugin_validate (or use the autonomous loop). If it fails, call dstu_plugin_diagnose, then dstu_plugin_write_source with a minimal repair and validate again. Report manifest, build and test Host load/unload errors honestly.
   A test Host is not an OS sandbox. Without actual UI observation say “视觉未验证”.
7. Generation ends at pending-confirmation. A single user confirmation on the card installs the frozen
   candidate and hot-loads it immediately: the Host commits the package, writes the profile entry and
   refreshes the UI manifest in that one action. No application restart and no manual folder dragging.
   Only the paired UI/Host manager can install, enable, disable, revoke or restore; Agent tools cannot
   invoke those installation authorities.
8. After installation, close the configuration loop instead of asking the user to restart. Call
   dstu_plugin_inventory to find the plugin and whether it hasConfig, dstu_plugin_config_get to read
   its real schema and current values, then dstu_plugin_configure to write complete values: the Host
   validates them and hot-updates the running plugin fiber and UI manifest immediately, and persists
   the profile entry under the manager's revision check. dstu_plugin_set_enabled hot-loads or unloads a
   managed plugin the same way. Neither action restarts the application.
9. Installed plugins run in the application's process. Full trust is not isolation. Do not promise
   code safety from structure checks, or reversal of filesystem/network/business-data side effects.
10. Compile/test-Host failures leave the installed release untouched. Managed replacement activation failures restore the previous release when available. Workshop startup-degraded and UI error-budget faults are isolated and may recover an earlier approved version (`lastGoodPackageDir`); use dstu_plugin_diagnose for exact errors and dstu_plugin_rollback for a failed managed work. Do not promise protection from process crashes, infinite loops or native faults. Revocation uninstalls but retains
   source and packages. Restoration rechecks retained files and reinstalls without asking a model.
11. Export with dstu_plugin_export; this writes a local .dstuplugin only, never publishes it.
12. Use dstu_plugin_app_restart only when the user explicitly asks to restart the application;
   plugin installation and configuration changes already hot-load and do not need it.

Use incremental discovery instead of loading every SDK declaration. Unsupported extension points
must be reported as unsupported; propose an available alternative, never patch the application.

## Fast-Path Authoring Cheatsheet (Zero `api_read` needed for standard plugins)

For standard `learning-tool` (Host + UI) or `host-tool` plugins, use the fast 3-step loop (`dstu_plugin_propose_install` with `autoGenerate: false` → `dstu_plugin_write_source` → `dstu_plugin_validate`) without spawning subagents or reading all SDK files:

1. **Propose draft**: Call `dstu_plugin_propose_install` with `autoGenerate: false` (omit `pluginId` for new plugins; pass existing `workshop.plugin-...` `pluginId` when upgrading). The response returns `id`, `pluginId`, `serviceName`, and `revision`.
2. **Write source**: Call `dstu_plugin_write_source` with `id`, `revision`, and `files`. You may use `__PLUGIN_ID__` and `__SERVICE__` placeholders (or the exact `pluginId` and `serviceName` from step 1) — the Host automatically replaces `__PLUGIN_ID__` and `__SERVICE__`:
   - `package.json`:
     ```json
     {
       "name": "dstu-workshop-learning-tool", "version": "1.0.0", "type": "module",
       "engines": { "deepStudent": ">=0.20.0 <1.0.0", "deepStudentPluginApi": "1" },
       "deepStudent": { "manifestVersion": 1, "id": "__PLUGIN_ID__", "displayName": "中文插件标题", "description": "一句话说明插件用途", "platforms": ["desktop"], "host": "./index.ts", "ui": "./ui.tsx" }
     }
     ```
   - `index.ts`:
     ```ts
     export default {
       name: '__PLUGIN_ID__',
       meta: { id: '__PLUGIN_ID__', version: '1.0.0', ui: './ui.js', provides: ['__SERVICE__'], remote: { '__SERVICE__': ['getData'] } },
       apply(ctx: { provide(name: string, service: unknown): void }) {
         ctx.provide('__SERVICE__', { getData() { return { ok: true }; } });
       },
     };
     ```
   - `ui.tsx` (for `learning-tool`):
     ```tsx
     import React from 'react';
     import { defineUiPlugin } from '@deepstudent/ui';
     export default defineUiPlugin({
       meta: { id: '__PLUGIN_ID__', version: '1.0.0', host: true },
       apply(ctx) {
         ctx.ui.i18n.addBundles({ 'zh-CN': { title: '中文插件标题' }, 'en-US': { title: 'Plugin Title' } });
         const host = ctx.ui.host.__SERVICE__;
         ctx.ui.views.register({ id: 'main', titleKey: 'title', component: () => <section style={{ padding: 24, color: 'hsl(var(--foreground))' }}>...</section> });
         ctx.ui.nav.register({ id: 'main', viewId: 'main', labelKey: 'title', order: 100 });
       },
     });
     ```
3. **Validate & stage confirmation card**: Call `dstu_plugin_validate` with `id`. When `ok: true`, the work automatically transitions to `pending-confirmation` and renders the interactive confirmation card directly in the chat.

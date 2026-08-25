# 0824 Compile Latest

- Source HEAD: `2b6488a6be592720c2a2878cb287323ca0113d97`
- Gate execution HEAD: `f809249648ce7c5015ee88050e4255165a32e1b2`
- Isolation branch: `cursor/0824-compile-latest-cde6`
- Environment: Rust 1.98.0, GTK/GDK 3.24.41, WebKitGTK 2.52.3, protoc 3.21.12, PDFium 7350

`f8092496` differs from the source HEAD only by the initial scaffold of this
report. Generated `src/version.ts`, `dist/`, downloaded PDFium binaries, and
downloaded PDFium license changes were not committed.

## Summary

| Gate | Result | Exit code | Duration |
| --- | --- | ---: | ---: |
| `npm ci` | PASS | 0 | 14.399 s |
| `npm run typecheck` | PASS | 0 | 46.777 s |
| `npx vite build` | PASS | 0 | 69.544 s |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | PASS | 0 | 328.899 s |

The standalone frontend commands initially found the intentionally ignored
generated module `src/version.ts` missing. `npm run version:generate` completed
with exit code 0 in 0.167 s; the exact requested commands were then rerun for
the authoritative results above. The initial typecheck exited 2 in 46.501 s,
and the initial Vite build exited 1 in 0.946 s. Both reported only the missing
version module.

## `npm ci`

- Exit code: 0
- Duration: 14.399 s
- Last 20 log lines:

```text
added 1192 packages, and audited 1193 packages in 14s

325 packages are looking for funding
  run `npm fund` for details

12 vulnerabilities (1 low, 5 moderate, 6 high)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
npm notice
npm notice New major version of npm available! 10.9.7 -> 12.0.2
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
npm notice To update run: npm install -g npm@12.0.2
npm notice
```

## `npm run typecheck`

- Exit code: 0
- Duration: 46.777 s
- Complete log (fewer than 20 lines):

```text

> deep-student@0.9.44 typecheck
> tsc --noEmit -p tsconfig.json

```

Initial pre-generation log:

```text

> deep-student@0.9.44 typecheck
> tsc --noEmit -p tsconfig.json

src/features/settings/components/AboutTab.tsx(13,26): error TS2307: Cannot find module '@/version' or its corresponding type declarations.
src/hooks/useAppUpdater.ts(261,56): error TS2307: Cannot find module '../version' or its corresponding type declarations.
src/main.tsx(241,45): error TS2307: Cannot find module './version' or its corresponding type declarations.
```

## `npx vite build`

- Exit code: 0
- Duration: 69.544 s
- Last 20 log lines:

```text
dist/assets/index-qgOLo3T5.js                           340.78 kB │ gzip:   114.52 kB
dist/assets/MindMapContentView-D6_erk6l.js              397.61 kB │ gzip:   115.66 kB
dist/assets/vendor-pdfjs-3cGUoCSg.js                    399.14 kB │ gzip:   116.59 kB
dist/assets/vendor-recharts-eu4BfOCF.js                 413.72 kB │ gzip:   118.26 kB
dist/assets/vendor-katex-TMoUESss.js                    555.67 kB │ gzip:   163.39 kB
dist/assets/GlobalDebugPanel-8hXC0hcU.js                605.91 kB │ gzip:   159.69 kB
dist/assets/vendor-exceljs-DI1eOv8a.js                  939.50 kB │ gzip:   270.99 kB
dist/assets/vendor-milkdown-BdONO2vz.js               1,240.23 kB │ gzip:   395.90 kB
dist/assets/vendor-pptx-DnEZ1ihH.js                   1,346.81 kB │ gzip:   437.10 kB
dist/assets/heic2any-D9XVpXIT.js                      1,352.91 kB │ gzip:   341.25 kB
dist/assets/vendor-mermaid-CKWXCWk6.js                2,739.90 kB │ gzip:   737.32 kB
dist/assets/index-DVr_WgvU.js                         5,382.83 kB │ gzip: 1,094.66 kB
dist/assets/index-B1rdW2Iy.js                         6,574.52 kB │ gzip: 1,906.95 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 1m 8s
```

Initial pre-generation log:

```text
vite v6.4.3 building for production...
transforming...
✓ 7 modules transformed.
✗ Build failed in 79ms
error during build:
Could not resolve "./version" from "src/main.tsx"
file: /workspace/src/main.tsx
    at getRollupError (file:///workspace/node_modules/rollup/dist/es/shared/parseAst.js:406:41)
    at error (file:///workspace/node_modules/rollup/dist/es/shared/parseAst.js:402:42)
    at ModuleLoader.handleInvalidResolvedId (file:///workspace/node_modules/rollup/dist/es/shared/node-entry.js:22127:24)
    at ModuleLoader.resolveDynamicImport (file:///workspace/node_modules/rollup/dist/es/shared/node-entry.js:22187:58)
    at async file:///workspace/node_modules/rollup/dist/es/shared/node-entry.js:22071:32
```

## `cargo check --manifest-path src-tauri/Cargo.toml --lib`

- Exit code: 0
- Duration: 328.899 s
- Result classification: PASS; GDK was present and Cargo reported no code error.
- Last 20 log lines:

```text
   |     ^^^^^^

warning: method `consume` is never used
  --> src/secret_prompt.rs:99:19
   |
68 | impl SecretPromptStore {
   | ---------------------- method in this implementation
...
99 |     pub(crate) fn consume(
   |                   ^^^^^^^

warning: function `prepare_docx_images` is never used
   --> src/vlm_grounding_service.rs:233:4
    |
233 | fn prepare_docx_images(
    |    ^^^^^^^^^^^^^^^^^^^

warning: `deep-student` (lib) generated 28 warnings (run `cargo fix --lib -p deep-student` to apply 6 suggestions)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 5m 28s
```

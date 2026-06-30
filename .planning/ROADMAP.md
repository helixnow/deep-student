# Roadmap: DeepStudent

Single source of truth for **in-progress** milestone work. Shipped milestones are archived under `.planning/milestones/` and summarized in `.planning/MILESTONES.md`.

## Shipped

| Version | Name | Date | Archive |
|---|---|---|---|
| v1.0 | DeepSeek V4/V3.2 Adapter Alignment | 2026-04-26 | [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) |
| v1.1 | Study UI Foundation Modernization | 2026-05-12 | [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md) |

## Active

### v1.2 — Performance & Code Health Baseline

**Goal:** Clean up 17 TS errors + cut main bundle from 1.2MB to ≤500KB gzipped by lazy-loading heavy features.

**Phases:**

- [ ] **Phase 8: Type Safety Cleanup** — Fix all 17 pre-existing TS errors and add `tsc --noEmit` CI gate.
- [ ] **Phase 9: Bundle Baseline & Analysis** — Install `vite-bundle-visualizer`, generate report, identify real culprits beyond the obvious large chunks.
- [ ] **Phase 10: Lazy Loading Heavy Features** — Convert Milkdown, Pptx/Xlsx preview, Settings, debug panel imports to `React.lazy` / dynamic `import()`.
- [ ] **Phase 11: manualChunks Reconfiguration** — Tune Vite's rollup output so vendor chunks are split efficiently and no single-route code lands in the main bundle.
- [ ] **Phase 12: Performance Baseline Validation** — Measure bundle sizes, iOS cold-start, first paint. Record in `.planning/perf-baseline.md`.

### Phase Details

#### Phase 8: Type Safety Cleanup

**Requirements**: TSCLEAN-01, TSCLEAN-02, TSCLEAN-03
**Success Criteria:**
1. `npx tsc --noEmit -p tsconfig.json` exits 0.
2. `npm run build` cannot succeed if TS errors exist (enforced by an npm script wrapper OR a pre-commit hook OR a CI job).
3. `AGENTS.md` documents the TS gate policy.

#### Phase 9: Bundle Baseline & Analysis

**Requirements**: PERF-06, BASELINE-03
**Success Criteria:**
1. `vite-bundle-visualizer` installed as devDep and runnable via `npm run analyze`.
2. Committed `docs/bundle-analysis.png` (or equivalent) + `docs/bundle-report.html`.
3. `.planning/perf-baseline.md` records the pre-optimization numbers: total gzipped size, top 10 chunks, estimated waste.

#### Phase 10: Lazy Loading Heavy Features

**Requirements**: PERF-02, PERF-03, PERF-04, PERF-05
**Success Criteria:**
1. Milkdown-related chunks are not in the main bundle and only appear in the network tab when a notes route is navigated to.
2. Pptx/Xlsx preview chunks only load when opening such a file.
3. Settings page chunk only loads when settings opens.
4. Debug panel chunk only loads when the debug toggle is activated.

#### Phase 11: manualChunks Reconfiguration

**Requirements**: PERF-01
**Success Criteria:**
1. `vite.config.ts` `manualChunks` covers: `vendor-react`, `vendor-milkdown`, `vendor-radix`, `vendor-tauri`, `vendor-chat-heavy`, `vendor-utils`.
2. Main bundle `index-*.js` gzipped ≤500KB.
3. No single chunk exceeds 800KB gzipped (reduces TTI for cold-start routes).

#### Phase 12: Performance Baseline Validation

**Requirements**: BASELINE-01, BASELINE-02, BASELINE-03
**Success Criteria:**
1. `.planning/perf-baseline.md` records before/after numbers for bundle, iOS simulator cold-start, first paint.
2. No regression in `npm test`, `npm run test:unit`, or study-ui Vitest.
3. Existing Playwright CT suites pass.

---

## Backlog

### Phase 999.1: Lightweight Translation Popover (BACKLOG)

**Goal:** 将翻译功能从完整工作台模式改为轻量 popover：选中文本点 Translate 后，在原位弹出小卡片流式显示译文，附带复制/收藏/发到 Chat 操作。TranslateWorkbench 保留作为 Learning Hub 长文翻译入口。

**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (promote with /gsd-review-backlog when ready)

---
*Last updated: 2026-05-15 — v1.2 active, Phase 8 starting*

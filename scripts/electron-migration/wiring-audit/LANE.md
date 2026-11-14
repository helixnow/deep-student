# X4-wiring-audit：插件孤岛与服务接线审计

## 状态：已完成（2026-11-04）

本 lane 没有 Rust 命令、没有 TESTMAP，也没有 pending 测试；交付物是审计工具（本目录）与报告 `docs/dev/electron-migration/audits/X4-wiring-audit.md`。协调者已签收 `0ec078036`（固定基线 main `3b2758d7a`），并明确不因新 main 自动重扫。

### 证据

| 项 | 结果 |
|---|---|
| lane 自检 `lane-gate.mjs` | main-red 修复提交 `442232e53`（基线 main `bec9c35ba`）通过 typecheck + boundaries，exit 0；之后的分支头只合入 main 并改了本表，同样重新自检 |
| ledger `npm run migration:ledger -- --check --no-write` | 作业 `20261104122238-6d178f`，exit 0；problems 全为 0 |
| 审计 `audit.mjs --check --json`（固定 main `3b2758d7a`） | 作业 `20261104085238-4518e9`，exit 1（预期发现：9 个缺名、0 个硬悬空、0 个环、`loadErrors=[]`） |
| 工具回归 `audit.test.mjs` | 作业 `20261104140653-b6c0fe`，14/14，exit 0（含 main-red 回归用例） |
| 夹具类型检查 `tsc -p tsconfig.fixtures.json` | 作业 `20261104140653-89ab26`，exit 0 |

### main-red 修复（fulltest 16a254adf）

`fixtures/host/plugins/consumer/tests/bridge.test.ts` 是本 lane 的夹具，被 `vitest.host.config.ts` 的 `scripts/electron-migration/**/*.test.ts` 当作测试套件收集，因为里面没有 suite 而加载失败。这是本 lane 自身的问题，与其他 lane 的接口无关。修复：把文件改名为 `tests/bridge.ts`。审计器靠 `tests/` 目录识别测试桥，桥的检测语义不变。另新增回归用例，禁止夹具里出现 `*.test.*` 或 `*.spec.*` 文件。

### 边界

- `--check` 目前是 report-only，何时上线由架构师/X6 决定；本 lane 不改全局门禁配置。
- `browserSurface` 有合法的 ShellBrowserSurface 默认实现，不为让计数归零新增 provider。
- 剩余 9 个缺名属于各责任 lane（W01/W05/W06/W07/W13/W15），见报告。

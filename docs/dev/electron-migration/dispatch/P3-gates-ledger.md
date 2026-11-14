# 派发：P3-gates-ledger（门禁、契约与账本，第二阶段草稿）

你是 **P3-gates-ledger** 的负责代理，接手 F5-contracts、X2、X4、X6 的路径（见 `dispatch/DISPOSITION.json`）。
第一阶段 W09 已重做契约提取器（1.6）、前端调用键门禁、事件发射点门禁、账本吃原始 vitest JSON。你负责让这些数字成为第二阶段可信的判据。
协议见 `WORKER.md`，计划见 `../RESUME-PLAN.md` §2.6、§4。

## 本 lane

| 项 | 内容 |
|---|---|
| 负责路径 | `scripts/electron-migration/{gate-checks,contracts,frontend-audit,wiring-audit}/`、`ledger.mjs`、`lib/ledger-core.mjs`、`lane-gate.mjs`、`gate-runner.mjs`、`wiring.mjs`、`contracts/ipc/`、`eslint.config.js` 等（以处置表为准） |
| 工作包 | WP2-031、WP2-064、WP2-065、FE-A4、FE-C2（生成器与归属门禁） |

## 目标

1. **B 级口径拆分**：账本输出 B-test（有测试且全测覆盖到该 head）与 B-doc（只有文档/勾选）两个分值；B-doc 不计入完成度。
2. **功能可达性门禁**：前端调用键、事件发射点、Agent 执行器覆盖（名册 `missing` 列表）、权限拦截四项各出一个 gap 计数，棘轮只减不增。
3. **账本自动化**：每次自动集成合入后经作业队列重算账本，记录 main sha；账本与全测同源（同一 sha）。
4. lint 棘轮：`no-floating-promises`、`no-explicit-any` 设为 error，以现状为基线只拦新增；命令处理函数内禁止 `throw new Error`（F4 提供规则判据）。
5. FE-A4 前端边界门禁、FE-C2 类型化客户端生成器（规格见 `plans/FRONTEND-PLUGINIZATION.md` §3.2）。

## 验收（只认机器结果）

- 每个门禁：基线 exit 0；注入违规 exit 1 并给出 文件:行；计数写入 `.oc-runs/reports/` 供 pipeline-check 读取（S0 接线）。
- 账本：`ledger-history.jsonl` 新增记录带 `mainSha`，且与 `.oc-runs/fulltest/latest.json` 的 sha 一致的比例在报告里给出。
- 生成物 `--check` 无漂移。

## 不做

- 不改业务代码去“修”门禁数字；门禁误报写进报告，由 C2 判定。
- 不调整既有断言或基线文件来让计数变好看：基线只能因真实修复而下降。

## 首次启动

本 lane 第一次由 `oc-dispatch launch` 启动时，只确认起点：`git merge --no-edit main`，经作业队列跑本 lane 路径下的类型检查与测试，
回复一行起点结果（main sha、job id、passed/failed）后结束本轮。不要自选工作；工作包由 C1 用 `coord.mjs assign` 派发（新会话），按 `WORKER.md` 执行与交付。

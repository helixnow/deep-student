# R3-frontend-ci-parallel：frontend job 的 lint/typecheck 与 build 并行化

> 子代理：SA-R3-09（模型 `claude-fable-5-thinking-xhigh`）  
> 分支：`cursor/optimization0824-5575`  
> 日期：2026-08-24  
> 改动文件：仅 `.github/workflows/ci.yml`

## 问题

`ci.yml` 的 `frontend` job 此前是单 job 全串行：

```
npm ci → licenses:check → generate-version → tsc --noEmit
       → eslint → vite build → bundle-size → npm audit
```

其中三个大头（`tsc` / `eslint` / `vite build`）互不依赖，串行意味着
frontend 信号的 wall clock = 安装 + 全部步骤之和。

## 改动

拆为 matrix 三 leg 并行 + 一个聚合 job，全部门禁保留、命令逐字不变：

### `frontend-checks`（matrix: `task: [lint, typecheck, build]`，`fail-fast: false`）

每 leg 共同前缀：checkout → setup-node（npm 缓存）→
`npm ci --legacy-peer-deps` → `generate-version`（tsc/vite 需要版本产物；
lint leg 保留以维持原执行环境，开销亚秒级）。之后按 leg 分工：

| leg | 门禁步骤 | 说明 |
| --- | --- | --- |
| `lint` | `npm run lint`、`licenses:check`、npm audit（informational） | 后两者只依赖依赖树、不依赖 dist，挂在最短 leg 平衡时长 |
| `typecheck` | `npx tsc --noEmit` | — |
| `build` | `npx vite build`、bundle-size check（warn mode） | 体积门禁读 dist，必须跟随 build |

步骤级注释（审查 F13 / WI-8 / F11）原样随迁；`timeout-minutes: 25`
保持不变（每 leg 是原串行工作的严格子集）。
`fail-fast: false`：一个 leg 失败不取消其余门禁信号，一次 push 能同时
看到三类失败，减少修复回合数。

### `frontend` 聚合 job（本任务最关键的非显然点）

`main-protection` ruleset（id 12791504，经 GitHub API 核实）要求的
required status check context **恰为 `Frontend`**（另有 `Backend`）。
matrix leg 上报的是 `Frontend · lint` 等带后缀名，命不中该 context ——
若只做拆分，required check 永远停在 pending，**main 将全面无法合并**。

因此保留 job id `frontend` / `name: Frontend` 作为聚合 job：

```yaml
frontend:
  name: Frontend
  needs: [frontend-checks]
  if: always()
  steps:
    - run: test "${{ needs.frontend-checks.result }}" = "success"
```

`if: always()` + 显式断言是有意的 fail-closed：若靠隐式 `success()`
在依赖失败时跳过本 job，skipped 的 required check 会被 ruleset 视为
满足（GitHub 文档化行为）—— lint 红了 main 却能合，假绿。显式断言下
任一 leg `failure`/`cancelled` 都让 `Frontend` 转红。聚合 job 自身开销
~10–20 秒 runner 启动，仅在三 leg 全部结束后运行。

## 预期收益

- frontend 信号 wall clock：原 ≈ 安装 + 7 步之和；现 ≈ max(三 leg) +
  聚合 job。按三大步骤时长同量级估算，缩短约 40–60%（真实数字待下次
  run 观察）。
- 并行税：`npm ci` 从 1 次变 3 次（缓存命中时每 leg ~1 分钟固定开销），
  计费 Linux 分钟数上升，换 PR 反馈延迟下降 —— 与本轮优化目标一致。

## 验证

- `python3 yaml.safe_load`：解析通过。
- `actionlint 1.7.7`：与 HEAD 基线完全相同的 4 条既有 SC2012 info
  （各 Rust job pdfium 准备步骤的 `ls | awk`，属 SA-R3-10 全 workflow
  复审范围），本改动**零新增**告警。
- ruleset required checks 经 `gh api repos/…/rulesets/12791504` 核实。
- `ci.yml` 内无其他 job `needs: frontend`；release 系 workflow 走独立的
  `reusable-build-frontend.yml`，不受影响。`changes` 路径过滤含
  `.github/workflows/ci.yml`，本改动的 PR 会照常触发 provider-contract。

## 回滚

局部于一个 job 段：把 `frontend-checks` 三 leg 的步骤按原顺序并回单个
`frontend` job、删除 matrix 与聚合断言即可，无其他文件依赖本结构。

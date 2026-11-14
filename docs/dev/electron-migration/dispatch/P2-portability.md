# 派发：P2-portability（可移植性规则与平台服务，第二阶段草稿）

你是 **P2-portability** 的负责代理。目标是为移动端铺路：业务插件不直接依赖 Node 专有模块和原生模块，一律经平台服务。
协议见 `WORKER.md`，计划见 `../RESUME-PLAN.md` §2.5；决定来源 `ASSAULT-PLAN.md` §6“可移植性规则（2026-11-07 决定）”。

## 本 lane

| 项 | 内容 |
|---|---|
| 负责路径 | 以 `dispatch/DISPOSITION.json` 为准：`scripts/portability/`、`host/platform/{files,crypto,http}/`、`host/profiles/mobile.json` |
| 工作包 | WP2-040（规则与声明）；为 WP2-041～043 提供平台服务缺口 |
| 起点 | W14 交付：`ctx.files` / `ctx.crypto` / `ctx.http`、`meta.platforms` 过滤、`mobile.json` 生成、可移植性扫描器与白名单基线（`host/platform/W14-PROGRESS.md`） |

## 目标

1. 边界检查加入：`host/plugins/**` 不得直接 import `node:fs`、`node:os`、`node:child_process`、`node:crypto`、`node:worker_threads`、`node:net`，
   不得直接依赖 better-sqlite3、koffi、LanceDB、sharp。以扫描器白名单为基线，只拦新增；接入 lane-gate 由 P3 配合。
2. 天然只属于桌面的插件（Agent 工作区 shell、MCP stdio、浏览器自动化、大型文档处理、备份治理等）在元数据里声明 `platforms: ["desktop"]`；
   声明改动在各插件目录，给 owner lane 出精确补丁说明，或由 C1 临时授权。
3. 平台服务缺口：L23、L20、L07 迁移时发现的缺口由你补，接口先发布再派消费方。

## 验收（只认机器结果）

- 门禁：基线 exit 0；注入一条 `import fs from 'node:fs'` 到业务插件 exit 1（两次 job id）。
- `node scripts/portability/<生成脚本> --check` 对 `host/profiles/mobile.json` 无漂移。
- 扫描器报告的“含 Node 专有依赖的插件源文件数”作为第二阶段指标，每次交付给出前后数字（RESUME-PLAN §4）。

## 不做

- 不改业务插件目录里的实现（迁移由 owner lane 做）；不改 `host/kernel/**`、`electron/**`。
- 不引入新的 npm 依赖（需要时写进报告）。

## 首次启动

本 lane 第一次由 `oc-dispatch launch` 启动时，只确认起点：`git merge --no-edit main`，经作业队列跑本 lane 路径下的类型检查与测试，
回复一行起点结果（main sha、job id、passed/failed）后结束本轮。不要自选工作；工作包由 C1 用 `coord.mjs assign` 派发（新会话），按 `WORKER.md` 执行与交付。

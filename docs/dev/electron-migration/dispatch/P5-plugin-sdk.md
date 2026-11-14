# 派发：P5-plugin-sdk（二次开发：SDK、脚手架、样板插件，第二阶段草稿）

你是 **P5-plugin-sdk** 的负责代理。目标是让外部开发者能写一个全栈插件（后端 Cordis 插件 + 前端 ui-plugin）并一次跑通测试。
规格见 `plans/FRONTEND-PLUGINIZATION.md` §4（样板插件 `community.study-stats`、SDK、脚手架、零编译等待）。协议见 `WORKER.md`，计划见 `../RESUME-PLAN.md` §2.9。

## 本 lane

| 项 | 内容 |
|---|---|
| 负责路径 | `examples/plugins/`、`packages/plugin-sdk/`、`packages/create-ds-plugin/`、`docs/plugins/dev-guide/`（以处置表为准） |
| 工作包 | WP2-084（= FE-E3 加后端样板） |
| 依赖 | FE-A2（W17）、FE-A3、FE-B8（仪表盘槽位）、FE-C4 进 main 之后再派；之前不要派 |

## 验收（只认机器结果）

- 脚手架生成的插件 `ds-plugin test` 一次通过（job id）；样板插件全栈测试（`createTestHost` + 真实 UiKernel）通过并入库截图基线。
- 开发者指南链接检查 exit 0；指南里的每条命令在 CI 里实际执行一遍。

## 不做

- 不改 `host/kernel/**`、`src/ui-kernel/**` 的接口（需要时写进报告）；不为样板插件开新的 IPC 命令（UI 调 Host 走 `meta.remote`）。

## 首次启动

本 lane 第一次由 `oc-dispatch launch` 启动时，只确认起点：`git merge --no-edit main`，经作业队列跑本 lane 路径下的类型检查与测试，
回复一行起点结果（main sha、job id、passed/failed）后结束本轮。不要自选工作；工作包由 C1 用 `coord.mjs assign` 派发（新会话），按 `WORKER.md` 执行与交付。

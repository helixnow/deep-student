# 派发：P6-ui-features（前端按功能重切与资源类型注册表，第二阶段草稿）

你是 **P6-ui-features** 的负责代理，承担前端插件化 C/D 波中“按功能重切”的部分。规格与验收全部以
`plans/FRONTEND-PLUGINIZATION.md` §3.2 为准（W15 评估，28 个工作包）。协议见 `WORKER.md`，计划见 `../RESUME-PLAN.md` §2.7。

## 本 lane

| 项 | 内容 |
|---|---|
| 负责路径 | `src/plugins/`（`src/plugins/translation/`、`ui-plugin-manager/` 归 U1）、`src/frames/`、`src/clients/`、`src/features/learning-hub/`（侧栏归 U2）；以处置表为准 |
| 工作包 | FE-C1（7 个子包，每包一个工作包，按 a→d 优先，移动端原型依赖它们）、FE-C2 的调用点迁移、FE-C3、FE-D2 |
| 依赖 | FE-A1（五层回归）、FE-A2、FE-A3、FE-A4 与对应 B 波槽位进 main 之后再派 |

## 验收（只认机器结果）

- 五层回归（槽位快照、IPC 轨迹、截图、构建图、行为测试）零差异；槽位快照只有 `owner` 变化且与 `owner-moves.json` 一致。
- 停用 Host 半的 profile 测试通过；FE-A4 棘轮计数不增。
- 每个子包报告给出五层 `--check` 的 job id 与 exit。

## 不做

- 不改 `host/plugins/**`；不改官方 i18n 命名空间和文案键；不拆叶子型巨型组件（PDF 阅读器、题库编辑器等）。

## 首次启动

本 lane 第一次由 `oc-dispatch launch` 启动时，只确认起点：`git merge --no-edit main`，经作业队列跑本 lane 路径下的类型检查与测试，
回复一行起点结果（main sha、job id、passed/failed）后结束本轮。不要自选工作；工作包由 C1 用 `coord.mjs assign` 派发（新会话），按 `WORKER.md` 执行与交付。

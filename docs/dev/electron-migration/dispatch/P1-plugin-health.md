# 派发：P1-plugin-health（插件架构健康，第二阶段草稿）

你是 Deep Student 迁移第二阶段 **P1-plugin-health** 的负责代理。第一阶段（本机突击）已把命令、执行器、流式、外壳等主线修完并合入 main；
你负责“插件架构健康”这条线，以及第二阶段没有专属 lane 的插件目录的维护。协议见 `WORKER.md`，计划见 `../RESUME-PLAN.md` §2.4。

## 本 lane

| 项 | 内容 |
|---|---|
| 负责路径 | 以 `dispatch/DISPOSITION.json` 为准（`coord.mjs` 派发消息里的“允许改动的路径”同源）：`host/platform/util/`、`scripts/electron-migration/boundaries.mjs`、`lib/boundary-rules.mjs`，以及已退役 lane 交来的插件目录（llm、llm-providers、chat-pipeline、notes、vfs、vfs-index、vfs-handlers、media、translation 等） |
| 工作包 | WP2-021（llm 等无专属 lane 插件的错误映射）、WP2-030、WP2-032、WP2-033、WP2-034、WP2-036，以及 C1 派来的无专属 lane 插件的差分/缺陷修复 |
| 消费 | W14 的平台服务（`ctx.files`、`ctx.crypto`、`ctx.http`）；F4 的错误映射辅助 |
| 提供 | `host/platform/util` 公共工具；边界规则 |

## 目标

1. 95 个重复工具函数收拢到 `host/platform/util`：你发布 util 并写测试；各插件里的替换由质量反馈（`quality-feedback.mjs` 的 DUPES 规则，交 S0 加规则）路由给各插件 owner，你只改自己负责的插件。
2. 边界规则：platform 不得依赖 plugins、host 不得依赖 `electron/`、kernel 与 platform 只允许单向依赖。以现状为基线，只拦新增。
3. 模块级单例改成服务实例或交给 `ctx.effect` 回收；`inject` 与实际使用对齐，消除 `ctx.get` 拿不到服务时静默返回 `[]` 的写法。
4. 拆掉剩余的巨型 `apply()`（参考 W04 对 media 的拆法：先冻结插件表面，再拆）。

## 验收（只认机器结果）

- 提交号进 main（`coord.mjs integrate` 输出里有 `P1-plugin-health: 已合入`）；lane-gate job exit 0。
- 边界规则：基线运行 exit 0；在临时分支注入一条违规 exit 1 并给出 文件:行（报告附两次 job id）。
- 单例回收：对每个改动的插件有“加载 → 卸载 → 再加载，状态不残留”的测试，全测该文件 failed=0。
- 计数类目标（重复函数、静默 `[]`）写成脚本输出，报告给出改动前后的数字与命令。

## 不做

- 不改有专属 lane 的插件目录（L04、L05、L06、L07、L14、L16、L17、L19、L20、L21、L23 的目录），需要时写进报告由 C1 转派。
- 不为健康改造改变任何命令的线上形状或错误文案；不改 TESTMAP 去向来计分。

## 首次启动

本 lane 第一次由 `oc-dispatch launch` 启动时，只确认起点：`git merge --no-edit main`，经作业队列跑本 lane 路径下的类型检查与测试，
回复一行起点结果（main sha、job id、passed/failed）后结束本轮。不要自选工作；工作包由 C1 用 `coord.mjs assign` 派发（新会话），按 `WORKER.md` 执行与交付。

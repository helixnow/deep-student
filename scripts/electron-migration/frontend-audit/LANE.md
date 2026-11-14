# X2-frontend-contracts 状态

**已完成**（C1 指派的定向复核：R01–R06、第二批 R07–R22+R05b、第三批 R23–R28、第四批 R29–R31、第五批 R32–R34）。
历史 `result.json`（`e139c97161`）中 L04/L17/L18 条目已逐项裁决，裁决与证据见 `REVIEW.md`、`reviewed.json`。

## 证据
- **WP-C2-W0-011（当前快照）**：固定 base main `e1204ee8a` 加 [wave0-sources.json](wave0-sources.json) 中的 20 个已交候选 tip，生成一次（job `20261105190226-98cd96` exit 0，产物 `01ca9d4ba`），再用同一输入跑 `--check`（`20261105190648-b14b74`，exit 1，问题真实存在）。inventory.ts 按路径选唯一 owner（`selectCorpus`），并校验工作树与 base 一致。计数见审计报告顶部。
- **WP-C2-W0-007（历史快照，已签收 9eb6c83a0）**：`inventory.ts` 生成 WAVE0 命令→owner→场景清单 `wave0-inventory.json/.md`（最终扫描 SHA `cde9325e9`，语料经 `--corpus-ref` 读取 13 个未合并提交，main 与候选分开计）。计数和旧 4 条复核见审计报告顶部。
- **main-red `650ddffbe`，复验 main `f821b3733`**：R20 的“未注册”、R29 的“必须 pending”已被 L18/L04 已合入实现取代。本轮保留 Rust 省略/去重原保证，更新真实 invoke 与 serializer 断言。`20261104233449-dff02b` 原 2 failed / exit 1 保留；`20261104233857-07c123` 两项 2 passed / exit 0。原 G03 去重 `20261104233449-ae7301` 1 passed、worker 事件 `20261104233657-aa8f51` 2 passed，均 exit 0。完整功能未签边界见 REVIEW.md 顶部。
- **main-red `677f6727c` / 发现时 main `d51544ecf`**：L18 修复已在 main，但断言翻转 `04df0ba34` 尚非 main 祖先；本分支保留 Rust 正确断言，需将断言修复一起正常集成。复验/自检结果见 `handoff-main-red-R32.md`。
- `fix(main-red)` 提交 `20ed25fac` 随合并提交 `27597e4e0`（main `80dcc5291`）通过官方自检；同基线原 `X2-R32` 作业 `20261104163336-f6c158` 1 passed / exit 0。续派合并 main `fb463060d` 后，本 lane 文件与该已验证提交没有差异；断言修复仍待正常集成，无新的自有实现或复验任务。
- 测试：`batch2.test.ts`、`batch3.test.ts`、`batch4.test.ts`、`review.test.ts`、`audit.test.ts`、`report.test.ts`。各批作业号见 REVIEW.md。
- 自检：`lane-gate.mjs` 在 `e0f5a4d55`（main `16a254adf`）全部通过；目录 vitest 作业 `20261104134147-9c439a` 5 文件 49 passed / exit 0。
- 本轮合并基线自检：`12593e306`（main `879e0a56b`）typecheck / boundaries 全部通过；新增输出回归作业 `20261104145711-0f0c0f` 2 passed / exit 0；最终提交另按 §5 再自检。
- D02 正常 main 复验：main `4525e11ac`（X2 merge `a2e216441`，typecheck / boundaries 自检通过）；`20261104153140-26dd94` 仅运行原 `X2-R32`，1 passed / exit 0。最终断言翻转提交另按 §5 自检。

## 留给其他 lane 的事项（非本 lane 工作）
- X2-D01：已全部关闭（R22 `a34d959a6`/`91e853a52`；R24、R25 `00d2606e6`/`3bff65125`），复验作业 `20261104140332-fdbc86`。
- X2-D02：**已关闭**。L18 `6b1b3fa40` 经 `a36488382` 进入 main；原 batch4 `X2-R32` 翻转为 Rust `媒体文件内容缺失: file_missing_x2`，`20261104153140-26dd94` 通过。没有其他待复验子例。
- R20 现已注册，仅空输入/配置错误/文本导入 DTO、存储与事件子集签收；PDF/其他格式不外推。R29 的 dispatcher/运行闭包现已有条件生产路径，原 G03 精确 ID 已 ported 并复验；完整 execute/真实模型不外推。
- R07–R12、R30 的旧状态保留历史基线，不在本轮另造任务；条件 worker 路径产生的 workspace_worker_ready 在原 L04 两例中观察到，不据此替代完整 chat_v2_send_message 审查。
- 既有前端问题（R18、R21、R28、R31 payload 类型）独立列出，本 lane 不改前端。

## 标准 v2 §1 八类自查（main `879e0a56b`，仅本 lane 负责代码）

| 类别 | 证据与结论 |
|---|---|
| 生产接线 | CLI `audit.ts:main` 调用真实 scanProgram / loadRegistry / reconcile / renderReport；report.test.ts 直接调用真实分类器/渲染器；batch 探针真实 apply 插件。静态测试不冒充动态成功。 |
| 单一所有者 | 扫描器只写本 lane result.json 与报告；本轮未执行写出。SQL / 文件写入仅用于 `/tmp/opencode/x2-batch*` 的测试夹具，无生产库或外 lane 实现改动。 |
| 数据边界 | schema.ts 保留未知/截断标记；只比较键、必需性与结构，不声明 enum、整数精度或完整 serde 等价。R04/R29 对 omit 方向的结论不变。 |
| 日志与错误 | CLI 故障打印并 exit 2，差异 --check exit 1；import 失败显式进入 findings；本工具不是 Rust 业务移植，无业务日志副本。 |
| 测试真实性 | 保留原测试；新增 report.test.ts 捕获 R06 旧派单与失效 runner 文案，2 passed（`20261104145711-0f0c0f`）。不以 49 个旧测试全部重跑替代此次自查。 |
| 完整性 | 沿用 REVIEW.md 中不可达、平台与跨进程边界，不声称所有业务分支完成。修正两处输出防止后续报告推翻已接受结论。 |
| 运行时语义 | metadata 探针不 apply，子进程隔离且有超时；batch 用 finally dispose 并只清理自建临时目录；没有引入后台服务、平台成功替身或新资源持有。 |
| 修复闭环 | D01 三子例已有 main 修复 hash 与原最小用例复验；D02 现已在 main 4525e11ac 以原 X2-R32 复验关闭（见上），不代改 L18。 |

本 lane 已完成，无剩余自有工作或待复验缺陷。八类自查未新增其他问题；本次仅翻转符合 Rust 的断言及记录闭环证据，未扩大覆盖范围。本轮最终提交按标准 v2 §5 完成 commit → merge main → lane-gate 后结束。

# X2 扫描器测试映射

本 lane 是新增审计工具，不移植 Rust 单测；无可标记 ported/obsolete 的 Rust 测试。
恢复时 `migration/testmap/` 与本目录均无 X2 TESTMAP。

运行：`npx vitest run -c vitest.host.config.ts scripts/electron-migration/frontend-audit`（集成门禁同款）。

| audit.test.ts 测试 | 验证要求 |
|---|---|
| AST aliases, namespace… | import 别名、namespace、条件名称、once/emit、键/类型提取、排除本地 emitter |
| fixed point derives… | 多层封装、非默认参数位置、底层转发不重复统计 |
| dynamic import destructuring… | 动态 import 别名、常量、动态事件模板 |
| fixed API command… | API 固定命令只计内部调用点；测试代码保留且单列 |
| shape comparison resolves refs… | 契约 $ref、嵌套字段、any 未知、integer/number 与联合类型 |
| three-way reconciliation… | 三方命令集合、Tauri 顶层 key 精确大小写、不转换嵌套字段、额外键为 review |
| events match dynamic channels… | 动态事件模式、payload 字段差异、Host 未解析端点不冒充缺失 |
| failed Host module imports… | 真实模块加载失败阻止门禁、不制造命令覆盖 |
| reviewed eventHub indirection… | 已人工核实的缓存间接封装、keyed handler 参数位置与 raw payload |
| runtime metadata probe… | 子进程动态加载真实模块的 meta，不执行 apply |
| explicit snake_case… | rename_all=snake_case 契约精确接受；raw Request 不误作参数对象 |
| cross-module wrapper… | 跨模块封装重命名 import、保留推导的参数位置 |
| frontend emitTo… | 跳过 target 参数，提取正确事件名及 payload |
| optional Rust event field… | Rust 可省略字段不能当作前端必需字段已对齐 |
| bare unknown event… | 未知事件不当作全部事件通配，防止制造 payload 伪差异 |
| lazy import then callbacks… | then 解构、懒加载缓存工厂、类型别名的 invoke 注入 |
| literal command tables… | 字面量命令表及单 return 事件通道工厂 |
| wrappers with bound args… | 内部绑定参数与 lease 等 payload 变换，仍能找到上层命令 |
| external shared refs… | 外部共享定义内部的局部 $ref 按原文档解析 |
| kernel registrations… | kernel 自有实际注册和 Electron 内置路由不误报缺失 |
| redundant snake/camel pairs… | 同时提供正确 key 与别名时只报多余别名，不误报调用无效 |
| Shell registerPlugin factory… | 静态提取 main → 工厂返回键，不把 handler 内返回对象算命令 |
| Host handler comparison… | kernel 将顶层 Option 缺失补 null，handler 不误报缺键 |
| loop command tables… | 循环命令表取全部元素，不把联合属性符号的首元素误当全集；可变 let 不常量折叠 |
| optional empty-args branch… | 可选参数的空参分支不能覆盖实际转发参数分支（invokeBrowser） |
| cast transport aliases… | 类型断言的 transport 别名、默认注入参数 invokeFn 保留 IPC 来源 |

全量扫描 smoke test 检查当前源码能否产生 JSON/Markdown；`--check` 以非零码反映当前差异且不写文件。
不运行 Rust、不运行所有插件测试、不修改被审计实现。

## main 合并后的定向复核（不替代全量快照）

`review.test.ts` 使用真实 src/Rust/契约/Host 文件验证已人工核实的分类；
主要检验静态证据及生产扫描器的 compareShapes/reconcile；R29 另调用当前真实生产序列化函数。不模拟 invoke 成功或插件 apply。

| 编号 | 对应测试 | 断言 |
|---|---|---|
| X2-R01 | integrated profile references… | 官方 profile 已接线真实 F2 入口，不宣称调用成功 |
| X2-R02 | real notes asset call… | 真实前端包含正确 camelCase 键；三个 snake 别名不算无效调用 |
| X2-R03 | deleted notes pagination… | 原 Rust、契约和 Host 均为 pageSize；前端 page_size 被忽略后默认 20 |
| X2-R04 | actual Canvas skip… | 实际契约的 x-option=omit 只收窄 producer，target 仍接受 null；旧 execute_write_frontend 无生产调用点 |
| X2-R05 | actual HEIC contract… | raw Request / binary Response 契约不误报普通参数对象键缺漏 |
| X2-R06 | macOS menu names… | 7 个菜单事件名字静态对齐；不在 Linux 伪造 macOS 点击投递验收 |

队列作业 `20261104064809-42b48e` 跑本文件加原 26 测试，共 32 passed / 0 failed / exit 0；
工具严格类型检查作业 `20261104064809-822239` exit 0。完整运行记录见 `REVIEW.md`。

## 第二批真实 invoke 定向探针（batch2.test.ts）

真实 apply chat/memory/media 插件并经内核 invoke；只提供外部端口。分类与证据见 `REVIEW.md` 第二批一节。

| 编号 | 断言 |
|---|---|
| X2-R07–R12 | 六条 L04 chat 命令 apply 后不在注册表，invoke 得内核 commandNotFound |
| X2-R13 | emergency_stop / resume_agents 各发一次 kill_switch_changed，payload=命令结果 |
| X2-R14–R17 | quick_assistant 三命令 resolve null；shown 发往 WebviewWindow quick-assistant |
| X2-R18 | relativePath 读真实文件；relative_path 被契约拒绝 |
| X2-R19 | media_transcribe_start 已注册；缺资源错误与 Rust 同文 |
| X2-R20 | textbooks_add 真实 invoke：空输入返回 []；无 VFS 的非空输入返回 Configuration；真实文本导入 DTO、持久化、进度 null 字段、广播与顺序均与 Rust 对照。PDF/其他格式未签 |
| X2-R21 | 契约 null Option 与前端非空类型不符（静态） |
| X2-R22 | cancelMedia 抛普通 Error → Rust `database-failed` 字符串（main a34d959a6 已修复） |
| X2-R05b | HEIC raw 输入三种情形的 AppError 与 Rust 文本一致 |

## 第三批（batch3.test.ts）

| 编号 | 断言 |
|---|---|
| X2-R23 | media_checkpoints 成功 DTO 与 Rust MediaCheckpoint 逐字段一致 |
| X2-R24 | media_checkpoints SQL 失败 → Rust 同款纯字符串（X2-D01 已由 00d2606e6 修复） |
| X2-R25 | media_study_ledger 零值 DTO 一致；SQL 失败 → Rust 同款纯字符串（X2-D01 已修复） |
| X2-R26 | textbooks_relink 不存在 → NotFound AppError 与 Rust 同文 |
| X2-R27 | bilistream 5xx 发出 media_bilibili_playback_error，键与值同 Rust |

| X2-R29（review.test.ts） | 保留 6 个字段 omit/non-required 校验；真实 agentCompletionEnvelope 的 None 省略与空字符串保留；原 G03 精确 ID 现映射 ported，不再强制 pending。原 inbox 去重不重投递保证由 L04 原测试复验 |

## main-red 650ddffbe 的 R20/R29 最小复验（固定 main f821b3733）

- 原失败复现：`20261104233449-dff02b`，仅 `X2-R20|X2-R29`，2 failed / exit 1（保留日志）。
- 更新后：`20261104233857-07c123`，同两项，2 passed / exit 0；其余 14 项由名称过滤未运行，没有新增 skip。
- L04 原 `g03_dedup_hit_converges_to_delivered_without_redelivery`：`20261104233449-ae7301`，1 passed / exit 0；真实 DeliveryWorker + L05 outbox/coordinator，delivered 状态、inbox 结果仍为一条。
- L04 原 worker 成功/失败取消事件路径：`20261104233657-aa8f51`，2 passed / exit 0；执行端口与跨 lane seams 由原测试提供，不冒充完整真实模型流水线。

## 第五批（batch4.test.ts）

| 编号 | 断言 |
|---|---|
| X2-R32 | stream_quality 缺失条目返回 Rust 文本 `媒体文件内容缺失: file_missing_x2`；L18 `6b1b3fa40` 经 `a36488382` 进入 main，保留原真实 invoke 用例复验 |
| X2-R33/R34 | browser_bridge 无桥：probe 完整 BiliError JSON、stream_quality 纯文本与 Rust 一致 |

D02 关闭复验：`20261104153140-26dd94`，仅 `-t X2-R32`，1 passed / exit 0；另一项由名称过滤未运行。main `4525e11ac`，修复 `6b1b3fa40`，集成 merge `a36488382`。

## WAVE0 inventory 回归（inventory.test.ts，WP-C2-W0-007）

| 测试 | 断言 |
|---|---|
| test and demo invoke sites… | 测试/demo 调用点不进入生产清单，单列 testOnly/demoOnly，消失项归因 test-only |
| unknown owner and unlocated Rust handler… | owner、Rust handler 未知时显式标 unknown 并计问题；differential 恒 not-run |
| multi-command scenarios… | 多命令场景中每个 step 命令都算覆盖；只在 commands[] 中声明的不算 |
| conditional registration… | inject 回调内的注册不算已证实注册 |
| seed steps of another lane… | 别域 lane 命令的种子步骤不计该命令覆盖（seedOnly、missing 仍为 true）；本域只有 error 步骤时标 errorOnly 并计问题 |
| nested pending files, auxiliary sidecars… | nested pending/platform-gated 只记 nestedIds，不计覆盖；无 commands[] 的 provider/sidecar 为辅助文件；无多数 owner 的文件为跨 owner，不计覆盖；main/候选来源分开；generate_handler! 解析含嵌套逗号的 cfg |
| corpus path owner…（WP-C2-W0-011） | 列在前面、从旧 main 分出的 tip 的继承副本不读，不遮蔽 owner；owner 改过的 main 文件换成候选版本（modifies-main），仍计为候选、不算 main；两个 tip 把同一路径改成不同 blob 时报 corpus-owner-conflict，不按顺序裁决；同 blob 时去重并合并标签；自有改动已等于 main 时仍算 main |

作业 `20261105153820-d92a39`：4 passed / exit 0；加入种子用例后 `20261105164546-c1a73c`：5 passed / exit 0；加入 nested/跨 owner/Rust 注册用例后 `20261105173713-06dac8`：6 passed / exit 0。WP-C2-W0-011 加入路径 owner 用例后 `20261105184353-7987ed`：7 passed / exit 0（`a.json@worktree` 改名为 `@main`，断言未放宽）。

## v2 自查回归（report.test.ts，不扫描调用点）

| 测试 | 断言 |
|---|---|
| R06 classification preserves… | 四种 preview 动态事件名称沿用 R06 的历史 undefined / 订阅前失败结论；保留成功通道 unproven，不重新派给 L17 |
| generated report recommends… | 直接调用真实 renderReport，推荐当前 Vitest 命令，不再输出 node --test；不写历史 result.json |

作业 `20261104145711-0f0c0f`：2 passed / exit 0。

# X2-frontend-contracts：前后端契约对账

> **WAVE0 §3/G3 命令清单快照（WP-C2-W0-011，当前）**：前端/契约/注册基线为固定 main `e1204ee8a02f1cfb3255fb1a75bb234c72236ce9`。扫描提交 `b5532109f` 与该基线只差 X2 自有文件；工具启动时用 `git diff`/`git status` 校验，不一致就 exit 2。产物头部写的 dirty 只是上一次运行留下、尚未提交的 `wave0-inventory.json`，属 X2 自有文件。输入固定在 [wave0-sources.json](../../../../scripts/electron-migration/frontend-audit/wave0-sources.json)：base 加 20 个截至 18:22Z 已交的候选 tip（完整 SHA）。F1/L03/L05/L12/L24 的语料取自 base；L12 在 base 上没有 equivalence 文件。生成 job `20261105190226-98cd96` exit 0，产物提交 `01ca9d4ba`。用同一 manifest 跑 `--check` 的 job 是 `20261105190648-b14b74`，结果 exit 1，计数与生成逐项相同。exit 1 表示清单里有真实问题，不是工具故障。之后不再为了追 main 重新生成；为过 lane-gate 合并 main 后的分支 tip 不是扫描基线。
>
> - 口径不变：生产调用点 1446，去重后 981 条命令（AST 实数；765 只是旧计划的分母）。其中 918 条有 Rust 契约，4 条是 plugin/平台命令，59 条 owner 未知。注册证据与 007 相同。`differential` 全部为 not-run，差分运行数 0。
> - 语料选择：每个路径只有一个来源。候选 tip 只贡献它自己改过的文件，判断依据是 blob 与它和 base 的 merge-base 不同。继承来的文件（来自旧 main 或其他 lane）一律不读，所以挡不住 owner 的版本。两个 tip 把同一路径改成不同内容时报 `corpus-owner-conflict`，不按参数顺序裁决。本次输入：base 提供 7 个文件，候选新增 59 个，改 main 版本的 0 个，冲突 0 个，跳过的继承副本 53 个（全部与 base 同 blob）。L02 和 L19 没有自有 equivalence 文件，记为无新增。旧规则（工作树优先、按 ref 顺序先到先得）在这批输入上不会改变数字，因为这次没有候选修改 main 文件，也没有两个 tip 改同一路径。修复防的是以后出现这两种情况时被静默遮蔽。逐 tip 文件数和每个文件的来源、与 main 的关系见 wave0-inventory.md「场景语料来源/对账」。
> - 场景覆盖：有本域 top 场景的 277 条，其中 main 18 条、只在候选里有的 259 条，缺 704 条。只有错误步骤的 14 条，只有 seed 的 15 条，只有 nested 的 1 条。问题共 886 个：scenario-missing 704、host-registration-unproven 63、owner-unknown 59、scenario-step-undeclared 45、scenario-success-missing 14、dynamic 1。候选不计入 main，这些场景都没有在 A/B 上运行。与 9eb6c83a0 独立 check 的 155(main18)/826 相比，main 部分同为 18 条，增加的部分全部来自本期候选。
> - 缺场景最多的 owner（供 C1 派下一组）：L13-vfs-api 174/190、L04-chat-session 71/98、L14-qbank 63/81、UNASSIGNED 59/59（前端调用了 Rust 未定义的命令，先定 owner）、L10-notes 46/66、L19-mcp-browser 46/46、L15-review-analytics 43/68、L18-media-docs 41/55。F2-shell 23/23 和 F3-storage 32/32 目前没有任何语料。
> - 作者声明与启发式并列列出：`declaredTargetIds` 只说明作者在 `commands[]` 里列了这个命令，不证明目标已经充分。`commands[]` 里可能有辅助命令，例如 L16 README:11 写明 `document-sessions.json` 的 16 条是“目标 10 + 辅助 6”。`declaredTargetNotDomain` 共 26 条，真实例子：L15 review 文件的 `commands[]` 列入了 `save_anki_cards`（owner L16），启发式把它判为种子；chatanki 文件也列入了 `chat_v2_create_session`、`save_api_configurations` 等其他 owner 的命令。更正上一版：C2 已撤回 L06 kill-switch 是显式目标的说法。`chat_v2_emergency_stop`/`resume_agents`/`resume_automations` 在 L06 tip `eef275701` 的 automations(11)/super-session(6) 两个 `commands[]` 中都没有列入，README:31 写的是“借用的跨域命令”，快照中三者的 declaredTargetNotDomain 均为 false。inventory.ts 的报告文字不再拿它当误判例子，改为从数据里取真实例子。
> - save_setting/get_setting：owner 按契约（C1 D059）为 L19，由 `dstu.browser` 实际注册，底层走 F4 settings 服务，契约不改。

> **历史快照：WAVE0 §3/G3 命令清单（WP-C2-W0-007，已签收 9eb6c83a0，不是本期完整语料）**：扫描 SHA `e41f1d061`（= main `6898abaae` 合并 `1b0678716` + 本工具提交，工作树 clean；src/profiles/contracts/lib.rs 自 `98c738988` 起未变，main 快照语料多了 L03 `chat-pipeline/equivalence/workspace.json`），生成器 `scripts/electron-migration/frontend-audit/inventory.ts`，产物 [wave0-inventory.json](../../../../scripts/electron-migration/frontend-audit/wave0-inventory.json) / [wave0-inventory.md](../../../../scripts/electron-migration/frontend-audit/wave0-inventory.md)。生成 job `20261105175733-8e8b96` exit 0；`--check` 见 WP 报告；参数错误 job `20261105154730-11954b` exit 2（工具故障）。
>
> - 生产调用点 1446（排除测试和 `src/demo/`），去重后 981 条命令：918 条有 Rust 契约，4 条 plugin/平台命令，59 条前端调用了 Rust 未定义的命令（owner 未知，见 md「owner 未知」）。方案中的 765 是旧版 inventory.mjs 字面量正则得出的数；契约里 frontend=app 标记 768 条，AST 展开封装后多出 150 条，没有消失项；未展开的动态调用点 1 个（`src/ui-kernel/bootstrap.ts:37`，插件桥）。
> - 注册证据：meta+静态 register 869、只有 meta 45（L16 动态注册）、kernel 实际注册 2、shell 静态路由 2、条件注册 1、off-profile 3、无注册 59。`differential` 一律为 not-run。
> - 旧 4 条复核（Rust 注册以 `src-tauri/src/lib.rs` 唯一 `generate_handler!` 为准；Host 插件有实现不等于 B 官方可调用）：`get_backup_config`/`set_backup_config` 在 Rust 中已注册（lib.rs:2219-2220），B 端 `dstu.platform.backup-config`（`host/platform/settings/backup-commands.ts`）不在 `host/profiles/desktop.json`，settings/index 只提供 settings 服务，属装配缺口，交 C1/F1，不派 L21 重复实现。`get_auto_backup_status` 只有 Rust 定义（`backup_config.rs:231-232`），不在 `generate_handler!` 中，A 端调用同样会 command not found。`chat_v2_super_deliver_inbox`（L06）只在 `inject([SEND_MESSAGE_PIPELINE_SERVICE])` 时注册（`host/plugins/agent-orchestration/index.ts:569`），main 上没有 `chat.send@1` 的提供者。另外：`test_web_search_connectivity` 也不在 Rust `generate_handler!` 中，但 B 端 `host/plugins/browser/index.ts:438` 注册了它；6 条 Rust 命令受 cfg 控制（mcp oauth 5 条、toggle_devtools）。
> - 可达口径：`callers` 是生产 src 中发出 invoke 的位置，不证明有 UI 调用。`pluginsApi.start/stop/logout`（`src/features/settings/api/pluginsApi.ts:57/58/67`）在 src 中没有引用，`plugin_start/stop/logout` 只靠封装计入。`notes_editor_flush` 经 `invokeWithLease`（`src/features/notes/noteHostCoordinator.ts:159`）真实调用，但契约标 frontend:none；它属于 150 条抽取缺口之一，不手改生成契约。
> - 场景覆盖（输入：main 快照 3 个文件 + `--corpus-ref` 13 个未合并提交，SHA 见 wave0-inventory.md）：981 条中有本域 top 场景 152 条（main 15 条，仅候选 137 条），缺 829 条。**限制**：本域/种子是启发式，按文件 `commands[]` 的严格多数 owner lane 判定，不是“目标命令/前置步骤”的作者证据。作者在 `commands[]` 中列为目标的命令另记 `declaredTargetIds`；`declaredTargetNotDomain`（16 条）表示作者列为目标、启发式却判为种子或跨 owner，两者并列，启发式不覆盖作者说明。L06 的 kill-switch 3 条在 `e3f08097b` 和当前 L06 tip `0149dff33` 的 `commands[]` 中都没有出现；README:31-38 明确写为“借用的跨域命令（不在 `commands` 里）”，owner L04，所以种子判定与作者说明一致。owner 取契约 lane，Host 实际注册插件见 `owner.plugins`：save/get_setting 契约 owner 为 L19，由 `dstu.browser`（`host/plugins/browser/index.ts:339/346`）注册，经 F4 settings 服务存储；契约未改。nested、辅助文件、跨 owner、无前端调用点的步骤命令规则同前。这些场景都没有在 A/B 上运行，不计 C 级；有场景也不等于 G3 已充分。

> **最新 main 定向复核（不全量重扫）**：固定 main `f821b3733`，处理 fulltest `650ddffbe` 的 R20/R29 两项历史负前提失效。下方 1,673 调用点 / 509 error / 296 review 是 `e139c9716` 的历史扫描快照，不代表当前 main 的剩余缺陷数。编号→提交→真实入口→队列退出码见 [REVIEW.md](../../../../scripts/electron-migration/frontend-audit/REVIEW.md)，机器修订见 [reviewed.json](../../../../scripts/electron-migration/frontend-audit/reviewed.json)。
>
> - **R20/R29 进展更新**：L18 `159fbc8ae` 经 `650ddffbe` 注册 textbooks_add，真实空输入/Configuration/文本导入 DTO、持久化、null 进度及广播已复验；PDF/其他格式未签。L04 dispatcher/worker 已在 `bb04a0c0e` 条件接线，R29 六字段省略保证保留，原 G03 去重不重投递测试复验通过；不能外推完整模型流水线。原失败复现 `20261104233449-dff02b` exit 1；更新后原两项 `20261104233857-07c123` 2 passed / exit 0，不改 GENERATED 或生产实现。以下历史分批记录中的“未注册/无生产者”以本更新为准。
> - **缺陷闭环更新**：D01 三子例均已关闭。D02 修复 `6b1b3fa40` 经 `a36488382` 进入 main；原 `batch4 X2-R32` 翻转后，作业 `20261104153140-26dd94` **1 passed / exit 0**（仅名称过滤运行此项），D02 关闭。以下分批记录保留发现当时状态，不代表当前仍开。
> - **X2-R01**：F2 的 23 条声明已由 main `642b3d6c4` 接入官方 profile，`ddd54715a` 防回归；原 21 条调用缺漏已静态核实修复，未据此声称 apply/invoke 成功。
> - **X2-R02/R03**：notes_save_asset 的冗余别名不影响调用；notes_list_deleted.page_size 是既有前端错键，Rust/契约/Host 均读 pageSize，缺省回落 20，不要求 Host 新增别名。
> - **X2-R04**：`fa0364355` 修复 X2 producer 对 x-option=omit 的误读；Canvas 五条 null/payload 差异不是 Host 缺陷。原 execute 已走 ACR apply_ops，保留旧 emitter/构造器不构成补发事件要求。
> - **X2-R05/R06**：HEIC raw Request/binary Response 契约正确；Host 接线/返回传输与平台验证仍未完成。菜单 7 个事件已人工穷举。preview 命令属于历史 undefinedCommands（inventory/unassigned.txt:36、integration/audit/commands.json:330-337）；调用者先 await、not-found 后 catch，当前 Rust 路径在订阅前失败。动态成功通道仍 unproven，但不向 L17 派新增生成/发射任务，不从 `{}` 猜全部事件。本次仅补报告/分类证据，源码未改，不重跑旧测试或全量扫描。
> - **第二批 R07–R22 + R05b（main `4c6cd1ba8`，merge `1b0f41320`，真实插件 apply + 内核 invoke，`batch2.test.ts`）**：R07–R12 六条 chat 发送/重试/编辑/续写/压缩/附件暂存仍未注册，属 L04 SPEC.md:14 自列待办（L03 编排）；R13 kill switch、R14–R17 小窗三命令与 shown 事件、R19 media_transcribe_start 已修复并真实调用通过；R20 textbooks_add 仍未注册（L18 已自列 F3 阻塞）；R18/R21 为既有前端问题；**R22 新确认**：media_transcribe_cancel 上游失败成 HandlerPanic 而非 Rust `database-failed` 字符串 → L18。R05b：HEIC 已在 main 注册，raw CallContext 输入与桌面拒绝文本已真实验证；跨进程 binary 与 Android 仍 unproven。
> - **第三批 R23–R28（`batch3.test.ts`，作业 `20261104115839-9c9945` 5 passed）**：media_checkpoints / media_study_ledger 成功 DTO、textbooks_relink NotFound、bilistream playback_error 事件均与 Rust 一致；memory://changed 13/13 发射点静态对应。**X2-D01**（L18 `mediaFailure` 把非 MediaError 变成 HandlerPanic）合并 R22/R24/R25 三个用例，复验矩阵见 REVIEW.md。
> - **第五批 R32–R34（`batch4.test.ts`，作业 `20261104133911-213c0f` 2 passed，main `ad11a8394`）**：browser_bridge 无桥时 probe 的 BiliError JSON 与 stream_quality 文本与 Rust 一致；**X2-D02**（低）stream_quality 缺失条目 Host 说"不存在"、Rust 说"内容缺失" → L18。X2-D01：R22 已由 `a34d959a6`（经 `91e853a52`）关闭，R24/R25 仍开。
> - 队列测试 `20261104064809-42b48e`：**32 passed / 0 failed / exit 0**；严格类型检查 `20261104064809-822239`：**exit 0**。本轮无跨平台成功 invoke 或独立验收签收。

源码快照：`e139c97161143638e31aa19adc43d647b6c2a095`；工具 schemaVersion=1。

## 结论与边界

**不通过**：此报告是调用面/结构对账，不是命令业务语义严格等价的证明。未改动前端或插件。
Host 插件命令来源为实际动态 import desktop profile 后取得的 `meta.commands`（runtime-meta），未执行插件 apply、未启动数据库或业务服务；不能把声明视为注册成功。另创建无插件、无数据库的真实 HostRuntime，读取内核实际注册的 plugin:* 命令。Electron main 的内置插件路由通过 registerPlugin(factory()) AST 边提取，标记为静态证据，不冒充 Host 元数据。静态 register/BackendEvents（不含测试）证据另列于 JSON。加载失败、动态命令与无法推断项均不计为通过。
Tauri 2：权威契约 args[].key 已按 tauri-macros 2.6.3/heck 0.5 转换；只精确匹配 key，不把 snake_case/camelCase 视为同义。`rename_all="snake_case"` 以契约 key 为准；嵌套结构不转换。额外顶层键 Tauri 会忽略，列 review，不误报为调用必败。
AST 遍历全部 src（含测试，测试单列不参与门禁）；识别静态/动态 import（含 then 与懒加载工厂）、别名、namespace、接口 invoke 注入，固定点推导转发封装的命令与参数位置，支持绑定参数及 payload 转换（后者明确标记 x-transform，不能声称完整键集已知）。eventHub 缓存表间接订阅另有人工核实的声明级摘要（hubListen 名称 0/handler 1；hubListenKeyed 名称 0/handler 2；registerDomainListener 名称 0/handler 1，均 raw payload；证据 src/features/workbench/core/eventHub.ts:106-117,153-184 与 agent/domainEvents.ts:312-350）。固定命令的 API/TauriAdapter 方法在其内部 invoke 点计一次，不按每个业务调用者重复展开。字符串常量/有限联合/对象命令表/条件/模板/单 return 名称工厂可展开；其余以 {} 标记动态部分，裸 {} 从不当作全事件通配。
类型由 TS checker（strictNullChecks=true，保留可空性）推断。JSON shape 深度 6，递归/any/unknown/索引签名显式保留；未知不是通过证据。结构比较检查必需字段与原始类型，不证明运行时值、所有 enum 分支或整数精度。Host 顶层 Option 参数按真实 kernel/contracts.ts:218-240 补 null 后比较；TS handler 注解差异列 review，不据此断言运行时拒绝。Host 事件为静态端点证据，不执行流式业务；未解析自定义 emitter 不宣称缺失。SDK 包内部隐式 IPC 不属于 src 内显式调用点计数。

## 运行

```sh
node --test scripts/electron-migration/frontend-audit/audit.test.ts
node scripts/electron-migration/frontend-audit/audit.ts
node scripts/electron-migration/frontend-audit/audit.ts --check
```

普通模式写本报告与 `scripts/electron-migration/frontend-audit/result.json`；`--check` 只读、重新对账，error 或 review 任一存在退出 1，工具故障退出 2，不使用当前问题作为豁免基线。info 为已定位的平台扩展而非 Rust 契约缺漏，不单独阻断。Node >= 24（原生 TS 类型擦除），依赖仓库 TypeScript。

## 统计

| 指标 | 数量 |
|---|---:|
| totalSites | 1673 |
| productionSites | 1663 |
| testSites | 10 |
| invokeSites | 1447 |
| listenSites | 180 |
| emitSites | 36 |
| frontendCommands | 980 |
| contractCommands | 1058 |
| hostCommands | 756 |
| frontendCommandsInContract | 918 |
| frontendCommandsInHostMeta | 656 |
| frontendCommandsWithShellRoute | 2 |
| frontendCommandsMissingHostMeta | 322 |
| hostCommandsMissingContract | 0 |
| frontendEventNames | 132 |
| contractEvents | 127 |
| matchedEventNames | 76 |
| eventNamesWithoutContract | 52 |
| contractEventNames | 112 |
| hostEventSites | 48 |
| loadedPlugins | 35 |
| failedPlugins | 0 |
| kernelCommandsActuallyRegistered | 3 |
| errors | 509 |
| review | 296 |
| info | 5 |

发现封装 31 个；底层转发点 32 个（不重复计业务调用）；未归入 IPC 的同名候选 87 个，全部保留在 JSON 供复查。

## 按 lane 汇总

| lane | error | review | info |
|---|---:|---:|---:|
| F1-kernel | 1 | 1 | 3 |
| F2-shell | 21 | 5 | 2 |
| F3-storage | 4 | 2 | 0 |
| F4-security | 3 | 0 | 0 |
| L02-llm-manager | 12 | 36 | 0 |
| L04-chat-session | 26 | 6 | 0 |
| L05-agent-workspace | 4 | 15 | 0 |
| L06-agent-orchestration | 0 | 3 | 0 |
| L07-agent-skills-ptc | 1 | 4 | 0 |
| L10-notes | 6 | 8 | 0 |
| L12-vfs-index | 16 | 13 | 0 |
| L13-vfs-api | 156 | 19 | 0 |
| L14-qbank | 59 | 8 | 0 |
| L15-review-analytics | 1 | 19 | 0 |
| L16-anki | 19 | 9 | 0 |
| L17-memory-research | 3 | 9 | 0 |
| L18-media-docs | 24 | 3 | 0 |
| L19-mcp-browser | 3 | 15 | 0 |
| L20-sync | 8 | 1 | 0 |
| L21-backup-governance | 0 | 8 | 0 |
| UNASSIGNED | 142 | 112 | 0 |

## 不一致清单（按 lane，前 30 条）

| lane | 类别 | 命令/事件 | 问题 | 证据 |
|---|---|---|---|---|
| F1-kernel | event-payload-mismatch | plugin-state-changed | payload.error: type null -> string | src/features/settings/components/plugins/PluginsTab.tsx:114 |
| F1-kernel | event-payload-unresolved | plugin-state-changed | frontend payload unknown | src/features/settings/components/plugins/PluginsTab.tsx:507 |
| F2-shell | argument-redundant-alias | copy_file | dest_path != destPath (Rust dest_path); correct key is also supplied; Tauri ignores this extra alias | src/utils/chatApi.ts:86 |
| F2-shell | argument-redundant-alias | copy_file | source_path != sourcePath (Rust source_path); correct key is also supplied; Tauri ignores this extra alias | src/utils/chatApi.ts:86 |
| F2-shell | event-name-unresolved | {} | eventName | src/menu/menuEventBridge.ts:104 |
| F2-shell | frontend-command-not-in-host-meta | copy_file | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/chatApi.ts:86 |
| F2-shell | frontend-command-not-in-host-meta | export_unified_backup_data | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/graphApi.ts:1146 |
| F2-shell | frontend-command-not-in-host-meta | get_app_data_dir | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/systemApi.ts:296 |
| F2-shell | frontend-command-not-in-host-meta | get_app_version | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/systemApi.ts:307 |
| F2-shell | frontend-command-not-in-host-meta | get_file_size | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/components/shared/UnifiedDragDropZone.tsx:459, src/features/learning-hub/apps/views/FileContentView.tsx:502 |
| F2-shell | frontend-command-not-in-host-meta | get_prevent_sleep | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/features/anki-tasks/AnkiTasksApp.tsx:203 |
| F2-shell | frontend-command-not-in-host-meta | install_apk | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/hooks/useAppUpdater.ts:597 |
| F2-shell | frontend-command-not-in-host-meta | open_file_externally | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/systemFileOpener.ts:38 |
| F2-shell | frontend-command-not-in-host-meta | open_system_permission_settings | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/features/settings/systemPermissions.ts:93 |
| F2-shell | frontend-command-not-in-host-meta | pdfstream_check_access | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/features/learning-hub/apps/views/TextbookContentView.tsx:256, src/hooks/usePdfLoader.ts:127 |
| F2-shell | frontend-command-not-in-host-meta | read_file_bytes | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/components/crepe/features/imageUpload.ts:435, src/components/shared/UnifiedDragDropZone.tsx:472 |
| F2-shell | frontend-command-not-in-host-meta | read_file_text | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/chatApi.ts:73, src/utils/settingsApi.ts:129 |
| F2-shell | frontend-command-not-in-host-meta | save_text_to_file | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/settingsApi.ts:125 |
| F2-shell | frontend-command-not-in-host-meta | save_webview_settings | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/systemApi.ts:94 |
| F2-shell | frontend-command-not-in-host-meta | set_android_immersive_mode | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/androidImmersiveMode.ts:27 |
| F2-shell | frontend-command-not-in-host-meta | set_backend_sentry_enabled | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/features/settings/components/GeneralTab.tsx:787 |
| F2-shell | frontend-command-not-in-host-meta | set_prevent_sleep | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/features/anki-tasks/AnkiTasksApp.tsx:209, src/features/anki-tasks/AnkiTasksApp.tsx:351 |
| F2-shell | frontend-command-not-in-host-meta | set_sidebar_vibrancy | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/components/TopLevelFallback.tsx:112, src/utils/sidebarTranslucency.ts:70 |
| F2-shell | frontend-command-not-in-host-meta | set_window_appearance | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/sidebarTranslucency.ts:31 |
| F2-shell | frontend-command-not-in-host-meta | sync_titlebar_sidebar_material | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/utils/sidebarTranslucency.ts:45 |
| F2-shell | frontend-command-not-in-host-meta | updater_install_supported | implementation module electron/index.ts declares it, but the official Host profile does not load that module | src/hooks/useAppUpdater.ts:483 |
| F2-shell | host-event-emitter-unproven | backup-jobs-resumable | no statically resolved Host BackendEvents endpoint; indirect/custom emitters require review (not proof of absence) | src/features/settings/components/DataGovernanceDashboard.tsx:1713 |
| F2-shell | host-event-emitter-unproven | data-governance-migration-status | no statically resolved Host BackendEvents endpoint; indirect/custom emitters require review (not proof of absence) | src/hooks/useMigrationStatusListener.ts:148 |
| F3-storage | argument-redundant-alias | set_test_run_id | test_run_id != testRunId (Rust test_run_id); correct key is also supplied; Tauri ignores this extra alias | src/utils/testApi.ts:118 |
| F3-storage | frontend-command-not-in-host-meta | reset_test_database | absent from all runtime-loaded desktop profile metadata | src/utils/testApi.ts:83 |

完整逐条清单见 result.json 的 findings（按 lane/code/name 排序）；下列为分组摘要，便于协调者分发。

### F1-kernel

- **event-payload-mismatch**（1）：`plugin-state-changed`
- **event-payload-unresolved**（1）：`plugin-state-changed`
- **platform-extension-without-rust-contract**（3）：`plugin:host|call`、`plugin:host|status`、`plugin:ui|manifest`

### F2-shell

- **argument-redundant-alias**（2）：`copy_file`
- **event-name-unresolved**（1）：`{}`
- **frontend-command-not-in-host-meta**（21）：`copy_file`、`export_unified_backup_data`、`get_app_data_dir`、`get_app_version`、`get_file_size`、`get_prevent_sleep`、`install_apk`、`open_file_externally`、`open_system_permission_settings`、`pdfstream_check_access`、`read_file_bytes`、`read_file_text` …（完整见 JSON）
- **host-event-emitter-unproven**（2）：`backup-jobs-resumable`、`data-governance-migration-status`
- **shell-command-outside-rust-contract**（2）：`plugin:clipboard-manager|read_text`、`plugin:clipboard-manager|write_text`

### F3-storage

- **argument-redundant-alias**（1）：`set_test_run_id`
- **frontend-command-not-in-host-meta**（4）：`reset_test_database`、`seed_test_database`、`switch_to_production_database`、`switch_to_test_database`
- **raw-body-command**（1）：`staged_upload_append`

### F4-security

- **frontend-command-not-in-host-meta**（3）：`get_auto_backup_status`、`get_backup_config`、`set_backup_config`

### L02-llm-manager

- **argument-case-mismatch**（6）：`test_api_connection`
- **argument-missing-key**（2）：`test_api_connection`
- **argument-redundant-alias**（22）：`ocr_extract_text`、`test_api_connection` …（完整见 JSON）
- **argument-shape-mismatch**（1）：`save_model_profiles`
- **argument-shape-unresolved**（1）：`estimate_tokens`
- **event-contract-ambiguous**（2）：`chat_v2_session_{}`、`chat_v2://settings_changed`
- **event-payload-mismatch**（2）：`chat_v2_llm_request_body`、`translation_stream_{}`
- **event-payload-unresolved**（1）：`deepseek_ocr_log`
- **frontend-command-not-in-host-meta**（1）：`ocr_extract_text`
- **host-event-emitter-unproven**（8）：`chat_translation_{}`、`chat_v2_llm_request_body`、`chat_v2://model_assignments_changed`、`chat_v2://model_profiles_changed`、`deepseek_ocr_log`、`essay_grading_stream_{}`、`mcp-bridge-tools-request`、`translation_stream_{}`
- **host-event-listener-unproven**（2）：`chat_translation_{}`、`translation_stream_{}`

### L04-chat-session

- **event-contract-ambiguous**（1）：`workspace_worker_ready`
- **event-payload-mismatch**（6）：`workspace_agent_completion`
- **event-payload-unresolved**（2）：`chat_v2_request_audit`、`chat_v2://kill_switch_changed`
- **frontend-command-not-in-host-meta**（20）：`chat_v2_compact_session`、`chat_v2_continue_message`、`chat_v2_edit_and_resend`、`chat_v2_retry_message`、`chat_v2_retry_variant`、`chat_v2_retry_variants`、`chat_v2_send_message`、`chat_v2_stage_context_attachments`、`chat_v2_wake_session`、`workspace_cancel_agent`、`workspace_cancel_sleep`、`workspace_close` …（完整见 JSON）
- **host-event-emitter-unproven**（3）：`chat_v2_request_audit`、`chat_v2://kill_switch_changed`、`workspace_agent_completion`

### L05-agent-workspace

- **event-payload-mismatch**（4）：`workspace_agent_joined`、`workspace_agent_left`、`workspace_coordinator_awakened`、`workspace_message_received`
- **event-payload-unresolved**（7）：`workspace_agent_joined`、`workspace_agent_status_changed`、`workspace_closed`、`workspace_message_received`
- **host-event-emitter-unproven**（8）：`workspace_agent_joined`、`workspace_agent_left`、`workspace_agent_status_changed`、`workspace_closed`、`workspace_coordinator_awakened`、`workspace_document_updated`、`workspace_message_received`、`workspace_warning`

### L06-agent-orchestration

- **event-contract-ambiguous**（1）：`todo://changed`
- **event-payload-unresolved**（1）：`chat_v2://automations_changed`
- **host-event-emitter-unproven**（1）：`chat_v2_automation_run_completed`

### L07-agent-skills-ptc

- **argument-case-mismatch**（1）：`skill_probe_requires`
- **event-payload-unresolved**（1）：`acr:bridge-cancel`
- **host-event-emitter-unproven**（3）：`acr:bridge-cancel`、`acr:bridge-request`、`skill-lifecycle-bridge-request`

### L10-notes

- **argument-case-mismatch**（1）：`notes_list_deleted`
- **argument-redundant-alias**（3）：`notes_save_asset`
- **argument-shape-unresolved**（4）：`notes_editor_flush`、`notes_enable_columns`、`notes_mentions_search`、`notes_update`
- **event-payload-mismatch**（5）：`canvas:ai-edit-request`
- **host-event-emitter-unproven**（1）：`canvas:ai-edit-request`

### L12-vfs-index

- **argument-case-mismatch**（2）：`optimize_chat_embeddings_table`
- **event-contract-ambiguous**（1）：`vfs-index-progress`
- **event-payload-mismatch**（14）：`media-processing-completed`、`media-processing-error`、`media-processing-progress`、`pdf-processing-progress` …（完整见 JSON）
- **event-payload-unresolved**（3）：`media-processing-completed`、`media-processing-error`、`media-processing-progress`
- **host-event-emitter-unproven**（6）：`media-processing-completed`、`media-processing-error`、`media-processing-progress`、`pdf-processing-completed`、`pdf-processing-error`、`pdf-processing-progress`
- **host-event-listener-unproven**（3）：`media-processing-completed`、`media-processing-error`、`media-processing-progress`

### L13-vfs-api

- **argument-extra-key**（3）：`vfs_optimize_lance`
- **argument-redundant-alias**（2）：`dstu_move_many`、`dstu_search_in_folder`
- **event-contract-ambiguous**（3）：`dstu:change`、`dstu:change:{}`、`pdf-annotations:changed`
- **frontend-command-not-in-host-meta**（156）：`dstu_copy`、`dstu_delete`、`dstu_delete_many`、`dstu_empty_trash`、`dstu_export`、`dstu_export_formats`、`dstu_list_trash`、`dstu_move`、`dstu_move_many`、`dstu_permanently_delete`、`dstu_purge`、`dstu_purge_all` …（完整见 JSON）
- **host-event-emitter-unproven**（1）：`mm_index_progress`
- **host-handler-shape-mismatch**（10）：`dstu_create`、`dstu_list`、`dstu_search`、`dstu_search_in_folder`、`todo_update_list`、`vfs_create_or_reuse`

### L14-qbank

- **argument-shape-mismatch**（2）：`qbank_commit_authoring_draft`、`qbank_list_questions`
- **event-payload-mismatch**（36）：`qbank_generation_task_event`、`qbank_grading_stream_{}`、`qbank-export-paper`、`qbank://changed`、`question_import_progress` …（完整见 JSON）
- **event-payload-unresolved**（1）：`review://changed`
- **frontend-command-not-in-host-meta**（21）：`cancel_question_bank_import`、`cancel_questions_csv_import`、`export_questions_csv`、`get_csv_preview`、`get_enhanced_statistics`、`get_exam_sheet_session_detail`、`get_learning_heatmap`、`import_question_bank_stream`、`import_questions_csv`、`list_exam_sheet_sessions`、`list_importing_sessions`、`qbank_ai_generate_questions` …（完整见 JSON）
- **host-event-emitter-unproven**（6）：`csv_import_progress`、`qbank_generation_task_event`、`qbank_grading_stream_{}`、`qbank-export-paper`、`question_import_progress`、`review://changed`
- **host-event-listener-unproven**（1）：`qbank_grading_stream_{}`

### L15-review-analytics

- **event-contract-ambiguous**（1）：`fsrs://changed`
- **frontend-command-not-in-host-meta**（1）：`fsrs_optimize_parameters`
- **host-handler-shape-mismatch**（18）：`fsrs_update_scheduler_config`、`review_plan_get_due_with_filter` …（完整见 JSON）

### L16-anki

- **argument-redundant-alias**（7）：`add_cards_to_anki_connect`、`export_cards_as_apkg_with_template`
- **argument-shape-mismatch**（1）：`save_anki_cards`
- **event-payload-mismatch**（12）：`anki_generation_event`
- **event-payload-unresolved**（1）：`anki_generation_event`
- **frontend-command-not-in-host-meta**（6）：`cancel_document_processing`、`get_document_processing_state`、`pause_document_processing`、`resume_document_processing`、`start_enhanced_document_processing`、`trigger_task_processing`
- **host-event-emitter-unproven**（1）：`anki_generation_event`

### L17-memory-research

- **event-name-unresolved**（4）：`{}`、`{}_end`、`{}_error`、`{}_start`
- **event-payload-unresolved**（3）：`hpias_event`、`memory://changed`、`quick-assistant://shown`
- **frontend-command-not-in-host-meta**（3）：`quick_assistant_apply_enabled`、`quick_assistant_hide`、`quick_assistant_show`
- **host-event-emitter-unproven**（2）：`hpias_event`、`quick-assistant://shown`

### L18-media-docs

- **argument-case-mismatch**（1）：`get_image_as_base64`
- **argument-missing-key**（1）：`get_image_as_base64`
- **event-payload-mismatch**（3）：`textbook-import-progress`
- **frontend-command-not-in-host-meta**（19）：`convert_heic_to_jpeg`、`handout_llm_complete`、`handout_vlm_caption`、`media_bilibili_bridge_pair`、`media_bilibili_create`、`media_bilibili_import_subtitle`、`media_bilibili_probe`、`media_bilibili_stream_quality`、`media_checkpoints`、`media_study_ledger`、`media_transcribe_cancel`、`media_transcribe_estimate` …（完整见 JSON）
- **host-event-emitter-unproven**（2）：`media_bilibili_playback_error`、`textbook-import-progress`
- **raw-body-command**（1）：`convert_heic_to_jpeg`

### L19-mcp-browser

- **argument-shape-mismatch**（2）：`test_mcp_connection`
- **argument-shape-unresolved**（3）：`browser_close`、`browser_focus`、`browser_get_state`
- **event-payload-mismatch**（1）：`mcp-bridge-request`
- **event-payload-unresolved**（5）：`browser:closed`、`browser:control-mode-changed`、`browser:navigated`、`browser:navigation-blocked`、`browser:title-changed`
- **host-event-emitter-unproven**（7）：`browser:closed`、`browser:content-user-input`、`browser:control-mode-changed`、`browser:navigated`、`browser:navigation-blocked`、`browser:title-changed`、`mcp-bridge-request`

### L20-sync

- **frontend-command-not-in-host-meta**（8）：`data_governance_detect_conflicts`、`data_governance_detect_prune_gap`、`data_governance_list_unsynced_items`、`data_governance_mark_asset_deleted`、`data_governance_mark_blob_deleted`、`data_governance_repo_check`、`data_governance_run_sync`、`data_governance_run_sync_with_progress`
- **host-event-emitter-unproven**（1）：`data-governance-sync-progress`

### L21-backup-governance

- **event-payload-unresolved**（1）：`backup-job-progress`
- **host-handler-shape-mismatch**（7）：`cloud_config_test_connection_draft`

### UNASSIGNED

- **event-payload-unresolved**（22）：`chat_v2_event_{}`、`exam_sheet_progress`、`mcp-bridge-resource-read-response`、`mcp-bridge-resource-read-response:{}`、`mcp-stdio-{}-closed`、`mcp-stdio-{}-error`、`mcp-stdio-{}-message`、`pomodoro-mini:ready`、`tauri://close-requested`、`tauri://created`、`tauri://destroyed`、`tauri://drag-drop` …（完整见 JSON）
- **event-without-contract**（57）：`acr:bridge-progress:{}`、`acr:bridge-response`、`acr:bridge-response:{}`、`canvas:note-updated`、`chat_v2_event_{}`、`exam_sheet_progress`、`mcp-bridge-prompts-request`、`mcp-bridge-prompts-response`、`mcp-bridge-prompts-response:{}`、`mcp-bridge-resource-read-request`、`mcp-bridge-resource-read-response`、`mcp-bridge-resource-read-response:{}` …（完整见 JSON）
- **frontend-command-not-in-host-meta**（59）：`bulk_import_problem_cards`、`cleanup_orphaned_images`、`continue_unified_chat_stream`、`delete_memory_internalization_tasks`、`export_knowledge_graph_data`、`extract_memories_from_chat`、`fix_database_schema`、`get_all_tags`、`get_chat_index_stats`、`get_detailed_tag_hierarchy`、`get_document_state`、`get_storage_info` …（完整见 JSON）
- **frontend-command-without-contract**（59）：`bulk_import_problem_cards`、`cleanup_orphaned_images`、`continue_unified_chat_stream`、`delete_memory_internalization_tasks`、`export_knowledge_graph_data`、`extract_memories_from_chat`、`fix_database_schema`、`get_all_tags`、`get_chat_index_stats`、`get_detailed_tag_hierarchy`、`get_document_state`、`get_storage_info` …（完整见 JSON）
- **host-event-emitter-unproven**（36）：`canvas:note-updated`、`chat_v2_event_{}`、`exam_sheet_progress`、`mcp-bridge-prompts-request`、`mcp-bridge-resource-read-request`、`mcp-bridge-resources-request`、`mcp-debug-command`、`mcp-stdio-{}-closed`、`mcp-stdio-{}-error`、`mcp-stdio-{}-message`、`pomodoro-mini:command`、`pomodoro-mini:ready` …（完整见 JSON）
- **host-event-listener-unproven**（21）：`acr:bridge-progress:{}`、`acr:bridge-response`、`acr:bridge-response:{}`、`chat_v2_event_{}`、`mcp-bridge-prompts-response`、`mcp-bridge-prompts-response:{}`、`mcp-bridge-resource-read-response`、`mcp-bridge-resource-read-response:{}`、`mcp-bridge-resources-response`、`mcp-bridge-resources-response:{}`、`mcp-bridge-response`、`mcp-bridge-response:{}` …（完整见 JSON）

## 动态命令/事件人工分类

下表逐点列出；有限命令联合已展开为静态名称，不在此重复。`{}` 不是通配豁免，未穷举命令保持 review。

| 位置 | 种类 | 表达式 | 分类 | 归一化名称 |
|---|---|---|---|---|
| src/mcp/tauriStdioTransport.ts:227 | listen | `${eventPrefix}-message` | 按会话/任务 ID 生成的事件通道；按模式对账 | mcp-stdio-{}-message |
| src/mcp/tauriStdioTransport.ts:247 | listen | `${eventPrefix}-error` | 按会话/任务 ID 生成的事件通道；按模式对账 | mcp-stdio-{}-error |
| src/mcp/tauriStdioTransport.ts:263 | listen | `${eventPrefix}-closed` | 按会话/任务 ID 生成的事件通道；按模式对账 | mcp-stdio-{}-closed |
| src/mcp/mcpService.ts:1790 | emit | `mcp-bridge-response:${req.correlationId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | mcp-bridge-response:{} |
| src/mcp/mcpService.ts:1798 | emit | `mcp-bridge-tools-response:${correlationId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | mcp-bridge-tools-response:{} |
| src/mcp/mcpService.ts:1806 | emit | `mcp-bridge-prompts-response:${correlationId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | mcp-bridge-prompts-response:{} |
| src/mcp/mcpService.ts:1814 | emit | `mcp-bridge-resources-response:${correlationId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | mcp-bridge-resources-response:{} |
| src/mcp/mcpService.ts:1823 | emit | `mcp-bridge-resource-read-response:${correlationId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | mcp-bridge-resource-read-response:{} |
| src/mcp/mcpService.ts:1827 | emit | `mcp-bridge-resource-read-response:${correlationId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | mcp-bridge-resource-read-response:{} |
| src/features/chat/adapters/tauri/adapterLifecycle.ts:42 | listen | blockChannel | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_v2_event_{} |
| src/features/chat/adapters/tauri/adapterLifecycle.ts:45 | listen | sessionChannel | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_v2_session_{} |
| src/debug-panel/plugins/MultiAgentDebugPlugin.tsx:255 | listen | toolEventChannel | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_v2_event_{} |
| src/debug-panel/plugins/ThinkingBlockDebugPlugin.tsx:89 | listen | eventChannel | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_v2_event_{} |
| src/features/chat/debug/multiVariantTestPlugin.ts:179 | listen | eventName | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_v2_event_{} |
| src/features/chat/debug/workspaceOrchestrationTestPlugin.ts:509 | listen | channel | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_v2_event_{} |
| src/dstu/api.ts:742 | listen | eventChannel | 按会话/任务 ID 生成的事件通道；按模式对账 | dstu:change, dstu:change:{} |
| src/features/chat/components/TranslationPopover.tsx:404 | listen | eventName | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_translation_{} |
| src/hooks/useQbankAiGrading.ts:243 | listen | eventName | 按会话/任务 ID 生成的事件通道；按模式对账 | qbank_grading_stream_{} |
| src/translation/useTranslationStream.ts:302 | listen | `translation_stream_${sessionId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | translation_stream_{} |
| src/essay-grading/useEssayGradingStream.ts:296 | listen | `essay_grading_stream_${request.stream_session_id}` | 按会话/任务 ID 生成的事件通道；按模式对账 | essay_grading_stream_{} |
| src/features/workbench/agent/bridge.ts:56 | emit | `${ACR_EVENT_PROGRESS_PREFIX}${payload.correlationId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | acr:bridge-progress:{} |
| src/features/workbench/agent/bridge.ts:202 | emit | corrEvent | 按会话/任务 ID 生成的事件通道；按模式对账 | acr:bridge-response:{} |
| src/features/chat/skills/skillLifecycleBridge.ts:154 | emit | `${BRIDGE_RESPONSE_PREFIX}${req.correlationId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | skill-lifecycle-bridge-response:{} |
| src/features/chat/plugins/blocks/subagentEmbed.tsx:311 | listen | eventChannel | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_v2_session_{} |
| src/menu/menuEventBridge.ts:104 | listen | eventName | macOS 菜单 handlers 表的键（buildHandlers）；交 F2-shell 核对 menu 事件集合 | {} |
| src/components/NoTagTreeShadPanel.tsx:187 | listen | eventName | 后端预览命令返回的事件基名，再追加 start/end/error；无法静态枚举，交 L17-memory-research 核对返回值 | {} |
| src/components/NoTagTreeShadPanel.tsx:197 | listen | `${eventName}_end` | 后端预览命令返回的事件基名，再追加 start/end/error；无法静态枚举，交 L17-memory-research 核对返回值 | {}_end |
| src/components/NoTagTreeShadPanel.tsx:203 | listen | `${eventName}_error` | 后端预览命令返回的事件基名，再追加 start/end/error；无法静态枚举，交 L17-memory-research 核对返回值 | {}_error |
| src/components/NoTagTreeShadPanel.tsx:248 | listen | `${eventName}_start` | 后端预览命令返回的事件基名，再追加 start/end/error；无法静态枚举，交 L17-memory-research 核对返回值 | {}_start |
| src/components/NoTagTreeShadPanel.tsx:253 | listen | eventName | 后端预览命令返回的事件基名，再追加 start/end/error；无法静态枚举，交 L17-memory-research 核对返回值 | {} |
| src/components/NoTagTreeShadPanel.tsx:269 | listen | `${eventName}_error` | 后端预览命令返回的事件基名，再追加 start/end/error；无法静态枚举，交 L17-memory-research 核对返回值 | {}_error |
| src/components/NoTagTreeShadPanel.tsx:278 | listen | `${eventName}_end` | 后端预览命令返回的事件基名，再追加 start/end/error；无法静态枚举，交 L17-memory-research 核对返回值 | {}_end |
| src/demo/scriptPlayer.ts:106 | emit | blockChannel | 演示包模拟后端发射；纳入扫描但不等同于 Host 发射实现 | chat_v2_event_{} |
| src/demo/scriptPlayer.ts:108 | emit | sessionChannel | 演示包模拟后端发射；纳入扫描但不等同于 Host 发射实现 | chat_v2_session_{} |
| src/demo/mockIpc.ts:623 | emit | `chat_v2_session_${sessionId}` | 演示包模拟后端发射；纳入扫描但不等同于 Host 发射实现 | chat_v2_session_{} |
| src/demo/app/packs/reading-translation/ai.ts:133 | emit | eventName | 演示包模拟后端发射；纳入扫描但不等同于 Host 发射实现 | translation_stream_{} |
| src/demo/app/packs/reading-translation/ai.ts:136 | emit | eventName | 演示包模拟后端发射；纳入扫描但不等同于 Host 发射实现 | translation_stream_{} |
| src/demo/app/packs/reading-translation/ai.ts:151 | emit | `chat_translation_${String(request.request_id ?? '')}` | 演示包模拟后端发射；纳入扫描但不等同于 Host 发射实现 | chat_translation_{} |
| src/demo/app/packs/question-bank/backend.ts:356 | emit | channel | 演示包模拟后端发射；纳入扫描但不等同于 Host 发射实现 | qbank_grading_stream_{} |
| src/demo/app/packs/question-bank/backend.ts:364 | emit | channel | 演示包模拟后端发射；纳入扫描但不等同于 Host 发射实现 | qbank_grading_stream_{} |
| src/demo/app/packs/question-bank/backend.ts:375 | emit | channel | 演示包模拟后端发射；纳入扫描但不等同于 Host 发射实现 | qbank_grading_stream_{} |
| src/engines/TemplateAIEngine.ts:32 | listen | `${eventBase}_start` | 按会话/任务 ID 生成的事件通道；按模式对账 | template_ai_stream_{}_start |
| src/engines/TemplateAIEngine.ts:44 | listen | eventBase | 按会话/任务 ID 生成的事件通道；按模式对账 | template_ai_stream_{} |
| src/engines/TemplateAIEngine.ts:69 | listen | `${eventBase}_reasoning` | 按会话/任务 ID 生成的事件通道；按模式对账 | template_ai_stream_{}_reasoning |
| src/engines/TemplateAIEngine.ts:92 | listen | `${eventBase}_json` | 按会话/任务 ID 生成的事件通道；按模式对账 | template_ai_stream_{}_json |
| src/engines/TemplateAIEngine.ts:152 | listen | `${eventBase}_usage` | 按会话/任务 ID 生成的事件通道；按模式对账 | template_ai_stream_{}_usage |
| src/engines/TemplateAIEngine.ts:174 | listen | `${eventBase}_error` | 按会话/任务 ID 生成的事件通道；按模式对账 | template_ai_stream_{}_error |
| src/engines/TemplateAIEngine.ts:219 | listen | `${eventBase}_cancelled` | 按会话/任务 ID 生成的事件通道；按模式对账 | template_ai_stream_{}_cancelled |
| src/engines/TemplateAIEngine.ts:229 | listen | `${eventBase}_end` | 按会话/任务 ID 生成的事件通道；按模式对账 | template_ai_stream_{}_end |
| src/features/chat/workspace/components/WorkspaceMessageItem.tsx:99 | listen | eventChannel | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_v2_session_{} |
| src/quick-assistant/service.ts:173 | listen | `chat_v2_event_${sessionId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_v2_event_{} |
| src/quick-assistant/service.ts:180 | listen | `chat_v2_session_${sessionId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | chat_v2_session_{} |
| src/mcp-debug/bridge.ts:309 | emit | `mcp-debug-response:${correlationId}` | 按会话/任务 ID 生成的事件通道；按模式对账 | mcp-debug-response:{} |

### 已穷举的计算型命令名

| 位置 | 表达式 | 人工分类 | 命令全集 |
|---|---|---|---|
| src/features/chat/skills/skillUsageStats.ts:37 | RECORD_ACTIVATION_COMMAND | 静态常量/有限类型或命令表，已穷举名称（不是未知运行时路由） | chat_v2_record_skill_activation |
| src/features/anki/taskControl.ts:36 | COMMAND_BY_ACTION[action] | 文档任务 pause/resume/cancel 的有限动作表，已穷举 | cancel_document_processing, pause_document_processing, resume_document_processing |
| src/features/chat/components/TranslationPopover.tsx:555 | command | 静态常量/有限类型或命令表，已穷举名称（不是未知运行时路由） | stream_chat_translation_aligned, stream_chat_translation_plain |
| src/features/flashcards/store/fsrsReviewStore.ts:707 | kind === 'bury' ? 'fsrs_bury_card' : 'fsrs_suspend_card' | 静态常量/有限类型或命令表，已穷举名称（不是未知运行时路由） | fsrs_bury_card, fsrs_suspend_card |
| src/features/flashcards/store/fsrsReviewStore.ts:1841 | lastSuspended.reason === 'bury' ? 'fsrs_unbury_card' : 'fsrs_unsuspend_card' | 静态常量/有限类型或命令表，已穷举名称（不是未知运行时路由） | fsrs_unbury_card, fsrs_unsuspend_card |
| src/features/settings/components/IndexMaintenanceSection.tsx:78 | table.command | chat/vfs 两个索引维护操作（按钮及 optimizeAll 表），已穷举 | optimize_chat_embeddings_table, vfs_optimize_lance |

## 封装入口（AST 推导参数位置，0-based；-1 为内部绑定参数）

| 位置 | 封装 | 操作 | 名称参数 | 数据/handler 参数 |
|---|---|---|---:|---:|
| src/api/tauriClient.ts:228 | tauriInvoke | invoke | 0 | 1 |
| src/api/tauriClient.ts:317 | tauriInvokeOr | invoke | 0 | 1 |
| src/demo/app/packs/media/backend.ts:187 | emitMedia | emit | 0 | -1 |
| src/demo/app/packs/reading-translation/ai.ts:115 | streamPopover | emit | 0 | -1 |
| src/features/browser/browserApi.ts:247 | invokeBrowser | invoke | 0 | 1 |
| src/features/browser/browserApi.ts:260 | invokeState | invoke | 0 | 1 |
| src/features/chat/workspace/events.ts:736 | registerListener | listen | 0 | 1 |
| src/features/learning-hub/apps/views/media/bilibiliLinkApi.ts:187 | invoke | invoke | 0 | 1 |
| src/features/learning-hub/apps/views/media/bilibiliTransport.ts:50 | command | invoke | 0 | 1 |
| src/features/learning-hub/apps/views/media/mediaTranscriptApi.ts:99 | invoke | invoke | 0 | 1 |
| src/features/mindmap/api/mindmapApi.ts:88 | invokeMindMap | invoke | 0 | 1 |
| src/features/notes/noteEditorHost.ts:134 | <callback> | invoke | 0 | 1 |
| src/features/notes/noteHostCoordinator.ts:196 | invoke | invoke | 0 | 1 |
| src/features/notes/noteHostCoordinator.ts:199 | invokeWithLease | invoke | 0 | 1 |
| src/features/settings/components/IndexMaintenanceSection.tsx:52 | optimizeTable | invoke | 1 | -1 |
| src/features/settings/components/openaiCodexAuthClient.ts:293 | call | invoke | 0 | 1 |
| src/features/settings/components/plugins/PluginsTab.tsx:100 | register | listen | 0 | 1 |
| src/features/todo/api.ts:138 | call | invoke | 0 | 1 |
| src/features/workbench/agent/domainEvents.ts:312 | ensureHubSubscription | listen | 0 | -1 |
| src/features/workbench/agent/domainEvents.ts:340 | registerDomainListener | listen | 0 | 1 |
| src/features/workbench/apps/notes/backlinksBackend.ts:41 | invokeBackend | invoke | 0 | 1 |
| src/features/workbench/components/StatusBar.tsx:393 | <callback> | invoke | 0 | 1 |
| src/features/workbench/components/WorkbenchDevPanel.tsx:609 | <callback> | listen | 0 | -1 |
| src/features/workbench/core/eventHub.ts:153 | hubListen | listen | 0 | 1 |
| src/features/workbench/core/eventHub.ts:171 | hubListenKeyed | listen | 0 | 2 |
| src/hooks/usePdfProcessingProgress.ts:77 | registerListener | listen | 0 | 1 |
| src/hooks/useTauriEventListener.ts:28 | attach | listen | 0 | 1 |
| src/ui-kernel/__tests__/community-example.test.tsx:30 | invoke | invoke | 0 | 1 |
| src/utils/chatApi.ts:65 | tauriInvoke | invoke | 0 | 1 |
| src/utils/guardedListen.ts:50 | guardedListen | listen | 0 | 1 |
| src/utils/shared.ts:153 | invokeWithDebug | invoke | 0 | 1 |

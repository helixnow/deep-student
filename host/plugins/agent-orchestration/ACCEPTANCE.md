# L06-agent-orchestration 独立验收（R2-review-agent，2026-11-04）

结论：不通过

审读快照：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。此快照没有既有 ACCEPTANCE。全部 17 条 IPC 纳入抽查；通过项限于表内行为，未以实现者的 SPEC 勾选作证据。

## 必须修复

- [ ] **O1：候选通知/局部门控已修，完整runner与正式启动链待闭合。** 最新d540b9166含平台retry时间、预约前窗口判断、catch仅error、ready后tick；不再将toISOString/取消清理错误传播/注册失败自启作为该候选待实现问题。候选未入本轮main 3b2758d7a，待最小集成复验；完整L03/L04 runner仍未闭合。正式F3/F1 **run失败规则已定**：失败不ready、不mark gate、HostFatal退出1，不自动重试；仅register失败政策待裁定，实际registry+gate组合仍需验证，模拟测试不签真实启动。见08:21Z映射。
- [x] **O2：旧服务名断线已复核修复。** index改取vfsRepo.todos，与实际L11 api（ensureDefaultInbox/createTodoItem，`host/plugins/vfs-repos/api.ts:127,132`）匹配；真实IPC命令测试验证消费该键并完成L06待办/回执/事件编排。作业20261104064353-512531退出0。只关闭键名断线，不把注入todos/shell的测试当作L11/F2整机验收。
- [x] **O3：disabled短路、成功事件及依赖缺失回退已复核修复。** fe4707440后命令/服务共用ensureSuperState/getSuperState，先判断开关；super-commands经host.invoke确认disabled时不取chat/workspace且无事件、ensure成功恰好一次changed、get_state不重复广播、缺依赖保留enabled回退。作业20261104064353-512531退出0；Rust对照 `super_session/commands.rs:18-39`，静态证据见前轮逐项表。
- [x] **O4：schedule省略字段已复核修复。** scheduleObject同时用于存储和automationToListItem，未设置Option不再输出null；列表/创建IPC及仓储严格字段集合断言通过。基线1297ac576、作业20261104064353-512531退出0；Rust对照 `automations.rs:250-274,2393-2415`。
- [x] **O5：本项分步错误上下文及Rust trim已复核修复。** fe4707440的entered/bodyDone区分begin/commit，各SQL步骤单独映射；U+0085 ID经真实update IPC成功。真SQLite触发器失败与begin/commit故障注入验证对应文案，作业20261104064353-512531退出0。关闭原列create/full-update/delete上下文与trim缺陷，不扩大为所有提交故障/事务数据回滚的证明；Rust对照 `automations.rs:1203-1217,1545,1688,1734,1786,4507`。
- [x] **O6：日志及取消事件已集成复验关闭。** 基线eeaf5bdc7包含4cbc09634→dbbfd4c2c→d540b9166的日志-only取消hooks，队列20261104110200-99af33中cancel endpoints用例分别走真实IPC与service，严格只见cancel_run且once定义disabled，退出0；Rust对照automations.rs:4635的None。原info/warn修复已有静态及既有测试证据，不重复全lane。
- [ ] **O7：legacy原边界候选已恢复，真实L04导入接线待闭合。** db42e4ea4→d540b9166已固定owner.get读/解析→automation插入commit→owner.save marker，与Rust automations.rs:1223-1266一致；这是有意保留原边界，不是F4能力缺失回退。SessionImportRepository三*WithConn与同tx编排已有，但L04真实提供方的生产消费链未证实，测试内SQL仓储不替代真实所有者；责任L06/L04，见08:21Z映射。旧直接INSERT/三参数Writer/legacy同事务marker不再派回最新候选。
- [x] **O8：kill-switch业务拒绝已通过真实消息路由settle验证。** 命令将缺chatState及真实killSwitch抛错转换validation CommandError；除原测试外，队列作业20261104065100-aee376使用实际serveHost→HostRuntime→L06命令、实际ChatV2State（未stub ensureAllowed），分别发送缺状态/已触发两条invoke，均在3秒界限内收到 `kind=result,ok=false` 的完整JSON错误字符串，退出0。不是仅toThrow或HandlerPanic测试宿主代替响应；Rust对照 `automations.rs:4855-4862`。
- [ ] **X6-UD-L06-01（复用X6编号）：候选已加字段decoder，但serde/D3仍未完整对齐。** 原main的trusted_profile_json直接as缺陷在候选95432befd已改为decodePersistedTrustedProfile；字段必填/unknown/枚举与读取时不validate方向正确。候选仍先JSON.parse为Number，丢u64精度并无法识别整数形式浮点/重复键；显式省略serde行列错误。故不签收，待按文末具体向量修复，不重复要求已有字段校验。出站JsonValue收窄不豁免入站边界；沿用X6编号，不重开已签O4/O5。

## 05:49Z/06:00Z 新候选 O1–O8 定向静态复核

候选 **`b3efce4fa`**（首批实现 `fe4707440` 等，说明 `5652c9cad:BLOCKERS.md`）。已读取候选代码与测试，不采信“33 files / 318 passed”作为自身运行证据。R2合并main后的运行基线为 **`364e0f3e4fb2884c942c2814567494d6754182f5`**，`b3efce4fa`、`5652c9cad` 均非该基线祖先，检查退出1；没有运行旧L06 suite、没有摘取实现。以下 TS 行号均属候选 `b3efce4fa`，路径前缀 `host/plugins/agent-orchestration/`；全部O项保持未勾选。

| 编号 | 真实生产入口与实现证据 | 测试真实性/静态结论 |
|---|---|---|
| O1 | `index.ts:116-124,249-257,429-445,536-550` 运行期探测runner，headless/inbox getter在缺提供方时undefined，chat.send经linked注入作用域条件注册并恢复info日志。`src/automation-runtime.ts:292-308,407-488` 已增token guard、实际结果入口、named会话写回及状态映射；通知改经 `src/automation-notifications.ts:142-204` 访问shell | 固定占位能力子项有实质改进；`tests/automation-commands.test.ts:137-181` 的headless是注入返回值，不是L03/L04真实成功执行。完整提供方仍缺、O1不关闭；通知新增错误分支差异见后 |
| O2 | `index.ts:258-267` 改取vfsRepo.todos；`repository/automation-todo.ts:62-118` 经其ensureDefaultInbox/createTodoItem，创建项与回执共用tx，提交后才emit | 与实际提供方 `host/plugins/vfs-repos/api.ts` 的vfsRepo名相符；`tests/automation-commands.test.ts:184-262` 经真实IPC触发，但todos/shell为测试注入，证明键名消费及L06编排，不等于真实L11全栈。旧键断线静态修复，未亲跑 |
| O3 | `index.ts:484-509` ensure/getState先读开关，disabled不取chat/workspace；ensure成功发changed，getState缺依赖warn后enabled=true空快照；服务与IPC复用这两入口 | `tests/super-commands.test.ts:52-106` 有真实host.invoke的disabled结果、零事件、成功changed及fallback；成功分支chat/workspace为对方服务替身，不替换L06状态机。静态对应Rust `super_session/commands.rs:18-39`，待运行 |
| O4 | `repository/automations.ts:144-164,651-675` 存储与列表共用scheduleObject，只省略null的Option字段；所有list-item使用点均受益 | `tests/automation-crud-commands.test.ts:46-80` 经IPC严格比较daily schedule为两个字段；仓储测试另断言weekly字段缺省（`:640-641`）。静态对齐Rust `automations.rs:250-274,2393-2415`，待运行 |
| O5 | `repository/automations.ts:315-345,497-595,600-644` 用entered/bodyDone区分begin/commit，并分别包装count/insert/load/update/reload/active-check/delete；index update使用rustTrim（`:162,362`） | `tests/automation-repository.test.ts:644-710` 真SQLite触发器拒绝insert/update/delete；begin/commit注入仅验证上下文分类，不证明真实SQLite commit失败回滚。`:197-205` 的CRUD命令测试验证U+0085 ID。静态步骤文案/顺序符合Rust `automations.rs:1083,1203-1217,1545,1686-1688,1734-1786`，待亲跑 |
| O6 | `repository/automations.ts:1085-1098` 补changed=1 info/事件、失败warn，runtime finalizeOnce传日志/事件hooks；但IPC取消入口 `index.ts:192-197` 与service `:386-389` 也传含emitChanged的onceFinalizeHooks | 日志恢复子项成立；**取消路径多发once_completed**：Rust `automations.rs:4635` 用None，不发该事件，命令只发cancel_run（`:4666-4667`）。候选 `repository/automations.ts:1071,1093-1095` 会先once_completed再cancel_run。O6仍有语义缺陷；当前仓储测试验证一般finalize有事件，未证明取消路径原序列 |
| O7 | `repository/session-tools.ts:324-337` 只声明SessionImportWriter，`src/session-tools.ts:1055` 委托writer；`repository/automation-legacy.ts:92-129` 改经settings所有者且marker仍在事务返回后save（符合Rust `automations.rs:1263-1266`） | 跨表直接INSERT移除及settings子项静态改善，但L04公开api未提供对应三参数原子writer。`tests/session-tools-db.test.ts:45-89` 的createImportWriter明确是测试替身，自写整套INSERT及transaction；不能证明真实提供方存在或同事务，原TESTMAP `:224` 仍ported。O7不关闭，需真实所有者接口/消费或保持pending |
| O8 | `index.ts:232-246` 将缺chatState及killSwitch抛出的Error转automationCommandError(validation)，命令通过runCommand分派；对应Rust `automations.rs:4855-4862` | `tests/automation-commands.test.ts:120-135` await真实host.invoke后精确比较JSON字符串并排除HandlerPanic，**不是只toThrow**。但chatState为测试注入，未亲跑、未测真实L04/connection传输下settle；静态正确，运行证据待集成 |

### O1 通知增量仍需对齐的分支

候选 `src/automation-notifications.ts:162-188` 的“已投递/策略never/活跃窗口/发送成功”分支，清marker和retry时间直接传播SQL异常；Rust `src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:3098-3105,3113-3123,3132-3142,3173-3183` 对这些操作均 `let _` 后继续。reserve失败也未按Rust `:3163-3168` 在本层warn并返回Failed。`:197` 的补投时间使用toISOString（Z），Rust `:3200` 使用to_rfc3339（+00:00），该字符串写入SQLite并用于调度比较，不能仅按日志差异豁免。此处记录于原O1执行/通知未完成项，不以壳通知调用存在就签收整体等价；本轮未新增编号。

### 运行基线与后续最小验证

本轮L06 runner **NOT RUN**，无退出码或Errors输出，不继承提供方33/318。集成后优先通过队列运行 automation-commands、automation-crud-commands、automation-repository、super-commands 定向文件；O8另须核对真实chatState/IPC错误settle，O7须等真实writer并验证原子回滚。O1完整执行仍依赖L03/L04，条件不发布仅是缺能力表达修正；旧chat.send@1仍待公开服务契约收敛。本轮不运行Electron或跨平台场景。

## 06:20Z 新增 D1/D2 候选复核（仅 O1/O7 增量）

候选 `539945675`，实现 `57683699e` / `72e69f8d2`，测试 `84a7d205c`。已与上轮 `b3efce4fa` 做增量对照。运行基线仍为 `47953bc66`（L03定向作业已完成，无重复作业）；核对main固定为 `2bf677b208dc798e0370658f05e491d5de899040`。539945675不在该main（祖先检查退出1），本轮候选runner未启动，无job/result退出码或Errors输出，不运行旧L06测试。下列TS行号均属注明提交。

### 提供方独立核验（不采信候选BLOCKERS的过期状态）

| 能力 | 实际提供方证据 | main 2bf677b2 状态 / L06消费状态 |
|---|---|---|
| settings getWithConn/saveWithConn | `7e063cfdd:host/platform/settings/api.ts:48-58` 定义；`index.ts:81-93` 真实store使用传入SqlExecutor执行所有者SQL | **已进入main**（祖先检查0）；L06候选index startup将ctx.settings传入legacy迁移，满足探测时会选择新分支，不能仍称此提供方branch-only |
| systemNotification | `e95356480:electron/index.ts:31,39-44` provide；固定main同文件保留provider，`host/profiles/desktop.json:41` 包含dstu.shell | **已进入main**（祖先检查0）；L06候选 `index.ts:128-138` 动态探测匹配方法，真实消费仍待L06集成；不继承注入替身的送达结果 |
| chat三个*WithConn | `44a15ca22:host/plugins/chat/api.ts:27-32` 导出真实session/message/blocks仓储函数 | **未进入该main**（祖先检查1）；候选没有importSessionPayload的生产调用方，只有函数定义与公开再导出，尚未构造真实SessionImportRepository |
| storage finalizer | `bf8f7b439:host/platform/storage/service.ts:184-193,308-310` 发布注册/运行方法；`startup-finalizers.ts:29-75` 只登记、显式run时才执行 | **未进入该main**（祖先检查1）；该提供方快照内未找到组合根调用runStartupFinalizers，只有实现/绑定/文档，不能把注册视为执行 |
| backgroundTasks | `host/platform/diagnostics/api.ts:14-18` 的spawn/shutdown接口；候选 `index.ts:140-142,390-400` 消费 | main已有该平台能力；本候选只把tick交给spawn，缺服务时直接runTick。此改动不证明所有headless任务已纳入退出等待 |

### O7：会话导入同连接改进，legacy事务边界仍不等价

- **会话导入编排静态改善**：`539945675:src/session-tools.ts:1055-1065` 在解析/重映射后由调用方开IMMEDIATE事务，将同一tx依次传createSessionWithConn、每条createMessageWithConn、createBlocksBatchWithConn；失败包装SESSION_IMPORT_DB_FAILED。对应Rust `src-tauri/crates/dstu-agent/src/chat_v2/tools/session_executor.rs:551-574`。SQL仍归表所有者，符合D1接口方向。
- **真实提供方未接线**：`repository/session-tools.ts:324-339` 是消费端接口，不是provider；候选内检索importSessionPayload只见定义，index未装配。`tests/session-tools-db.test.ts:45-91` 仍在测试里实现所有者INSERT，新回滚测试 `:363-387` 证明L06调用方事务遇到blocks错误会回滚，但不证明L04实际方法被调用/原字段语义全部保留。不能据同一个tx对象就关闭O7或将未接线部分计作已完成。
- **legacy新WithConn分支违反原边界**：`repository/automation-legacy.ts:145-154` 把marker检查、JSON读取/解析、automation插入、marker保存全放到同一IMMEDIATE事务。Rust `automations.rs:1223-1234` 是先读settings/解析，再开事务（`:1236-1241`），插入commit后释放连接，最后save marker（`:1263-1266`）。新分支既改变“已迁移直接返回”与begin失败的优先级，也让marker保存失败回滚已插入定义，而Rust此时定义已提交。D1要求保持**原有**事务，不是把所有者方法全部塞进事务。
- `tests/automation-repository.test.ts:788-825` 的Map版withConnSettings忽略真实tx；它新增“marker被拒则automation插入回滚”的断言，锁定了与Rust不同的边界，不应作为等价证明。Fallback `automation-legacy.ts:157-163` 保留get-before/save-after，可说明仍通过settings所有者及原先分段顺序，**不能声称跨所有者原子操作已完成**；也不能为了该称谓改变Rust原边界。F4已在main提供WithConn后，候选探测将走有问题的新分支，此非纯假设路径。O7保持未关闭。

### O1：启动finalizer尚不能保证初始化先于tick

- `539945675:index.ts:364-373` 注册finalizer，无after依赖；注册失败warn后立即initializeScheduler。F3 `bf8f7b439:startup-finalizers.ts:29-46` 对late/duplicate注册抛错，run按拓扑顺序await（`:53-75`）。捕获后直接初始化绕过排序/失败闸门，不能称与平台启动次序等价；未配置after也没有给出恢复收尾先于自动化的依赖证据。
- `index.ts:375-401` 不论注册是否仅挂起，立即setInterval，每15秒触发，只有ticking互斥，没有初始化完成标记。F3注册本身不执行callback；若组合根尚未run、前序finalizer等待或失败，tick仍可先行。Rust `automations.rs:5577-5609` await初始化任务完结才进入`:5611-5630`的tick循环。不能用“通常15秒内完成”证明顺序。
- `tests/automation-commands.test.ts:124-158` 用Proxy把registerFinalizer写入Map，安装后立即手工调用hook；仅证明回调内容可执行，未用真实F3 run排序，也未让定时器跨过未初始化阶段、未测试注册失败和前序finalizer失败。需要实际生产组合根/启动顺序证据后才能关闭该O1子项。
- backgroundTasks.spawn对tick在途计数与退出拒绝是有效接缝方向，但它不是startup gate，不阻止上述抢跑。没有证据要求自动化备份/恢复/删除传播治理许可；本轮**不要求新增L21 guard**，自定义人设文件锁不归为治理锁。

### O1：通知结果分类改进与剩余预约顺序差异

- `539945675:src/automation-notifications.ts:188-232,251-292` 新增清理marker/retry的best-effort分支，reserve错误原位warn后返回Failed，修复了上轮“清理错误向上抛”的子项；delivered清pending，suppressed释放notification预约并清pending，error释放后安排补投，返回handled/deliveredOs区分正确。`tests/automation-notifications.test.ts:190-257` 在真SQLite上检查最终marker/结果，但notification provider为注入对象，不是实际F2。
- **窗口抑制顺序仍不同**：正式provider分支先写notification预约（`:257-264`），再await notify让F2判断窗口（`:268-273`），被抑制后才撤预约（`:282-287`）。Rust `automations.rs:3131-3147` 在reserve（`:3153`）前先判断窗口活跃并返回handled。对“窗口活跃且预约SQL失败”的可达失败分支，Rust不做预约、返回suppressed，候选却提前返回Failed且不调用窗口判定；窗口抑制路径的落盘/故障顺序不能由最终“无marker”断言证明等价。
- `releaseAndScheduleRetry` 的 `:226` 仍用toISOString写Z时间，Rust `automations.rs:3200`写to_rfc3339的+00:00；上一轮持久化时间格式未决项保留。实际F2 `electron/system-notification.ts:57-66` 的窗口查询失败返回error，而Rust `automations.rs:3039-3047` 按不活跃继续；此为L06/F2集成待对齐，不在审读分支改实现。

本轮只追加静态证据，O1/O7不勾，其他O项不重做。候选进入运行基线并修复上述顺序后，最小相关文件为automation-commands、automation-repository、automation-notifications、session-tools-db，**届时经全局job队列**提交；本轮无新测试job，已完成的L03作业 `20261104061531-b747b9` 不重复提交。

## 后续建议

- [ ] 增加真实插件组合的 ensure-disabled、kill-switch 拒绝、todo 投递验收；目前 `tests/services.test.ts` 甚至将 headless 固定失败作为预期，测试全绿不能作为功能等价证明。
- [ ] `repository/automations.ts` 和 `src/session-tools.ts` 均超过约 800 行，后续按职责拆分；优先修复上列行为问题。

## 已核实通过

- [x] **复核确认**：17 条契约命令都有注册，`contracts/ipc/L06-agent-orchestration.json:4` 与 `index.ts:54-60` 对应；见下表逐项结论。
- [x] **复核确认**：TESTMAP 239 行均 ported，0 pending/obsolete/merged，表头与行统计一致（`TESTMAP.md:12,20-258`）；没有需要批准却擅自标 obsolete/merged 的行。15 条 schedule 原测试断言真实保留。
- [x] **复核确认**：set_enabled 使用 immediate 事务，取消运行 token 置于 afterCommit；命令事件在仓储返回后发送（`repository/automations.ts:350-430`、`index.ts:100-105`；Rust `automations.rs:1321-1409`）。
- [x] **复核确认**：本 lane 发布的 agentAutomation/agentSubagent 为 lowerCamelCase 且 meta/provide 一致（`index.ts:61,279,421`）；跨插件 import 经 api.ts。旧消费名 O2 和 inbox 的 chat.send@1 是例外，不能算整体命名通过。
- [x] **复核确认**：31 个测试文件、298 用例亲跑全部通过；原生导入及静态 wiring 通过；strict 无未豁免违规、无生产 console 或测试模块 import。O6 的语义吞错和 O7 的表所有权违规仍需人工检查。

## 命令等价：17 条

简称 R=`src-tauri/crates/dstu-agent/src/chat_v2/automations.rs`，C=`src-tauri/crates/dstu-agent/src/chat_v2/super_session/commands.rs`，I=`host/plugins/agent-orchestration/index.ts`，A=`host/plugins/agent-orchestration/repository/automations.ts`。日志、错误、返回形状差异分别按上列 O 项归并。

| 命令 | 结论与抽查内容 | TS / Rust 证据 |
|---|---|---|
| chat_v2_automation_list | 问题 O4；created_at/id 排序、count/max、notify session_mode=null 与 agent 默认 isolated 一致 | I:91、A:325-330,584-615 / R:2370-2415,4425-4432 |
| chat_v2_automation_create | 问题 O4/O5；enabled=true、notify、run_once、2/60/600 默认；字段校验、事务内 20 上限、提交后事件一致 | I:92-98、src/automation-request.ts:63-80、A:259-317 / R:1113-1217,4436-4470 |
| chat_v2_automation_set_enabled | 问题 O4；版本 CAS、同状态 no-op、不增版本、提交后 cancel 通过 | I:100-106、A:350-430 / R:1310-1409,4475-4495 |
| chat_v2_automation_update | 问题 O4/O5；缺省与显式 null 的 editable 字段、once_completed 提示通过；automationId 使用 JS trim 而 Rust trim，U+0085 输入会产生额外差异（属 O5 输入/错误修复范围） | I:108-125、src/automation-request.ts:83-116、A:442-545 / R:4499-4548 |
| chat_v2_automation_delete | 问题 O4/O5；版本→heartbeat→活跃 run 的检查顺序、reversible=false 通过 | I:128-133、A:549-572 / R:1716-1786,4817-4834 |
| chat_v2_automation_runs | 通过所查过滤与默认值：automationId=null、limit=50、runs/count；不据此保证所有 optional run 字段省略语义 | I:135-139 / R:4554-4565 |
| chat_v2_automation_cancel_run | 问题 O6；条件更新→prune→owner→cancel token→once finalize 顺序、错误字符串主路径通过 | I:141-146、A:892-933 / R:4596-4669 |
| chat_v2_automation_retry_run | 通过：仅终态重试，agent 清 delivered、notify 保留，max_attempts 至少 attempt+1，成功事件 | I:158-163、repository/automation-summary.ts:40-56 / R:4569-4593,4642-4654 |
| chat_v2_automation_summary | 通过：六项聚合、24h 失败窗、next retry、nullable MIN/MAX，查询后读 background，失败默认 true | I:82-89、repository/automation-summary.ts:11-37 / R:4674-4784 |
| chat_v2_automation_set_background_enabled | 通过：先保存 true/false 字符串，失败带业务前缀，成功才发事件 | I:148-156 / R:4795-4812 |
| chat_v2_automation_run_now | 问题 O1/O2/O8；pause 和版本检查有实现，但完整执行/拒绝映射不等价 | I:175-234、src/automation-runtime.ts:311-340 / R:4839-4969 |
| super_session_get_settings | 通过：缺设置/读失败回退空 instructions | I:364、src/settings.ts:27-32 / C:43-45 |
| super_session_set_settings | 通过：Rust trim、按 Unicode scalar 截 4000、保存错误原前缀、成功 null | I:410-417、src/settings.ts:35-41 / C:49-54 |
| super_session_ensure | 问题 O3：disabled 短路及 changed 事件缺失 | I:402-404 / C:33-39 |
| super_session_get_state | 问题 O3 的依赖预取；已齐依赖时 enabled=false 和 ensure 失败回退分支保留 | I:365-407、src/super-state.ts:603-618 / C:18-19 |
| super_session_set_enabled | 通过所查内部状态机：写设置→ensure/取消 worker→hidden→changed；全链受 W2/O1 未接线影响 | I:408-409、src/super-state.ts:626-649 / C:24-28 |
| chat_v2_super_deliver_inbox | 问题 O1；生产依赖解析即失败，不能拿测试注入的 pipeline 证明已完成；命令入口 info 日志也未保留 | I:344-362、src/super-inbox-drain.ts:178-219 / C:59-81 |

普通时间格式使用平台 chrono，数据库返回数字仍经 `num(Number)`（A:127-141,220）；`SPEC.md:17` 登记了精度限制，但它不是协调者批准的持久化大整数等价豁免，本轮未宣称全域 u64 等价。

## ported 测试真实性：15 条

映射 `TESTMAP.md:21-35`。TS 统一 `host/plugins/agent-orchestration/tests/automation-schedule.test.ts`，Rust 统一 R。生产函数由 A:6-13 及 runtime 调用，从 index 实际可达；所有项通过、复核确认，未 stub 被测算法。

| 原测试名 | 保留断言 | TS 行 / Rust 行 |
|---|---|---|
| parse_time_accepts_hhmm | 09:30、带空白 23:59 | 34 / 5770 |
| parse_time_accepts_24_hour_boundaries | 00:00/23:59 接受，24:00/23:60 拒绝 | 39 / 5782 |
| parse_time_rejects_non_hhmm_shapes | 九个非法输入（含全角数字）均拒绝 | 46 / 5796 |
| parse_last_run_at_preserves_rfc3339_timezone_instant | +08:00 转同一 UTC 时刻 | 52 / 5816 |
| validate_schedule_daily_rejects_weekday | daily + weekday 拒绝 | 56 / 5826 |
| validate_schedule_weekly_requires_weekday | weekly 无 weekday 拒绝 | 60 / 5841 |
| normalize_schedule_shape_weekly_canonicalizes | 集合去重升序、单元素收敛、daily 不改 | 64 / 5856 |
| validate_name_and_prompt_limits | 空名、4001 prompt、101 name 拒绝，正常通过 | 86 / 5896 |
| is_due_daily_before_time | 到点前 false | 101 / 5904 |
| is_due_daily_after_time_never_run | 到点未跑 true | 105 / 5911 |
| is_due_daily_already_ran_today | 当日已跑 false | 109 / 5918 |
| is_due_daily_catch_up_after_offline_same_day | 昨日跑、今日晚到 true | 113 / 5926 |
| is_due_weekly_wrong_weekday | 周三对周一 false | 117 / 5934 |
| is_due_weekly_on_scheduled_day | 周三对周三 true | 124 / 5954 |
| compute_next_trigger_daily_later_today | 当日 10:00→18:00 | 130 / 5973 |

上述成立不覆盖 O1 的 headless 真正执行；239 条静态接线通过也不证明 `ctx.get` 的运行时服务名有效。

## 亲自运行：原始输出摘要

Linux / Node v26.5.0，以下退出码均 0。

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/agent-orchestration
 RUN  v3.2.7 /home/dsdev/dev/ds-mig/R2-review-agent
 Test Files  31 passed (31)
      Tests  298 passed (298)
   Start at  11:35:52
   Duration  29.80s

$ node scripts/electron-migration/wiring.mjs --lane agent-orchestration
合计 ported 239，其中所测模块未从 index.ts 接入 0（0.0%）

$ node scripts/electron-migration/importable.mjs host/plugins/agent-workspace/index.ts host/plugins/agent-orchestration/index.ts host/plugins/chat-pipeline/index.ts
importable: ok
(node:74395) ExperimentalWarning: WASI is an experimental feature and might change at any time

$ DSTU_BOUNDARY_STRICT=1 node scripts/electron-migration/boundaries.mjs host/plugins/agent-workspace host/plugins/agent-orchestration host/plugins/chat-pipeline
boundaries: scanned 264 files, 0 violation(s), 15 suppressed via boundary-allow
```

## 语义差异分类

**缺陷/未完成（应修）**：O1 残缺执行/通知及入口 info 缺失；O2 旧服务名；O3 ensure 开关/事件/依赖顺序；O4 null 与缺省；O5 事务文案及 update ID 的 JS trim；O6 once 日志/事件；O7 表所有权；O8 kill-switch 错误变 panic。

**已登记但不是已接受的平台差异**：`SPEC.md:29,34-39` 已记录 headless/send/通知缺口，不改变 O1 必须闭合的结论；`:17` 记录 Number 限制。**已接受平台差异**：`docs/dev/electron-migration/decisions.md:52-59` 中毫秒时间精度；同步无 await 的状态临界区替代锁是本轮可接受实现方式。上述记录均未批准旧服务名、业务错误前缀丢失、事件缺失或跨表复制。

## 最新集成实跑：基线1297ac576（本节覆盖旧快照状态）

运行基线 `1297ac576df147d46949f3f72e85f8c91eb6a68d`，合入main `9c13dfc39f2c29aaffda6c61f7dedee2273197f5`，含539945675。已对照539945675与本基线的index、automation-legacy、automation-notifications，无实现差异；因此此前静态已指出且未修的O1/O6/O7分支继续有效。clearNotificationMarker/Pending的catch继续及reserve的catch已是当前源码，不再作为待修项。

### 六文件定向作业

```text
job 20261104064353-512531
command: npx vitest run -c vitest.host.config.ts host/plugins/agent-orchestration/tests/automation-commands.test.ts host/plugins/agent-orchestration/tests/automation-crud-commands.test.ts host/plugins/agent-orchestration/tests/automation-repository.test.ts host/plugins/agent-orchestration/tests/super-commands.test.ts host/plugins/agent-orchestration/tests/automation-notifications.test.ts host/plugins/agent-orchestration/tests/session-tools-db.test.ts
 RUN  v3.2.7 /home/dsdev/dev/ds-mig/R2-review-agent
 ✓ session-tools-db.test.ts (5 tests)
 ✓ automation-crud-commands.test.ts (15 tests)
 ✓ automation-repository.test.ts (47 tests)
 ✓ automation-commands.test.ts (7 tests)
 ✓ automation-notifications.test.ts (10 tests)
 ✓ super-commands.test.ts (3 tests)
 Test Files  6 passed (6)
      Tests  87 passed (87)
   Start at  14:43:55
   Duration  22.09s
[作业 20261104064353-512531] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064353-512531.log
```

job result及完整log 84行已读取，无Errors报告行/未捕获异常。O2–O5原列修复点结合既有Rust审读可关闭。87通过不代表全部断言等价：legacy marker失败回滚测试仍锁定与Rust不同的边界，session import测试仍用测试仓储，finalizer仍由测试手动触发，不能用这些绿项关闭O1/O7。

### O8真实生产连接错误响应补证（不写实现/测试文件）

额外通过队列提交 `node --input-type=module -e <内联核验>`，作业 **20261104065100-aee376**。脚本完整命令可从job result回取；使用现有kernel fixture profile仅完成启动，加载仓库IPC契约及真实L06插件，在临时目录创建真实F3库/三个automation迁移与真实F4 settings。实际测试目标链为：内存HostTransport发 `handshake/invoke` → **生产serveHost连接路由** → HostRuntime/契约/真实L06命令 → `HostTransport.send` 收到结果；没有使用createTestHost的HandlerPanic替代器。先不提供chatState，再注入从 `chat/api.ts` 导出的真实ChatV2State并trip；没有替换ensureAllowed。每次有3秒超时，严格比较整条结果。结束shutdown/dispose并删除自建临时目录，未写仓库其他路径。

```text
O8 real serveHost wire responses: [{"kind":"result","id":"r2-missing","ok":false,"error":"{\"code\":\"VALIDATION_ERROR\",\"message\":\"AgentKillSwitch gate: ChatV2State is unavailable, admission denied (fail-closed).\"}"},{"kind":"result","id":"r2-tripped","ok":false,"error":"{\"code\":\"VALIDATION_ERROR\",\"message\":\"AgentKillSwitch tripped: all agent activity is stopped. Call chat_v2_resume_agents to resume.\"}"}]
PASS: 2 actual InvokeRequest -> InvokeResponse error settlements; real ChatV2State, no HandlerPanic substitute.
[作业 20261104065100-aee376] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104065100-aee376.log
```

该Node原生runner无Errors报告/异常输出，O8关闭。这证明生产协议路由的错误响应，不声称测试了Electron原生MessagePort或前端UI。本轮不跑Electron/跨平台；不重复L03已完成作业。当前O1/O6/O7仍未关闭，lane结论仍不通过B。

## 新候选 dbbfd4c2c：拆分仓储后的 O1/O6/O7 静态增量

本轮基线HEAD=`79d94bf24ca931eae44462c89611fa6497d3b0a2`，main固定核对点=`d5cd234aa8a919807b65eeca250e5567cc527f95`。`dbbfd4c2c` 及4cbc09634/bc965752a/6772ac1f0/1e6bab7ba/db42e4ea4均非该main祖先（逐项退出1）。按未集成分支仅静态核对，不重复旧suite或已关闭项目。C1提供方作业20261104064508-d5f478的67通过/exit0不计为本审读者运行。

**追溯实际文件而非旧行号：** `dbbfd4c2c:repository/automations.ts:20-41` 现为re-export；定义CRUD在automation-definitions.ts，共享类型在automation-model.ts，取消/once/租约/通知记录在automation-runs.ts。生产index/runtime继续经该聚合出口引用，取消实际实现核对到automation-runs.ts，未因原文件行数消失判定实现丢失。

| 编号/子项 | 提交、真实入口及新文件证据（行号均属dbbfd4c2c） | 静态结果与断言真实性 |
|---|---|---|
| O6取消事件 | 4cbc09634；`index.ts:114-120,217-221,463-466` IPC/service均传onceFinalizeLogHooks；`repository/automation-runs.ts:225-260` 接收日志类型，并在调用finalize前显式重建 `{info,warn}` | 不只TS类型限制，运行时也不会转发意外emitChanged。先cancel token再finalize的顺序保留；普通调度仍可传完整hooks（同文件:270-291），符合Rust automations.rs:4635的None及:1894-1930的可选事件。新 `tests/automation-commands.test.ts` 的 `cancel endpoints finalize once automations without emitting once_completed` 经真实IPC及公开service分别取消两条once，严格只见两条cancel_run并确认定义disabled。静态符合，未亲跑不勾 |
| O1 retry时间 | 4cbc09634；`src/automation-notifications.ts:222-229` → `formatTimestampMillis` → `src/automation-schedule.ts:443-444` 的chronoRfc3339 | 已不使用toISOString，失败先释放预约，非running才设置+5分钟重试；新测试分别检查两条失败路径的持久化retryAt以+00:00结尾。符合Rust automations.rs:3186-3207。此候选不再列时间格式缺陷 |
| O1抑制/预约顺序 | bc965752a/6772ac1f0；`src/automation-notifications.ts:254-287` 先policy、再mainWindowIsActive、再reserve、再notify；传suppressIfWindowActive=false | mainWindowIsActive继续使用查询失败false的公开shell原语；禁止F2二次查询，解决上轮窗口查询失败被改为投递error的集成分支。测试验证预检时notify未调用、shell三个调用、最终marker；抑制前无reserve还来自源码先后顺序，不以仅最终无marker冒充中间步骤断言。后续provider返回suppressed仍释放预约。静态符合所列原分支，未签整机OS通知 |
| O7 legacy边界 | db42e4ea4；`repository/automation-legacy.ts:137-151` 先owner.get marker→读取/解析→IMMEDIATE插入事务返回→owner.save marker | 已移除WithConn条件分支，即使真实F4提供WithConn也不会改变顺序。原先“marker失败回滚定义”的错误断言已删除，新增测试用真实SQLite确认marker保存拒绝后定义仍有1条；另测marker=true先于坏JSON解析短路。对齐Rust automations.rs:1223-1241,1263-1266。静态修复符合；不称跨所有者原子、也不以此关闭整个O7 |
| O1正常finalizer tick门控 | 1e6bab7ba；`index.ts:329-339,376-423` startScheduler先initialize再创建timer，正常注册时callback不执行就没有timer；disposed避免卸载后启动 | “starts the scheduler tick only after the startup finalizer runs” 测试推进15秒，hook前spawn=0、hook后spawn=1，较旧手动hook测试增加了timer证明。但registerFinalizer/backgroundTasks仍为接缝替身，不证明F3真实组合根拓扑/错误分支。正常注册时抢跑子项静态修复 |

### O1仍未修：注册失败绕过平台启动闸门

`dbbfd4c2c:index.ts:410-415` 的registerFinalizer catch仍warn后直接startScheduler，绕过F3对late/duplicate/排序失败的治理；新增测试只覆盖注册成功，不覆盖失败。将timer移到hook内部没有解决catch直接执行同一hook的问题。此项继续派回O1，不能用67通过或timer测试关闭整项。真实L03/L04完整runner依赖、O7真实L04仓储提供与生产调用也保持未完成。没有新增要求自动化获取L21备份/删除许可。

本轮runner **NOT RUN**：无新job、无result退出码/Errors，不继承提供方结果。待候选进入运行基线后，经全局队列仅运行automation-commands、automation-notifications、automation-repository三个文件验证这批修复；不重复已关闭W5/O2–O5/O8/P2/P3/P6。O6暂留未勾选，O1/O7仅更新子项，未关闭计数仍10。

## 07:19Z O1拒绝/ready时点候选（d540b9166）

仅核对相对dbbfd4c2c新增的 `d1b03b409` 实现及d540b9166快照测试，不重做旧通知/取消审读。运行HEAD=`4c0057f7c`，固定main=`679fd3e4d3bdaff9d38188aab851704e952b9ac0`；d540b9166/d1b03b409祖先检查均退出1。当前main对应storage API/service及组合根检索未见registerFinalizer/runStartupFinalizers，不能宣称正式F3运行集成完成。

| O1新增子项 | 实际入口/行号（属d540b9166） | 静态判断 |
|---|---|---|
| 拒绝注册不自启 | `index.ts:451-456` registerFinalizer catch只调用logger.error，没有initializeScheduler/startTicking/startScheduler | **旧catch启动问题已静态修复**。重复/晚注册抛错后局部调度器没有启动回退；不重复派旧实现问题 |
| 正常finalizer/ready顺序 | `index.ts:438-440`先初始化再调用startAfterStartupReady；`:419-435`异步等待120000ms，ready=false/缺gate/Promise失败均只error，ready=true且未disposed才进入startTicking | **局部门控静态符合**。等待没有被await进finalizer，因此不会阻塞F3执行后续钩子；timer建立在`:385-403`，仅在ready回调后发生。其保证依赖组合根只在整体成功后markReady |
| 平台无finalizer接口 | `index.ts:457-459`仍立即初始化/启动 | 与“平台拒绝注册”明确分开；这是兼容分支，不是正式F3 registry+gate验证证据 |
| O7 legacy子项 | `repository/automation-legacy.ts:137-151`仍先读/解析、插入事务返回后owner.save marker | 沿用db42e4ea4静态结论，无回退到同事务marker；真实L04导入接线仍待，O7不关闭 |

**测试边界如实标注**：`tests/automation-commands.test.ts:24-105` 中createStartupGateFixture与createFinalizerRegistry均是本测试自行实现的ready等待和open/running/done/failed状态机，registry经Proxy替换storage注册方法，并未导入正式F3 StartupFinalizerRegistry或F2 createStartupGate。后续测试（`:271-466`）验证hook前无tick、初始化后但ready前无tick、ready后spawn一次、重复/晚注册拒绝及前序失败不启动；对L06局部控制流有价值，**不能称“真实F3拒绝点/真实装配已验”**。

**尚未完成的整体规则**：F2实际 `electron/startup-gate.ts:8-22` 是单调ready布尔值，guard.dispose也能markReady，本身没有“启动已失败”状态。正式F3 registry何时失败、组合根失败后是否禁止markReady、重试如何恢复、晚注册是否中止整体启动，仍需F3/F2/组合根共同确定并用真实实现验证。d540b9166的BLOCKERS:97-100已明确请求该规则，不能以本地模拟registry的成功/失败用例关闭整个O1。完整L03/L04 runner也仍未闭合。

协调者亲取的提供方作业20261104071623-a25bc5（13pass/exit0）仅记录为来源；本轮**没有独立runner/job**，无可引用的自身退出码/Errors，不复跑旧L03或全lane。候选进入main后最多先用队列筛选automation-commands中的startup/finalizer拒绝相关用例；正式F3 registry+gate整体验证须待实际装配就绪，不能用模拟夹具替代。所有编号勾选保持不变。

## 08:21Z 最新去向：候选修复与正式启动规则分开

最新L06仍为d540b9166，本轮不重读旧用例或复跑已关项。固定main 3b2758d7a未含d540b9166/dbbfd4c2c；以下仅更新证据/owner，未新增测试job。

| 项目 | 已核关键候选证据 | 当前剩余owner与精确验证 |
|---|---|---|
| O1通知顺序/retry | dbbfd4c2c的automation-notifications.ts:254-287先policy→窗口→预约→notify(false)，:222-229平台时间；d540b9166保留 | L06/F2集成后仅验证窗口活跃不预约、查询失败按不活跃、投递失败释放/5分钟补投。原Rust `src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:3039-3047,3086-3209`。候选已修，不重复派“toISOString/先预约” |
| O6取消事件 | automation-runs.ts:225-260内部剥离emitChanged，index两入口日志-only；候选新测试精确只见cancel_run | L06候选合入后仅复跑cancel endpoints用例。原Rust `automations.rs:4596-4638,4666-4667`；静态修复待本审读者运行，不是继续要求写代码 |
| O7 legacy | d540b9166 automation-legacy.ts:137-151先读解析→插入事务commit→owner.save marker | 候选已恢复，验证marker保存失败时插入仍留存；原Rust `automations.rs:1223-1266`。不要再次要求把marker塞进D1事务 |
| O7真实导入 | SessionImportRepository三*WithConn，调用方同tx；L04 b0ed6a135继承公开仓储候选，L06仍未提供生产装配证据 | L06/L04：用真实所有者方法导入后读取chat表；在块写入失败时会话/消息/块全部回滚。原Rust `tools/session_executor.rs:551-574`。测试自写SQL仓储不能替代该链 |

**run失败规则已明确，不再列为待裁定**：独立阅读F1候选 `fa4e03485:host/kernel/connection.ts:67-79,111-127`：正常启动await runStartupFinalizers后才markReady；任一run异常向上抛、HostFatal退出1，不发HostReady、不mark gate，组合根不自动重试；恢复模式跳过业务finalizer但mark gate。F3候选 `39d81465b:host/platform/storage/startup-finalizers.ts:53-83`：拓扑/钩子失败置failed，显式重run跳过已完成项。两候选未入固定main（祖先检查1），**规则明确与当前集成可运行是两件事**。

**仅register政策仍待裁定**：F1同文件:77-79区分插件apply/注册失败隔离与必需启动钩子完整性，不能把所有register失败自定为全局fatal。L06 d540b9166已局部fail-closed，模拟registry不证明正式F3拒绝/HostFatal/gate整链。责任F1/F3组合根、F2 gate及L06消费：真实registry注册L06钩子与后续失败钩子，验证失败不markReady/不tick/不发HostReady；成功才ready。未取得这项独立证据前O1不关，不重提“所有run失败规则未定”。

## v2集成最小复验及X6分类（基线eeaf5bdc7）

```text
job 20261104110200-99af33
command: npx vitest run -c vitest.host.config.ts host/plugins/agent-orchestration/tests/automation-commands.test.ts host/plugins/agent-orchestration/tests/automation-repository.test.ts host/plugins/agent-orchestration/tests/automation-notifications.test.ts -t 'cancel endpoints finalize once|legacy_json_migration_commits_definitions|legacy_json_migration_reads_the_marker|prechecks window activity|a failed OS delivery|releases the F2 reservation'
Test Files 3 passed (3)
Tests 6 passed | 67 skipped (73)
Duration 7.65s
[作业 20261104110200-99af33] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104110200-99af33.log
```

完整result无Errors；67 skipped是-t筛选。O6关闭；O1预约前抑制/失败补投平台时间、O7 legacy marker提交后保存子项亲跑通过，不继承提供方结果。O1完整runner/正式启动组合、O7真实L04仓储消费仍不关。已关闭O2–O5/O8及P2/P3/P6不重复运行。

**X6-UD-L06-01独立确认**：当前 `repository/automation-definitions.ts:89-93` 将数据库trusted_profile_json直接JSON.parse as TrustedAutomationProfile；没有字段/枚举/整数解码，是真实入站持久化边界，经 `loadAutomations→rowToAutomation` 到列表/调度。沿用X6编号派L06，不另造同义finding，不以已有O4输出字段通过覆盖此问题。

**`:150` 与`:92`分类不同**：`:143-151` 构造版本冲突AppError时，将生产automationToListObject输出断言为JsonValue，是出站类型收窄，不是此处在读取外部JSON。可从“入站JSON无解码”规则中窄排该表达式，但它仍依赖rowToAutomation先保证current有效；不能据这个出站cast豁免`:92`的入站缺陷、D3或输出校验。没有建议删cast/换语法躲门禁，也没有批准文件级skip。

## 95432befd 返工独立复核：X6-UD-L06-01保持开放

固定候选 **95432befd43e60cc141b5f4043a52dba20d1c7b4**（命名提交本身为空，实际代码/测试由先前协调检查点保存）；审读HEAD=f64e1fc47，main核对点=4c6cd1ba8f377e7200310ae1930fe7def9c61ee3，候选祖先检查退出1。没有在旧源码上重跑用例，也没有取候选实现到本树。以下TS行号均属此候选。

### 已核实的改进（不重复派修）

- `repository/automation-definitions.ts:91-95` 已改为decodePersistedTrustedProfile，生产list/update仓储路径实际调用；`src/trusted-profile.ts:279-318` 对camelCase必填字段、deny_unknown_fields、根access枚举、string/bool/Vec元素做检查，返回按声明顺序构造的对象。
- 读取只解码，不seal/validate/hash重算，符合Rust `src-tauri/crates/dstu-agent/src/chat_v2/automations.rs:989-1003`；业务验证/上限不应被拿来掩盖合法u64解码问题。blank列在rowToAutomation外层保持None。
- 外层 `Conversion error from type Text at index: <UTF-8字节数>` 与调用点Failed to load automations/automation有真实链路；新增 `tests/automation-crud-commands.test.ts` 的X6组通过真实库保存原字符串、再调用list/update IPC，未stub decoder；更新路径检查decode错误早于version conflict，方向正确。

### 必须继续修复的精确边界

以下均以测试中完整fullProfile为基底，只改注明的**原始JSON token**，不是用JSON.stringify提前归一化输入：

| 输入/场景 | 候选行为的静态依据 | Rust要求与影响 |
|---|---|---|
| `timeoutSeconds:9007199254740993` 或 `maxOutputBytes:9007199254740993` | `trusted-profile.ts:294` 先JSON.parse，`:210-214`返回number，原值会变9007199254740992 | Rust struct字段为u64（automations.rs:315-316），应精确保留到内部比较/写回；D3不能经过Number丢高位。读取时不validate本就是Rust行为，不能因该值超业务预算而忽略此解码边界 |
| `maxOutputBytes:18446744073709551616`（u64::MAX+1） | `:212` 的u64 max常量本身也是JS Number，舍入成同一个2^64；`:213` 的 `value > max`不成立，候选接受越界 | serde u64拒绝该JSON数值；必须在浮点舍入前区分上界，不能只补Number.isSafeInteger后拒绝全部大整数 |
| `schemaVersion:1.0` / `maxToolRounds:1e0` | JSON.parse归一成1，Number.isInteger为true | serde整数类型拒绝浮点JSON token，即使数学值为整数；现有1.5用例未覆盖这一分支 |
| 原字符串含重复 `schemaVersion`（例如先1后2） | JSON.parse只留末值，decodeStruct Object.entries没有重复信息（`:268-275`） | serde派生结构反序列化返回duplicate field，不采用末值；必须保留/检测重复字段，不能通过出站对象构造测试证明 |
| 正常缺字段/类型错误 | `:290`明确不保留 `at line L column C`；`:318`只拼无位置detail。新增tests中的dbErr精确期望也无位置后缀 | Rust `serde_json::from_str` 错误原样嵌入rusqlite FromSqlConversionFailure（automations.rs:995-1000），包含行列。v2 §1.4未批准删掉该上下文；当前测试固定了弱化文案 |

这些是原X6字段解码返工的剩余问题，不另加同义编号，也不由审读者改实现或测试。`:150` automationToListObject出站断言未改，继续按出站收窄分类；它不证明读取trusted profile已经正确。

### V2-01 / V2-02关联增量

- **V2-01静态符合**：`index.ts:515-522` settings读取失败按true，明确false先短路，load/open失败按false，对照Rust automations.rs:4779-4792；新增用例通过真实settings表DROP/损坏schedule触发服务路径，未用自身if表达式代替业务主体。
- **V2-02静态符合本次rollback修复点**：`repository/automation-todo.ts:77-127` 收据读取/创建todo/收据INSERT失败记录原步骤warn后抛内部sentinel，使平台IMMEDIATE事务回滚；外层仅识别该sentinel返回false，不重复日志；begin/commit失败分开映射。`:129-133` 只有事务成功且新建后发事件。Rust automations.rs:2559-2609在失败return前未commit，Drop回滚，成功才emit；方向一致。
- `tests/real-plugin-composition.test.ts:30-39,79-122` 安装真实L04/L05/L11/L13与F3，只有OS传输替身；独立观察连接在event离开时查询已提交todo/receipt；触发器拒receipt后验证todo/receipt均不增加且不发事件。比旧自写todos更强，但仍是**提供方代码审读**，不是本审读者运行。

提供方jobs（包括20261104113053-b17b43所报40/40）只记录来源；本轮独立runner **NOT RUN**，无新job/result退出码或Errors，不继承其结果。候选未入main，X6-UD-L06-01不勾；V2-01/02为静态候选结论，未改既有O2/O3/O8签收范围。正常main集成并补齐以上raw-token/u64/错误文案后，才经队列筛选X6组与V2-01/02最小用例。

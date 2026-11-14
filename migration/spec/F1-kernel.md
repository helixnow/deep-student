# F1-kernel 行为规格（`migration/spec/F1-kernel.md`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 11 个 · 发出事件 3 种 · 契约：`contracts/ipc/F1-kernel.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

### WP-287：cloud SSOT 入站内部标签枚举首错

- 生产链：`commands.ts::_dispatch` → `ContractSet.checkArgs` → `serdeCheck`；失败发生在
  F4 `errors/cloud-config-commands.ts:11` → L21 `backup/index.ts:171` 的业务调用之前。
  不改变 F4 转发、L21 配置规范化/存储或 F5 的字段契约。
- Rust：`dstu-sync/src/cloud_config_commands.rs:48-113`，provider 标签为 lowercase，变体字段
  `webdav/root/allow_insecure` 按声明顺序；SafeWebDavConfig 为 camelCase 且拒绝未知字段。
  `src/cloud_config_commands.rs:10-16` 的参数先由 Tauri 2.11.5 `ipc/command.rs:62-68,84-104`
  从 `&Value` 解码，错误按既有 `invalid args` 包装，不进入保存函数。
- 首错依据（Cargo.lock 锁定 serde/serde_derive 1.0.228、serde_json 1.0.149）：
  `serde/src/private/de.rs:859-884` TaggedContentVisitor 先验证标签、缓冲非标签内容；
  `serde_derive/src/de/enum_internally.rs:54-61` 再解所选变体；`struct_.rs:55-65,122-130`
  FIELDS 不包含标签，`:236-274,303-318` 按输入键顺序解码已有值，之后按声明顺序检查缺字段。
  因此非法 provider 优先于业务字段；`webdav:{}` 与 `allowInsecure` 的输入先后会改变首错。
- 可判定形状限定：有 x-rust 的 oneOf、各分支均严格 object 且超过两个属性、首属性为同名
  required 字符串 const、标签值互异。已核生成器 `schema.ts:837-877`：external 对象一键，
  adjacent 最多两键，untagged 为 anyOf；不以通用 oneOf 猜测 tagged enum，不硬编码命令/类型。
  剥离标签后复用既有 struct/$ref/Option 校验，保留字段声明顺序和完整错误原文。
- 未确定路径仍 UNKNOWN：两字段等歧义形状、序列、数字缓冲内容。数字不能直接复用 &Value 的
  错误：`serde_json/number.rs:549-569` 的 deserialize_any 会选择 u64/i64/u128/i128/f64/map，
  ContentVisitor 与直接 typed &Value 有不同错误和首错；本包不扩展该数值模拟。
- 新测试经真实 Host、实际 F4 契约及 F4/L21 生产插件；外部 settings 记录写调用，storage/secrets
  仅提供外部依赖。G3 原两条 camel 输入均应拒绝；成功 snake_case false/true 真的进入保存服务，
  对象入口和 argsJson 原文入口均覆盖。失败时保存调用为零、已有设置不变、无事件。
  不声明真实 SQLite/网络端点或新 A/B 差分录制已验证；TESTMAP 原映射不变。

### WP-128：官方 profile 装配备份配置命令

- Rust 入口：`src-tauri/src/lib.rs:2219-2223` 只注册 get/set/pick/clear/default 五条；
  `backup_config.rs:231-234` 的状态命令仅有定义，正式 Host 仍须返回 not-found。
- F4 的真实 `host/platform/settings/backup-commands.ts` 已随 main `6e2936bac` 发布；
  F1 只把该路径纳入生成器的明确独立入口列表，与既有 `plugins/sync/startup.ts` 一起精确发现，
  不扫描任意 TS 模块。desktop.json 由生成器产生，原38项相对顺序、W13位置及稳定依赖排序保持。
- `BackupConfig::load/save`（:74-90）、get/set（:116-132）经原 F4 settings 服务持久化到真实
  mistakes.db；camelCase、默认值、可选字段、错误与写后日志仍由 F4 实现。本包不增加业务解码或表写入。
- pick（:137-170）通过现有 ShellService `dialog.open` 携带目录选项和调用窗口；选中保存，取消不写。
  clear（:174-179）只清目录；default（:184-187）使用真实 paths 的默认 recovery/backups 路径。
  Electron `shell/plugins/dialog.ts:123-140` 已提供对应目录选择/取消返回；真实窗口由 C2/X1 后继抽验。
- 生产回归 `host/kernel/tests/profile-backup-config.test.ts`：正式全 profile、真实 capabilities、真实
  storage/settings/paths，无业务服务替身；独立 SQLite 连接经 F4 `getWithConn` 核实提交可见性，
  shell 测试边界只返回选择结果；核五条注册、状态 not-found、依赖先后与卸载撤销。所有资源 finally 释放。
- 证据等级为生产 Host 装配测试及源码审读，不增加 Rust TESTMAP 映射，不代表真实窗口或 C 录制签收。

### WP-193：Shell typed 错误传输公共面

- 依据 `dstu-browser/src/browser/bridge.rs:77-105,114-148`：Bridge 错误保留 code/message/details，
  Display 为 `bridge error {code}: {message}`；其余 Eval/Timeout/ChannelClosed 是独立错误。
- 仅增补协议失败支 `errorData?: ShellErrorData`，类型为 `{ code: string; message: string; details?: unknown }`。
  原 `error: string` 仍为显示文本；ShellService 按 id 接收失败后构造 ShellError，op/message 不改，
  `readonly data?: ShellErrorData` 原样承接 errorData。api.ts 公开同一 ShellError 类和数据类型。
- 无数据就保留 undefined，不从显示文本反解析，不生成 Bridge kind 或业务 takeover 策略。
  details 缺省/null/嵌套值按发送内容保留，kernel 不解码 browser 信封、不改写其业务字段。
- 成功仍 resolve(value)；正常回复先删除 pending/清 timer，超时删除 pending 后拒绝；断连走现有
  shutdown→dispose→rejectAll 并清理全部 timer；迟到/未知 id 仍返回 false，由 connection 原 warn。
- 测试 `tests/shell-error-wire.test.ts` 使用真实 MessageChannel→messagePortTransport→serveHost→
  ShellService；验证结构数据、普通字符串、成功配对、超时、断连、重复/迟到回复和 timer 清理。
  此传输增补没有业务表/文件写入或新增时限；Rust call 层的 warn 与业务恢复由后继消费者保持。

### WP-182：工具结果预算保留原生 raw 数字原子

- Rust 依据：`dstu-agent-api/src/budget.rs:23-117`，`truncate_string_leaves` 只收缩 `Value::String`，
  `Value::Number` 走 `_ => false`；三个分支（未超预算原样、收缩后达标附 metadata、仍超预算 preview）
  均对原 Number 序列化原 token。注册表出口 `executor_registry.rs:404-412`。
- 缺陷：`agent-api.ts::applyToolResultBudget` 的遍历对原生 `JSON.rawJSON` 原子走 `Object.entries`，
  得到普通 `{rawJSON:"…"}` 对象；超预算后结果与 preview 文本把数字写成对象，超长原子还会被当字符串截断。
- 修复：遍历先用 kernel 既有 `serde.ts::isJsonNumberAtom` 判定原生数字原子并原样返回；预算、
  叶子上限、码点计数、metadata 文案与 preview 截取不变。普通同形 `{rawJSON}` 对象仍按对象处理。
- 测试：`tests/tool-result-budget-raw.test.ts` 直接调用生产函数，并经 chat 公共
  `createExecutorRegistry().execute` 默认 30000 预算；嵌套对象/数组中 9007199254740993 与 u64::MAX 原文不变。

### WP-143：bigint-only 出站原始 JSON

- Rust 依据：serde_json 1.0.149 `ser.rs:108-151,1600-1661` 的整数经 itoa 写十进制 token，
  不经过 f64；Tauri 2.11.5 `ipc/mod.rs:181-186,240-246` 的成功/错误及 `event/mod.rs:125-131`
  的事件均经 serde_json 输出。前端解析为 JS number，允许自然舍入。
- 行为：原值根部或 JSON 容器内只有 bigint 时，也选择既有 `wireJsonOutput` 原文分支；
  `json` / `payloadJson` 保精确整数 token，value/error/payload 从同一文本 JSON.parse 得到。
  原生 raw atom 分支、普通无 bigint/raw 的对象与 binary 成功出口保持既有语义。
- 生产落点：`commands.ts` 成功/CommandError、`events.ts::_emit` 共用 `json.ts::hasRawJson` 判定；
  connection 原样透传可选原文。内部对象与 Host 监听保持 bigint；没有新增业务字符串字段。
- 测试先行：`tests/bigint-json-wire.test.ts` 使用真实 MessageChannel→serveHost→注册命令/事件，
  覆盖根整数、数组、嵌套容器、相邻 9007199254740992/3、i64 两端、0；成功/失败与广播/定向事件
  均断言原文和投影，debug/release 两种模式；普通对象与 Uint8Array/ArrayBuffer 无原文字段。
- 本段无数据库/文件业务写入、时钟、重试或取消变更；原有错误/日志/清理顺序保留。证据等级为生产
  内核传输测试及 Rust 审读，X1/X7 消费录制与 C 级签收由后继验证承担。

### F1-RAWJSON-01：arbitrary_precision Value 的原生原子出口

**F1-RAWJSON-02 后继（C1/C2批准）**：冻结协议可选增补 `BackendEvent.payloadJson?: string` 与
`InvokeResponse` 成功/失败两支 `json?: string`。只有原Host值含原生raw品牌时生成：对原值执行
一次JSON.stringify（BigInt replacer返回原生raw十进制数字），随后JSON.parse同一文本得到投影值；
文本与payload/value/error同源，不按已投影Infinity猜原始类型。该分支typed Infinity/NaN序列化null，
raw1e400仍是原数字token；内部原对象/监听保持不变。debug在序列化前照旧检查plain结构，该raw文本
分支允许非有限number交给标准JSON序列化，普通无raw路径仍保既有检查。binary结果、框架错误、普通
消息无可选字段。F2仅有原文时直接转发既有JSON body/事件，无原文保持旧stringify。
生产connection.ts透传可选字段；新增真实fork advanced进程测试覆盖success/error/event及ordinary/binary
字段缺省，原二进制/ACL断言不变。F2最终renderer消费仍待双方同树测试，Host进程结果不替代该签收。

L18 StructuredQuestion.json→L14 question-import-progress→backendEvents.emit 的实际输入使用F4
jsonNumberToRawJSON生成原生JSON.rawJSON数字。Rust serde_json arbitrary_precision写出原数字token，
前端JSON.parse后为IEEE-754数字；kernel先以JSON.isRawJSON品牌判定合法原子，出口才JSON.parse(rawJSON)，
保大数舍入、超f64 Infinity、下溢和负零。内部监听者、服务值和持久化原token不改写，不把普通
{rawJSON:string}或null-prototype同形对象当原子。命令debug先检查内部值再投影/契约校验，事件同序。
F2后继main事件JSON.stringify及shell encodeBody会再次把Infinity/负零改为null/0；已交F2/C1处理，
本修复不将Host边界用例当成这些极值的最终renderer闭环。

### main-red：CommandError 构造与 ACL 原文入口（2026-11-05）

- Rust `tauri::ipc::InvokeError` 将 `Err(E)` 的序列化值送入 reject（`ipc/mod.rs:240-253`）；Host 的
  `CommandError.value` 必须保持该值，构造诊断 message 不得调用非法类值的 `toJSON` 而变成 panic。
  先用既有 plain-JSON 检查决定诊断；合法对象保持 JSON 诊断，BigInt 只在诊断文本中用精确十进制字符串，
  原 value 不转换。线上校验、D3 number 投影仍在 CommandService，失败仍先记录 error 再返回契约诊断。
- `CapabilityAcl.fromDirectory` 用已公开的 `parseCapabilityFile` 读取 UTF-8 原文，保留 typed list 的
  字段错误优先级；不先 JSON.parse。权限求值、来源过滤、重复 capability id 检查保持原顺序。

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：`PluginInfo.error`、`PluginStatusSnapshot` 的全部 Option 字段在 serde 中都没有 `skip_serializing_if`（`src/plugins/types.rs:72-100`），因此缺省值一律是 JSON `null`；契约把这些键列为 required，`host/kernel/plugin-types.ts:emptyStatusSnapshot` 与 `PluginManager.list` 也显式填 `null`。
- [x] u64/i64 超过 2^53 的表示：只有事件 `ts` 是 i64（`Utc::now().timestamp_millis()`，`events.rs:44/56/68`），当前毫秒值远小于 2^53，安全映射为 JS number；`seq/message_id` 等 iLink 字段按 JSON 原值读取，不做位运算。
- [x] D3 IPC 大整数边界：`findNonJson` 不再拒绝 BigInt；`toWireJson` 只在命令结果/错误、事件载荷、`plugin:host|call` 参数与返回值的线上边界把 BigInt 复制为 JSON number（超过 2^53 与 Rust serde_json→前端 `JSON.parse` 同样舍入）。内部游标/比较/写库值保持 BigInt，不提前 Number 化；测试断言插件返回的原对象未被改写。
- [x] F4 `app_version_is_injected_from_app_manifest` 的同义测试：走生产 `serveHost` 握手 → `ctx.app.version`，握手值读取真实 `src-tauri/Cargo.toml` 的 `[package] version`（`crates/dstu-core/build.rs` 用它注入 `DSTU_APP_VERSION`；根 `build.rs::verify_application_versions` 已校验 `package.json`/`tauri.conf.json` 一致）。测试 `host/kernel/connection.test.ts::app_version_is_injected_from_app_manifest` 断言非空、非 `0.0.0` 且运行时版本与 manifest 完全一致；不新增孤立 `APP_VERSION` 常量，也不重复实现版本一致性框架。
- [x] 字段顺序（serde_json preserve_order）：workspace `src-tauri/Cargo.toml:101` 启用 preserve_order；iLink sendmessage 业务错误中的 JSON 按输入对象顺序输出，不排序。事件载荷按结构体字段顺序构造（`pluginId,state,error,ts`；`pluginId,pngBase64,status,ts`；`pluginId,kind,summary,ts`），测试不序列化比较 HashMap。
- [x] f32 精度：本 lane 没有 f32；`rateLimitPerMin` 从 u64 读取（`ilink_bot/mod.rs:793`），整数以 BigInt 检查 0..u64::MAX，保留设置中的十进制精度；get_config 内部大值保持 BigInt，只在 IPC 转 number。非法 patch 值忽略；非法/溢出 usize 设置回退 10。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：命令返回 `AppError { error_type, message, details }`（`dstu-core/src/models.rs:928`），`host/kernel/plugins.ts` 用 `CommandError(asAppError(...))` 原样 reject；未知插件为 `Validation` + `未知插件: {id}`（`manager.rs:63`），非 ilinkbot 的 `set_enabled` 为 `Validation` + `unsupported plugin`（`manager.rs:275`）。命令处理函数中的非 AppError 异常按 `Unknown` 包装；CommandService 的 panic 语义（无响应）保持不变。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：`start`/`begin_login` 各建一个 `AbortController` 并存入 RunningHandle（对应 `manager.rs:175-186,314-333`）；`stop`/`cancel_login`/`logout`/`shutdown_all` 调 `stop_internal` 先移除 handle 再 abort（`manager.rs:240-249`），与 Rust 先移除再 cancel 的顺序一致；iLink 登录 loop 同时响应外层 signal 与登录专用 signal（`ilink-bot.ts:runLoginFlow`）。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：`lifecycle: Mutex<()>`（`manager.rs:33`）对应 `PluginManager.serialized` 的 promise 尾链，start/stop/begin_login/cancel_login/logout/shutdown 全部串行；states/errors/handles 是单事件循环内的 Map，等价于 Rust 的 RwLock；`next_generation` 用单调整数，run 完成时只有 generation 匹配才落状态（`manager.rs:202-235`）。
- [x] 时间与 ID：生成方式、格式、时区：事件 `ts = Date.now()`（毫秒 epoch，与 `chrono::Utc::now().timestamp_millis()` 相同）；iLink `client_id = dstu-{毫秒}-{uuid 前 8 位}`（`client.rs:282-285`）；二维码内容由服务端给出，PNG 为纯 base64（无 data-url 前缀，`dstu-util/src/qr.rs:10-21`）。
- [x] 不对含 HashMap 的结构做序列化后比对：`PluginManager.list` 按 id 排序后返回（`manager.rs:143`），测试按数组与字段断言；iLink `contextTokens` 是对象映射，只按 key 读取，不比较序列化字符串。

## 日志位置（quality.md §七）

以下是已有日志映射；远程任务未接线的日志仍列在下方，不宣称全链完成。生产代码没有 `console.*`，也没有只含 `void` 的 catch。

| Rust 位置 | 级别 | TS 位置 |
|---|---|---|
| `src/plugins/events.rs:47,59,71` emit 失败 | warn | `plugin-events.ts::createPluginEventSink` 的 `warn` 回调（由 `PluginManager`/`IlinkBotPlugin` 注入 `ctx.logger`） |
| `src/plugins/manager.rs:71` unusual transition | debug | `plugin-manager.ts::setState`（`debug` 回调，Cordis 入口注入 `logger.debug`） |
| `src/plugins/manager.rs:470` bootstrap list 失败 | warn | `plugin-manager.ts::bootstrapEnabled` |
| `src/plugins/manager.rs:496` auto-start 失败 | warn | `plugin-manager.ts::bootstrapEnabled` |
| `src/plugins/ilink_bot/mod.rs:162` send 失败 | warn | `ilink-bot.ts::sendChunks` |
| `src/plugins/ilink_bot/mod.rs:265` 扫码状态失败 | warn | `ilink-bot.ts::runLoginFlow` |
| `src/plugins/ilink_bot/mod.rs:328` 未知扫码状态 | debug | `ilink-bot.ts::runLoginFlow`（`debug` 回调） |
| `src/plugins/ilink_bot/mod.rs:376` getupdates 业务错误 | warn | `ilink-bot.ts::pollLoop`（`ret`/`errcode` 原样） |
| `src/plugins/ilink_bot/mod.rs:438` 缺 context_token | warn | `ilink-bot.ts::pollLoop` |
| `src/plugins/ilink_bot/mod.rs:568` getupdates 失败 | warn | `ilink-bot.ts::pollLoop` |
| `src/extensions.rs:309` 插件 apply 失败 | error | `extensions.ts::ExtensionRegistry.register`（`logger.error`） |
| `src/agent_wiring/roster.rs:170` descriptor 工具无执行器 | error | `agent-wiring.ts::verifyRosterCoverage`（`logger.error`，Rust `{:?}` 的 `["a", "b"]` 形状） |
| 用户 profile 文件无效（`docs/plugins/SDK.md` §6，非 Rust） | error | `profile.ts::loadStartupProfile`（`ctx.logger('host').error`，随后 emit `host://plugin-profile-failed`） |
| profile 中未安装的插件（隔离装载语义，非 Rust） | warn | `profile.ts::installProfile` → `runtime.ts::recordDegraded`（逐条 `ctx.logger('host').warn`，随后 emit `host://plugins-degraded`） |

以下 Rust 日志属于尚未发布的其他 lane，本 lane 不复制其实现，等对方 api.ts 发布后接入：

- `src/plugins/ilink_bot/mod.rs:489`（Stop 取消会话）、`617`（创建远程任务会话失败）、`637`（Stop 先于 attach）、`691`（任务结果发送失败）需要 L06 的 `task_command`/headless；TS 目前只在 `RemoteTaskBridge` 缺失或 dispatch 抛错时记录 `[ilinkbot] ...`。
- `src/agent_wiring/plugins.rs:82`（Insight 被动提示失败）需要 L10/L17 的 `InsightHintProvider` 槽位。

Rust 以 `let _ =` / `.ok()` 静默忽略的位置（如删除旧凭证、读取 enabled 设置、`start` 失败）TS 同样继续执行；其中少数位置额外记录了诊断日志，不改变控制流与返回值。

## 命令 `plugin_begin_login`

<!-- BEGIN GENERATED:cmd:plugin_begin_login -->
- Rust：`src-tauri/src/plugins/commands.rs:66` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:65`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：id: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_begin_login -->

- [x] 输入：`id` 为插件 id；未知 id 在加锁后由 `plugin()` 拒绝（`manager.rs:59-64,306`）。
- [ ] 输出：立即返回 `null` 与后台登录已实现（`manager.rs:343-418`）；绑定后自动 start 的真实远程任务链尚缺 L04 task_command/L06 headless API，F1-V2-04，不能计整链完成。
- [x] 错误：桌面端检查 `插件仅支持桌面端`（`manager.rs:303-305`，Host 恒为桌面）；已处于 starting/waiting_login/running 或已有 handle 时直接返回成功（`manager.rs:307-321`）；后台登录失败写入 `Error` 状态并携带错误文案；未拿到凭证则回到 `Stopped`（`manager.rs:371-379`）；保存 enabled 失败为 `Error` + `保存启用状态失败: ...`（`manager.rs:381-393`）。
- [x] 事件：`plugin-state-changed`（waiting_login、成功后的 stopped/starting/error 等）与 iLink 的 `plugin-qrcode`/`plugin-activity`（`ilink_bot/mod.rs:236-324`）。
- [x] DB 读写：读取 `plugin.ilinkbot.*` 配置与安全存储凭证；确认扫码后写 `plugin.ilinkbot.credentials` 与 `plugin.ilinkbot.enabled=true`（`ilink_bot/mod.rs:304-314`，`manager.rs:381-394`）。
- [x] 取消/并发：`lifecycle` 串行化；登录任务持有独立 generation，取消/重复请求不会共享 token（`manager.rs:314-333`）。
- [x] 时间/ID：事件 ts 毫秒；二维码刷新最多 3 次，总超时 480 秒（`ilink_bot/mod.rs:220-229,282-287`）。

## 命令 `plugin_cancel_login`

<!-- BEGIN GENERATED:cmd:plugin_cancel_login -->
- Rust：`src-tauri/src/plugins/commands.rs:74` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:66`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：id: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_cancel_login -->

- [x] 输入：`id`；未知 id 为 `未知插件: {id}`（`manager.rs:421-424`）。
- [x] 输出：`null`，状态强制为 `stopped`（`manager.rs:425-427`）。
- [x] 错误：插件 `cancel_login` 返回的 AppError 原样上抛；未知 id 为 Validation。
- [x] 事件：插件取消前的状态事件 + 最终的 `plugin-state-changed`(stopped)。
- [x] DB 读写：不写设置；iLink 只发送登录取消信号（`ilink_bot/mod.rs:816-823`）。
- [x] 取消/并发：`lifecycle` 串行；先 `stop_internal`（移除 handle 并 abort）再置 stopped，避免旧任务复活（`manager.rs:421-427`）。
- [x] 时间/ID：无生成。

## 命令 `plugin_get_config`

<!-- BEGIN GENERATED:cmd:plugin_get_config -->
- Rust：`src-tauri/src/plugins/commands.rs:40` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:60`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：id: string
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_get_config -->

- [x] 输入：`id`；未知 id 为 Validation（`manager.rs:289-293`）。
- [x] 输出：插件 `get_public_config` 的 JSON；iLink 固定返回 `enabled,rateLimitPerMin,modelConfigId,systemPrompt,bound,hasToken,accountId,userId,baseUrl`（`ilink_bot/mod.rs:763-785`）。
- [x] 错误：读取凭证失败时 iLink 记录日志并按未绑定返回；未知 id 为 Validation（`manager.rs:289-293`）。
- [x] 事件：无。
- [x] DB 读写：只读 settings 与安全存储（`plugin.ilinkbot.rate_limit_per_min/model_config_id/system_prompt/enabled/credentials`）。
- [x] 取消/并发：无锁；只读快照。
- [x] 时间/ID：无生成。

## 命令 `plugin_get_status`

<!-- BEGIN GENERATED:cmd:plugin_get_status -->
- Rust：`src-tauri/src/plugins/commands.rs:32` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:59`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：id: string
  - 结果：PluginStatusSnapshot · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_get_status -->

- [x] 输入：`id`；未知 id 为 Validation（`manager.rs:147-156`）。
- [x] 输出：插件快照 + 管理器当前 `state`；若管理器记录了错误，覆盖 `lastError`（`manager.rs:150-155`）。
- [x] 错误：未知 id；插件 status 自身按 Rust 约定吞掉读取失败（`ilink_bot/mod.rs:742-761`）。
- [x] 事件：无。
- [x] DB 读写：只读 settings/凭证与内存中的二维码/活动状态。
- [x] 取消/并发：无锁；读取内存 Map + settings。
- [x] 时间/ID：事件 ts 不在本命令生成。

## 命令 `plugin_list`

<!-- BEGIN GENERATED:cmd:plugin_list -->
- Rust：`src-tauri/src/plugins/commands.rs:11` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:56`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：（无）
  - 结果：PluginInfo[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_list -->

- [x] 输入：无参数（契约 `Record<string, never>`）。
- [x] 输出：按 id 升序的 `PluginInfo[]`（`manager.rs:119-145`）；`configured = is_configured(public_config)`，`bound = is_bound()`，`enabled` 读 `plugin.{id 去掉 -}.enabled`。
- [x] 错误：配置读取失败按 `Value::Null` 继续（`manager.rs:126`）；enabled 读取失败按 false；未知插件不会出现。命令本身不返回错误。
- [x] 事件：无。
- [x] DB 读写：读 settings 与安全存储凭证，不写。
- [x] 取消/并发：无锁；每个插件独立快照。
- [x] 时间/ID：无生成。

## 命令 `plugin_logout`

<!-- BEGIN GENERATED:cmd:plugin_logout -->
- Rust：`src-tauri/src/plugins/commands.rs:82` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:67`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：id: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_logout -->

- [x] 输入：`id`；未知 id 为 Validation（`manager.rs:430-433`）。
- [x] 输出：`null`；停止轮询、清凭证、状态 stopped（`manager.rs:433-451`）。
- [x] 错误：`plugin.logout` 失败原样上抛；保存 `plugin.ilinkbot.enabled=false` 失败为 `Database` + `重置启用状态失败: ...`（`manager.rs:446-449`）。
- [x] 事件：停止过程中的 `plugin-state-changed`（stopping/stopped）与 iLink `plugin-activity`（已解绑，`ilink_bot/mod.rs:825-834`）。
- [x] DB 读写：删除 `plugin.ilinkbot.credentials`（安全存储 + 遗留明文行），写 `plugin.ilinkbot.enabled=false`（`ilink_bot/mod.rs:110-114`）。
- [x] 取消/并发：`lifecycle` 串行；先 `stop_internal` 再清凭证，避免轮询读到半清状态。
- [x] 时间/ID：无生成。

## 命令 `plugin_set_config`

<!-- BEGIN GENERATED:cmd:plugin_set_config -->
- Rust：`src-tauri/src/plugins/commands.rs:48` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:62`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：id: string, patch: Value
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_set_config -->

- [x] 输入：`id` + 任意 JSON `patch`；iLink 只识别 `enabled`(bool)、`rateLimitPerMin`(u64)、`modelConfigId`(string)、`systemPrompt`(string)，其余忽略（`ilink_bot/mod.rs:787-810`）。
- [x] 输出：`null`。
- [x] 错误：未知 id 为 Validation；数据库写入失败为 `Database`（iLink 使用 `AppError::database(e.to_string())`，`ilink_bot/mod.rs:791`）。
- [x] 事件：无（`enabled` 只写设置，不启动/停止；启动由 `plugin_set_enabled` 负责）。
- [x] DB 读写：写 `plugin.ilinkbot.enabled/rate_limit_per_min/model_config_id/system_prompt`；绝不接受 `token` 字段（`ilink_bot/mod.rs:808`）。
- [x] 取消/并发：无锁；单条 UPSERT 由 settings 服务串行化。
- [x] 时间/ID：settings 服务写 `updated_at`（RFC3339），本命令不生成 ID。

## 命令 `plugin_set_enabled`

<!-- BEGIN GENERATED:cmd:plugin_set_enabled -->
- Rust：`src-tauri/src/plugins/commands.rs:57` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:64`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：id: string, enabled: boolean
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_set_enabled -->

- [x] 输入：`id` + `enabled`；未知 id 为 Validation（`manager.rs:269-271`）。
- [ ] 输出：`null`；`enabled=true` 调 `start`、false 调 `stop` 已实现（`manager.rs:281-285`）；true 的真实远程任务链受 F1-V2-04 阻塞，不能计整链完成。
- [x] 错误：非 `ilinkbot` 返回 `Validation` + `unsupported plugin`（`manager.rs:272-276`）；写设置失败为 `Database` + `保存 enabled 失败: ...`（`manager.rs:277-280`）。
- [x] 事件：start/stop 产生的 `plugin-state-changed`。
- [x] DB 读写：写 `plugin.ilinkbot.enabled`（`true`/`false`）。
- [x] 取消/并发：先写设置再调用 start/stop；start/stop 各自获取 lifecycle 锁（`manager.rs:269-287`）。
- [x] 时间/ID：无生成。

## 命令 `plugin_start`

<!-- BEGIN GENERATED:cmd:plugin_start -->
- Rust：`src-tauri/src/plugins/commands.rs:16` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:57`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：id: string
  - 结果：PluginState · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_start -->

- [x] 输入：`id`；未知 id 为 Validation（`manager.rs:158-163`）。
- [ ] 输出：状态返回与后台轮询已有实现（`manager.rs:164-170,237`）；轮询收到合法消息后的任务 Launch/ACK/取消/完成链未接入，F1-V2-04（BLOCKERS.md），不能计整链完成。
- [x] 错误：桌面端检查；未配置插件仍可启动（由插件 run 决定）；run 失败异步落到 `Error` 并记录 Display 文案（`manager.rs:222-233`）。
- [x] 事件：`plugin-state-changed`（starting，及后续 stopped/error）。
- [x] DB 读写：读取公开配置（失败按 Null）与凭证；iLink 轮询时写 cursor/context token（`ilink_bot/mod.rs:381-399`）。
- [x] 取消/并发：`lifecycle` 串行；启动前 `stop_internal` 清理残留 handle；generation 防止旧任务完成覆盖新任务（`manager.rs:172-235`）。
- [x] 时间/ID：事件 ts 毫秒；generation 单调递增。

## 命令 `plugin_stop`

<!-- BEGIN GENERATED:cmd:plugin_stop -->
- Rust：`src-tauri/src/plugins/commands.rs:24` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:58`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：id: string
  - 结果：PluginState · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_stop -->

- [x] 输入：`id`；未知 id 为 Validation（`manager.rs:251-254`）。
- [x] 输出：恒为 `stopped`（`manager.rs:255-266`）。
- [x] 错误：未知 id。
- [x] 事件：`plugin-state-changed`（stopping、必要时 stopped）。
- [x] DB 读写：无写；iLink run 退出时可能持久化最后一次 cursor（`ilink_bot/mod.rs:381-385`）。
- [x] 取消/并发：`lifecycle` 串行；移除 handle → 置 stopping → abort（`manager.rs:240-249`）。
- [x] 时间/ID：无生成。

## 命令 `plugin_unbind`

<!-- BEGIN GENERATED:cmd:plugin_unbind -->
- Rust：`src-tauri/src/plugins/commands.rs:87` · async
- 前端：app（1 处，例 `src/features/settings/api/pluginsApi.ts:68`）
- 契约：`contracts/ipc/F1-kernel.json`
  - 参数：id: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:plugin_unbind -->

- [x] 输入：`id`；未知 id 为 Validation。
- [x] 输出：`null`；Rust 直接调用 `manager.logout(&id)`（`commands.rs:87-90`），Host 的 `plugin_unbind` 同样转调 `unbind → logout`。
- [x] 错误：与 `plugin_logout` 完全一致。
- [x] 事件：与 `plugin_logout` 完全一致。
- [x] DB 读写：与 `plugin_logout` 完全一致。
- [x] 取消/并发：与 `plugin_logout` 完全一致。
- [x] 时间/ID：与 `plugin_logout` 完全一致。

## 事件 `plugin-activity`

<!-- BEGIN GENERATED:event:plugin-activity -->
- 事件名 `plugin-activity`，常量 `ACTIVITY`
- 发送点：`src-tauri/src/plugins/events.rs:70`（emit）
<!-- END GENERATED:event:plugin-activity -->

- [x] 载荷：`{ pluginId: string, kind: string, summary: string, ts: i64 }`（`events.rs:31-37`，camelCase）。
- [x] 触发时机与顺序：iLink 收到消息（msg_in）、回复分片（msg_out）、扫码绑定成功（login）、登录失效/忽略非绑定用户/任务发送失败（warn）时立即 emit（`ilink_bot/mod.rs:147-148,313-314,368,406-407,429,683-692`）。
- [x] 节流/合并：无节流；每条活动一条事件。
- [x] 是否在事务提交后：无数据库事务；活动是内存状态更新后立即发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` 广播到全部窗口（`events.rs:70`），Host 用 `ctx.backendEvents.emit`，target 为 Any。

## 事件 `plugin-qrcode`

<!-- BEGIN GENERATED:event:plugin-qrcode -->
- 事件名 `plugin-qrcode`，常量 `QRCODE`
- 发送点：`src-tauri/src/plugins/events.rs:58`（emit）
<!-- END GENERATED:event:plugin-qrcode -->

- [x] 载荷：`{ pluginId: string, pngBase64: string, status: string, ts: i64 }`（`events.rs:23-28`）。
- [x] 触发时机与顺序：拿到二维码时 status=`wait`；轮询状态变化时重复发送（wait/scaned/confirmed/expired），`confirmed` 后清空 png（`ilink_bot/mod.rs:236-243,271-276,315-320`）。
- [x] 节流/合并：每次状态轮询最多一条；同一状态可能重复（Rust 不判重）。
- [x] 是否在事务提交后：无事务；二维码生成后立即发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` 广播（`events.rs:58`）。

## 事件 `plugin-state-changed`

<!-- BEGIN GENERATED:event:plugin-state-changed -->
- 事件名 `plugin-state-changed`，常量 `STATE_CHANGED`
- 发送点：`src-tauri/src/plugins/events.rs:46`（emit）
<!-- END GENERATED:event:plugin-state-changed -->

- [x] 载荷：`{ pluginId: string, state: PluginState, error: string | null, ts: i64 }`（`events.rs:12-19`）。
- [x] 触发时机与顺序：每次 `PluginManager::set_state`（`manager.rs:66-92`）；状态机只记录 unusual transition 日志，不拒绝（`manager.rs:70-77`）。
- [x] 节流/合并：无节流；每次状态写入一条。
- [x] 是否在事务提交后：无事务；states/errors 内存更新后立即发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` 广播（`events.rs:46`）。

## Host 事件能力扩展：窗口定向监听（C2 04:45 接口需求）

依据 Rust `Window::listen`/`unlisten`（`src/window/mod.rs:2353`、`dstu-llm/src/llm_manager/mod.rs:8226-8250`），
在既有 `ctx.backendEvents` 上增加窗口定向、可单次注销的监听；不另建私有总线。

- [x] API：`listenWindow(window: WindowRef, event: string, receive: (payload: unknown) => void): () => void`（`host/kernel/api.ts`）。
  与 L02 `McpFrontendBridge`（`host/plugins/llm/src/mcp_tools_service.ts:12-15`）签名一致，`ctx.backendEvents` 可直接作为 bridge。
- [x] 过滤：按 Tauri `EventTarget` 路由，而不是按发出者 `source`。`listenWindow` 以
  `EventTarget::Window { label }` 订阅；后端 `emit` 广播（target Any）会送达窗口监听者，
  `emitTo(Window{label})` / `emitTo(AnyLabel{label})` 只送达目标窗口，不同窗口的同名事件互相隔离。
  `source` 只表示发出窗口，目标不同的响应不会误唤醒（对照 `src/manager/mod.rs::emit_to`、
  `src/event/listener.rs::match_any_or_filter`、`src/window/mod.rs:2353`）。
- [x] 注销：返回的 disposer 幂等；响应成功、超时、取消都可在 `finally` 中调用。监听同时经 `ctx.effect` 随插件卸载撤销。
- [x] 消费：事件仍走现有 `_emit`/`_deliverFrontend` 路径；L02 请求/响应、L10 Canvas、L19 MCP 桥不需要新的服务名。

## Profile 启动与回退（插件生态接口）

依据 `docs/plugins/SDK.md` §1、§6（F1 负责的 Host 侧行为；Rust 的 Tauri 版本没有用户插件 profile）。

- [x] 选择顺序：显式 profile（`--profile` / `ServeHostOptions.profile`）> 用户 profile `<app.dataDir>/plugins/user.profile.json`（存在时）> 官方 profile `host/profiles/desktop.json`（`profile.ts::loadStartupProfile`）。握手中的 `profile` 是外壳候选：等于默认用户 profile 路径时走用户 profile 分支（可回退），等于官方 profile 时走显式分支并要求核心服务（`connection.ts::serveHost`）。
- [x] `extends` 关键字：值等于 `"official"` 时解析为官方 profile 绝对路径，与普通路径并存于字符串或数组；关键字不按相对路径查找（`profile.ts::resolveProfile`）。
- [x] 用户 profile 覆盖：条目合并仍按 id、后出现者替换且保留位置；`disabled: true` 可关闭官方插件。
- [x] 文件级失败回退：**只有**用户 profile 的读取/解析失败、模块导入失败、`meta.id` 不符才回退；Host 记录 error 日志（`ctx.logger('host')`，含完整错误栈），经 `ctx.backendEvents.emit` 发出 `host://plugin-profile-failed`，再加载官方 profile 继续启动。此时尚未安装任何插件。
- [x] 插件级失败不回退：缺服务 / `apply` 抛错按下面的隔离语义处理，用户 profile 中已成功装好的插件保持装载。
- [x] 事件载荷：`{ profile: string, error: string }`——`profile` 是用户 profile 的绝对路径，`error` 是失败原因（`Error.message` 或字符串化值）；target 为 `Any`（后端广播）。
- [x] 顺序与副作用：日志 → 事件 → 官方 profile 装载；事件在 `HostReady` 之前经同一传输发出，前端可在 `ready` 前收到。
- [x] 显式 profile：文件级失败仍是 `HostFatal`（命令行 / headless 既有语义）；插件级失败同样按隔离语义处理，且不要求平台核心服务。握手 `profile` 指向官方 profile 时按显式分支处理并要求核心服务；指向默认用户 profile 时按用户 profile 分支（可回退）。

### 隔离装载语义（`profile.ts::installProfile`）

- [x] 排序：`inject`/`meta.provides` 稳定拓扑排序；本 profile 内提供服务的条目排在消费者之前，独立条目保持 profile 顺序。重复提供服务与依赖环在安装任何插件前抛 `ProfileError`。
- [x] 缺服务：`inject` 的服务在运行时不存在 → 该插件不安装，记 inactive（`missing service "X"`）；它声明的服务不可用，依赖这些服务的条目同样 inactive（级联，原因 `missing service "X" (provided by inactive plugin "id")`）。
- [x] `apply` 失败：`HostRuntime.installIsolated` 只撤销该插件自身（含 apply 中注册的命令/事件/服务），其他插件继续；依赖它服务的条目级联 inactive。
- [x] 汇总：全部未安装条目逐条 `ctx.logger('host').warn`（`[host] plugin "<id>" is inactive: <reason>`），非空时 `ctx.backendEvents.emit('host://plugins-degraded', DegradedPlugin[])`；`DegradedPlugin = { id, reason }`。
- [x] 命令 `plugin:host|status`：返回同一份 `DegradedPlugin[]`（内核自有命令，本地窗口，不参与覆盖检查）。
- [x] 致命（HostFatal）：内核自身错误、profile 文件无法解析（含导入失败 / id 不符 / 重复提供 / 依赖环）、平台核心服务 `storage`/`paths`/`log` 不可用。官方 profile 与用户 profile 分支启用 `requireCoreServices`，缺失时抛 `ProfileError('platform core services unavailable: …')`。
- [x] 生成器：`host/profiles/generate.ts` 固定首条 `../kernel/plugins.ts`，随后收集默认导出插件的 `host/platform/<name>/index.ts`（跳过 `time`/`util`/`net-policy` 等纯模块），再收集 `electron/index.ts` 的 `dstu.shell`（提供 `startupGate`、注册 23 个 F2 命令；模块顶层不导入 Electron main API，Host 在 utilityProcess 中加载），最后收集 `host/plugins/<name>/index.ts`；`--check` 与磁盘不一致时退出 1。

## D2 启动收尾组合根（C2 2026-11-04 06:38 裁定）

依据 Rust `lib.rs` setup：`StartupReadyGuard::new()` 置于闭包首行（`:838`），恢复模式在 `:953-959` 提前
返回，其余路径在迁移/业务初始化后退出；所有路径都由 guard drop 标记就绪。F3 分支
（`fe46369d8`/`9f8c77387`）的 `StorageService` 发布 `registerFinalizer` / `runStartupFinalizers` /
`finalizerNames`，只负责注册、排序与执行，不自动 run，也不 import 业务插件；该 API 现已合入 main `d84e29565`。
F1 的组合根、启动日志（`5d373dbf2`）与版本测试（`1b3cedeaa`）已随 main 集成（C2 merge `e60e7a771`
已确认二者为祖先）；真实链测试已按批准方案仅 cherry-pick `-x 7fdd36afe` 为 `5d451e443`，F3 API等待已解除。

- [x] 组合根位置：`host/kernel/connection.ts::boot` 在 `loadStartupProfile` 返回后、发送 `HostReady` 前调用
  `finishStartup`。
- [x] 正常启动：从 `ctx.get('storage')` 结构化探测 `runStartupFinalizers`，存在则 `await`；全部成功后
  才从 `ctx.get('startupGate')` 调用 `markStartupReady()`。F2 的 `dstu.shell` apply 只提供 gate，
  不在自身 apply 提前 mark；组合根是唯一标记点。
- [x] 恢复模式：`ctx.get('dataSpace').status().recovery_required === true` 时跳过业务 finalizer，但仍标记
  gate，等价 Rust `StartupReadyGuard` 在 setup 提前返回时 drop，放行恢复状态查询。
- [x] 失败分支：finalizer / 恢复状态查询抛错时向上传播，boot 发送 `HostFatal` 并以 1 退出；不发送
  `HostReady`，不标记 gate。
- [x] lane 边界：kernel 只用结构化接口按服务名探测，不 import `host/platform/storage` 或 `electron/`，保持
  平台不 import 业务。
- [x] 测试：`host/kernel/connection.test.ts` 走生产 `serveHost`，覆盖正常（finalizer 执行 → gate mark）、
  恢复（skip finalizer → gate mark）、失败（fatal / no ready / no gate mark），并经真实 `frontend-event`
  消息验证 `target` 路由。
- [x] F3 的 `registerFinalizer` / `runStartupFinalizers` / `finalizerNames` 已合入main `d84e29565`，
  `9900d8dda`为其祖先；F1组合根无需改动即可执行。独立测试提交已带回，不合混合证据分支。

### 真实组合链历史证据与正式分支交付

2026-11-04更新：F3已进main；以下是当时临时工作区的取证记录。`7fdd36afe`现已按`-x`带回为
`5d451e443`；只运行新增的真实链四例确认正式API，不重复当时8例组合。注册失败政策仍待裁定。

`connection.test.ts` 的 `startup.plugin.ts` 只验证组合根分支，不是 F3 registry 的整链证据。为满足 C2
2026-11-04 的“真实 `StartupFinalizerRegistry` + `serveHost` 注册路径”要求，在 F1 `1b3cedeaa` +
生产日志改动 `5d373dbf2` + F3 `9900d8dda`（其后 `ab794ce5c` 仅文档）的合并工作区（merge `a612c4496`）新增
`host/kernel/connection.startup-real.test.ts`（测试提交 `7fdd36afe`，证据分支
`evidence/F1-F3-startup-real`）：profile 直接安装真实 `StorageCordisService`（内部即真实 registry）与
真实 F2 `createStartupGate`，经生产 `serveHost` 启动。作业 `20261104075748-2c9c0f`：8 tests passed
（真实链 4 个 + 组合根回归 4 个），exit 0。证据分支中的 F1 日志改动是 cherry-pick `df8e6206e`
（内容同 F1 `5d373dbf2`）；测试依赖该改动。F1 已随 main 集成（含 `5d373dbf2`），F3 合入 main 后执行
`git cherry-pick -x 7fdd36afe`。`evidence/F1-F3-startup-real` 只用于取证，**不要整支合入**（会带入 F3
代码）；`7fdd36afe` 的 7 个文件全部是 `host/kernel/` 下的新增文件，可独立 cherry-pick。C2 2026-11-04
08:26 已接受该独立提交方案；main 缺 F3 时不强行带入以免破坏类型检查。结论：

- 正常：真实 registry 按 `after` 依赖执行 `migrate → restore → cleanup`；三个钩子执行期间
  `startupGate.isStartupReady()` 均为 false，全部成功后才 mark，然后才发送 `HostReady`。
- 执行失败：`restore` 抛错 → `StartupFinalizerError` 向上传播，`HostFatal.message` 为
  `startup finalizer failed: fixture.startup-real.restore`；组合根在抛错前把失败阶段、失败 finalizer、
  已完成列表与原始 cause 写入 Host 日志（`main.ts` 输出 stderr）。无 `HostReady`、gate 未 mark、
  exit 1；失败钩子只执行一次（无自动重试），也不产生 `host://plugins-degraded`（不是插件 apply 失败）。
- 恢复模式：三个 finalizer 均已注册但一个都不执行，gate 仍 mark，`HostReady` 正常发出。
- 注册失败：业务插件第二次 `registerFinalizer` 触发真实 `FINALIZER_DUPLICATE`；`installProfile` 按既有
  规则只隔离该插件（`host://plugins-degraded` + `plugin:host|status`），boot 仍 ready/gate。当前 F3
  `registerFinalizer` 没有注销句柄，插件回滚前已成功的第一次注册仍会在 `finishStartup` 执行；测试
  明确记录了这一“部分注册泄漏”。

**政策待裁定（不擅自改语义）**：可选插件 apply 失败继续按 degraded 隔离；若失败插件本应提供必需的
恢复/清理 finalizer，当前会把“启动不完整”当成“可选插件降级”。需要架构师裁定必需钩子的声明与失败
传播方式（如显式 `required` 声明、启动完成条件或 host 级 fatal 清单）后，F1 才能改变 gate 语义。
裁定前不把全部 apply 错误改为 fatal。C2 2026-11-04 08:26 回执：政策请求已追加 `082349530` 的注册
失败“部分钩子泄漏”真实证据，仍待架构师裁定。

**显式重试归属**：F1 boot 在 finalizer 失败后立即发送 `HostFatal` 并退出，不存在自动重试或定时重试；
F3 registry 的“再次 run 跳过已完成项”只供显式调用方使用。当前生产没有该调用方；未来若要进程内重试，
必须由外壳/恢复编排在获得明确失败状态后显式调用。业务插件不得 catch 后自行启动或定时等待来替代启动
契约（L06 请求，C2 2026-11-04 确认）。

## 二进制命令结果边界（X2-R05，2026-11-04）

X2 复核确认 HEIC 契约本身正确（`convert_heic_to_jpeg` 的 `Request` 注入 + `result.x-binary=true`），
问题在 Host 返回路径：此前 `commands.ts` 对所有结果执行 `toWireJson`，二进制只能靠 F2 的
`{ "__dstuRawBytes": "<base64>" }` JSON 信封穿过边界。前端 Android raw-byte invoke 与 F5 契约均不改；
F1 只补齐 Host 的二进制传输边界。

- [x] `result.x-binary === true` 的契约（Rust `tauri::ipc::Response`）允许处理函数返回 `Uint8Array`
  （含 Node `Buffer`）或 `ArrayBuffer`；`commands.ts::_dispatch` 跳过 `toWireJson` 与 `findNonJson`，
  原始字节直接进入 `InvokeResponse.value`，由 MessagePort / `fork({ serialization: 'advanced' })` 的
  structured clone 搬运；main 的 `ShellRuntime.encodeBody` 将其作为 raw body 回写，前端收到 `ArrayBuffer`。
- [x] 兼容 F2 现有实现：`{ "__dstuRawBytes": "<base64>" }` 信封仍是 x-binary 契约的合法值，继续按 JSON
  传输并由 main 的 `decodeRawBytes` 解码；`read_file_bytes` 不需要因本改动修改。
- [x] debug 校验：x-binary 契约只接受原始字节或上述信封，其他形状按契约违规 reject；非 x-binary 命令
  返回二进制仍按 plain-JSON 规则拒绝，二进制豁免没有扩散到普通命令。
- [x] 原始请求体：零具名参数命令可直接接收 `Uint8Array` 载荷（HEIC 的 `Request` 注入形状），
  `call.payload` 保持原字节。
- [x] 测试：`host/kernel/binary-result.test.ts` 经生产 `createTestHost`/`CommandService._dispatch` 覆盖
  `Uint8Array`、`ArrayBuffer`、`__dstuRawBytes` 信封、非 binary 契约拒绝，并用仓库真实
  `convert_heic_to_jpeg` 契约 + stub 验证 raw `Request` 输入（`call.payload` 原字节）与字节输出；
  `host/kernel/e2e.test.ts` 经真实 Host 子进程 + advanced serialization 验证 `Uint8Array` 结果和 raw body 输入。
- [ ] 跨平台等价未签收：Linux 环境没有 Android codec、macOS/iOS WebView 或 Windows 原生运行验证，
  也未执行真实 HEIC 成功 invoke（media 插件尚未注册 `convert_heic_to_jpeg`）；这些属于 L18/F7 与
  平台运行证据，不在 F1 的静态实现范围内。F1 只保证 Host 的二进制传输边界不再丢弃字节。
- 不改前端 `invoke<ArrayBuffer>('convert_heic_to_jpeg', bytes)` 的 raw-byte 调用方式，也不要求 F5 把
  `x-binary` 改成 JSON。

## 前端插件桥（F0b，`docs/plugins/FRONTEND.md` §3、§5）

不是 Rust 命令；由 kernel 直接提供（`runtime.ts`）。两者都是内核自有命令：不在 `contracts/ipc`，不参与覆盖检查，
只对本地窗口开放（remote 页面按 ACL 拒绝）。

- [x] `PluginMeta`：`ui?: string`（相对插件模块文件的 UI 半路径）、`remote?: Record<string, readonly string[]>`（服务 → 允许 UI 调用的方法）、`version?: string`（进入清单）。
- [x] 清单形状：`UiManifestEntry = { id, file, version? }`；`file` 为 `resolve(dirname(插件模块), meta.ui)` 的绝对路径；包名无法解析为文件时记 warn 并跳过（`runtime.ts::uiManifest`）。
- [x] 过滤：插件模块位于 `host/` 内（官方插件，UI 半已打包进前端）不进清单；只列用户/社区插件。
- [x] 命令 `plugin:ui|manifest`：返回当前清单（`HostRuntime.uiManifest()`）。
- [x] 事件 `host://ui-manifest`：清单序列化结果与上次不同时 `backendEvents.emit`；在 `install`/`installAll` 成功后、`unload` 后、profile 装载完成（`finishProfile`）后检查；初始空清单视为已知（不发事件）。
- [x] 命令 `plugin:host|call`：参数 `{ service, method, args }`（纯 JSON 校验，`json.ts::findNonJson`）；只放行已装载、确实提供该服务的插件在 `meta.remote[service]` 中列出的方法。
- [x] 错误：未提供的服务 / 未列出的方法 / 缺少方法 → `CommandError(AppError.validation(...))`；方法抛 `CommandError` 按其值 reject；其他异常交由命令层按 panic 处理（日志 + 前端 Promise 不 settle）。
- [x] 返回值：`findNonJson` 不通过时记 error 并以 `Unknown` 拒绝（消息 `[dstu-host] plugin:host|call <service>.<method> returned a value that is not plain JSON: …`）。
- [x] 取消：`CallContext.signal` 作为最后一个参数 `{ signal }` 传给方法；调用方 abandon 时中止。

## v2 自查修复 F1-V2-01/03/05

- 配置边界：Rust `ilink_bot/mod.rs:120-124,793-796` → `ilink-bot.ts::readRateLimit/setConfig`。
  usize 按桌面 u64 范围解析（允许 `+`，不允许空白/小数/溢出）；patch 非负整数按 u64 检查。
  settings 所有者仍 F4，F1 只保存 `plugin.ilinkbot.rate_limit_per_min`，顺序与错误映射不变。
- 计时：Rust `mod.rs:222,228,249` 的 Instant → `performance.now()`；事件 `events.rs` 的 Utc
  仍用 Date.now。`monotonicNow` 测试注入口与事件 `now` 分开；到期比较保留严格 `>`。
- 清理：可中止 sleep 正常完成与 abort 都移除监听、清 timer，不积累轮询监听器。
- bootstrap：Rust `manager.rs:476-493` get_setting 的 `.ok().flatten()` → 失败按缺失继续迁移 enabled
  并调用 start；仍无额外事务。TS 额外 warn 不改变错误传播。
- 测试：`host/kernel/tests/plugins-v2.test.ts` 经真实插件入口/公开 manager 服务，验证 u64 设置精确保存、
  内部 BigInt/IPC number、非法范围不写、墙钟跳变不触发登录超时、enabled 读错后继续启动。
  `plugins.test.ts` 只扩大测试夹具的内部 JSON 类型以适配 D3，原断言无改动。
- 证据：生产入口测试 + Rust 逐分支审读；不是 Rust 动态差分，待独立复核签收。

## v2 自查修复 F1-V2-02 / 文件输入解码

- `ilink-decode.ts` 逐字段对应 `src/plugins/ilink_bot/client.rs:17-83`：String、Option、default Vec/map、
  i32/i64/u64；保留数字 token 精度与浮点/整数字面量区别；缺省列表是 []，显式 null 拒绝。
  结构体重复字段拒绝、未知字段忽略，凭证 camelCase 必填/default 规则共用同一解码入口。
- 类型错误/缺失字段/重复字段保留 serde 的说明与 UTF-8 行列位置；HTTP 再加 reqwest 0.11.27
  `error.rs::Display(Kind::Decode)` 的 `error decoding response body: ` 前缀。凭证从_str不加 reqwest 前缀。
- `sendText` 按 `client.rs:323-334` 的 Value::as_i64 分类：浮点和越界值不作为错误码；大整数不先转 number；
  业务错误 JSON 保留原整数与输入顺序。无业务表写入，HTTP status/取消路径不变。
- `plugins.test.ts` 原5个错误断言改为更精确的 Rust 文案（非弱化）：两个 `{}` HTTP 缺字段加 reqwest前缀/位置，
  msgs对象错误改成 `invalid type: map, expected a sequence`，两个凭证错误加 serde 类型说明/位置。
  Rust 业务入口分别为 `client.rs:168-170,193-195,253-255` 与 `mod.rs:91-92`；这5个不是原Rust具名测试。
- 新测试 `ilink-decoding.test.ts` 经过真实 HTTP server→IlinkClient，断言 >2^53 精度、u64/i64边界、浮点拒绝、
  null列表拒绝、重复字段、错误原文、sendmessage分类。凭证解码由原plugins.test和生产登录入口覆盖。
- ACL 文件按 tauri-utils `acl/capability.rs::CapabilityFile` 支持 single/list/named-list；逐字段验证
  local/window/webview/platform/remote/permissions，Option remote/platform接受null、Vec字段不接受null。
  ContractSet 文件加载先校验实际消费的 envelope/name/args/schema 字段，再交原 Ajv 编译业务 schema。
  `file-decoding.test.ts` 走 fromDirectory，覆盖真实仓库契约与非法文件，不以 TypeScript 断言冒充校验。

### v2 完成清单索引（逐命令，沿用上文分支规格）

| 命令 | Rust→TS入口/分支 | 数据边界/错误/日志 | 所有权/运行时 | 生产测试与证据 | 整链结论 |
|---|---|---|---|---|---|
| plugin_list | commands.rs:11 / manager.rs:119-145 → plugins.ts / PluginManager.list | IPC契约，null/排序；失败继续；日志见全局表 | settings只读；快照 | plugins.test.ts command surface，审读 | 已核局部，待独立复核 |
| plugin_get_status | commands.rs:32 / manager.rs:147-156 → getStatus | IPC契约，status Option=null；凭证解码 | settings只读；快照 | 同上 | 已核局部，待复核 |
| plugin_get_config | commands.rs:40 / mod.rs:763-784 → getConfig/getPublicConfig | 凭证解码，精确usize；读取失败继续 | settings只读 | plugins-v2.test.ts u64/usize，审读 | 已核局部，待复核 |
| plugin_set_config | commands.rs:48 / mod.rs:787-809 → setConfig | IPC Value，逐字段类型，u64，不接受token；首错返回Database | F4 settings保存自有键；顺序无事务 | plugins.test.ts + plugins-v2.test.ts | 已核局部，待复核 |
| plugin_stop | commands.rs:24 / manager.rs:251-267 → stop | IPC id，未知id Validation；状态事件 | lifecycle串行；先移除后abort | plugins.test.ts | 已核局部，待复核 |
| plugin_cancel_login | commands.rs:74 / manager.rs:421-427 → cancelLogin | id/Validation；stopped事件 | cancel→stop→stopped；listener释放 | plugins.test.ts | 已核局部，待复核 |
| plugin_logout | commands.rs:82 / manager.rs:430-451 → logout | id/Validation/Database前缀；状态事件 | F4删凭证/保存enabled；串行 | plugins.test.ts | 已核局部，待复核 |
| plugin_unbind | commands.rs:87-90 → unbind→logout | 与logout同源 | 与logout同源 | plugins.test.ts | 已核局部，待复核 |
| plugin_start | commands.rs:16 / manager.rs:158-237 → start | IPC id；HTTP解码/事件；远程任务日志待接线 | generation/abort；L04/L06 API缺失 | plugins.test.ts局部；真实任务pending | F1-V2-04阻塞，不签完成 |
| plugin_set_enabled | commands.rs:57 / manager.rs:269-287 → setEnabled | bool/unsupported/Database；启停事件 | 先settings后启停 | 局部已测；true任务链pending | F1-V2-04阻塞 |
| plugin_begin_login | commands.rs:66 / manager.rs:301-418 → beginLogin | id/凭证/QR错误与事件；自动轮询待接 | lifecycle/Instant期限；F4保存凭证 | plugins-v2.test.ts真实登录错误；headless pending | F1-V2-04阻塞 |

上述证据均为生产入口测试或审读，未执行 Rust 差分；未勾选行不由静态注册率覆盖。

## agent_wiring 自定义档案接线解锁（2026-11-05）

`custom_agent_tests.rs:21-57` 的全部断言经 L05/L24 公共 API 执行：safeToolSet 包含四个只读工具；
L24 生产 `createChatAnkiExecutors` 按真实 first-match 顺序处理每个工具且敏感度为 low；真实临时 Markdown
经 `findCustomProfile` 解码后，allowedTools 保留两项协作工具加四项只读工具及原顺序。
生产消费点为 L24 `index.ts` 的 executor 构造与 L05 自定义档案加载；不复制常量或执行器，不增加业务实现。
测试自己的临时文件在 finally 删除；这些元数据查询无数据库写入、事件或 Rust 日志。

## W13 显式 pre-storage bootstrap 位置

### 独立入口发现（L20 `d74ad476b` 合同）

- L20正式入口为 `host/plugins/sync/startup.ts`，默认导出 `dstu.sync-startup`，仅inject paths；
  晚期 `sync/index.ts` 不再提供 storageStartupSync。生成器在扫描sync目录时额外导入该精确模块，
  不扫描其他业务helper文件。存在sync目录却缺少startup模块时导入失败，不静默遗漏早期服务。
- 发现后的唯一provider/仅paths校验与kernel后固定位置复用原逻辑；不新增platform→业务依赖，
  不改安装器或用finalizer代替。导入失败与声明冲突均在生成清单前抛错，不输出半成品profile。
- `profile-bootstrap.test.ts` 的独立模块fixture仅验证真实生成器→loader发现、排序及apply失败隔离；
  原index入口与非法依赖用例保留。真实purge/reset行为由L20/F3负责，正式profile整链另行验证。
- `profile-isolation.test.ts` 的W13官方profile用例在隔离dataDir/XDG路径创建真实purge marker，
  通过passthrough spy观察真实模块安装与reset：provider已安装→storage尚未发布且marker仍在时调用reset→
  真实sync_state文件存在→marker清除→恢复状态正常且业务库可打开。不注入替身服务、不复制SQL；
  finally卸载runtime并恢复环境。另用真实目录占位制造reset开库失败和marker unlink失败，分别验证
  reset未完成/已完成两条轨迹、marker保留、恢复状态及业务库拒开。原无marker官方启动用例保留。
  这些用例证明正式profile消费顺序，五表事务和失败回滚仍由L20/F3原例验证。

依据 `src-tauri/src/lib.rs:1015-1063`，purge后的五表reset必须在业务库初始化前完成，成功后才清marker。
不能用D2 post-plugin finalizer代替（F3 `a5b6c8a8d` 已确认自己的早期回调）。

- 生成器扫描真实入口，找到声明 `storageStartupSync` 的唯一提供方时，将其条目固定放在kernel首条之后、
  所有platform条目之前。目录名、插件id任意；只有明确的服务契约决定此位置。
- 提供方必须仅inject `paths`；声明storage/syncSupport/notes等依赖在生成时抛错。重复提供方也抛错。
- 仍使用现有稳定拓扑排序：storage可选中时paths必定ready，而更早的bootstrap也已ready，因此先apply bootstrap。
  F4 paths本身无inject。没有新增通用阶段、排序metadata或平台→业务依赖。
- 正常：paths→bootstrap.provide→F3 apply→purge→reset→清marker→业务库；无purge不调用reset。
- bootstrap导入失败：profile fatal；apply失败：沿原隔离规则degraded，F3 purge取不到服务进入startup_cleanup恢复，
  保留marker、不打开业务库。reset失败/marker清除失败的处理仍归F3，不能由F1 finally mark伪造成功。
- 五表事务、upload_seq保留全部归L20；只消费其公开provider。F1不写这些表。
- 测试 `profile-bootstrap.test.ts` 走真实生成器→loadProfile→orderForProfile→Cordis apply，
  用明确的插件输入夹具证明顺序、失败隔离、禁止循环依赖。它不是F3 purge/L20 reset的整链证据。
- 正式profile真实组合仍pending：F3 `syncStateDatabasePath`现已集成，main仍缺L20独立provider；等其正常集成后生成
  desktop.json，验证无标记/purge成功/reset失败/marker失败的真实表、marker、恢复状态与业务库打开边界。
  不用空provider计完成，不重复已签收D2八例。
# WP-133：入站 JSON 原文（2026-11-06）

实现前审读依据（cargo registry `index.crates.io-1949cf8c6b5b557f/`）：
- tauri-2.11.5 `src/ipc/protocol.rs:527` 先 from_slice::<Value>；`src/ipc/mod.rs:55-65` InvokeBody Json/Raw。
- tauri-2.11.5 `src/ipc/command.rs:62-68,84-104,134-144`：具名参数 Value::get、缺失/Option/bytes、InvalidArgs 包装。
- serde_json-1.0.149 `src/value/de.rs:705-728,817-845`：借用 Value 的 typed 数字委派到 Number；
  `src/number.rs:530-533,582-599,627-643`：arbitrary_precision 按目标类型 parse，失败 `invalid number`（无行列）。
- `src/number.rs:809-813`：非数值类型收到数字的 Unexpected 为 `number`。
- `src-tauri/src/insight/handlers.rs:66-77`：status、limit、offset 顺序，后两者 Option<i64>，默认 100/0。
- WP111 原件 `/tmp/opencode/x1-b-v0-SDuuW6/0/wire.jsonl:21-22,26-27`：两个相邻 token 在旧 Shell→Host 对象中合并。

行为边界：InvokeRequest/DispatchRequest 增补 argsJson?: string；非 bytes 且存在时原文唯一权威，
无效原文返回 result(ok=false,error:string)，不回填 args、不走 panic。先保持既有 not-found/ACL，再解析完整 Value，
然后签名顺序具名契约校验，最后调用 handler。Raw bytes 不改；旧对象入口不改。
处理器的 typed 安全整数为 number、不安全整数为 bigint；Value 的非安全整数/非整数 token 保留原生 raw atom，
JSON.stringify 仍生成 number token。范围与消费签名、验证原件在本包交付记录列明，不宣称 1058 命令业务全闭合。

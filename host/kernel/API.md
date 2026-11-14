# Desktop Host 插件编写指南（kernel / F1）

Host 是跑在 Electron `utilityProcess` 里的 Node 进程，内核是 Cordis（`@deepseek-ai/cordis` 4.0.5）。
每个业务功能都是一个 Cordis 插件：在 `apply(ctx)` 里注册 Tauri 命令、提供或使用服务、订阅事件。
所有注册都是副作用，插件卸载时自动撤销。

插件**只**从这两个文件导入 kernel：

| 文件 | 用途 |
|---|---|
| `host/kernel/api.ts` | `definePlugin`、`CommandError`、类型（`CallContext`、`WindowRef`、`EventTarget` …），以及 `ctx` 上的 kernel 服务类型 |
| `host/kernel/core.ts` | 可移植入口（W14）：`definePlugin`、`CommandError`、类型、常量、`PluginMeta.platforms`；`api.ts` 全部重导出。运行时只加载 `error-model.ts` → `json.ts` |
| `host/kernel/testing.ts` | 测试宿主 `createTestHost`（只在测试中导入） |

其余文件（`commands.ts`、`runtime.ts` …）是 kernel 实现，插件不要导入。

`api.ts` 与 `core.ts` 的运行时闭包都不加载 Node 模块（守护测试 `tests/portable-entry.test.ts`）。iLink 渠道插件
（原 `ilink-client.ts` / `ilink-bot.ts` / `ilink-decode.ts`）已移到 `host/plugins/ilink/`，经其 `api.ts` 发布，由 `plugins.ts` 实例化；
QR 编码器移到 `host/platform/util/qr.ts`。下文提到的这些文件名指新位置。

## 1. 最小插件

```ts
// host/plugins/qbank/manifest.ts
import { CommandError, definePlugin } from '../../kernel/api.ts';

export default definePlugin({
  meta: {
    id: 'dstu.qbank',
    lane: 'L14-qbank',
    commands: ['qbank_get_paper'],        // 本插件注册的全部 Tauri 命令
  },
  apply(ctx) {
    ctx.commands.register<{ paperId: string }, Paper>('qbank_get_paper', async ({ paperId }, call) => {
      const paper = await loadPaper(paperId, call.signal);
      if (!paper) throw new CommandError(`试卷不存在: ${paperId}`); // = Rust Err(String)
      return paper;                                                 // = Rust Ok(Paper)
    });
  },
});
```

规则：

- `meta.id` 全局唯一。官方插件的 id 都在保留 publisher `dstu` 下，社区模块用它会以 `ID_RESERVED` 进降级列表（§16.2），
  所以社区代码不能顶替官方插件；用户 profile 关闭官方插件用 `disabled`（见 §8 Profile）。
- `meta.commands` 必须列出插件注册的**每一个**命令；注册未声明的命令直接抛错。
- 命令名必须存在于 `contracts/ipc/*.json`（F5 从 Rust 抽取）。没有契约的命令不能注册——
  Rust 里没有的命令不补实现（前端调用它时返回 Tauri 的"未找到"错误）。
- 同名命令只能注册一次；注册随插件卸载撤销，撤销后可以重新注册。

## 2. 命令

### 2.1 参数

处理函数收到的 `args` 已经按契约校验，语义与 Tauri 2.11.5 一致
（`tauri-2.11.5/src/ipc/command.rs:62-149`、`tauri-macros-2.6.3/src/command/wrapper.rs:427-528`）：

| 情形 | Tauri 行为 | kernel |
|---|---|---|
| 键名 | 前端传入的键（默认 camelCase，`rename_all` 由契约 `args[].key` 体现） | 按 `args[].key` 查找 |
| 多余的键 | 忽略 | 忽略，**不会**出现在 `args` 中 |
| 键缺失，参数非 `Option` | `missing required key` 错误 | 同左 |
| 键缺失或为 `null`，参数是 `Option<T>` | `None` | `args[key] === null`（两种情况统一为 `null`） |
| 键为 `null`，参数非 `Option` | serde 类型错误 | 同左（`invalid type: null, expected …`） |
| 载荷不是对象（数组、`null` …） | `Value::get` 返回 None → 键缺失 | 同左 |
| 载荷是 `Uint8Array`/`ArrayBuffer` | 任何具名参数都报 bytes payload 错误 | 同左 |
| 多个参数都有问题 | 按 Rust 签名顺序，第一个失败的参数决定错误 | 同左 |

需要原始载荷（Rust 注入了 `tauri::ipc::Request`）时读 `call.payload`；需要原始请求头时读
`call.headers`（仅在 main 转发 `InvokeRequest.headers` 时存在）。

#### WP-133 入站原文（供 F2 / F5 / 业务消费者）

- `InvokeRequest.argsJson?: string`（`DispatchRequest` 同签名）只用于 JSON body；存在时 `args`
  仅为旧投影，不能作为解码 fallback。F2 从原 `payload.data` 直接转发文本，不能重做 stringify(args)。
- Host 的 connection→runtime→commands 保留文本，F4 `parseJsonDocument` 完整语法读取，再按具名参数顺序
  做 serde + 精确感知的 AJV 契约校验；Raw `Uint8Array`/ArrayBuffer 忽略此字段，保持 bytes 分支。
- `IpcInteger = number | bigint`：typed `x-int` 安全整数为 number，其他合法整数为 bigint。
  递归支持 `$ref`、Option、Vec、map、struct 字段、tuple、enum 分支与生成 flatten。
- V08-01：schema 未标数字类型的位置（`serde_json::Value`、`{}`、`true`）解成**普通 JSON**，与 `JSON.parse`
  的结果相同，所有数字都是 `number`；处理器可以 `structuredClone`、`Number()`、展开。前端参数由
  `JSON.stringify` 产生，重新序列化得到原文，不丢信息（见 host/platform/API.md「数字表示」）。
- `call.payload` 在有源文时是同源完整 Value（含未知键），同样是普通 JSON；无源文和 bytes 不改。
  需要数字 token 的处理器显式调用 `call.exactPayload()`（懒计算，安全整数以外的数字为 F4 原生 `JsonRawNumber`，
  `1.0`、大整数、超 f64 均保留）。原子不能克隆、不能 `Number()`，用完立即序列化或转换。
- 错误仍为 `InvokeResponse {kind:'result',id,ok:false,error:string}`：语法/字段类型不合法为
  `[dstu-host] invalid argsJson: <serde syntax detail with line/column>` / `expected a string`；
  typed 数字越界、小数或指数喂整数为 ``invalid args `<key>` for command `<cmd>`: invalid number``。
  无效源文不回填、不进入处理器、不挂起。既有 not-found/ACL 优先；有效 JSON 的参数错误按签名次序。
- 精度供方不代表 1058 命令业务已适配：L15 `insight-commands.ts::ListArgs` 与 L17
  `InsightCommandService.listInsights` 等仍声明 number；涉及 i64/u64 的消费签名需使用 `IpcInteger`，
  业务运算/DB 不能 Number(bigint)。本包只验证真实 L15 handler 已将精确 offset 送到服务边界。
- 原对象入口保持已有行为；其已损失的数字无法恢复。原有 serde 不完整形状的错误文案仍由 AJV 提供，
  不声称全部 serde attributes、自定义 Deserialize、f32 极端双舍入或全域业务精度闭合。

### 2.2 返回值

- 返回值 = Rust `Ok(T)` 的 serde 序列化结果；`undefined` 按 `null` 发送（Rust `()`）。
- 返回值在 debug 下（`ctx.app.debug`，测试宿主默认开启）必须是 plain JSON：对象、数组、字符串、有限数字、
  布尔、`null`；kernel 拒绝 `Map`/`Set`/`Date`/类实例/`NaN`/数组中的 `undefined`/稀疏数组，并按契约 `result`
  schema 校验**线上值**，违规时以 `[dstu-host] command "…" returned a value that violates its contract …` reject，
  方便在开发期发现形状偏差。release 下不做这两项检查，但 BigInt 的线上转换仍然执行；值里有函数、symbol 或非普通
  原型的对象（类实例、`Map`、`Date`、`URL`…，字节除外）时，kernel 不拒绝，按 `JSON.stringify` 投影成普通 JSON 再发
  （有 `toJSON` 的用它，`Map`/`Set` 成 `{}`，函数属性省略），并记一条 warn
  `[dstu-host] command "…" returned a value that is not plain JSON: <第一处路径与类型>; sent its JSON projection`
  （V08-10，`json.ts::plainWireOutput`）。检查借 `toWireJson` 的那一趟遍历顺带完成，普通值没有额外开销。
- D3：`BigInt` 不属于非法 JSON。内部游标/版本号/比较保持 BigInt 精确值；命令返回前只复制一份线上值，
  BigInt → `number`（超过 2^53 时与 Rust `serde_json` 输出后前端 `JSON.parse` 一样按 IEEE-754 舍入），
  不修改插件返回的原对象。
- F1-RAWJSON-01：原生 `JSON.rawJSON` 值由 `JSON.isRawJSON` 品牌识别，出口按
  `JSON.parse(atom.rawJSON)` 投影；普通 `{rawJSON: string}` 对象（含null-prototype）保持对象。
  内部监听/持久化仍保原atom及精确token。超f64/负零在Host边界为Infinity/-0；F2最后一跳
  再JSON序列化的语义修复另行跟进，Host用例不签收这些极值的renderer整链。
- F1-RAWJSON-02 / WP-143：实际命令/错误/事件出口发现原生raw原子或bigint（根值或容器内）时，生成一次完整JSON文本；
  `InvokeResponse.json?: string` / `BackendEvent.payloadJson?: string` 携带该文本，投影值从同一
  文本JSON.parse得到。F2须直接用它作为现有JSON body/事件文本，不再parse/stringify；字段缺省
  沿旧输出。raw溢出与同载荷typed非有限数字分别保原token/null，BigInt在文本中为原十进制数字。
  内部对象/事件监听仍拿原值。binary成功结果、普通无raw且无bigint消息不带文本字段。
  bigint-only 同样保留原整数token（如9007199254740993），投影自然舍入为9007199254740992；
  X1/X7记录精度时使用上述原文，不从投影重新stringify推断原整数。
- 对象中值为 `undefined` 的属性视为省略该键（等价 serde `skip_serializing_if`），允许。
- `u64`/`i64` 超过 2^53 的值按 Rust 实际序列化（契约 `x-int`）处理，见 README §3.3。
- **二进制返回值（X2-R05）**：契约 `result` 标注 `"x-binary": true`（Rust 返回 `tauri::ipc::Response`）时，
  处理函数返回 `Uint8Array`（含 Node `Buffer`）或 `ArrayBuffer`。kernel 跳过 JSON 复制与 `findNonJson`，
  把字节原样交给传输层；MessagePort / `child_process.fork({ serialization: 'advanced' })` 的 structured clone
  保留 typed array，main 的 `ShellRuntime.encodeBody` 将其作为 raw body 回写，前端 `invoke` 收到
  `ArrayBuffer`（与 Tauri 一致）。这条路径不经过 `toWireJson`，也不会把字节变成 JSON 数组/对象。
  纯 JSON 传输（或尚未切换的 F2 `read_file_bytes`）仍可用 `{ "__dstuRawBytes": "<base64>" }` 信封；
  main 的 `decodeRawBytes` 在回写前解码。debug 下 x-binary 结果必须是原始字节或该信封，其他形状按契约违规
  reject；普通（非 x-binary）命令返回二进制值仍按上一段的 plain-JSON 规则拒绝。
  原始请求体（Rust 注入 `tauri::ipc::Request`）继续通过 `call.payload` 读取；零具名参数命令可直接接收
  `Uint8Array` 载荷（`convert_heic_to_jpeg` 即此形状）。

### 2.3 错误

**保证：处理函数抛出任何值，前端 Promise 都会 settle。**

| 处理函数的行为 | 前端 Promise | 依据 |
|---|---|---|
| `throw new CommandError(value)` | reject `value`（原样；`undefined` → `null`）。debug 下按契约 `error` schema 校验；命令在 Rust 中不返回 `Result` 时也视为违规 | Rust `Err(E)` 经 `serde_json::to_value` 后 reject（`src/ipc/mod.rs:240-247`） |
| 裸抛 `AppError` 普通对象（`throw AppError.not_found(…)`） | 等同 `throw new CommandError(该对象)`：原样 reject，debug 下同样按契约校验 | 只认 Rust `AppError` 的 serde 形状：普通对象、恰好 `error_type`（合法变体）/`message`（字符串）/`details` 三个键（`isAppErrorValue`） |
| 抛出其他任何值（`Error`、`TypeError`、`StorageError`、字符串、数字、`undefined`、其他对象…），或 kernel 在派发过程中自身出错 | reject **统一内部错误**；kernel 带栈（含 `cause` 链）记 error 日志（Cordis logger `commands`，经日志桥接以 target `dstu_host::commands` 落盘到主日志 `deep-student.log`）。测试宿主中以 `HandlerPanic` reject，`HandlerPanic.reply` 即前端收到的值 | **有意偏离 Rust**，见下文 |

debug 下 `CommandError` 的值（或裸抛的 `AppError`）不是 plain JSON、不符合契约 `error` schema、或命令在 Rust 中不返回
`Result` 时，前端 reject 的是诊断字符串 `[dstu-host] command "<cmd>" rejected with a value that violates its contract (<契约文件>): <问题>`，
并以同一文本记 error 日志（同样会 settle）。典型情形：在 `error` 为 `string` 的命令里裸抛 `AppError`。release 下不做该校验，
值按 D3 转成线上 JSON 后原样 reject。

统一内部错误的 `message` 取被抛出值的文本 `errorDisplay(value)`：`Error` 取 `message`（为空时取 `name`），字符串原样，
带非空字符串 `message` 的对象取该字段，其他值尽量 JSON 化，对任何值都不抛错。

**显示文本（V05-02、V08-04）**：`AppError.*` 是普通对象，`String(error)` 得到 `[object Object]`。插件拼接错误文本一律用
`errorDisplay(error)`（`kernel/api.ts`、`platform/errors/api.ts` 同一个函数），不要写 `error instanceof Error ? error.message : String(error)`；
它等价 Rust `e.to_string()`（`impl Display for AppError` 只写 message，`dstu-core/src/models.rs:1038-1042`）。
`new CommandError(value).message` 按同一规则取文本：普通对象带非空字符串 `message` 时取它（AppError、envelope、DstuError），
其余值是 JSON 文本或非 JSON 诊断；前端收到的仍是 `value`，不受影响。

形状按命令契约的 `error` schema 选第一个能通过校验的：

| 契约 `error` | reject 值 | Rust 对应 |
|---|---|---|
| `AppError` | `{ error_type: 'Unknown', message, details: null }` | `AppError::unknown`（`From<anyhow::Error>` 同形） |
| `CommandError` 信封 | `{ code: 'INTERNAL_ERROR', message }` | `CommandError::internal` |
| `DstuError` | `{ type: 'Internal', message }` | `DstuError::Internal(String)` |
| `string`、命令不返回 `Result`、schema 无法编译 | `message` | `Err(String)` |
| kernel 命令（`plugin:*`） | `{ error_type: 'Unknown', message, details: null }` | 同上，这些命令的其他错误也是 `AppError` |

release 下的 `CommandError` 值按 §2.2 同样投影（warn 文案为 `rejected with a value that is not plain JSON`）。

结果已算出但发不出去（release 下投影也救不了的值，例如含函数的循环引用：投影失败，warn 写 `JSON projection failed …,
sent as is`，按原值发送时 `MessagePort` 抛 `DataCloneError`）时，
连接层记日志并改发同形状的统一内部错误（message 以 `[dstu-host] command "<cmd>" produced a response that cannot be sent` 开头）。

**与 Tauri 的差异（有意偏离）**：Rust 中命令返回 `Err(e)` 时按 serde 序列化 `e` 发给前端（序列化失败时退化为
`e.to_string()`）；命令 panic 时（release `panic = "unwind"`，`src-tauri/Cargo.toml`），异步命令的 future 在 tokio
任务中 panic，任务终止、resolver 被丢弃而从不回调（`src/ipc/mod.rs:371-389` 只在 `task.await` 正常返回后
`return_result`；`InvokeResolver` 无 `Drop` 回调），前端 Promise **永不 settle**，只有 panic hook 写崩溃日志
（`src-tauri/src/crash_logger.rs`）。Host 侧插件里 `throw new Error(...)` 远多于 Rust 中真实的 panic 点，
沿用“永不 settle”会让大量漏掉的错误映射表现为前端永久挂起，所以 kernel 改为回复统一内部错误。不为每次
异常写崩溃日志（避免把可恢复的业务失败当崩溃，20 份上限很快被冲掉）；进程级 `uncaughtException` 仍由
`ctx.log` 写崩溃日志。

所以：凡是 Rust 中以 `Err(...)` 返回给前端的错误，迁移后仍必须 `throw new CommandError(<与 Rust 相同的 serde 值>)`
（或裸抛 `AppError`）——统一内部错误只是兜底，`error_type`/`code` 都是通用值，不能替代 Rust 原有的错误分类。
测试中漏掉的映射会以 `HandlerPanic` 暴露。

`CommandError` 构造只保留原 `value` 并生成诊断 message：非法类值不调用其 `toJSON`，由命令边界报告
plain-JSON 违规；内部 BigInt 不因构造 message 而抛错或改写。诊断文本中的 BigInt 使用精确十进制字符串，
线上 reject 值仍按 D3 转 JSON number。

#### 2.3.1 棘轮：静态 lint 与动态守卫

- **静态**：ESLint 规则 `ds-host/no-untyped-command-throw`（`eslint-rules/no-untyped-command-throw.js`）拦住处理函数里
  原样冒到 kernel 的 `throw new Error(…)` / 抛字符串，按文件计数冻结在 `no-untyped-command-throw.baseline.json`，
  由 `host/kernel/tests/command-error-lint.test.ts` 守护。它不跨文件追踪服务实现。
- **工作单**：`node eslint-rules/no-untyped-command-throw.baseline.mjs --inventory` 按归属列出处理函数的错误出口。
  其中 `bare` 是静态启发式：处理函数调用的跨文件服务即使内部已 catch 并分类，也会被算进来（例如 vfs-handlers
  157 个处理函数全记为 bare，动态守卫却证明它们都 settle 成已分类值）。所以 `bare` 只是候选，**不是棘轮**。
- **动态守卫（棘轮）**：测试文件 `command-error-settle*.test.ts` 用 `host/kernel/testing.ts` 的
  `unsettledCommandErrors(host, plugins, { exclude, args, timeoutMs })` 依次 invoke 这些插件声明的每个命令（参数默认为
  `minimalCommandArgs` 按契约生成的最小值，多数命令会把它当作无效 id 拒绝），断言返回的列表为空。
  列表里的每一项都是没有 settle 成 `ok` 或已分类 reject 的命令，原因有四种：`unclassified`（生产中是统一内部错误）、
  `contract`（debug 契约违规诊断）、`did not settle`、`not in contracts`。守卫通常跑两遍：一遍依赖正常，
  一遍让依赖失败（关闭数据库等），因为这正是 Rust `?` / `map_err` 返回 Err 的两类来源。`exclude` 只放会触达网络、模型、
  音频或长任务的命令。参考实现：`host/plugins/vfs-handlers/tests/command-error-settle.test.ts`（W04）。
- **登记**：`eslint-rules/command-error-settle.json` 的 `guards` 记录归属 → 守卫文件，需要手工维护。
  `command-error-lint.test.ts` 检查每个守卫：文件存在、按上面的规则命名、导入了该归属的模块、使用了 kernel 的守卫工具。
  有 bare 处理函数却没有守卫的归属必须列在 `unguarded` 名单里。名单只减不增：新增归属需要先补守卫，
  补了守卫或 bare 归零后用 `--update` 收紧（新增条目会被拒绝，除非加 `--allow-increase`）。

### 2.4 Tauri 框架错误（kernel 产生，逐字一致）

| 情形 | reject 的字符串 | 依据（tauri-2.11.5） |
|---|---|---|
| 命令未注册（debug） | `<cmd> not allowed. Command not found` | 本应用启用 app ACL manifest（`src-tauri/build.rs:54-56`），且 build.rs:217-246 保证 ACL allow 列表 = 注册集合，所以未注册命令先被 ACL 拒绝：`src/webview/mod.rs:1833-1853` → `resolve_access_message`（`src/ipc/authority.rs:403-405, 426`） |
| 命令未注册（release） | `Command <cmd> not allowed by ACL` | `src/webview/mod.rs:1855-1858` |
| `plugin:<p>\|<c>` 未注册（debug） | `<p>.<c> not allowed. Plugin not found` | `authority.rs:327-331, 408-410, 426`（Host 收到的插件命令其插件不在 Rust ACL manifests 中） |
| `plugin:<p>\|<c>` 未注册（release） | `Command plugin:<p>\|<c> not allowed by ACL` | `src/webview/mod.rs:1855-1858` |
| 参数反序列化失败 | ``invalid args `<key>` for command `<cmd>`: <detail>`` | `src/error.rs:58-60`，经 `src/ipc/mod.rs:249-253` 转成字符串 |
| ↳ 键缺失 | detail = `command <cmd> missing required key <key>` | `src/ipc/command.rs:96-102` |
| ↳ 字节载荷 | detail = `command <cmd> expected a value for key <key> but the IPC call used a bytes payload` | `src/ipc/command.rs:90-94, 138-142` |
| ↳ 类型/取值错误 | detail = serde_json 的错误文案，例如 `invalid type: number, expected a string`、``invalid value: integer `-1`, expected u32``、``missing field `count` ``、``unknown variant `x`, expected one of `a`, `b` `` | `host/kernel/serde.ts` 头部注释列出各条依据（serde 1.0.228 / serde_json 1.0.149，`preserve_order` + `arbitrary_precision`） |

`ContractSet`/`commandNotFound` 等函数在 `errors.ts` 中，插件不需要直接调用。

### 2.5 `CallContext`

```ts
interface CallContext {
  source: WindowRef;      // 调用窗口（替代注入的 Window / WebviewWindow）
  signal: AbortSignal;    // 见下
  invokeId: string;
  payload?: unknown;      // 原始载荷（tauri::ipc::Request）
  headers?: Readonly<Record<string, string>>; // 原始请求头（invoke 消息携带时）
}
```

`signal` 在两种情况下中止：

1. 前端放弃等待（`InvokeAbandon`：窗口关闭、页面重载），`signal.reason` 为 `'window-closed'` / `'reloaded'`；
2. 插件正在停止，`signal.reason` 为 `CommandStoppedError`。

Tauri 没有前端取消 invoke 的 API；Rust 中不会因页面关闭而停止的命令，迁移后也**不得**因 `signal` 停止——
只在 Rust 原本就有取消点（`CancellationToken`、drop 语义）的地方监听它。中止后命令仍正常返回或抛错，kernel 照常回复。

## 3. 事件

```ts
ctx.backendEvents.emit('chat_v2_stream_abc', payload);                               // Rust app.emit
ctx.backendEvents.emitTo({ kind: 'WebviewWindow', label: 'main' }, 'evt', payload); // Rust emit_to
ctx.backendEvents.listen('settings-changed', (payload, source) => { ... });         // Rust app.listen
const off = ctx.backendEvents.listenWindow({ window: 'main', webview: 'main' },
  'mcp-bridge-tools-response:...', payload => { ... });                            // Rust Window::listen
off(); off();                                                                      // 幂等注销
ctx.on('host/window', (ref, state) => { ... });                                     // Rust WindowEvent / on_page_load
ctx.on('host/exiting', ({ reason }) => { ... });                                    // Rust RunEvent::ExitRequested
```

- `host/exiting`（`HostExiting { reason: 'shutdown' | 'dispose' }`）：Host 开始关停，每个 runtime 只发一次，早于任何命令中止和
  插件 dispose（§7「关停」）。同步派发、返回值不被等待：在这里只做取消和置位（例如取消在途自动化，对应 Rust `lib.rs:3251`
  `mark_automation_app_exiting()`），耗时清理放进 `ctx.effect` 的 disposer。名字固定，W02 的自动化订阅它。

- `host/window` 的 `state`：`created` / `focused` / `blurred` / `close-requested` / `destroyed` 对应 Rust `WindowEvent`；
  `page-load-started`（增补）对应 `Builder::on_page_load` 的 `PageLoadEvent::Started`（`src-tauri/src/lib.rs:487-491`），
  只表示 `ref.webview` 的主框架开始加载新文档（首次加载、刷新、跨文档导航）。focus、close-requested、invoke、同文档导航都不是页面加载。
  `ref` 是 main 发来的 `WindowRef`（window/webview label 分开、可选可信 `origin`），原样派发；监听随插件卸载撤销。
  需要 Rust `PageLoadEvent::Started` 清理的插件只认 `state === 'page-load-started'` 并按 `ref.webview` 处理；旧版 main 不发送该状态。

- 后端事件以 `BackendEvent { event, payload, target }` 发给 main，由 main 按 Tauri target 规则扇出到 webview。
- `emit` 之后同步调用 Host 侧监听者（与 Rust `Listeners::emit` 一致，`src/manager/mod.rs:534-556`）。
- `listen` 等价 Rust `app.listen`（target 为 Any），收到该事件名的**全部**前端 `emit`/`emitTo` 与后端 emit，
  不论 target（`src/event/listener.rs:306-311`）。前端 `emit` 无载荷时为 `null`。后端自身 emit 时 `source` 为
  `{ window: '', webview: '' }`。
- `source.native === true` 表示该事件是 main 自己产生的原生回调（browser-content 的 `dstu-browser://page-finished`、
  `title-changed`、`navigation-blocked`），由消息级 `FrontendEvent.native` 决定；页面经 `plugin:event|emit` 发出的同名事件
  不带它，`source` 里自带的 `native` 会被丢弃。只信原生回调的监听者应检查 `source.native === true`（SEC-E05）。
  旧版 main 不发送该字段，此时所有事件都不带。
- `listenWindow` 等价 Rust `Window::listen`（`src/window/mod.rs:2353`）：订阅登记为
  `EventTarget::Window { label }`，投递按 Tauri target 规则（`match_any_or_filter`）判定，`source` 只是
  发出者、不参与接收范围。后端 `emit` 广播（target Any）会送达窗口监听者；`emitTo(Window{label})` /
  `emitTo(AnyLabel{label})` 只送达目标窗口；其他窗口的同名事件不会误投。`receive` 只收载荷，不收 `source`。
  返回的注销函数幂等，且监听随插件卸载自动撤销。
  L02 的 `McpFrontendBridge`（`listenWindow` + `emit`）可直接以 `ctx.backendEvents` 实现。
- 事件名只允许字母数字与 `- / : _`，否则抛 `TypeError`（文案同 Tauri `IllegalEventName`）。
- 载荷 `undefined` → `null`；debug 下非 plain JSON 载荷抛 `TypeError`；release 下发给前端的载荷按 §2.2 投影成普通
  JSON 并记 warn（`payload of event "…" is not plain JSON: …`）。`BigInt` 合法：发给前端的线上载荷
  转成 JSON number（D3），Host 侧监听者仍拿到内部原值（投影只作用于线上那一份）。
- 监听函数抛错会被记录日志，不影响其他监听者。

## 4. 自定义协议

```ts
ctx.protocols.register('pdfstream', async (req) => {
  const range = req.headers['range'];
  return { status: 206, headers: { 'content-type': 'application/pdf' }, body: readChunks(path, range) }; // AsyncIterable<Uint8Array>
});
```

- 一次性 `Uint8Array` 响应体 → 一条 `ProtocolResponse(final: true)`。
- `AsyncIterable<Uint8Array>` → 先发头 `ProtocolResponse(final: false, 空 body)`，每块一条 `ProtocolChunk(final: false)`，
  最后一条空的 `ProtocolChunk(final: true)`；迭代中途抛错时最后一块带 `error`（protocol.ts 增补字段），main 应中止响应流。
- 处理函数抛错 → 500，body 为错误消息（Rust 协议处理函数没有错误通道，这属于缺陷，kernel 只保证有响应并记日志）。
- 没有注册的 scheme → 404。同一 scheme 只能注册一次。Range 等语义由处理函数按 Rust 实现负责。

## 5. 外壳代办（`ctx.shell`）

```ts
const result = await ctx.shell.request<string>('dialog.open', { title: '选择文件' });
```

请求以 `ShellRequest { id, op, args }` 发给 main，按 id 配对 `ShellResponse`。默认超时 30 秒（Host 参数
`--shell-timeout=<ms>`）；超时或 `ok: false` 时以 `ShellError` reject。可用的 `op` 由 F2 定义。

WP-193 公共错误面（从 `host/kernel/api.ts` 导入 `ShellError` 与 `ShellErrorData`）：

```ts
interface ShellErrorData { code: string; message: string; details?: unknown }
// ShellResponse 失败支（protocol.ts）：
// { kind: 'shell-result'; id: string; ok: false; error: string; errorData?: ShellErrorData }
class ShellError extends Error {
  readonly op: string;
  readonly data?: ShellErrorData;
  constructor(op: string, message: string, data?: ShellErrorData);
}
```

`ShellError.message` 始终使用原 `error` 显示文本；`data` 原样保留 main 显式发送的 `errorData`。
无数据的字符串错误、超时和断连仍为原 ShellError，data 为 undefined；不从显示文本反解析 code，
不添加业务 kind。details 可缺省、为 null 或其他可经 MessagePort 传输的值，kernel 不作业务解释。
F2 WP194 负责发送，L19 WP195 负责恢复其领域 BridgeError；F5 冻结登记另包。

## 6. 服务

### 6.1 提供服务

服务 = Cordis `Service` 子类。名称就是 `ctx` 上的属性名；在 `declare module` 中增补类型。

```ts
// host/plugins/vfs/src/service.ts
import { Service, type Context } from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Context {
    vfs: VfsService;
  }
}

export class VfsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'vfs');          // 注册为 ctx.vfs，随插件卸载自动撤销
  }
  async getResource(id: string) { ... }
}

// manifest.ts
export default definePlugin({
  meta: { id: 'dstu.vfs', provides: ['vfs'], commands: [...] },
  apply(ctx) {
    const vfs = new VfsService(ctx);
    ctx.commands.register('vfs_get_resource', ({ id }) => vfs.getResource(id as string));
  },
});
```

- `meta.provides` 必须与实际提供的服务一致：声明了却没提供、或提供了却没声明，安装都会失败。
- 服务方法里的 `this.ctx` 是**调用方**的 context（Cordis 的 trace 机制），所以服务内部用 `this.ctx.effect(...)`
  登记的副作用归调用方插件所有、随调用方卸载撤销——kernel 的 `ctx.commands.register` 就是这样实现的。
  服务实例不要使用 `#private` 字段（会被 Cordis 的代理破坏），用 `_` 前缀。
- 跨插件的服务接口以 `contracts/services/` 为准（F5 / G 维护）。不兼容修改时换一个服务名（如 `vfs2`），
  让新旧版本可以并存，消费方显式迁移。

### 6.2 使用服务

```ts
export default definePlugin({
  meta: { id: 'dstu.notes', commands: [...] },
  inject: ['vfs', 'storage'],      // 这些服务全部就绪后才 apply；任一消失时插件被停下，回来后重新 apply
  apply(ctx) {
    ctx.commands.register('notes_list', () => ctx.vfs.list('notes'));
  },
});
```

- Cordis 4 中 `inject` 里的**每个**名字都是必需依赖（对象形式 `{ name: config }` 的值是传给该服务的 intercept 配置，
  `{ required: false }` 并不会让它变成可选）。可选依赖用 `ctx.get('name')`（返回 `undefined` 表示未提供）。
- kernel 服务（`commands`、`backendEvents`、`protocols`、`shell`、`app`）挂在根上，不需要 `inject`。
- 仍有插件 `inject` 某个服务时，不能单独卸载提供它的插件（`unload` 抛错）。

## 7. 生命周期

| 阶段 | 行为 |
|---|---|
| 安装 | `ctx.plugin()` 启动；`apply` 抛错 → Cordis 撤销其已产生的副作用，kernel 移除插件并抛出原错误。之后检查：依赖已就绪、`meta.provides` 一致 |
| 停止 | ① 插件的命令拒绝新调用（返回"未找到"）② 中止进行中调用的 `signal`（`CommandStoppedError`）③ 等待它们结束，最多 `COMMAND_CLOSE_TIMEOUT_MS`（2000 ms，`HostRuntimeOptions.commandCloseTimeoutMs`）；不理 abort 的调用记 warn 后 detached，结果照常回给调用方 ④ Cordis 撤销副作用（服务、监听、注册、`ctx.effect`） |
| 批量安装（`createTestHost`） | 全部启动并通过检查才算成功；任一失败按逆序停止本批已装插件，再抛原错误。profile 装载走 §8 的按插件隔离语义 |
| 退出 | 见下文「关停」 |

需要清理的资源用 `ctx.effect(() => { open(); return () => close(); })` 登记。长命令把 `CallContext.signal` 接进去，
否则卸载/退出时只会被 detached，不会真正停下。

### 关停（V09 P1-1/P1-2/P1-5）

| 阶段 | 位置 | 最长等待 |
|---|---|---|
| 广播 `host/exiting`（§3） | serve 收到 shutdown 消息 / SIGTERM 时以 `shutdown`；直接 `runtime.dispose()` 以 `dispose` | 同步 |
| A. 并行中止全部插件的在途命令 | `runtime.dispose()` | `COMMAND_CLOSE_TIMEOUT_MS` 2000 ms |
| B. 按安装逆序 dispose 插件 | `runtime.dispose()` | 每个插件 `PLUGIN_DISPOSE_TIMEOUT_MS` 1500 ms，整段 `DISPOSE_PHASE_BUDGET_MS` 3000 ms，其中最后 `CORE_DISPOSE_RESERVE_MS` 500 ms 只给 storage / paths / log 的提供方（其他插件用到段截止前 500 ms 为止）；超时记 warn、继续下一个（其清理在后台跑完）。diagnostics 的 `backgroundTasks.shutdown()` 先 abort 全部任务再最多等 1000 ms |
| 退出进程 | `main.ts::exitSoon` | 500 ms |

合计 ≤ 5500 ms；外壳的关停预算（`electron/shell/host.ts` `shutdown(timeoutMs)`）必须大于它。`main.ts` 收到 SIGTERM 后
6000 ms 仍未退出则 `process.exit(1)`。单个插件卸载（`runtime.unload`）同样受命令截止时间约束，但 fiber dispose 不设上限。

## 8. Profile

Host 加载哪些插件由 profile JSON 决定。启动时按以下顺序选择（`profile.ts::loadStartupProfile`）：

1. **显式 profile**（`--profile=<path>` 或 `ServeHostOptions.profile`）：原样加载；文件级错误 → `HostFatal`，进程以 1 退出。
   插件级失败仍按下面的隔离语义处理（测试 / headless 常只装业务插件，因此不要求平台核心服务）。
   握手中的 `profile` 字段是 Electron 外壳选择的启动候选：指向默认用户 profile 路径时按用户 profile 分支
   （文件级失败可回退）；指向官方 profile 时按显式 profile 加载并要求平台核心服务。
2. **用户 profile** `<app.dataDir>/plugins/user.profile.json`（存在时）：加载它（通常 `extends: "official"`）。
   **只有 profile 无效**（如读取、解析失败或官方模块导入失败）时才记录 error 日志、经 `backendEvents`
   发出 `host://plugin-profile-failed`（载荷 `{ profile: <用户 profile 绝对路径>, error: <失败原因> }`），
   然后加载官方 profile 继续启动。社区模块导入失败、缺服务或 `apply` 失败时，只降级对应插件及受影响的依赖者。
3. **官方 profile** `host/profiles/desktop.json`（`extends: "official"` 也解析到它）。

```json
{
  "extends": "official",
  "plugins": [
    { "id": "dstu.qbank", "module": "./plugins/my-qbank/index.ts", "config": { "pageSize": 50 } },
    { "id": "dstu.anki", "disabled": true }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `extends` | 可选，字符串或数组。`"official"` 表示官方 profile；其他值按本文件所在目录解析为路径。先按顺序展开基础 profile，再处理本文件条目；检测循环 |
| `plugins[].id` | 插件 id，必须等于模块默认导出的 `meta.id` |
| `plugins[].module` | 模块：`./`、`../` 相对声明它的 profile 文件；绝对路径；`file:` URL；或包名（只限官方 / 显式 profile）。用户 profile 及其 extends 的非 official 文件只接受前三种，`data:`、`node:`、`http:`、包名等说明符是 `ProfileError`，按文件无效回退到官方 profile（S01-r3 M1：这类模块不经社区清单检查就会被 `import()` 执行） |
| `plugins[].config` | 传给 `apply(ctx, config)`；插件有 `Config`（Schemastery）时先校验并补默认值（§16.3） |
| `plugins[].disabled` | `true` 时移除之前同 id 的条目（用户关闭官方插件） |

合并规则：条目按出现顺序排列；**后出现的同 id 条目替换先前条目**（保留先前条目的位置，即覆盖者在被覆盖者
原本的加载位置加载）。替换官方条目只对应用内模块有效：社区模块用官方 id（`dstu.*`）会以 `ID_RESERVED` 降级（§16.2），
被替换的官方插件也就不再装载。不认识的键报错。

加载过程（`profile.ts::loadProfile` → `prepareProfile` → `installProfile`）：

1. 解析 `extends` 链并按 id 合并（尚未安装任何插件）。
2. 社区条目（模块不在 `host/`、`electron/` 内）先读 `package.json#deepStudent` 并检查（§16.1），**导入前**拒绝的
   条目不执行任何代码，直接进降级列表（原因带错误码）。
3. 导入其余模块；任一导入失败或官方插件 `meta.id` 不符即报错（此时尚未安装任何插件）。社区插件再核对
   `meta.id` / `meta.version` / 服务名空间 / 权限；全部条目检查平台；社区插件服务名冲突、`requires` 不满足的
   条目降级（§16.1）。
4. 按 `inject` / `meta.provides` 稳定拓扑排序：本 profile 内提供服务的条目排在消费者之前，独立条目保持文件顺序。
   重复提供服务或依赖环是 profile 结构错误，在安装任何插件之前抛出。
5. 逐个安装（`HostRuntime.installIsolated`）：
   - `inject` 的服务在运行时不存在 → 该插件**不安装**，记为 inactive（原因 `missing service "X"`）；
     它声明的服务因此不可用，依赖这些服务的后续条目同样 inactive（级联，原因注明 inactive 的提供方）。
   - `apply` / 启动校验失败 → 只撤销该插件自身（含它在 apply 中注册的命令、事件、服务等副作用），
     其余条目继续；依赖它服务的条目级联 inactive。
6. 全部结束后把未安装条目（安装前拒绝的排在最前）交给 `HostRuntime.recordDegraded`：逐条 `ctx.logger('host').warn`，
   非空时 `backendEvents.emit('host://plugins-degraded', DegradedPlugin[])`；同一列表由内核命令
   `plugin:host|status` 返回（`DegradedPlugin = { id, reason }`）。

**致命（HostFatal）** 只有三类：内核自身错误、profile 文件无法解析（含导入失败 / id 不符 / 重复提供 / 依赖环）、
平台核心服务 `storage`/`paths`/`log` 不可用。官方 profile 与用户 profile 的启动分支要求核心服务
（`ProfileLoadOptions.requireCoreServices`），缺失时抛 `ProfileError('platform core services unavailable: …')`；
其他服务缺失只让依赖它的插件 inactive。

### 启动收尾与就绪闸门（D2）

`connection.ts::boot` 在 `loadStartupProfile` 返回后、发送 `HostReady` 前调用 `finishStartup`，顺序对齐 Rust
`lib.rs` setup：

1. 若 `dataSpace.status().recovery_required === true`：跳过业务 finalizer（Rust 在恢复预检后提前返回）；
2. 否则若 `storage.runStartupFinalizers` 存在：`await` 全部已注册 finalizer；
3. 若 `startupGate` 存在：`markStartupReady()`（恢复模式也执行，等价 Rust `StartupReadyGuard` 在
   setup 任意退出路径 drop）。F2 的 `dstu.shell` apply 只 `provide('startupGate')`，不在自身 apply
   提前 mark；组合根是唯一标记点。

任一步抛错都会让 boot 失败：发送 `HostFatal`、以 1 退出，不发送 `HostReady`，也不标记就绪。kernel 只按
服务名做结构化探测，不 import `host/platform/storage` 或 `electron/`。

失败输出边界：`HostFatal` 只携带 `message`/`stack`，所以 `finishStartup` 在抛错前把失败阶段
（`recovery probe` / `runStartupFinalizers` / `startupGate.markStartupReady`）以及 F3
`StartupFinalizerError` 的 `finalizer`/`completed`/`cause`（按结构化字段探测，不 import F3）写入 Host
日志（log 插件已装载时落盘到主日志，同时输出到 stderr，见 §10）。没有新增线上事件或协议字段。

重试边界：boot 不重试，finalizer 失败即 `HostFatal` + exit 1。F3 registry 的 `run()` 再次调用会跳过已
完成项，但当前生产没有显式调用方；业务插件不得 catch 后自行启动或定时等待来替代启动契约。

注册失败边界（政策待架构师裁定）：业务插件在 `apply` 中调用 `registerFinalizer` 抛错时，仍按既有
`installProfile` 隔离规则处理——只将该插件标为 degraded、广播 `host://plugins-degraded` 并由
`plugin:host|status` 返回，boot 可继续 ready 并 mark gate。若该插件本应提供必需的恢复/清理钩子，当前
会把“启动不完整”呈现为“可选插件降级”；必需钩子的声明/失败传播未定，F1 不擅自把全部 apply 错误改为
fatal。F3 当前也没有注销已注册 finalizer 的句柄，插件回滚前已成功的注册仍会执行（“部分注册泄漏”）。

F3 的 `registerFinalizer`/`runStartupFinalizers`/`finalizerNames` 已随main `d84e29565`集成（包含`9900d8dda`）。
F1组合根和日志也已集成。此前临时工作区的真实registry测试`7fdd36afe`，已仅按`cherry-pick -x`
带回F1责任分支为`5d451e443`（7个kernel测试/fixture文件），没有合入混合证据分支。
`connection.startup-real.test.ts`测真实F3 registry/F2 gate；旧`startup.plugin.ts`只覆盖组合根分支。

`node host/profiles/generate.ts` 生成 `desktop.json`：固定首条 kernel 自有入口 `../kernel/plugins.ts`
（`dstu.plugins`，对应 Rust 中常驻 Tauri state 的 `PluginManager`），随后按目录名排序收集
`host/platform/<name>/index.ts` 中默认导出 `definePlugin` 的平台插件（纯模块如 `time`/`util`/`net-policy` 跳过），
再收集 `host/` 之外的 F2 外壳插件 `electron/index.ts`（`dstu.shell`，提供 `startupGate` 并注册 23 个应用命令），
最后收集 `host/plugins/<name>/index.ts`。业务 lane 不手改 profile；平台服务插件已在清单内，安装顺序由 loader
的拓扑排序决定。`--check` 只比较磁盘内容，不一致时退出 1（供集成门禁检测漂移）。

W13 早期同步清理有一个显式 bootstrap 位置：扫描到唯一提供 `storageStartupSync` 的入口后，
生成器把它放在 kernel 首条之后、所有 platform 条目之前，并要求仅 `inject: ['paths']`。
L20 独立入口按交付合同固定为 `host/plugins/sync/startup.ts`；扫描到sync目录时额外导入此模块，
缺文件直接失败，不把晚期index当作早期provider。其余模块仍只发现各目录index，位置由provides判定。
这使既有稳定排序确定 `paths → sync bootstrap → storage`，不依赖目录名，也不增加平台到业务插件的 inject。
bootstrap 只提供回调；实际 reset 仍由 F3 在 purge 后、清 marker 前调用。导入失败 fatal；apply 失败仍隔离，
F3 在 purge 时缺 provider 必须走恢复状态、保留 marker、保持业务库关闭。D2 finalizer不能替代此边界。
L20 `d74ad476b` 已提供真实startup模块；F1候选已正常合入并由生成器生成38条清单，bootstrap位于第2条。
真实官方profile的purge启动已验证provider在storage前被消费；F3 `55884368c` 公共开库出口与L20
消费切换仍须进入最终联合源，不能将候选的私有导入留到main。五表事务/保upload_seq由L20原例验证。
`dstu.shell` 的模块顶层不得导入 Electron main 专有 API：Host 在 Electron `utilityProcess` 中加载它，
原生窗口/对话框能力一律经 `ctx.shell.request` 转给 main；生成器与 `importable.mjs electron/index.ts` 已验证
Node 原生类型擦除下可导入。

**为什么不用 `@deepseek-ai/cordis-plugin-loader`**：它在模块导入失败时只记日志并继续（`config/entry.ts:223-229`），
与"profile 文件无效即致命"冲突；它会对配置里的 `!!js` 表达式求值（`config/utils.ts`），不适合用户可编辑的 profile；条目以 loader
entry id 标识，按插件 `meta.id` 覆盖还得另加一层；其 HMR、配置回写等能力 Host 不需要。kernel 直接用 Cordis 核心的
`ctx.plugin()`，约 200 行（`profile.ts`）。

## 9. 测试

所有 lane 的测试都写在 `createTestHost` 上。它运行**真实的** kernel：同一套注册表、契约校验、Tauri 错误、事件、协议、
插件生命周期，只把 Electron main 换成内存记录。其他 lane 的服务用 `provide` 提供替身——**这是唯一允许放测试替身的地方**。

```ts
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import qbank from '../manifest.ts';

describe('qbank_get_paper', () => {
  it('returns the paper and rejects unknown ids like Rust', async () => {
    const host = await createTestHost({
      plugins: [qbank],                                   // 或 [[qbank, config]]
      provide: { storage: fakeStorage },                  // 其他 lane 的服务：对象或 Service 子类
    });
    try {
      await expect(host.invoke('qbank_get_paper', { paperId: 'p1' })).resolves.toMatchObject({ id: 'p1' });
      await expect(host.invoke('qbank_get_paper', { paperId: 'nope' })).rejects.toBe('试卷不存在: nope');
      await expect(host.invoke('qbank_get_paper', {})).rejects.toBe(
        'invalid args `paperId` for command `qbank_get_paper`: command qbank_get_paper missing required key paperId');
      expect(host.eventsNamed('qbank-paper-opened')).toEqual([{ paperId: 'p1' }]);
    } finally {
      await host.dispose();
    }
  });
});
```

`createTestHost(options)`：

| 选项 | 默认 | 说明 |
|---|---|---|
| `plugins` | `[]` | 按顺序安装；失败则回滚并让 `createTestHost` reject |
| `provide` | — | `{ 服务名: 实现 }`，在插件之前提供。实现为普通对象时直接 `ctx.provide`；为 `Service` 子类时作为插件启动 |
| `contracts` | 仓库 `contracts/ipc` | `LaneContract[]` 叠加在仓库契约之上；`{ only: [...] }` 只用给出的；`ContractSet` 原样使用 |
| `app` | `debug: true`，临时 `dataDir` | 覆盖 `AppInfo`；默认的临时目录在 `dispose()` 时删除 |
| `source` | `{ window: 'main', webview: 'main' }` | 默认调用窗口 |
| `shell` | 以错误回复 | `(op, args) => value` 回答 `ctx.shell.request` |
| `shellTimeoutMs` | 30000 | |
| `hostCallCaller` | 与生产相同（`DEFAULT_HOST_CALL_CALLER_MODE`） | `plugin:host\|call` 缺 `caller` 时 `'warn'` 或 `'require'`（§15.2） |

返回的 `TestHost`：

| 成员 | 说明 |
|---|---|
| `invoke(cmd, args?, source?, { exactJson? }?)` | 与前端 `invoke` 相同：resolve 成功值，reject 前端看到的值；panic 时 reject `HandlerPanic`（`.reply` 为前端实际收到的统一内部错误，`.cause` 为原异常）。V08-02：参数能无损写成 JSON 时默认像 Electron main 一样带 `argsJson: JSON.stringify(args)`，走生产解码路径；含字节、bigint、`undefined` 值、Date、Map、类实例、NaN 时走对象路径 |
| `invokeRaw(cmd, args?, source?)` | 同 `invoke`，总走对象路径（等价 `{ exactJson: false }`）；只给专门测旧路径或必须传非 JSON 参数的用例 |
| `startInvoke(...)` | 返回 `{ id, result, abandon(reason?) }`，用来测试 `signal`；参数路径规则同 `invoke` |
| `emitFrontend(event, payload?, source?)` | 模拟前端 `emit` |
| `emitNative(event, payload?, source?)` | 模拟 main 自己产生的原生回调（`FrontendEvent.native`）：监听者收到的 `source.native` 为 `true`（SEC-E05） |
| `window(ref, state)` | 模拟窗口生命周期（`host/window` 事件） |
| `events` / `eventsNamed(name)` | 发往前端的 `BackendEvent`（按顺序；可 `events.length = 0` 清空） |
| `shellRequests` | 发往 main 的 `ShellRequest` |
| `protocol(scheme, url, init?)` | 发起协议请求，返回 `{ status, headers, body, messages, error?, text() }` |
| `install(...)` / `unload(id)` | 运行中安装 / 卸载 |
| `coverage()` | §11 的覆盖报告 |
| `ctx` / `runtime` / `app` / `plugins` | 根 context、运行时、应用信息、已安装插件 |
| `dispose()` | 停止全部插件并删除临时目录。**每个测试都要调用**（放 `finally` 或 `afterEach`） |

命令错误守卫工具（§2.3.1）：`unsettledCommandErrors(host, plugins, options?)`、`minimalCommandArgs(contracts, name)`、
`commandErrorOutcome(invoke, timeoutMs?)`，同样从 `testing.ts` 导入。

契约还没生成、或要测 kernel 没覆盖的形状时，可以在测试里手写最小契约（格式见 `contract.ts`，示例
`host/kernel/__fixtures__/contracts/F1-fixture.json`），用 `contracts: [laneContract]` 叠加。手写契约必须描述
Rust 的真实形状，不得为了让测试通过而放宽。

## 10. Host 进程

`host/kernel/main.ts` 是 Host 入口，F2 以 `utilityProcess.fork('host/kernel/main.ts', ['--profile=<path>'])` 启动
（Node 24.22 原生剥离 `.ts` 类型，所以 kernel 与插件代码只能用可擦除的 TS 语法：不用 `enum`、参数属性、带值的 `namespace`）。

| 参数 | 说明 |
|---|---|
| `--profile=<path>` | profile；握手中的 `profile` 优先；都没有时加载 `host/profiles/desktop.json` |
| `--tauri-dir=<path>` | capabilities 与 app permissions 资源根，默认仓库 `src-tauri`；打包时须附带这两个目录 |
| `--contracts=<dir>` | 契约目录，默认仓库 `contracts/ipc` |
| `--shell-timeout=<ms>` | shell 请求超时 |

开发开关的环境变量映射成插件配置（`env-config.ts`，浅合并到 profile 中该插件的 `config` 之上，只用于文件 profile）：

| 环境变量 | 插件 | 配置键 |
|---|---|---|
| `DEEP_STUDENT_HPIAS_BACKEND` | `dstu.memory` | `hpiasBackend`（原样字符串；Rust 每次调用读环境变量，Host 进程启动时读一次，Electron 子进程继承 main 的环境） |
| `DEEP_STUDENT_WEBDAV_RATE_LIMIT` | `dstu.sync-providers` | `webdavRateLimit`（原样字符串；`webdav.rs:107-125` 的解析与回退由插件完成） |

运行时开关（不进插件配置）：`DS_HOST_CALL_CALLER=require` 让 `plugin:host|call` 必须带 `caller`，其他取值无效（只能收紧，§15.2）。

**编译缓存（`compile-cache.ts`，主代理 2026-11-07 决定保留）**：`main.ts` 的第一个 import 调 `module.enableCompileCache()`，
缓存在 `<os.tmpdir()>/node-compile-cache`（按文件内容哈希与 Node 版本失效），HostReady 5 s 后 `flushCompileCache()` 写盘；
`NODE_DISABLE_COMPILE_CACHE=1` 关闭，启用或写盘失败只在 stderr 留一行、按未缓存运行。W12 在 Electron 里的 A/B（中位数，
`host/e2e/smoke/W12-PROGRESS.md` 第五、六轮）：

| | 关 | 开 | 差 |
|---|---|---|---|
| 冷启动（缓存为空）fork→ready | 1.71 / 1.95 s | 2.23 / 2.19 s | 慢 0.2–0.5 s |
| 热启动 fork→ready | 1.44 / 1.53 s | 1.19 / 1.20 s | 快约 0.3 s |
| 冷启动空闲 Host RSS（JS 堆相同，heapUsed 78–79 MB） | 309 MB | 336 MB | +27 MB 原生内存 |

取舍：缓存为空的启动（首次安装、升级后首启、系统清理 `$TMPDIR` 之后——macOS 会删除 3 天未访问的临时文件）多付
0.2–0.5 s 和约 27 MB 原生内存，换来此后每次启动快约 0.3 s；日常启动以热启动为主，判定为值得。这 27 MB 在 JS 堆之外，
Node 的 `module` API 只有 `enableCompileCache` / `flushCompileCache` / `getCompileCacheDir`，没有在写盘后释放缓存数据的接口；
要去掉只能关闭缓存。未采纳的变体：缓存
放到应用数据目录（不被系统清理，但目录要等握手后才知道，届时内核静态模块已经加载，且要处理多版本共存与清理）、安装时
预生成（缓存与 Node / Electron 版本绑定，需要打包流程配合）——都留作以后的优化，归 W06 打包一并评估。

**HostReady 后收缩一次堆（只评估，未实现）**：W12 的堆诊断（`diagnostics/host-heap.spec.ts`）显示空闲时 heapTotal 151 MB、
heapUsed 79 MB，约 70 MB 已提交未使用；堆里最大的是保留的模块源码字符串（51 MB），这部分 GC 收不回。评估结论：暂不做。
- 收益上限未测：70 MB 是已提交未使用的堆页，一次完整 GC 能归还多少给操作系统取决于碎片；V8 的 memory reducer 在分配率
  降下来后也会自己做收缩 GC，空闲越久差距越小。打开聊天、笔记、设置后 Host 本就会回涨 35–45 MB（同一文档的“开应用后”行）。
- 成本：Node 只能经 `--expose-gc`（需要 W06 在 `utilityProcess.fork` 的 execArgv 里加，或运行时 `v8.setFlagsFromString`，
  Node 文档明确说启动后改 flag 的行为未定义）调用 `gc()`；约 80 MB 堆的 mark-compact 是一次几十到上百毫秒的主线程停顿，
  HostReady 之后正是渲染进程第一波 invoke 的时候，只能放到空闲后（例如与写盘同在 5 s 后）。
- 要推进，先让 W12 在堆诊断里加一个阶段：空闲 30 s 后经 CDP `HeapProfiler.collectGarbage` 强制 GC，再分别在 1 分钟后、
  打开应用后读 RSS。只有 RSS 降幅稳定在 40 MB 以上且打开应用后仍保留大部分时，才值得为它加 `--expose-gc`。

传输（`transports.ts`，都实现 `serve.ts` 的 `HostTransport`，以后的 WebSocket 实现同一接口）：

- Electron `process.parentPort`：main 发出的第一条消息若带端口（`child.postMessage({ kind: 'connect' }, [port])`）则之后全走该
  `MessagePortMain`；否则 parentPort 本身就是通道。第一条消息若本身是协议消息（不是 `connect`）照常投递。
- `child_process.fork(..., { serialization: 'advanced' })` 的 IPC 通道；`worker_threads` 的 `parentPort`。

协议流程（`protocol.ts`）：main 发 `Handshake` → Host 校验协议版本、填充 `ctx.app`、加载 profile → `HostReady`。
握手前收到的其他消息会缓冲到 ready 之后处理。启动失败 → `HostFatal { message, stack }` 并以 1 退出。之后：

| 消息 | 处理 |
|---|---|
| `invoke` | 派发命令，总是回 `InvokeResponse`（panic 时回统一内部错误，见 §2.3） |
| `abandon` | 中止对应调用的 `signal` |
| `frontend-event` | 交给 `backendEvents.listen` 监听者 |
| `window` | 派发 Cordis 事件 `host/window`（含增补状态 `page-load-started`，见 §3） |
| `protocol` | `ProtocolResponse` + `ProtocolChunk` |
| `shell-result` | 配对 `ctx.shell.request`（启动期间也立即处理） |
| `shutdown`（增补） | 有序退出后以 0 结束；连接断开、SIGTERM 同样处理 |

日志：插件用 Cordis 的 `ctx.logger(name)` 记录的日志有两个出口——

- **主日志文件**（落盘）：`dstu.platform.log` 装载时把 Cordis logger 桥接到 `ctx.log`
  （`host/platform/log/cordis-bridge.ts`），写入 `<appLogDir>/deep-student.log`，行格式
  `[YYYY-MM-DD][HH:MM:SS][LEVEL][dstu_host::<name>] …`，按主日志规则过滤（全局 Info，debug 不落盘）。
  log 插件装载前、仍在 Cordis 内存缓冲里的记录（该缓冲只保留 error / info）装载时补写一次。
  命令兜底（§2.3）的 error 日志以 `dstu_host::commands` 落盘。
- **stderr**（辅助）：`main.ts` 用 `log-export.ts::createStderrExporter` 输出 error / warn / info
  （`[dstu-host] <level> [<name>] …`）。Electron 以 `stdio: 'inherit'` 启动 Host，main **不收集** stderr，
  只在开发终端可见；打包后应以主日志文件为准。

## 11. 覆盖检查

```ts
import { checkCoverage } from '../kernel/coverage.ts';
const report = checkCoverage({ plugins: metas, contracts: ContractSet.fromDirectory(), registered });
```

| 字段 | 含义 |
|---|---|
| `unregistered` | 契约中有、但没有插件声明的命令（未迁移） |
| `unknown` | 插件声明了、但契约中没有的命令 |
| `duplicates` | 被多个插件声明的命令 |
| `declaredNotRegistered` | 声明了但运行时没有注册（需传 `registered`） |
| `registeredNotDeclared` | 注册了但不在所属插件 `meta.commands` 中（需传 `registered`） |

`HostRuntime#coverage()` / `TestHost#coverage()` 会自动填入运行时注册情况。

## 12. 已知差异与限制

- Host 入口读取 capabilities 与 app permissions，按平台、window / webview label 与 origin 校验应用命令，拒绝文案对齐 Tauri。F2 从 main 持有的 `WebFrameMain`/`WebContents` 读取真实 frame URL 设置 `WindowRef.origin`（`electron/main.ts:325-327`、`electron/shell/runtime.ts:240-253,298`），不信任 renderer 自报的 `headers.origin`；`browser-surface-host.test.ts` 已断言伪造 `headers.origin` 不污染 source。Tauri 插件命令及其资源 scope 由 F2 外壳执行校验。测试宿主通过 `acl: CapabilityAcl.fromDirectory(platform)` 启用真实 ACL；手写测试契约默认不启用应用 ACL。
- **serde 文案模拟覆盖常见形状**：基本类型、整数范围（含 128 位溢出）、浮点格式、`Option`、`Vec`、map、struct
  （缺字段、`deny_unknown_fields`、字段值错误按前端键顺序）、单元 enum。对 untagged / internally / adjacently tagged
  enum、`flatten`、元组、非零整数、以数组表示的 struct 等，校验仍由 ajv 按契约 schema 完成，但 detail 文案为 ajv 的
  描述（如 `must be string at /a`），**不是** serde 原文。`rustDebugString` 对 Rust `char::escape_debug` 的可打印字符
  判断按 Unicode 类别近似。
- **跨插件服务调用没有运行时 schema 校验**（f3958900 中 `PluginHost.call` 的 host-owned method contract）。
  服务是 Cordis 对象，直接方法调用；接口一致性依赖 `contracts/services/` 生成的类型与评审。
- **契约方言**：ajv 以 2020-12 + strict 模式编译，`x-*` 关键字注册为注解，`format` 不校验（Rust 侧格式语义见 `x-format`）。
  schema 按需编译；无法编译的契约让对应 invoke 以 `[dstu-host] contract …` reject。CI 可调用
  `ContractSet.fromDirectory().compileAll()` 提前列出全部无法编译的 schema。
- 单元 enum 的外部标签 map 形式（`{"Variant": null}`，契约标注 `x-also-accepts`）在输入反序列化时转为规范字符串，支持嵌套；结果 schema 仍只接受规范字符串。原始 `call.payload` 保留原值。
  契约生成器把 `__De` 单元 enum 写成 `oneOf: [字符串 enum, 每个变体一支 {"<Variant>": null}]`（`x-rust`/`x-also-accepts` 在外层），
  `serde.ts` 只认这个精确形状并按单个 enum 处理：map 形式同样转为规范字符串，错误为 serde 原文
  （``unknown variant `x`, expected one of …``、`invalid type: …, expected string or map`、`expected unit`、
  `map with a single key`）。`#[serde(other)]`（字符串分支无 enum）等其余形状仍走 ajv 文案。
- 测试宿主中 panic 以 `HandlerPanic` reject，生产中前端 Promise 以统一内部错误（`HandlerPanic.reply`）reject——
  这是刻意的差异，方便测试断言漏掉的错误映射。生产行为本身与 Tauri（panic 时永不 settle）不同，见 §2.3。

## 13. F1 续迁接口

### Capability领域解码（F1-DECODE-01，F2共享出口）

`host/kernel/api.ts` 增补 `decodeCapabilityFile(value: unknown, source?: string): Capability[]`，
`CapabilityDecodeError` 与类型 `Capability/CapabilityPermission/CapabilityPlatform`。
Host `CapabilityAcl.fromDirectory` 已消费同一实现；F2 `electron/shell/capabilities.ts` 应调用此出口后再做插件scope语义。

- 支持单对象、数组、`{ capabilities: [...] }`；出现capabilities键即选择NamedList，不因非法值回退单对象。
- 输出补齐Rust默认：description=""、local=true、windows/webviews=[]、remote/platforms=null；permissions/identifier必填。
  Vec显式null拒绝，Option null接受，unknown字段忽略；按输入字段顺序检查已出现值，再报缺字段。
- permissions为字符串或`{ identifier, allow: unknown[]|null, deny: unknown[]|null }`。
  Scopes是`Option<Vec<Value>>`，保留任意JSON元素；不擅自收窄成字符串记录、丢弃scope或解释F2插件规则。
  flatten先解码identifier，再处理buffer中的allow/deny。Identifier按实际Rust规则保留uppercase/core前缀行为。
- Target接受规范字符串或`{"linux":null}`等单元enum map形式；规范化后才用于platform过滤。
  remote.urls仍只是原字符串，origin匹配规则不变。scope/domain解码不为远程页面新增权限。
- 错误有`file/path/detail`（path是JSON Pointer）；值级出口不伪造原文行列。
- 原文出口 `parseCapabilityFile(text, source?): Capability<JsonNode>[]` 由 ACL 文件入口消费；顶层 map
  先读完整 Value 再执行领域解码，顶层 list 流式读取 typed Capability，字段/重复错误优先于后续语法错误。
  opaque scope 保持 F4 JsonNode，F2 不应把节点直接当作普通对象范围值；值级出口继续接受已解析的 JS 值。
  2026-11-05 main 已包含F4 IgnoredAny、positional endArray、arbitrary_precision Value；原文出口
  直接消费公共原语，capability-text的6条原断言已在Node/Electron通过（见LANE作业证据）。

### 通用值级诊断的限制（C04-01）

正式出口均为 `host/kernel/api.ts`：`serdeCheck(schema, value, base, resolver)`、
`normalizeUnitEnums(schema, value, base, resolver)`、`rustDebugString(value)`、`unexpectedOf(value)`；
类型 `SerdeCheck`、`SchemaRefResolver`、`JsonSchema` 同处导出。沿用已有IPC生产实现，不复制算法。

- `SerdeCheck` 为 `{ ok: true } | { ok: false, detail: string } | { ok: 'unknown' }`。
  **unknown不是通过**。这是部分值级诊断，不是覆盖全部JSON Schema约束的验证器；所有者仍须自己的结构解码/完整校验。
- 不支持的untagged/tagged/flatten/tuple等形状可能返回unknown；不得把AJV fallback文案说成serde原文。
- 输入已经是解析后的值：**没有原始JSON字符串的行列信息**，也无法还原重复键或曾经舍入的数字token。
  不能由重新JSON.stringify的位置推测Rust from_str错误位置。F1当前没有通用schema+原文位置解码API。
- 本lane `ilink-decode.ts` 是四个iLink结构及sendmessage Value的专用解码器，不是ConversationSnapshot/ChatSession的通用解析面。
  L04自身字段/default/Option/省略/u64精度、快照导入顺序仍归L04；其from_str原文位置需求保持未解决，不以此出口宣称C04-01闭合。
- `unexpectedOf` 是serde_json::Value层的诊断（含内部BigInt的数字显示为`number`），不是原始token层的
  integer/f64诊断。F2等消费方只经api.ts导入；F4 JsonReader的词法层保持独立来源。

F1-DECODE-02：ContractSet文件加载先验证envelope/commands/args及所有消费到的schema结构。
schema结构复用Ajv内置2020-12 meta-schema（保留x-*注解与boolean schema），不手写另一套schema语法。
编译/跨文件$ref解析仍按原来的lazy路径；坏文件报ContractError并含文件路径、JSON Pointer，不泄漏数组迭代TypeError。

- `node host/profiles/generate.ts` 生成官方 profile；各 lane 不手改。当前候选生成38条（含`dstu.vector`与独立`dstu.sync-startup`）：`dstu.plugins` 固定首条，
  随后是 `host/platform/<name>/index.ts` 中默认导出插件的平台服务（跳过纯模块），然后是 `electron/index.ts`
  的 `dstu.shell`（提供 `startupGate`、注册 23 个 F2 命令），最后按目录名排序收集 `host/plugins/<name>/index.ts`。
  生成前逐个导入入口，任一入口在 Node 原生类型擦除下不可加载即失败；`--check` 与磁盘不一致时退出 1。
- `GLOBAL_SHORTCUT_TRIGGERED` = `global-shortcut://triggered`。F2 发 FrontendEvent，L17 用 `ctx.backendEvents.listen(GLOBAL_SHORTCUT_TRIGGERED, (payload, source) => …)` 接收原载荷。
- `Disposer` / `Scope` / `HookSet` / `Slot` / `HookKernel` / `ScopedPluginHost` 从 `api.ts` 导出；对应 dstu-kernel。Drop 需显式 `dispose()` 或 `using`。`ScopedPluginHost.applyAll` 失败时保留先前成功条目（Rust 语义），与 profile 装载的按插件隔离（见 §8）语义一致。
- 前端 serde 文案审读：`src/features/template-management/lib/templateLibrary.ts:137-144` 分类 `missing field / invalid type / unknown field / duplicate field / invalid value`，消费模板文件导入的错误；未发现依赖 tagged/untagged/flatten/tuple/NonZero IPC 参数 detail 的分支，故不扩大其错误模拟范围。模板导入文件错误须由所属 lane 保持 Rust 原文。
- `dstu-agent-api` 契约层已完整导出：`DescriptorTable`、`ToolExecutor`/`ToolExecutorBase`、`ExecutionContext`（`CallIds`/`ExecutionFlags`/`RequestExt`）、`HostRequest` 与 `HostBridge`/`AppEventEmitter`/`RuntimeRootResolver`/`ToolBlockStore`/`AdmittedToolDispatcher` 五个宿主端口、`ProviderId`/`isCatchAllProvider`/`headlessSchemas`。Rust trait 默认值由基类与 `executorSensitivity*`/`executorConcurrencyClass`/`executorManagesCancellation`/`executorResultCharBudget` 提供；`resultCharBudget` 的 `null` 保留“关闭外层预算”的 `Option::None` 语义。
- `ToolRegistryBuilder` 的空名称/alias判断使用F4的Rust trim（含U+0085、不去U+FEFF），通过检查后仍保存原名称，不做名字归一化。
  iLink客户端同样只用Rust trim判断baseUrl是否为空；非空时仍仅删除尾随`/`，不擅自裁剪URL里的其他空白。
- `agent-wiring.ts` 迁移 `services.rs::build_pipeline_services` 与 `roster.rs::missing_descriptor_tools`/`verify_roster_coverage`。
  `agent-roster.ts` 保留 F1 负责的显式顺序：`APP_EXECUTOR_ROSTER`（63）、`WORKSPACE_COORDINATOR_GROUP`（5）与
  `PIPELINE_EXECUTOR_TAIL`（3），`composeAppExecutorRoster` / `composePipelineExecutorRoster` 按 Rust 顺序从
  同名实例目录取用；缺条目一次性列出并抛错，不补占位 executor。上述常量、组合函数与类型均从 `api.ts` 导出。
  各领域执行器实例仍待对应 lane 发布，故 TESTMAP 中依赖真实执行器的用例保持 pending。
- `extensions.ts` 迁移 `src/extensions.rs` 组合根：13 个条目的固定 apply 顺序、按名字幂等、失败保留此前成功条目、
  失败后下一次调用重试、未发布的 installer 通过 `missing` 明确上报。`EXTENSION_PLUGIN_ORDER`、`ExtensionRegistry`、
  `registerExtensions`/`disposeGlobalExtensions` 与相关类型从 `api.ts` 导出，供外壳或组合根注入各 lane 的 installer。
  具体 installer 由各 lane 提供；`remote` 槽位被占用仍视为成功（installer 捕获取 `SlotOccupied`）。
  `plugins.rs` 的 Canvas 读取与 Insight 被动提示属于 L10/L17 领域逻辑，本 lane 只保留“注册到槽位”的接线位，不复制其算法。
- `qr.ts` 按 Rust `qrcode` 0.13 的默认行为逐项移植：`bits.rs::encode_auto`（最小版本、ECC M、
  `optimize.rs` 最优分段）、`ec.rs` 分块 Reed-Solomon 与交织、`canvas.rs::apply_best_mask`（8 个掩码
  按 crate 的 penalty 规则取最小，平局保留首个），并按 `render/mod.rs::min_dimensions` 的 ceil 规则生成
  ≥256px 灰度 PNG。`host/kernel/tests/plugins.test.ts` 用 crate 自带的 ISO Annex I 向量
  （`QrCode::with_version(b"01234567", Version::Normal(1), EcLevel::M)`）逐模块比对；该向量实际选择
  mask 2（格式信息 `0x5e7c`），因此同时验证分段、ECC、格式信息与掩码选择，而不是固定掩码近似。

## 14. 插件子系统（`src/plugins`）

v2 接手后的数据边界：`PluginJsonValue` 允许内部 BigInt，`IlinkInteger = number | bigint`。
HTTP i64/u64 与 settings usize 保持精确值，只在 IPC 输出由 kernel 转 JSON number。
`ilink-decode.ts` 按 Rust struct 解码 missing/null/default/重复字段与整数 token，不用 JSON.parse 类型断言。
登录期限使用 performance.now（`IlinkBotOptions.monotonicNow`），事件时间仍用 UTC Date.now（`now`）。
远程任务桥尚缺真实 L04 task_command/L06 headless 组合；start/enable/扫码后自动启动不可因命令注册而算整链完成，
见 `host/kernel/BLOCKERS.md` F1-V2-04。

- `plugins.ts` 是 `dstu.plugins` Cordis 插件：`inject: ['settings']`，提供 `ctx.plugins`（`PluginManager`），并在
  `meta.commands` 中声明 11 个 `plugin_*` 命令。11 个命令逐字注册；`plugin_unbind` 与 `plugin_logout` 都调用
  `PluginManager.logout`（`commands.rs:87-90`）。
- 自启动（V04-12）：apply 时向 `storage` 注册启动 finalizer `dstu.plugins.bootstrap-enabled`，finalizer 里排
  `PLUGIN_BOOTSTRAP_DELAY_MS`（3000 ms）定时器再 `bootstrapEnabled()`，对应 Rust `lib.rs:1356-1368` setup 末尾的
  `sleep(3s)`。恢复模式下组合根不跑 finalizer（§8「启动收尾」），所以不自启动，等价 Rust 恢复模式提前 return、不注册
  PluginManager。没有 storage finalizer 的宿主（TestHost）记一条 warn、不自启动；插件卸载会取消未到期的定时器。
- `plugin_manager.ts` 对齐 `manager.rs`：state/errors/handles 三张表、`lifecycle` 串行锁、run generation 隔离、
  `plugin.<id 去掉 - >.enabled` 键、iLink 特例 `plugin.ilinkbot.enabled`、`unsupported plugin`、`未知插件: {id}`、
  bootstrap 对显式 `false/0` 的尊重与缺失值的迁移。
- `ilink-bot.ts` 对齐 `ilink_bot/{client,guard,mod}.rs`：凭证安全存储（`plugin.ilinkbot.credentials`）、公开配置、
  QR 登录（480s 总超时、3 次过期刷新）、轮询退避（2s/30s）、`-14` 清凭证并切 `waiting_login`、非绑定用户与
  滑动窗口限流（60s）。二维码 PNG 用 `qr.ts` 的纯 TS 编码器（Rust `qrcode` 0.13 等价的最优分段、ECC M、
  penalty 最佳掩码，无原生依赖，输出 256px 级灰度 PNG）。
- **跨 lane 依赖**：消息分发需要 L06 的 `chat_v2::task_command` + headless turn。Host 侧通过
  `RemoteTaskBridge` 接口注入（`isControlMessage` / `dispatch` / `cancelSession`）；未注入时轮询仍工作，收到消息记录
  `remote task bridge is not installed` 并发送 `plugin-activity` warn，不伪造任务结果。
- **profile**：官方 profile 由 `host/profiles/generate.ts` 生成：固定首条 `../kernel/plugins.ts`（`dstu.plugins`），
  再收集平台服务插件、`electron/index.ts` 的 `dstu.shell` 与业务插件（各 lane 不手改）。平台插件与 shell 已在清单内；
  个别插件缺服务时只让自身与下游 inactive（见 §8），不再整批回滚。
- **agent_wiring 阻塞**：`agent_wiring/tests/{descriptor,headless,hooks,legacy,parallel,roster,custom_agent}_tests.rs`
  的 38 个用例中，2 个只依赖注册表构建器的用例已移植（`agent-wiring-providers.test.ts`），其余 36 个依赖
  `chat_v2::tools::{ToolExecutorRegistry,BUILTIN_DESCRIPTORS}`、`task_command`、approval manager
  与 L03/L05/L06/L07/L24 的 executor 实现；这些尚未迁移到 Host。未用占位 executor 冒充移植，TESTMAP 保持 pending。
  `command_surface_tests` 的 1 个用例已按同样的四个命令面移植到
  `host/kernel/tests/agent-wiring-command-surface.test.ts`。

## 15. 前端插件桥（`docs/plugins/FRONTEND.md` §3、§5）

插件可以同时带 UI 半：`meta.ui` 是 UI 模块路径，相对**插件模块文件**；`meta.remote` 声明 UI 可调用的服务方法；
`meta.version` 进入清单（用户插件通常来自自己的 `package.json`）。

```ts
export default definePlugin({
  meta: {
    id: 'example.word-of-day',
    provides: ['exampleWordOfDay'],
    ui: './ui.js',
    version: '1.2.3',
    remote: { exampleWordOfDay: ['today', 'history'] },
  },
  apply(ctx) { ctx.provide('exampleWordOfDay', new WordOfDay(ctx)); },
});
```

### 15.1 UI 引导清单

- 命令 `plugin:ui|manifest`：返回 `UiManifestEntry[] = { id, file, version? }`，`file` 是 UI 模块的绝对路径
  （`meta.ui` 相对插件模块解析）。内核自有命令，不在 `contracts/ipc`，不受 ACL 权限表约束，只对主窗口的本地页面开放（§15.2 末条）。
- 只列**用户/社区插件**：插件模块位于 `host/` 内（官方插件，UI 半已打包进前端）时不进清单。
- 清单变化时经 `ctx.backendEvents.emit('host://ui-manifest', manifest)` 广播：
  插件安装（`install`/`installAll` 成功）、卸载（`unload`）、profile 装载完成（启动、回退到官方 profile）。
  事件只在序列化后的清单与上次不同时发送；初始空清单不发事件（前端默认只加载官方 UI）。
- 插件模块是无法解析为文件的包名且声明了 `meta.ui` 时，记录 warn 并跳过该条目（清单必须有绝对路径）。
- **UI 文件必须在插件包内（SEC-E12）**：`meta.ui`（相对路径或绝对路径）解析后必须严格位于插件包根目录之内，即 profile
  筛查时找到的 `package.json` 所在目录（`PluginInstall.packageRoot`）；直接 `install` 且没有包根时以模块所在目录为界。
  比较前经 URL 规范化消去 `.` / `..`，按路径组件比较，Windows 不区分大小写（`module-origin.ts::fileUrlWithin`）。越界时
  v1 清单不收录、v2 条目不带 `file`，并记 warn `meta.ui "<ui>" of plugin "<id>" resolves outside its package <root>; its UI half is not listed`。
  原因：外壳 `ds-plugin://` 以 UI 文件所在目录为服务根，`meta.ui: '../../../ui.js'` 会让上层目录整个可读。

### 15.2 `plugin:host|call`

参数：`{ caller?: string, service: string, method: string, args: unknown[] }`（`caller` 在 `'require'` 模式下必填，见下）。

- 放行条件：某个**已装载且确实提供该服务**的插件，其 `meta.remote[service]` 包含 `method`。
  未提供的服务 → `Validation` `unknown service "<service>"`；未列出的方法 →
  `Validation` `service "<service>" does not expose "<method>" to UI (declare it in meta.remote)`。
- **调用方绑定（SEC-E06 Host 半，决策 7“跨半调用只走 `meta.remote`”）**：`caller` 是发起调用的 UI 半的插件 id，
  由 UI 内核按调用方插件的作用域填写（沙箱化之后由 broker 按端口绑定的插件 id 填写，见
  `src/ui-kernel/SEC-E06-SANDBOX-DESIGN.md`）。给出时，服务必须由 `caller` 这个插件自己提供，且只看它自己的
  `meta.remote`；否则 `Validation` `plugin "<caller>" cannot call service "<service>" of "<owner>": a UI half may only call its own Host half`
  （`caller` 不是已装载插件时同样如此）。`caller` 存在但不是非空字符串 → `Validation`
  `plugin:host|call requires "caller" to be a non-empty string when given`。
  **缺 `caller` 时**由 `HostRuntimeOptions.hostCallCaller`（`HostCallCallerMode`）决定：
  - `'require'`（默认 `DEFAULT_HOST_CALL_CALLER_MODE`）：在查找服务之前以 `Validation`
    `plugin:host|call requires "caller", the plugin id of the calling UI half (SEC-E06)` 拒绝。
  - `'warn'`（只能显式传入）：按上一条放行；按服务计数（`HostRuntime.hostCallsWithoutCaller()`，
    只计已有服务），每个服务首次出现时记一次 warn（`… carries no "caller" plugin id … (SEC-E06)`）。
  - 桌面入口（`main.ts`）读环境变量 `DS_HOST_CALL_CALLER`：只有取值 `require` 生效，其余取值与未设置都用默认值，所以只能收紧
    （`env-config.ts::hostCallCallerMode`）。`serveHost` / `serveHostCore` 与 `createTestHost` 都接受同名选项。
  - 默认值已切到 `'require'`（K2）：UI 内核（`src/ui-kernel/kernel.ts` 的 `ctx.ui.host`）与移动端诊断页（`mobile/src/main.ts`
    的 `hostCall`，`caller: 'dstu.mobile.diagnostics'`）都带 `caller`。外壳自己发的调用也要带调用方插件 id
    （`electron/shell/background-residency.ts` 查 `agentAutomation.backgroundResidency` 应带 `caller: 'dstu.agent-orchestration'`；
    不带时被拒，外壳退回逐条读设置）。
  W17 设计中的“或已授权”（调用方声明了 `service:<服务名>` 且用户同意过）要等同意记录落地，目前只放行自有服务。
  **在社区 UI 半移进 sandbox iframe 之前，`caller` 只是自报身份**：主窗口主世界里的任何代码都能填任意 id，
  所以这一条现在只防误用（误调别的插件），不防恶意。
- 调用：`serviceObj[method](...args, { signal })`；`signal` 随调用方 abandon 中止（与命令一致）。
- 参数与返回值必须是纯 JSON（`findNonJson`）；`BigInt` 在 Host 桥的线上边界转成 JSON number（D3）。
  参数不合法 → `Validation` `invalid arguments for plugin:host|call: …`；
  返回值不合法 → 记 error 日志并以 `Unknown` 拒绝（`… returned a value that is not plain JSON: …`）。
- 错误：方法抛 `CommandError`（或裸 `AppError`）→ 按其值 reject；其他异常 → 与命令一致：带栈记日志，
  前端 reject `{ error_type: 'Unknown', message, details: null }`（§2.3）。
- 该通道不是 Rust 命令。三条 kernel 命令（`plugin:ui|manifest`、`plugin:host|call`、`plugin:host|status`）只对
  `KERNEL_COMMAND_WINDOWS`（`commands.ts`，目前只有 `main`）中的 window **且** webview 上的本地页面开放（SEC-E11）：
  社区 UI 半与插件状态同步只在主窗口启动，quick-assistant、pomodoro-mini 等其他窗口、remote 页面一律
  `Command … not allowed by ACL`（与 ACL 拒绝同一文案）。移动端外壳的 label 默认也是 `main`。
  不参与命令覆盖检查（`HostRuntime.coverage()` 过滤内核命令）。

## 16. 插件生态 v1（`decisions/2026-11-07-plugin-ecosystem-v1.md` P0 · kernel 半）

### 16.1 社区插件清单装载

契约：`contracts/plugin-manifest/v1.schema.json`（W09 gate `gate-checks/plugin-manifest.mjs` 用同一份）。kernel 实现在
`manifest.ts`（可移植），装载接线在 `profile.ts::prepareProfile`。**社区条目** = 模块文件不在应用内（`host/`、`electron/`）
的 profile 条目（`module-origin.ts`）；模块文件不存在时不筛查，交给导入阶段按 profile 文件错误处理。

社区条目在导入前按以下顺序检查，第一处失败即拒绝（`checkManifest`）：

1. 自模块文件向上找到的 `package.json` 有 `deepStudent` → 否则 `MANIFEST_MISSING`；
2. `manifestVersion` 是本应用支持的版本（1）→ 更高的整数 `MANIFEST_VERSION_UNSUPPORTED`（提示升级应用）；
3. **先查 `engines.deepStudent`**（npm range 的严格子集：`^X.Y[.Z]`、`~X.Y[.Z]`、`X.Y.Z`、`>=X.Y.Z[ <A.B.C]`）→ 缺失 / 无法解析
   `MANIFEST_INVALID`，不满足 `ENGINE_INCOMPATIBLE`。新版本清单的其他字段可能不认识，所以 engines 在全量校验之前；
   **预发布版本号按 npm semver 7 的 `includePrerelease` 判断**（见下文“预发布版本”）；
4. `permissions[].kind` 只认 `service` → 其他 `PERMISSION_UNKNOWN_KIND`；
5. 全量 schema 校验，外加 `requires` 不得指向自己、range 不得为空 → `MANIFEST_INVALID`；
6. id 的保留 publisher（§16.2）→ `ID_RESERVED`；profile 条目 id ≠ 清单 id → `ID_MISMATCH`；
7. 当前平台不在 `platforms` → `UNSUPPORTED_ON_PLATFORM`；
8. `deepStudent.host` 存在且解析到的文件就是 profile 的模块 → 否则 `HOST_ENTRY_MISMATCH`。

导入后（`checkPluginModule`）：`meta.id` 等于清单 id（`ID_MISMATCH`）、`meta.version` 等于 `package.json#version`
（`VERSION_MISMATCH`）、`meta.provides` 在自己的服务名空间内（`SERVICE_NAME_INVALID`）、没有 `meta.commands` 且不注入
kernel 专有服务（§16.7 第 2 项，`KERNEL_API_FORBIDDEN`）、`inject` ⊆ 声明的权限（§16.4，`PERMISSION_UNDECLARED`）。然后：社区插件提供的服务与其他条目冲突 → `SERVICE_CONFLICT`（只降级社区插件；官方之间的
冲突仍是 profile 结构错误）；`requires` 按本次装载中的版本（社区取 `package.json#version`，官方取 `meta.version`，缺省为
应用版本）反复检查到不动点 → `REQUIRES_MISSING` / `REQUIRES_INCOMPATIBLE`。`requires` 只在安装前检查：被依赖的插件
`apply` 失败不会经 `requires` 级联（经 `inject` 的服务缺失仍按 §8 级联）。

**预发布版本**（`satisfies(version, range, { includePrerelease })`，默认开启）：`engines.deepStudent` 与 `requires` 都按
npm semver 7 的 `includePrerelease` 语义求值，与 `require('semver').satisfies(v, r, { includePrerelease: true })` 逐条一致
（`tests/plugin-manifest-contract.test.ts` 的真值表取自 semver 7.8.6）。`requires` 一并采用，是因为官方插件的版本就是应用
版本，beta 构建上二者必须同一口径。预发布版本低于同号正式版（`0.12.0-beta.1` < `0.12.0`），范围的展开规则：

| 范围 | 下界 | 上界 | `0.12.0-beta.1` |
|---|---|---|---|
| `^0.12`、`~0.12`（省略补丁号） | `>=0.12.0-0`，含 `0.12.0` 的预发布 | `<0.13.0-0` | 满足 |
| `^0.12.0`、`~0.12.0`、`>=0.12.0` | `>=0.12.0`，不含 | `<0.13.0-0` / 无 | 不满足（要求正式版） |
| `^0.11`、`^0.11.0` | — | `<0.12.0-0`，不含 `0.12.0` 的预发布 | 不满足 |
| `>=0.11.0 <0.12.0`（显式上界） | — | `<0.12.0`，含 `0.12.0` 的预发布 | 满足 |
| `0.12.0`（精确） | — | — | 不满足 |

所以 beta 构建只装载声明了接纳它的范围的社区插件；面向下一版 beta 的插件应写省略补丁号的 `^X.Y`。正式版应用的判定
不受影响（非预发布版本两种语义相同）。W09 gate（`gate-checks/plugin-manifest.mjs`）的 `satisfies` 默认仍按 npm 语义
（预发布不满足任何范围），kernel 一致性测试以 `includePrerelease: false` 与其两参调用比对；gate 对应用版本的 engines
检查开启 `includePrerelease`，与 kernel 同口径（W09 `4fb94483`，在 `assault/W09-frontend-contracts` 上，随 W09 进 INT）。

**启动时不兼容只降级该插件**：被拒绝的条目进 `DegradedPlugin[]`（`plugin:host|status`、`host://plugins-degraded`、
UI 清单 v2 的 `degraded`），`reason` 为 `"<CODE>: <detail>"`。IPC 契约中 `DegradedPlugin` 只有 `{ id, reason }`，
所以错误码编码在 `reason` 前缀里（沿用既有的 `UNSUPPORTED_ON_PLATFORM: ` 写法）；前端用
`plugin-load-error.ts` 的 `parseDegradedReason(reason) → { code?, detail }` 与 `PLUGIN_LOAD_CODES` 解析（该文件无依赖，
UI 可直接导入）。插件配置错误（§16.3）在 `apply` 前抛出，同样以 `CONFIG_INVALID: ` / `CONFIG_CREDENTIAL: ` 开头。

**安装期拒绝**的接口已留好：`assertInstallable(pkg, { appVersion, platform, installed })` 以 `community-install`
场合跑同一套检查（外加 `requires` 对已安装插件），失败抛 `PluginLoadError`（`code`、`pluginId`、`detail`）。安装器
（P1）直接调用它，拒绝原因与启动降级用同一套错误码。

**官方插件**（`dstu.*`，模块在应用内）不读 `package.json`，不在启动时做清单校验：它们与应用同版本发布、profile 由
生成器产出、启动路径不应为每个内置插件读文件，移动端也没有文件系统。一致性由测试与 gate 保证——
`tests/plugin-manifest-contract.test.ts`（官方 profile 的 id 合法且为 `dstu.*`、kernel 的 range / schema 实现与 W09 gate
逐条一致）、W09 gate（官方包的 `package.json#deepStudent`）与 `host/profiles/platforms.test.ts`。运行时只按官方插件的
`meta.platforms` 过滤平台。

### 16.2 插件 id 与派生命名空间

id 语法与保留 publisher 取自契约 `$defs/id`、`$defs/reservedPublishers`（`plugin-id.ts` 直接导入 schema JSON）：

- `forbidden`（`ds`、`deepstudent`、`deep-student`、`official`、`builtin`、`system`、`community`）：任何插件都不得使用；
- `dstu`：只有应用内置模块可用，社区来源一律 `ID_RESERVED`（防止冒充官方插件）；
- `local` / `test`：启动时允许（本地开发、测试夹具从用户 profile 装载），**安装期**拒绝；
- `example`：允许（示例插件就是给开发者装来看的）。

由 id 派生的名字（`pluginNamespaces(id)`，前端与 Host 共用）：

| 用途 | 规则 | `example.word-of-day` |
|---|---|---|
| 主服务名 `service` | 各段按 `.`/`-` 切词拼成 lowerCamelCase；`meta.provides` 必须等于它或以它为前缀再接大写开头的后缀 | `exampleWordOfDay`（`exampleWordOfDayCache` 也属于它） |
| 存储键前缀 | `ds:plugin:<id>:` | `ds:plugin:example.word-of-day:` |
| 数据目录 | `<数据目录>/plugins/<id>`（`dataDirSegments`，由调用方用平台路径服务拼接） | `plugins/example.word-of-day` |
| i18n / 设置命名空间 | id 本身 | `example.word-of-day` |
| 自定义事件名 | id 的 `.` 换成 `/`，再接 `:<event>`（`pluginEventName`；前缀 `eventPrefix`）。事件名规则（字母数字与 `- / : _`，Tauri `is_event_name_valid`）前端外壳与 `backendEvents` 共用，在可移植的 `event-name.ts::isEventNameValid`；id 不含 `/`，所以派生名与 id 一一对应；`event` 不合法时 `pluginEventName` 直接抛错。社区插件的 Host 半目前拿不到 `backendEvents`（内核专有服务），还发不出这类事件 | `example/word-of-day:refreshed` |
| 槽位贡献 id | `<id>/<localId>`，`localId` 不含 `/`（`pluginSlotId`） | `example.word-of-day/sidebar` |

**现有官方插件的兼容策略**：官方插件保持现有的服务名（`storage`、`notes` 等）、存储键、数据目录与事件名，不改成派生
名字——这些名字已经落在用户数据、同步载荷、备份与前端代码里，改名需要数据迁移且对用户无收益。派生规则只约束社区
插件（启动时强制服务名空间）与新写的插件；官方插件之间的服务名冲突仍是 profile 结构错误。

### 16.3 插件配置（`Config`）

`HostPlugin.Config` 是 Schemastery schema（`api.ts` 导出 `Schema`）。`runtime.start` 在 `ctx.plugin` 之前调用
`plugin-config.ts::resolvePluginConfig`：

- 没有 `Config` → 配置原样传入；
- `Config` 不是 Schemastery（没有 `~standard`）→ `CONFIG_INVALID`；
- schema 中有凭据字段（`role: 'secret'`，或键名为 `apiKey`/`token`/`password`/`secret`/`privateKey`/`credentials` 等）
  → `CONFIG_CREDENTIAL`：**凭据不进配置**（profile 是用户可编辑的明文 JSON），走安全存储服务；
- 校验失败 → `CONFIG_INVALID: invalid config: <Schemastery 消息>`；成功时补齐默认值后的值传给 `apply`，并记在已安装条目上。

失败只让该插件 `apply` 前失败（按 §8 隔离降级），不影响其他插件。Cordis 自身也会校验：`ctx.plugin(plugin, config)` 的
`Fiber._reload` → `resolveConfig` 调 `Config['~standard'].validate`（`fiber.update` 同样），所以 profile 路径只要插件带
`Config` 就会触发；kernel 先校验一次，是为了给出错误码与凭据检查（`tests/plugin-config.test.ts` 同时核实了 Cordis 的行为）。

### 16.4 权限（`service:`）

社区插件的 `inject` 必须 ⊆ 清单 `permissions` 中 `kind: "service"` 的服务 ∪ 隐式授予（`IMPLICIT_SERVICE_GRANTS = ['log']`），
否则 `PERMISSION_UNDECLARED`；不认识的 `kind` 在装载第 4 步就拒绝。`storage` **不**隐式授予：在按插件隔离的存储服务
（W07）出现之前，`storage` 是全局数据库，需要显式声明并在审核时看见。官方插件不受限制（同一代码库内审查，`inject`
本身就是声明）。约束目前只在装载时检查声明；进程隔离之前，运行时对未注入服务的访问（Cordis `internal/get`）尚不拦截（P1）。
kernel 专有服务（`commands`、`protocols`、`backendEvents`、`shell`、`dstuPluginInstaller`，`kernel.ts::KERNEL_ONLY_SERVICES`）即使写进
`permissions` 也不能注入（`KERNEL_API_FORBIDDEN`）；它们挂在根上、不注入也能取到，所以运行时另有检查（§16.7 第 2 项）。

**这是防误用，不是安全边界（SEC-E06）。** 社区 Host 半与内核同进程（`profile.ts` 直接 `import()` 模块），插件代码可以自己
`import('node:fs')` / `node:child_process`、读 `process.env`（main 传给 Host 的完整环境）、经 `ctx.root` 或 Cordis 内部取到
任何服务、改写全局对象。`service:` 权限的作用是让审核者看见插件要用什么、让守规矩的插件在误用时立刻失败；挡住恶意插件
要靠 §16.7 的进程隔离。

### 16.7 社区 Host 半隔离（SEC-E06 Host 半）：现状与阻断项

**未完成**（已落地部分见本节末尾）。决策 5 写明 1.0 前不开放社区插件；下面三项是开放之前的阻断项（W17 的 UI 半沙箱见
`src/ui-kernel/SEC-E06-SANDBOX-DESIGN.md`）：

1. **进程隔离**：每个社区插件的 Host 半一个独立进程。只能由外壳用 `utilityProcess` 拉起，再由 main 转交 MessagePort 给 Host：
   打包版 fuses 关闭了 RunAsNode，Host 自己 `child_process.fork` 不出 Node；Node 的权限模型（`--permission`）作用于整个
   进程，不能按 Worker 划分。子进程环境变量只给白名单，不继承 main 的环境。
2. **RPC 服务面**：子进程里跑一个最小 Cordis Context。注入的服务（清单 `permissions` 中的 `service:` 与同意记录的交集）是
   代理：方法一律异步，参数与返回值纯 JSON，`{ signal }` 跨进程映射为取消消息；插件 `provides` 的服务在 Host 侧同样是异步代理，
   `meta.remote` 照常经 `plugin:host|call` 转发。v1 不给社区插件 `ctx.commands` / `ctx.protocols` / `ctx.backendEvents`。
   影响：注入给社区插件的服务不能有同步方法、回调参数或流（流以后可经单独的 MessagePort 做）。
   子进程崩溃或超时按插件降级（`host://plugins-degraded`），卸载即结束进程；每个进程常驻内存估计 30–40 MB（未实测）。
3. **同意流程**：profile 中的社区条目只有在同意记录（插件 id + 版本 + 权限集合的摘要）匹配时才装载；权限增加后，新增部分在重新同意前
   不生效（决策 4）。记录由主窗口的同意界面经内核命令写入，不放在 `plugins/` 目录里。它防的是“静默扩权”和“只放一个
   `user.profile.json` 就装上插件”；能任意改写用户数据目录的本地攻击者不在它的防护范围内。

**已落地**：§15.2 的调用方绑定；第 2 项中"v1 不给社区插件 kernel 服务"的同进程部分（K1）。社区插件（profile 筛查过
清单、`InstalledPlugin.packageRoot` 有值）：

- 装载时：声明 `meta.commands` 或注入 `KERNEL_ONLY_SERVICES` → 降级 `KERNEL_API_FORBIDDEN`，模块不 apply；
- 运行时：`ctx.commands.register`、`ctx.protocols.register`、`ctx.backendEvents.emit/emitTo/listen/listenWindow`
  抛 `PluginLoadError('KERNEL_API_FORBIDDEN')`，`ctx.shell.request` 以它 reject；在 `apply` 中调用即按 §8 降级，原因
  `"KERNEL_API_FORBIDDEN: <方法> is not available to community plugins in plugin API v1"`。只读的 `ctx.commands.has()` 不限制；
- 按调用方 fiber 归属判定（`kernel.ts::assertKernelSurface`）：官方插件、移动端（没有社区插件）与归属不明的调用
  （`ctx.root.*`、kernel 自身）保持原行为。官方服务被社区插件调用时，服务用自己的 `ctx` 发事件不受影响；Cordis
  `Service` 子类的**原型方法**里 `this.ctx` 是调用方的上下文，官方服务不要在这类方法里调用 kernel 专有服务
  （现状：`host/plugins` 中唯一的写法 `chat-pipeline/index.ts:307` 是箭头函数字段，取的是服务自己的 `ctx`）。

这仍是防误用：`ctx.root` 与 Cordis 内部都能绕过，挡恶意插件要等进程隔离。剩余分块与顺序见
`host/kernel/SEC-E06-HOST-ISOLATION-PLAN.md`。估计：W06 拉起与端口转交约 2 人日，W01 子进程运行时 + 服务代理 +
生命周期约 5 人日，同意记录与界面 W01 + W17 约 3 人日。

### 16.5 稳定接口与弃用

- `api.ts` 的导出面有类型快照 `host/kernel/api.surface.txt`（`tests/api-surface.ts` 用 TypeScript checker 序列化）：
  任何导出的签名、成员或标签变化都会让 `tests/api-surface.test.ts` 失败。确认是有意变化后用 `vitest -u` 更新快照并在
  提交信息中说明（W02 的 agent-api 导出同样在快照内）。
- 标 `@stable` 的导出是社区插件可依赖的接口（`definePlugin`、`HostPlugin`、`PluginMeta`、`Context` 增强、命令 / 事件 /
  协议接口、`CommandError`、`Schema` 等，清单由测试固定）。它们只做向后兼容的扩展；不兼容的修改先给旧接口加
  `@deprecated` 并保留一个发布周期，再删除。
- `@typescript-eslint/no-deprecated` 对 `host/`、`electron/` 开启（`eslint.config.js`，类型化）。现存 11 处用法按文件冻结在
  `eslint-rules/no-deprecated.baseline.json`；棘轮 `bin/heavy node eslint-rules/no-deprecated.baseline.mjs`（约 3 分钟，
  `--update` 只收紧）。kernel 自身零用法由 `tests/no-deprecated-lint.test.ts` 检查。

### 16.6 可移植引导

Host 会话不依赖 Node：`serve.ts`（握手、路由、启动收尾、`serveImportedHost`）、`contract-set.ts`（`ContractSet`）、
`runtime.ts`、`profile-install.ts`（安装隔离、`loadImportedProfile`）、`module-origin.ts`（`file:` URL 与路径互换，按 Node
`url` 规则实现）。读文件的桌面入口是 `connection.ts`（`serveHost`、文件 profile）、`contracts.ts`（`ContractSet.fromDirectory`）、
`profile.ts`（解析、导入、清单筛查）与 `main.ts`。`tests/portable-bootstrap.test.ts` 用可移植性扫描器的闭包分析守住前者。
没有文件系统的宿主这样启动：

```ts
import { ContractSet } from 'host/kernel/contract-set.ts';
import { serveImportedHost } from 'host/kernel/serve.ts';

serveImportedHost(transport, {
  contracts: () => ContractSet.empty(),
  installs: async () => [/* { plugin, config } … 由 host/profiles/mobile.json 生成 */],
  platform: 'mobile',
});
```

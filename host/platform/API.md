# F4 平台服务接口：`ctx.paths` · `ctx.secrets` · `ctx.settings` · `ctx.log`

## 共享错误（`errors/api.ts`）

`AppError.database(message)` 等构造器与 Rust `models.rs` 一一对应，返回普通对象
`{error_type, message, details}`；`details` 默认 `null`。`authentication` 是 `Network`，
`internal` / `operation_failed` / `not_implemented` 是 `Unknown`，保持 Rust 原行为。
用 `throw new CommandError(AppError.database(message))` 发送；`CommandError` 重导出 kernel 的异常包装器。
Rust 同名 envelope 使用 `CommandErrorEnvelope.new(code, message)`，可用
`with_data(envelope, data)` / `with_trace_id(envelope, id)` 添加字段。`ErrorDetails` 同样提供
纯函数构造器和 `with_*` 方法，以及全部 `ErrorDetailsBuilder`、HTTP/错误字符串分类函数。
这些是无状态值构造器，无需 Cordis inject；不会注册额外服务。

**`UNSUPPORTED_ON_PLATFORM`**（`errors/unsupported-on-platform.ts`，没有任何导入，前端与移动端 worker 可直接引用；`errors/api.ts`
同名转出）：“当前平台没有这项能力”的统一代号与消息格式。`UNSUPPORTED_ON_PLATFORM`（代号）、`UNSUPPORTED_ON_PLATFORM_PREFIX`
（`'UNSUPPORTED_ON_PLATFORM: '`，非 Rust 错误到前端只剩消息文本，前端按它识别）、
`unsupportedOnPlatformMessage(capability, platform, detail?)` → `UNSUPPORTED_ON_PLATFORM: <capability> is not available on <platform>[: <detail>]`
（`capability` 用平台能力清单 `mobile/src/capabilities.ts` 中的 id）、`parseUnsupportedOnPlatform(message)` 取回三者。
使用方：存储层 `StorageError('UNSUPPORTED_ON_PLATFORM')`（`storage/errors.ts`）、`ctx.http` 的 `HttpError('UnsupportedOnPlatform')`
（见「http」）、插件装载降级原因（kernel `PLUGIN_LOAD_CODES`，原因文本是 `UNSUPPORTED_ON_PLATFORM: plugin "<id>" supports …`，
不是能力格式）。`storage/errors.ts` 目前仍自己定义前缀常量，`http/pinned-policy.ts` 从 `storage/errors.ts` 导入
（W14 交接：两者改为从这里导入，`pinned-policy.ts` 因此不再依赖存储层）；`errors/tests/unsupported-on-platform.test.ts` 核对三处一致。

接口定义（冻结）：`host/platform/{paths,secrets,settings,log}/api.ts`。业务插件只 `import type`
这些文件，并在插件 `inject` 里声明 `paths` / `secrets` / `settings` / `log`。
实现入口：各目录的 `index.ts`（Cordis 插件，`ctx.reflect.provide` 注册同名服务）。

依赖关系：`paths` ← `log` ← `secrets` ← `settings`（`settings` 另依赖 F3 `storage`）。
测试中可以不经 Cordis，直接用各 `index.ts` 导出的 `create*` 工厂构造。

## 数字表示（V08-09，W01）

Host 内部同一个 JSON 数字可能有三种形态：普通 `number`、`bigint`、`JSON.rawJSON` 原子（冻结、null 原型的不透明对象）。
原子不能 `structuredClone` / `postMessage`（DataCloneError），不能 `Number()` / 模板字符串（TypeError），展开或
`Object.entries` 会把它静默变成 `{rawJSON:"…"}`。所以边界上的约定是：**默认普通 JSON，原子显式 opt-in**。

| 位置 | 形态 |
|---|---|
| 命令参数中带类型的整数（契约 `x-int`） | 按数字 token 解码：安全整数为 `number`，超出为 `bigint`；溢出、小数、指数、负号（无符号）按 serde 报 `invalid number` 等原文 |
| 命令参数中带类型的浮点（`x-float`） | `number`；`f32` 位置为 `Math.fround(x)`，落库/出站时用 `f32ToJsonNumber` 取最短十进制 |
| 命令参数中的 `serde_json::Value`、`{}`、`true` 位置 | **普通 JSON**，与 `JSON.parse` 的结果相同：小数、≥2^53 的整数都是 `number` |
| `CallContext.payload`（JSON 载荷） | 普通 JSON，同上；字节载荷原样 |
| `CallContext.exactPayload()` | 显式 opt-in：首次调用时计算，安全整数以外的 token 保留为原子（含 `1.0`、`1e400`）。只给需要 serde 式 token 语义（`from_value` 严格解码）的处理器，用完立即序列化或转换 |
| `plugin:host\|call` 的参数 | 先查非 JSON 值，再投影成普通 JSON |
| 命令返回值、`ctx.backendEvents.emit` 载荷 | 可以含 `bigint` 与原子；kernel 出站时写精确 JSON 文本（`wireJsonOutput`），前端 `JSON.parse` 后与 Rust 输出的精度损失相同 |
| 插件内部从数据库 JSON 读出的 Value（`parseJsonDocument`、`valueFromStr` 等） | 可以用原子保真写回；只在同一 runtime 内经 `JSON.stringify` 落盘，跨 worker / IPC / 克隆前先转换 |

**Value 位置用普通 JSON 不丢信息**：前端用 `JSON.stringify` 生成 invoke 参数，其中每个数字都是某个 double 的最短往返表示，
所以对前端发来的任何数字文本 `s`，`JSON.stringify(JSON.parse(s)) === s`，重新序列化得到的文本与 Rust
`arbitrary_precision` 保存的 token 相同（`1.0`、`1e400`、`9007199254740993` 这类文本前端发不出来）。

**测试**：`TestHost.invoke` 对 JSON 安全的参数默认带 `argsJson`，与 Electron main 走同一条解码路径（V08-02）；参数含字节、
`bigint`、`undefined` 值、`Date`、`Map` 等时走对象路径，`invokeRaw` / `{ exactJson: false }` 显式走对象路径（host/kernel/API.md「测试」）。

## 平台纯函数模块

以下三个模块没有 Cordis 服务（不需要 `inject`/`provide`），直接 import 函数即可。
消费方应引用 `host/platform/<模块>/index.ts` 或 `api.ts`；`paths/compat.ts` 只为兼容
既有导入保留同名 re-export，新代码不要继续把实现写回 compat。compat 本身是可移植的（只剩纯函数），
文件原语（`atomicWriteFile` / `createDirAll` / `setMode` / 带退避的 rename）在桌面入口
`host/platform/util/durable-fs.ts`。

### time（`host/platform/time`）

chrono 0.4 兼容的时间格式化/解析。

| API | 语义 |
|---|---|
| `now()` | 单次采样，返回 `{ epochNanos, millis, rfc3339 }`；`rfc3339 === toRfc3339(epochNanos)` |
| `nowEpochNanos()` | 当前 Unix 纪元纳秒（`bigint`） |
| `toRfc3339(epochNanos?, {local?, offsetMinutes?})` | `DateTime::to_rfc3339()`：AutoSi 小数秒 0/3/6/9 位，UTC 写 `+00:00` |
| `toRfc3339Opts(nanos, format, useZ?, offsetMinutes?)` | `to_rfc3339_opts`；`format` = `Secs`/`Millis`/`Micros`/`Nanos`/`AutoSi`。`useZ` 只在偏移 0 时输出 `Z` |
| `parseRfc3339(text)` | `DateTime::parse_from_rfc3339`：接受 `T`/`t`/空格、大小写 `Z`、`+`/`-`/U+2212 偏移、任意位小数（截到 9 位）、闰秒 `:60`；非法返回 `null` |
| `parseChronoDateTimeUtc(text)`（`time/api.ts` 或 `time/index.ts`） | chrono **0.4.41** `DateTime<Utc>` serde 字符串 / FromStr：relaxed RFC3339，返回 UTC `ParsedDateTime` 或 `null`；支持 `2012-12-12 12:12:12+0000`、`2012-12-12 12:12:12 UTC`、不补零字段、有符号扩展年与源码允许的 Unicode 空白，仍要求完整时区与有效公历日期 |
| `parseFlexibleTimestamp(text, {numeric?})` | `parse_flexible_timestamp_public`：RFC 3339 → SQLite `YYYY-MM-DD HH:MM:SS`/`T` 形式 → 纯数字（`>=1e11` 毫秒，`>=1e9` 秒） |
| `parseFlexibleTimestampSqlite(text)` | `SyncManager::parse_flexible_timestamp` 的内部版本：**不接受**纯数字 |
| `parseFlexibleTimestampMillis(text)` | 返回毫秒数或 `null` |
| `civilTime` / `ymd` / `chronoStamp` | 兼容既有日志/备份代码的字段与格式辅助 |

`parseFlexibleTimestamp` 的两个版本差异来自 `dstu-sync/src/data_governance/sync/mod.rs`：
公开版（`:71-95`）为资源/待办的 INTEGER 毫秒 `updated_at` 增加数字分支；内部版
（`:4612-4628`）只接受文本格式。纯数字阈值固定为 `1e11`（1e9..1e11 按秒解释，
更小的整数返回 `null`），`i64` 溢出也返回 `null`。

`parseChronoDateTimeUtc(value: string): ParsedDateTime | null` 用于已解码的 serde 日期字符串。
数字字段只认 ASCII；日后必须立即跟 `T/t/ASCII 空格`，其他分量前的空白遵循 Rust White_Space
（含 U+0085，不含 U+FEFF）。偏移小时/分钟须各两位，中间可有任意多个冒号或 White_Space，
也可无分隔符。无时区、非法日期/偏移、非空白尾随文本返回 null。它不处理 JSON/Option；
调用方必须把非法日期视为整个持久化记录解码失败，不能把失败转成 `expires_at: None`。

成功结果的日历字段已转为 UTC（`offsetMinutes === 0`）；小数保留九位纳秒，多余位截断。
闰秒仍是 `second:59, nanos:1_000_000_000+fraction`。既有 `epochNanos` / `millis` 是归一化
Unix 投影：**单独保留 epochNanos 会丢失闰秒身份**，需要复现 chrono 闰秒比较/保存时保留整个
`ParsedDateTime`（基础秒可由 `epochNanos - BigInt(nanos)` 得到）。`toRfc3339Opts(epochNanos, …)`
也只能格式化该投影，不负责复原闰秒。源分支表见 `migration/spec/F4-security.md` 的 WP-007 节。

### util（`host/platform/util`）

`DIFFICULTY_RUBRIC` 从 `util/api.ts` / `util/index.ts` 导出，为 Rust
`dstu-core/prompt_contracts.rs:57-63` 的逐字难度契约。供 L18/L14 题目结构化/导入 prompt 统一引用，
不需要 Cordis 注入。L01/L03 既有 LaTeX 契约不在此复制。共享导出不等于消费接线完成。

Value 数字补充：`JsonReader.readValue()` / `parseJsonDocument(text)` 对应启用 arbitrary_precision 的
语法读取，接受 `{"a":1e400}`。数字节点 `value.raw` 保留原文；超 f64 有限范围时为
`{kind:'arbitrary',raw}`（公开类型 `JsonValueNumber`），不暴露 Infinity。其余分类仅为投影提示，
调用方不能据此跳过自身的 `from_value` 类型/范围解码。`skipValue()` 对未知字段也只检查数字语法；
`readNumber` / `readUnsigned` / `readSigned` 仍是 typed 路径，超范围保持 `number out of range`。
深度 128、字符串转义和文档尾随字符检查未放宽。F3 文件头检测可直接对 `parseJsonDocument(sample)`
做成功/失败判定，不必访问数字节点。

Value 保存正式面（`util/api.ts` / `util/index.ts`）：

- `jsonNumberToRawJSON(value: JsonValueNumber): JsonRawNumber`：把已验证 Value 数字转为标准
  `JSON.rawJSON` 数字原子，不经过 Number。规范化 Rust Value 的指数（小写 e/正号）及整数 -0；
  `JSON.stringify({n: atom})` 可保存合法 `1e999` 为 `{"n":1e+999}`。u64/i64 也可使用；
  若 owner 内部保留 bigint，现有 bigint replacer 可以与该原子共存。原子是不透明 native 对象，
  不能 spread/structuredClone 后再当普通业务对象使用；缺少 rawJSON 的 runtime 明确抛错，不 fallback。
  原子仅供同一 runtime 的 JSON.stringify 保存，不作为跨进程/IPC DTO；出站数值形状由字段 owner 显式处理。
- `stringifyJsonValue(node: JsonNode): string`：从已验证 reader Value 树输出 compact JSON，
  数字不舍入、对象 last-wins/首次键序保留。需要 `preserve_order`（包括 `"10"`/`"2"` 这类键）时
  使用它，不先投影普通对象再 JSON.stringify（JS 自有键顺序会重排整数样式键）。
- 两者均不是 typed decoder、不是对任意 JS 对象的通用 serializer，也不把不合法 JSON 数字或
  typed 溢出输入转换为 null；合法超 f64 的 Value 和坏 JSON fallback 必须区分。

精确 `IgnoredAny`：typed owner 对未知字段显式调用 `JsonReader.skipIgnoredValue(): void`（从
`util/api.ts` 导入类）。该方法消费 pending colon 和一个值，按 serde_json 1.0.149
`deserialize_ignored_any` → `ignore_value` 的迭代栈扫描，不构造节点、不做数字范围检查、
不验证 `\u` 代理项配对、不消耗 typed 的 remaining_depth。仍检查四位 hex、转义、控制字符、
容器/逗号/冒号，错误为同一 `JsonSyntaxError`。如 `unknown:"\ud800"`、超 128 层未知数组可忽略，
非法 hex 或坏数字仍报错。已知字段继续 typed 读取；调用方完成根对象后须 `end()` 检查 trailing。
既有 `skipValue()`、`nextKey()` 自动跳过未读值的行为不变（仍是有深度/配对检查的旧 Value 式丢弃），
不应再把它们称作精确 IgnoredAny；未知字段需显式选择新方法。

positional struct/tuple 收尾：读满固定字段后调用 `JsonReader.endArray(): void`（不要再调用
`nextItem()` 预读多余元素）。它按 `de.rs:1072-1086 end_seq` 消费 `]`，遇逗号则先消费并跳空白，
后接 `]` 报 `trailing comma`，否则报 `trailing characters`；无逗号且 EOF 报
`EOF while parsing a list`。peek 错误位置对应下一个 UTF-8 **字节**（不是整个 Unicode 字符）。
`nextItem()` 已返回 false 后不能再调用本方法（数组已关闭）。

| API | 语义 |
|---|---|
| `f32ToJsonNumber(value): number \| null`（`util/api.ts`、`util/index.ts`） | 仅用于启用 `serde_json/arbitrary_precision` 的 f32 出站字段：先 `Math.fround`，再选择最短、最近、等距取偶数的 f32 roundtrip 十进制，投影为 JS number。例 `33.33333206176758` → `33.333332`，`Math.fround(1e20)` → `1e20`；非有限/窄化溢出 → null。保留 number 的 -0（但普通 `JSON.stringify` 会把 -0 写成 0；本 helper 不承诺原始 JSON 文本拼写）。不改 f64、不用于内部运算、不全局替换 serializer。 |
| `decodeBase64Standard(text)` | `base64 0.22.1` `general_purpose::STANDARD.decode`：canonical padding、不允许尾随位；返回 `{bytes}` 或 `{error}`，`error` 为 crate `DecodeError` 的 Display（`Invalid symbol N, offset M.`、`Invalid input length: N`、`Invalid padding`、`Invalid last symbol N, offset M.`）。调用方自己加错误前缀。旧路径 `secrets/crypto-service.ts` 仍 re-export |
| `JsonReader`（`util/api.ts`） | serde_json 1.0.149 `from_str` 的流式读取：typed decoder 按 serde derive 顺序 `beginObject`/`nextKey`/`readBool`/`readString`/`readUnsigned(exp,max)`/`readSigned`/`readOptionNone`/`beginArray`/`nextItem`/`skipValue`/`end`，因此字段类型错误和已知字段重复会先于后面的语法错误和尾随字符报出。重复判断、alias、default、必填由所有者自己做；`fieldError` 用于对象仍打开时（如 duplicate），`error` 用于对象关闭后（如 missing）。错误为 `JsonSyntaxError`，`<Display> at line L column C`，column 按 UTF-8 字节计。数字分类按 `ParserNumber`：`-0`、小数、指数、超出 u64/i64 的整数都算 F64。F64 类型错误显示 `floating point `<v>``，`<v>` 由 `ryuFormat`（名字沿用，实为 zmij 1.0.21 `Buffer::format`，serde_json 1.0.149 `error.rs:471-475`）生成：十进制指数在 [-5, 15] 内用定点（`1000000000000000.0`、`0.00001`、`-0.0`），否则科学计数，正指数带 `+`（`1e+16`、`1.8446744073709552e+19`），负指数为 `1e-6` |
| `JsonReader.readEnumVariant(expected?)` / `endEnumObject()` | externally-tagged enum 的 map 形式（`de.rs` `deserialize_enum`）：`beginObject()` 后按 `deserialize_str` 读变体名，不走 map 的空/逗号/结束分支，`:` 在读值时消费；读完变体值后，`endEnumObject()` 只跳空白并要求 `}`，不读第二个键，否则在当前位置报 `expected value` 或 `EOF while parsing an object`。变体名校验和错误文案由调用方负责 |
| `parseJsonDocument(text)` / `objectLastWins(node)` | `serde_json::Value`：对象成员按顺序保留重复键，`objectLastWins` 按 last-wins 取值。不要用它解码 typed struct |
| `parseJsonDocumentBytes(bytes)` / `JsonReader.fromSlice(bytes)`（供方候选，WP-130） | `serde_json::from_slice::<Value>`（de.rs:2657、read.rs SliceRead）：返回与 `parseJsonDocument` 相同的 `JsonNode`（raw 数字、重复键、`1e400` 为 arbitrary）。不先整体校验 UTF-8：字符串/键在闭合引号后才校验，报 `invalid unicode code point`（位置为闭合引号之后）；之前的语法错误、控制字符、坏转义、EOF 先报；字符串外的非 ASCII 字节按 `expected value` / `trailing characters` 等语法错误报；`skipIgnoredValue` 不校验被忽略字符串的 UTF-8。column 按字节计；BOM 不剥离。不替换乱码后成功。L02 HTTP 接入由 L02 另包完成 |
| `trim` / `trimStart` / `trimEnd`（别名 `rustTrim*`） | Rust `str::trim*`：Unicode White_Space；不去 U+FEFF，去 U+0085 |
| `utf8ByteLength` / `charCount` / `takeChars` | Rust `len()` / `chars().count()` / `chars().take(n)` |
| `truncateUtf8` | 返回不超过字节上限的最长 UTF-8 前缀（不拆码点） |
| `truncateUtf8Exact` | Rust `String::truncate`：越界或非字符边界抛 `RangeError` |
| `utf8ErrorMessage` / `decodeUtf8Strict` | Rust `Utf8Error`/`FromUtf8Error` 的 Display 文案与严格解码 |
| `canonicalReason` / `statusLine` | `http 1.5.0` `StatusCode::canonical_reason`（62 个标准码；未知返回 `null`）；`statusLine` 复刻 `StatusCode` Display（未知码输出 `<unknown status code>`） |
| `crc32` / `Crc32` | IEEE CRC-32，支持增量 |
| `ZipWriter` / `writeZip` / `readZip` / `ZipArchive` | Stored/Deflated、UTF-8 名称、Unix 权限、DOS 时间；读取校验 CRC |
| `ZipArchive.inspectByIndex(i, {platform?})` / `zipEnclosedName(name, platform?)` / `ZipError` | zip 0.6.6 `by_index` 的元数据面，不解压、不校验 CRC。错误按 Rust 顺序抛出：越界（FileNotFound）→ 加密（Password required）→ 本地头（Invalid local file header / io EOF）→ 不支持的压缩方法；`message` 为 `ZipError` 的 Display。返回 `ZipIndexEntry`：`unixMode`（`unix_mode()`，Unix/DOS 分支，其余为 null）和 `enclosedName`（`enclosed_name()`，按当前平台 Rust `Path::components` 语义判断，不安全为 null）。symlink、条目数、大小、压缩比的判断由调用方完成 |

ZIP 范围与项目启用的 `zip 0.6` feature 一致：只支持 Stored/Deflated；不写 ZIP64
（超 4 GiB / 65535 条目抛错）、加密、bzip2/zstd。读取兼容 ZIP64 中央目录，
无 UTF-8 标志的旧文件名按 CP437 解码。默认压缩为 Deflated、默认时间 1980-01-01
（`zip 0.6` 未启用 `time` feature 的默认值）。

#### 模型包装 token 清理（`model-special-tokens.ts`，C2 2026-11-04 确认归 F4）

`crates/dstu-util/src/utils/model_special_tokens.rs` 的单一共享实现；各 lane 不得再复制
策略、token 表或流式状态机。

| API | 语义 |
|---|---|
| `MODEL_SPECIAL_TOKENS` | 五个 GLM/Qwen 包装 token（`begin_of_box`/`end_of_box`/`im_start`/`im_end`/`endoftext`）；L16 等消费方引用本常量 |
| `for_provider_model(provider_type, provider_scope, model)` | Rust `ModelWrapTokenPolicy::for_provider_model`：`trim` 用 Rust Unicode White_Space，大小写只折叠 ASCII；provider 精确匹配 `qwen`/`dashscope`/`zhipu`/`bigmodel`；模型含 `qwen`/`chatglm`，或 ASCII 字母数字段以 `glm`/`qwq`/`qvq` 开头 |
| `create_model_wrap_token_filter(...)` | 上述策略 + 过滤器的组合入口；消费方首选 |
| `ModelWrapTokenStreamFilter` | `process(chunk)` / `flush()` / `reset()`；流式、Markdown-aware，保守清理行首包装、token-only 行、续写头与流尾 closer |
| `ModelWrapTokenPolicy` | `Disabled` / `GlmOrQwen`；默认构造为 `Disabled` |

消费分工：L02 在构造流式适配器时按 provider/model 调 `for_provider_model` 或
`create_model_wrap_token_filter`，为 content/reasoning 各建一个实例；L01/L03 只消费
`process`/`flush`/`reset`（L03 现有 `WrapTokenFilter` 接口兼容），不得再实现策略。
L03 当前默认仍是 `identityWrapTokenFilter`（Disabled 子集），L02 注入后按策略生效；
`identityWrapTokenFilter` 只应保留给禁用路由/测试。17 条 Rust 测试已移植到
`util/tests/model-special-tokens.test.ts`；实际调用方接线在 L02/L03 的流式构造点，
F4 已通过 `WrapTokenFilter` 类型兼容测试锁定接口。

#### SSE / UTF-8 流（`sse-buffer.ts`，F4 单一共享实现）

`crates/dstu-util/src/utf8_stream.rs` 与 `crates/dstu-util/src/utils/sse_buffer.rs` 的单一实现；
L01/L02 的流式管线应引用本入口，不再各自维护 `SseEventBuffer` 副本。

| API | 语义 |
|---|---|
| `Utf8StreamDecoder` | `decode(bytes)` 跨 chunk 保留 0–3 字节不完整 UTF-8；真正非法序列替换 U+FFFD；`flush()` 对截断尾部补一个 U+FFFD；`hasPending()` |
| `SseLineBuffer` | `processChunk(string)` 按行拆分；默认上限 10 MiB；`hasRemaining()` / `flush()` / `clear()` / `checkDoneMarker(line)` |
| `SseEventBuffer` | `processBytes(Uint8Array)` 增量解码 + `scan_from` 线性续扫；保留 `event:`/`id:`/`retry:` 与 `data:` 同块；完整 JSON data 立即产出；默认上限 10 MiB；`flush()` / `clear()` / `checkDoneMarker(block)` |
| `extractStreamDataPayload(block)` | SSE `data:` 行合并；裸 JSON / `[DONE]` 仅作有限 fallback，不把元数据/注释当数据 |
| `setSseBufferLogger(fn)` | 注入 `(level,message)`；溢出走 error、非法 UTF-8/截断走 warn，仅记录长度类元数据。返回带身份校验的 disposer，只清自己的绑定；作用域与 Rust `tracing` 全局 subscriber 一致（一个 Host 进程一个 logger），多宿主卸载不误清另一个消费者。生产由 `dstu.platform.log` 插件在 apply 时绑定 target `dstu_util::utils::sse_buffer`，L01/L02 改用平台入口后无需各自注入 |

默认上限与 Rust `DEFAULT_MAX_BUFFER_SIZE` 一致（10 MiB）。28 条 Rust 测试已移植到
`util/tests/sse-buffer.test.ts`；L01 的 `llm-providers/src/sse-buffer.ts`（16 MiB 本地副本）
与 L02 的 `stream_validation.ts:163`、`single_shot_stream.ts:217` 两份副本待各自 lane
改为引用本入口（F4 不改其文件）。

### net-policy（`host/platform/net-policy`）

`crates/dstu-core/src/net_policy.rs` 的逐行移植：

- `parseIp(text)`：Rust `IpAddr::from_str`（无方括号/zone id；IPv4 前导零拒绝）；
- `isLoopbackIp` / `isInternalIp` / `isBlockedInternalIp`：接受 `IpAddress` 或 IP 字面量字符串；
- `isLoopbackHost(host)`：`localhost` / `*.localhost`、去掉全部尾点、ASCII 小写、127/8、::1、
  IPv4-mapped loopback；
- `isBlockedInternalIp = isInternalIp && !isLoopbackIp`：回环放行，私网/链路本地/云元数据封锁。
- `isSafeRemoteUrl(url)`：`dstu-util/src/utils/fetch.rs::is_safe_remote_url` 的移植；只允许
  http/https，IP 字面量直接判定，域名解析全部地址后任一被封锁即失败关闭。需要 `node:dns`，
  因此只在桌面入口 `net-policy/node.ts` 导出（`net-policy/index.ts` 是可移植入口：只含 URL/IP 判定）。
- `fetchBinaryWithCache(url)`：同一 Rust 模块的缓存下载；10 秒超时、不跟随重定向、非 2xx/失败/超时
  返回 `null`，按 URL 缓存 `{bytes,mimeType}`。同样只在 `net-policy/node.ts`。L01 的 `remote-image.ts` 通过 `RemoteImageFetcher`
  注入缓存读取器，待其完成接线后走生产路径。

**导航策略**（`net-policy/navigation.ts`，`crates/dstu-browser/src/browser/policy.rs` 的移植）：内置浏览器顶层导航的判定，
纯函数、无 I/O、不做 DNS。browser 插件（`host/plugins/browser/src/policy.ts` 原样转出）与 Electron 外壳
（`electron/shell/browser-agent-guard.ts`）共用这一份，外壳因此不依赖插件实现。

- `allowNavigationWithOptions(url, allowInsecureHttp)` → `NavigationDenyReason | null`（null 即放行），按顺序：
  `new URL` 失败 → `InvalidUrl`；scheme（小写）在 `FORBIDDEN_SCHEMES`（`file`、`javascript`、`data`、`blob`、`tauri`、`asset`、`ipc`）
  → `ForbiddenScheme`；`https` 有主机即放行；`http` 有主机且 `allowInsecureHttp` 或主机为回环（`isLoopbackHost` /
  回环 IP 字面量，含 `[::1]`）才放行，否则 `NonLoopbackHttp`；`https`/`http` 无主机 → `MissingHost`；其余 scheme 一律
  `ForbiddenScheme`。`allowNavigation(url)` 等于 `allowInsecureHttp = false`。
- `isBlockedForAgent(url)`：Agent 私网硬拦截的字面量部分（Rust `is_blocked_for_agent`）。解析失败或无主机为 true；域名只拦
  `localhost` / `*.localhost`（去尾点、小写）；IP 字面量用 `isInternalIp`，**回环也拦**（不同于 `isBlockedInternalIp`）。
  其他域名在这里不判，须由调用方解析后对全部地址判 `isInternalIp`（Rust `ensure_resolved_addresses_are_public`）。
- `navigationDenyMessage(reason)`：文案与 Rust `Display` 逐字相同，被拦事件与错误信息都用它；`AgentPrivateNetwork` 只用于文案，
  `allowNavigation*` 不返回它。

调用方怎样组合（与 Rust `window.rs::navigation_allowed` 一致）：`allowInsecureHttp` 的实际取值是
`!agentPrivateNetworkGuard || agentAllowInsecureHttp`。即用户自己浏览（Agent 防护关闭）时任意 `http` 都放行，只拦危险
scheme；Agent 防护开启时 `http` 仅回环，除非用户另开了 Agent 的 http 许可。规范策略通过后，Agent 防护开启时再做私网判定：

| 调用方 | 判定 |
|---|---|
| browser 插件 `window-policy.ts::navigationAllowed` | 规范策略 + `validateAgentTarget`；同步钩子里遇到需要异步解析的域名失败关闭（`DNS resolution is unavailable`） |
| browser 插件 `browser-service.ts::checkNavigationUrl` | 插件发起的导航：规范策略；来自 Agent 时再 `validateAgentTargetForAgent`（经外壳 `browser.resolveAgentHost` 解析） |
| browser 插件 `browser-tool-executor.ts` | Agent 工具入参：`allowNavigation` 只用来拒 `InvalidUrl` / `ForbiddenScheme` / `MissingHost`（http 留给导航时判），再 `isBlockedForAgent` |
| 外壳 `browser-agent-guard.ts` | 策略由插件经 `browser.setAgentNavigationPolicy` 推送（Host 退出时复位为关闭）。`will-navigate` / `will-redirect` 同步判规范策略与字面量；`webRequest.onBeforeRequest`（主框架、每跳重定向）用会话解析器做完整判定（2 s 超时，无结果/失败/任一私网地址都拒绝）；`onHeadersReceived` 按实际连接 IP 复判防 DNS 重绑定（经代理时跳过） |

与 Rust 的有意偏离都在外壳（W06 记录）：请求层取消时 Chromium 会在被拦 URL 上提交 `ERR_BLOCKED_BY_CLIENT` 错误页，而 Rust
同步拦截停在原页；重绑定只能在响应头阶段识别，请求已到达目标但响应被丢弃（Rust 无重绑定防护）。子帧与子资源与 Rust 一样不判。
fake-ip 代理（`198.18.0.0/15`）会让 Agent 浏览全部被判为私网，同 Rust。测试：`net-policy/tests/navigation.test.ts`（平台层入口）、
`host/plugins/browser/tests/policy.test.ts`（Rust `policy.rs` 完整用例对照，经插件原导入路径）、`electron/tests/browser-agent-guard.test.ts`。

### zip（`host/platform/zip`）

基于文件句柄的流式 ZIP 读写，支持 ZIP64；同样没有 Cordis 服务，直接 import `zip/index.ts`。
写出布局与 Rust `zip 0.6.6` 字节一致（`tests/__fixtures__` 为 Rust 生成的对照归档）。
大文件、备份归档、可能超过 4GiB / 65535 条目的场景用本模块；小型内存归档仍用 util 的
`ZipWriter` / `ZipArchive`。

```ts
import { ZipFileReader, ZipFileWriter } from '../zip/index.ts';

const writer = await ZipFileWriter.create(partialPath);        // 默认 flags 'wx'；覆盖用 { flags: 'w' }
try {
  await writer.addDirectory('logs');                            // 自动补 '/'，Stored
  await writer.addFile('logs/host.log', source);                // 默认 Deflated（zlib 6），按源大小决定本地头 ZIP64
  await writer.addBuffer('manifest.json', json, { compression: 'stored' });
  await writer.finish();                                        // 中央目录 + EOCD，默认 fsync
} catch (error) {
  await writer.abort();                                         // 关闭并删除目标文件，不抛错
  throw error;
}

const reader = await ZipFileReader.open(zipPath, { maxEntries: 100_000 });
try {
  for (const entry of reader.entries) {                         // 只读中央目录，不解压
    if (entry.isDirectory) continue;
    const stream = await reader.openEntryStream(entry, { onData: (bytes, total) => budget.take(bytes) });
    // …或小条目 await reader.readEntry(entry)
  }
} finally { await reader.close(); }
```

- 写入：`addStream(name, source, { sizeHint })` 接 `Readable`/异步迭代；`addFile` 的
  `verifyOpened(size, isFile)` 在写任何字节前校验源文件，`onData` 可在同一遍读取里算哈希；
  返回 `{ size, compressedSize, crc32 }`，`size` 为实际读到的字节数（导出期间文件变化可据此发现）。
  不支持并发写同一 writer；任一步失败后 writer 进入 failed 状态，只能 `abort()`。
- 布局：时间戳固定 1980-01-01，属性 0o100644 / 0o40755，made-by 0x032E；仅非 ASCII 名置 UTF-8
  标志；不写 data descriptor（写完回填本地头）；中央目录 ZIP64 扩展字段只在值 ≥ 4GiB 时出现。
  **有意偏离 Rust**：条目数 ≥ 65535 即写 ZIP64 EOCD（Rust 为 > 65535，正好 65535 时其产物
  会被部分读取方误判）。
- 读取：`entries` 为 `ZipEntry`（`name`、`isDirectory`、`compression`、`size`、`compressedSize`、
  `crc32`、`localHeaderOffset` 等）；`has(name)` / `find(name)` 按名查找。`openEntryStream` 校验
  实际字节数（不符抛 `ZipEntrySizeMismatchError`，含 `expected`/`actual`/`truncated`）与 CRC（`Invalid checksum`）；
  `onData` 抛错即中止，用于跨条目的实际解压预算。`maxEntries` / `maxCentralDirectoryBytes`
  （默认 256 MiB）在读中央目录前拒绝伪造的超大目录，`tooManyEntries` 可定制错误。
- 错误：格式问题抛 `ZipFormatError`（`kind`：`InvalidArchive` / `UnsupportedArchive` / `Io`，
  文案对齐 `zip::result::ZipError`）。
- 工具：`crc32Update(chunk, crc)`、`ZIP64_BYTES_THR`、`ZIP64_ENTRY_THR`。
- 消费方：L21 备份导出/导入（`plugins/backup/src/zip.ts`）、L23 delta restore、F3 恢复事件导出
  （`storage/recovery-export.ts`）与 `checkZipSecurity`（`storage/backup-common.ts`）。
- 慢测（> 4GiB、70000 条目、Rust 字节对照）由 `DS_ZIP_SLOW_TESTS=1` 打开。

#### 可移植核心（`zip/core/index.ts`）

上面的 `ZipFileWriter` / `ZipFileReader` 是桌面适配层（`zip/node/file.ts`：`FileHandle` + zlib）。读写逻辑本身在
`zip/core/`，只依赖 Web Streams、`Uint8Array`、`TextEncoder` / `TextDecoder`，移动端 Worker、WebView 与桌面共用，
字节布局相同。移动端与浏览器 import `zip/core/index.ts`；`zip/index.ts` 在其上再导出桌面适配层。

```ts
import { MemoryZipSink, ZipReader, ZipWriter, memoryZipSource, readAllBytes } from '../zip/core/index.ts';

const sink = new MemoryZipSink();
const writer = new ZipWriter(sink);                               // codec 默认 webZipCodec
await writer.addDirectory('logs');
await writer.addBytes('manifest.json', json, { compression: 'stored' });
await writer.addStream('logs/host.log', webReadableOrAsyncIterable, { sizeHint });
await writer.finish();                                            // 返回归档总字节数
const archive = sink.bytes();

const reader = await ZipReader.open(memoryZipSource(archive), { maxEntries: 100_000 });
for (const entry of reader.entries) {
  if (entry.isDirectory) continue;
  const stream = await reader.openEntry(entry, { onData: (bytes, total) => budget.take(bytes) }); // ReadableStream
  // …或小条目 await reader.readEntry(entry)（Uint8Array），整流读完用 readAllBytes(stream)
}
```

| 接口 | 作用 | 实现 |
|---|---|---|
| `ZipByteSink.write(data, position)` | 随机写：条目写完后回填本地头的 CRC 与大小（`zip 0.6.6` 不写 data descriptor） | 内存 `MemoryZipSink`（`bytes()` 取结果）；桌面 `fileZipSink(handle)` |
| `ZipByteSource { size, read(position, length) }` | 随机读：先读文件尾 EOCD，再按偏移读条目；只有读到末尾时才返回更短的结果 | 内存 `memoryZipSource(bytes)`；桌面 `fileZipSource(handle, size)` |
| `ZipCodec { deflateRaw(level?), inflateRaw(), crc32(data, prev) }` | raw deflate 与增量 CRC-32 | `webZipCodec`（`CompressionStream('deflate-raw')` + 纯 JS CRC；**不能指定压缩级别**，`level` 非 6 时抛 `RangeError`）；桌面 `nodeZipCodec`（zlib，支持级别，原生 `zlib.crc32`） |

- `ZipWriter(sink, { codec?, label? })`：`addDirectory` / `addBytes` / `addStream`（`ZipChunkSource` = `ReadableStream` 或
  同步 / 异步可迭代对象，含 Node `Readable`）/ `finish()`；`state`（`open` / `failed` / `finished`）、`offset`、`entryCount`。
  条目选项 `compression`、`level`、`zip64`（强制本地头 ZIP64）、`onData`（同一遍读取里算哈希）。失败后进入 `failed`，
  只能丢弃目标（桌面 `abort()` 删除文件）。
- `ZipReader.open(source, { maxEntries?, maxCentralDirectoryBytes?, tooManyEntries?, codec? })`：`entries`、`has` / `find`、
  `openEntry`（Web 流，校验大小与 CRC，错误同上）、`readEntry`。桌面 `ZipFileReader.openEntryStream` 是同一实现包成 Node
  `Readable`、`readEntry` 返回 `Buffer`，另有返回 Web 流的 `openEntry`。
- 工具：`toReadableStream(source)`、`readAllBytes(stream)`、`crc32Update`、`ZipFormatError`、`ZipEntrySizeMismatchError`。
- 核心内部不用 `pipeThrough` / `pipeTo`：Node（实测 v26.5）取消管道链时即使管道 promise 已处理，仍会抛出未处理的拒绝，
  提前中止解压就会触发；核心只用 reader / writer，出错或取消时显式向上游取消、向下游 abort。自己拼接流的调用方同样
  应避免在桌面主进程里取消 `pipeTo` 链。
- 移动端限制：目前只能用内存 source / sink（整包在内存里）。要在文件上流式读写，需要 `ctx.files` 提供按位置读写的
  句柄（写入要回填本地头），由 W14 的文件服务提供后实现 `ZipByteSource` / `ZipByteSink` 即可，核心不用改。

## paths

三个根，全部与 Rust 一致（引用：`src-tauri/src/lib.rs`、`tauri-2.11.5/src/path/desktop.rs`、`dirs-4.0.0`）：

| 根 | 值 | 来源 |
|---|---|---|
| base | `AppInfo.dataDir` = Tauri `app_data_dir()` = `dirs::data_dir()/<identifier>` | lib.rs:855 |
| slot | `base/slots/slot{A,B}`（活动槽，`slots/state.json` 的 `active`） | data_space.rs:1005-1019,1651-1675 |
| log | macOS `~/Library/Logs/<id>`；Windows/Linux `dirs::data_local_dir()/<id>/logs` | desktop.rs:278-290；lib.rs:872 |

`<id>` = `com.deepstudent.app`（tauri.conf.json:5）。`ctx.paths.identifier` 优先取外壳写入的环境变量
`DS_APP_IDENTIFIER`（`paths/os-dirs.ts` 的 `APP_IDENTIFIER_ENV` / `resolveAppIdentifier`；外壳侧是
`electron/shell/os-dirs.ts` 的 `hostPathEnv`，与 `DS_SHELL_OS_DIRS` 同时在 fork Host 之前写入）。变量缺失或为空时取
`basename(dataDir)`，正式安装中二者相同；值不是 Tauri identifier 字符集（字母数字与 `-`，以 `.` 分段，因此只是一个路径段）时
同样回落，并经设备身份日志 target 记一条 warn。`DS_APP_DATA_DIR` 冒烟隔离时 app data 目录名不是 identifier（例如
`/tmp/smoke/data`），此时 `appLocalDataDir` / `appConfigDir` / `appCacheDir` / `appLogDir` 只有取 `DS_APP_IDENTIFIER`
才与外壳 path 插件（`PathResolver` 的 `<dir>/<identifier>`）一致；`paths/tests/app-identifier.test.ts` 用外壳的
`resolveShellOsDirs` + `hostPathEnv` 逐项比对三个平台。

**操作系统目录与 `DS_SHELL_OS_DIRS`**（`paths/os-dirs.ts`）：`ctx.paths.os` 的 `home`/`data`/`dataLocal`/`config`/`cache`
优先取外壳传入的环境变量 `DS_SHELL_OS_DIRS`。Electron main 在 fork Host 之前写入（`electron/shell/os-dirs.ts`，
Windows 取 Known Folder，与 Rust `dirs` 的 `SHGetKnownFolderPath` 一致），utilityProcess 与 worker 线程继承。值是 JSON 对象，
键为 `home`、`data`、`dataLocal`、`config`、`cache`，值必须是目标平台的绝对路径；变量缺失或为空时全部按 dirs-sys 规则从
环境变量推导（macOS `~/Library/...`；Windows `%APPDATA%`/`%LOCALAPPDATA%`；Linux `XDG_*`，非绝对路径的 XDG 值忽略）。
不是合法 JSON、不是对象时整体忽略，单个键不是绝对路径时只忽略该键（`parseShellOsDirs` 返回原因），缺省的键同样回到推导。
`temp` 与 `download` 不经该变量传递（`temp` 取 `os.tmpdir()`，`download` 由 `home` 推导，Linux 读 `user-dirs.dirs`）。

| 路径 | 根 | 用途 | Rust |
|---|---|---|---|
| `slots/state.json`、`slots/slot{A..D}/` | base | 数据槽 | data_space.rs:1005-1019 |
| `recovery/backups/` | base | 默认备份目录 | data_space.rs:1031；backup_config.rs:649 |
| `.secure/{.key_seed,<key>.enc,.keystore_opt_in}` | base | 云凭据、bilibili、MCP OAuth 的 SecureStore | cloud_credentials.rs:51 |
| `.device_id`（旧：`device_id`、`<dataLocal|config|home>/deep-student/.device_id`） | base | 设备身份 | device_id.rs:45-72 |
| `mistakes.db`（含 `settings` 表） | slot | 主库 | file_manager.rs:222 |
| `databases/vfs.db`、`databases/audit.db`、`chat_v2.db`、`llm_usage.db`、`browser.db` | slot | 各库（F3 管理） | 见 storage/api.ts |
| `.secure/…` | slot | 主库 SecureStore（API Key：`<vendor>.api_key.enc` 等） | database/mod.rs:1211-1219 |
| `.master_key` | slot | CryptoService 主密钥 | lib.rs:3555；llm_manager/mod.rs:4757 |
| `deep-student.log`、`deep-student_<日期>.log` | log | 主日志 | lib.rs:788-794 |
| `crash/crash-*.log` | log | 崩溃日志 | crash_logger.rs:18 |
| `{frontend,backend,debug}/` | log | 结构化调试日志 | debug_logger.rs:68-74 |
| `debug-logs/*.json` | log | LLM 请求/响应调试日志 | debug_log_service.rs:16 |
| `<dataLocal>/deep-student/.secure` | os | `SecureStore::new()` 回退 | secure_store.rs:666 |
| `<dataLocal|data|config|temp>/deep-student/sync/sync_state.db` | os | 同步状态库 | sync/state.rs:23-29 |

`ctx.paths.slot.join(slotDir, …)` / `ctx.paths.baseJoin(…)` 用于其余功能目录（images、vfs_blobs、
workspaces、chat_v2_artifacts 等，完整清单见 TESTMAP.md 附录「路径盘点」）。运行期活动槽以 F3
`ctx.storage.locations.activeDir` 为准。

设备身份分两个入口，不得混用：

- `ctx.paths.deviceId()`：`data_governance/commands_sync.rs:1197` 的旧根优先包装。先读
  `base/device_id`，非空原值直接返回并写回 `DEVICE_ID`（主路径不存在时同步迁移到 `base/.device_id`）；
  未命中再委托底层权威语义。L20 data_governance 命令继续使用本方法。
- `ctx.paths.dataSpaceDeviceId()`：`dstu-storage/src/data_space/device_id.rs::get_device_id()` 的底层语义：
  `DEVICE_ID` 环境变量（规范化）→ 主路径 `base/.device_id` → 旧路径（`base/device_id`、
  data_local/config/home 下 `deep-student/.device_id`，命中即迁移）→ 生成 `<hostname>-<uuid8>`
  并原子写主路径；写失败时进程内保持同一临时 ID。L23/L11 等需要与 Rust 底层身份一致的消费方
  使用本方法，不得复制身份算法。

设备身份日志（迁移/生成/写失败）经生产插件注入的 `ctx.log` target
`dstu_storage::data_space::device_id` 输出，默认不再走 console。
另有 `normalizeDeviceId`、`deviceIdShortHash`、`rotateDeviceIdAfterRestore`。

## secrets

`ctx.secrets.openStore(root)` = Rust `SecureStore::new_with_dir(root)`：构造期尽力创建
`<root>/.secure`，失败只记 warn 后继续。两个实例按 Rust 习惯：
- 主库凭据：`openStore(activeSlotDir)`（`Database` 用 `db_path.parent()`）；
- 云凭据/bilibili/MCP：`openStore(appDataDir)`（`get_secure_store`）。

**磁盘格式（逐字节兼容）**

- `<key>.enc` 文件名：键中 `/`、`\` 替换为 `_`。内容 `nonce[12] ‖ AES-256-GCM(utf8(value)) ‖ tag[16]`，无 AAD。
- 设备密钥 v3：`SHA-256(seed_utf8 ‖ "deep-student-secure-salt-v3")`；seed 为 `.key_seed` trim 后内容
  （新建时 32 字节随机数的小写 hex）。
- legacy v2：`SHA-256(ANDROID_ID? ‖ home ‖ dataLocal ‖ hostname ‖ (USER|USERNAME) ‖ "deep-student-secure-salt-v2")`；
  v3 解密失败时尝试，成功即用 v3 重写。
- `.key_seed` 形态：明文；`DPAPI1:` + base64（Windows，熵 `deep-student.key_seed.dpapi.v1`，
  `CRYPTPROTECT_UI_FORBIDDEN`）；`KEYSTORE1:` + hex(SHA-256("deep-student.key_seed.fingerprint.v1" ‖ seed))。
- 平台密钥库：service `deep-student`，account `key_seed.<指纹>`，值 = 明文种子。macOS 为登录钥匙串
  generic password（与 keyring 3.6.3 apple-native 相同）；Linux 固定 Secret Service（不回退 keyutils）。
  默认关闭，`.secure/.keystore_opt_in` 存在才启用；`DEEP_STUDENT_KEY_SEED_FILE_ONLY` 禁用。
- 原子写：同目录临时文件 → fsync → chmod 0600 → rename；目录 0700（Windows 用 icacls）。
- 云凭据：`cloud_storage_credentials`（JSON，camelCase，缺省字段省略）、`cloud_storage_credentials_staged`
  （`{"generation":n,"credentials":{…}}`）、`cloud_storage_credentials_generation`（十进制）。

`ctx.secrets.openCrypto(dir)` = `CryptoService::new`：`<dir>/.master_key` = base64(32 字节)。加密 API Key 的实例传
应用根目录（`ctx.app.dataDir`），不传活动槽目录：备份和恢复读写的是根目录的 `.master_key`，启动时 storage 把槽内已有的
主密钥复制到根目录（RF-W07-crypto-root-adopts-slot-master-key）。
`encryptApiKey` → `{ciphertext: b64(ct‖tag), nonce: b64(12), version: 2}`；空串加密为空 ciphertext/nonce。
`version != 2` 的旧数据按 base64 明文解码。

`ctx.secrets.backup`（`crypto/backup_crypto.rs`）：DSBK v1 `DSBK‖01‖m,t,p(u32LE)‖salt16‖nonce12‖ct‖tag`（头 45）、
v2 `DSBK‖02‖m,t,p‖salt16‖prefix7‖chunk(u32LE)`（头 44）+ 每块 `GCM(prefix7‖counter_be32‖final)`，Argon2id v0x13
（默认 64 MiB/t3/p4；解密侧上限 1 GiB/16/8，超限在派生前拒绝）；`FileCipherSession`、首块试解、密码校验子
`SHA-256("deep-student.encryption-marker.verifier.v1"‖key)`、加密目录记忆。

### DSBK native Argon2 实例依赖（C2 AP0136/0137）

- `createBackupCrypto(options?: BackupCryptoOptions): BackupCrypto` 定义在 `secrets/backup-crypto.ts`（Node 实现，
  依赖 `node:crypto`、`node:fs`），调用方从这个文件导入；`BackupCryptoOptions` 等类型在 `secrets/api.ts`。
  `secrets/api.ts:269` 还留着一行值重导出（仓库里没有经它导入的调用方），它让 `api.ts` 带上 Node 依赖，交 W07 删除。
  `BackupCryptoOptions.nativeArgon2?: NativeArgon2` 类型只引用 F7 `native/api.ts`，不私引实现或新增包。
  既有 `createSecretsService(options)`（`secrets/index.ts`）同样增补可选 `nativeArgon2`，传给同一 factory。
- 生产 secrets 插件在 apply 以现有 `ctx.reflect.get('nativeArgon2', false)` 取得服务快照；
  官方 desktop profile 的 native 在 secrets 之前，实际实例消费真实 F7 raw Argon2id v0x13/no secret/AD。
  不添加必需注入破坏旧最小 profile，不在 provider 晚装后偷偷切换已有实例/session。
- 手动工厂（例如 L21）必须先取得真实 `ctx.nativeArgon2`，显式传入：
  `createSecretsService({os,log,keystore:null,nativeArgon2:ctx.nativeArgon2})` 或
  `createBackupCrypto({nativeArgon2:ctx.nativeArgon2})`。仅在别的 Host 安装 native、但未传入旧工厂，
  不会自动加速它；caller 负责真实服务的装配顺序及存活期。
- 每个实例捕获自己的 provider，无全局可变开关。提供后优先 native，错误按原
  `Argon2id 密钥派生失败: …` 包装并上抛，**不**在失败后回退 noble。
  未提供时，原 Node crypto（可用）/Electron noble 路径保持；不能拿此旧路径声称 native 已消费。
- 应用上限→Argon 参数→salt 校验顺序不变，在任何 backend 调用前完成；默认65536 KiB/t3/p4/32字节、
  UTF-8/NUL、DSBK布局/首块终块规则不变。bytes/file、session foreign-salt cache、首块、verifier
  共用实例 deriver；password Buffer finally 清理、单次派生 key finally 清理、session dispose 缓存清理保留。
  真实 native 每次交出独占可写 key 分配，F4用 Buffer view 接管，不增加未跟踪的密钥副本；
  这不授 JS 不可变字符串或所有 native 内部内存的物理清零等价。

`ctx.secrets.publication`（`crypto_publication.rs`）：`<root>/.crypto_restore_journal.json` 与
`.crypto_restore_rollback/`，`recover(root, lease)` 返回 `Clean | RolledForward | RolledBack`（F3 数据空间启动时调用）。

错误：`SecureStoreError`（`kind` = Rust 变体名，`message` = thiserror 文案，
`toCommandError(op)` = `{code, message, data:{operation, retryable}}`）。

## settings

`ctx.settings` 绑定 `ctx.storage.database('mistakes')` 与 `openStore(dirname(mistakes.db))`。
`save/get/delete/listByPrefix/deleteByPrefix` 是同步 SQL（同 `Database::*_setting`）；
`saveSecret/getSecret/deleteSecret` 按 `isSensitiveKey` 路由，同一实例内串行（`secret_operation_lock`）。
`updated_at` 为 chrono `to_rfc3339()` 形式（`+00:00` 时区，小数秒位数 0/3/6/9 自适应）。
`ctx.settings.bind(db, secureStore)` 绑定其他库。

D1 事务接缝：`saveWithConn(conn,key,value)` / `getWithConn(conn,key)` /
`deleteWithConn(conn,key)` / `listByPrefixWithConn(conn,prefix)` /
`deleteByPrefixWithConn(conn,prefix)` 只使用调用方传入的 F3 `SqlExecutor`，SQL 仍在本模块执行；
调用方在自己的事务里依次调用，不直接写 `settings` 表。敏感键的 `*Secret` 方法不提供
`WithConn`（安全存储与数据库不在同一事务）。

备份配置命令插件（`settings/backup-commands.ts`，id `dstu.platform.backup-config`，lane `F4-security`）
注册 `get_backup_config` / `set_backup_config` / `pick_backup_directory` / `clear_backup_directory` /
`get_default_backup_directory`，与 Rust `generate_handler!`（`src-tauri/src/lib.rs:2219–2223`）一致。
`get_auto_backup_status` 在 Rust 中只有定义（`backup_config.rs:231`）、未注册，Host 同样不注册，
调用返回 kernel 的 command not found；状态读取保留为导出函数 `loadAutoBackupStatus(settings)`
（`AutoBackupStatus::load`）。设置键与 Rust 相同：
`backup.config`、`backup.auto_backup_status`。`settings/backup-config.ts` 是不依赖 Cordis 的纯逻辑：
serde 兼容读写（缺省值、camelCase、`BackupTier` 别名、`skip_serializing_if` 省略 `backupTiers`）、
`defaultRecoveryBackupDir`、`getEffectiveBackupDir`、自动备份暂存目录与旧备份清理。
`get_default_backup_directory` 复刻 `FileManager::get_writable_app_data_dir` 的
`base → data_dir/DeepStudent → temp/deep_student_data` 回退探测。

## cloud config（`errors/cloud-config-*.ts`）

`errors/index.ts` 是插件入口（默认导出 `dstu.platform.cloud-config`，并重导出 `api.ts`）。
`dstu.platform.cloud-config` 插件注册 `cloud_config_ssot_save` / `cloud_config_ssot_get` /
`cloud_config_ssot_clear` / `cloud_config_publish`，只做参数转发；实现由 L21/L23 通过
`ctx.reflect.provide('cloudConfig', impl)` 提供，接口见 `errors/cloud-config-api.ts`
（`CloudConfigService`，方法失败抛 kernel `CommandError`）。插件 `inject: ['cloudConfig']`，
服务未发布时该插件不会被加载；测试用 `createTestHost({ provide: { cloudConfig } })`。
Rust 参照：`src-tauri/src/cloud_config_commands.rs` 与 `dstu-sync/src/cloud_config_commands.rs`。

## diagnostics / devtools

`toggle_devtools` 通过 shell op `webview.toggle_devtools` 切换调用方窗口并在成功时返回切换后的
布尔状态；参数带 `__window`（调用方窗口 label），失败以字符串错误返回。该 op 由 F2 在
`electron/main.ts` / `electron/shell` 实现（Electron `webContents.isDevToolsOpened()` +
`toggleDevTools()`）；Rust 参照 `debug_commands.rs:462–483`。

`ctx.diagnostics`（`diagnostics/api.ts`）：`checkPackageManager` / `checkAllPackageManagers` /
`autoInstallPackageManager`，对应 `check_package_manager` / `check_all_package_managers` /
`auto_install_package_manager`（实现见 `diagnostics/package-manager.ts`）。

`ctx.backgroundTasks`（`createBackgroundTasks`，对应 `dstu-platform/background_tasks.rs`）：
`spawn(task)` 在准入关闭后返回 `null` 并记 warn（Rust `spawn` 返回 `Option<JoinHandle>`），
`size` 对应 `BACKGROUND_TASKS.len()`，`shutdown()` 先关闭准入再等待在途任务、最多 5 秒
（超时不取消任务）。X4/W17 的宿主生命周期直接复用该接口，不另建框架。

## log

- `ctx.log.write(level, target, msg)` / `ctx.log.logger(target)`：主日志，过滤规则同
  lib.rs:788-807（全局 Info；`lance`、`lance_encoding`、`lance_io`、`tracing`、`h2`、`hyper`、`rustls`、
  `reqwest` 为 Warn）。行格式 `[YYYY-MM-DD][HH:MM:SS][LEVEL][target] message`（本地时间；
  `timezone_strategy(UseLocal)` 让 level 排在 target 前）。轮转同 tauri-plugin-log 2.8.0
  `RotatingFile`（`KeepSome(5)`，10 MiB）。
- `ctx.log.structured`：`DebugLogger`（`write_debug_logs` 命令写前端日志用 `writeFrontendEntries`）。
- `ctx.log.debugLogs`：LLM 请求/响应调试日志与 `get_debug_logs_info`/`clear_debug_logs`/
  `cleanup_old_debug_logs`/`ensure_debug_log_dir`/`read_debug_log_file` 的实现函数。
- `ctx.log.writeCrashLog(error)`：崩溃日志；`index.ts` 的插件在 Host 进程注册
  `uncaughtException` 钩子写入（对应 panic hook）。
- 脱敏：`redactSensitiveText` / `redactSensitiveFields` / `sanitizeForLevel` / `scrubPii`。
- Cordis 日志桥接（`cordis-bridge.ts`）：`dstu.platform.log` 装载时把 Cordis `ctx.logger` 桥接到主日志，
  插件的 `ctx.logger(name).error/warn/info/debug` 以 target `dstu_host::<name>`（logger 名为空时为 `dstu_host`）
  写入 `deep-student.log`，再按上面的 `level_for` 规则过滤（debug 不落盘）；文本与 stderr 相同，时间取记录产生时刻。
  装载前留在 Cordis 内存缓冲里的记录按序补写一次；写盘失败不抛给记日志的插件，只在 stderr 提示一次。
  Host 入口另把同样的记录写到 stderr（`host/kernel/log-export.ts`），log 插件装载前的启动失败只能看 stderr 与 `HostFatal`。

本目录只提供服务；上述 Tauri 命令的注册（`write_debug_logs`、`get_debug_logs_info`、
`secure_*`）由拥有这些命令的 lane 插件调用本服务完成。

## sqlite busy（生产只用 `busy_timeout`；`nativeSqliteBusy` 仅测试）

主代理决定（2026-11-07）：锁争用在生产中只靠 `busy_timeout` 加 `BEGIN IMMEDIATE`，与 Rust 生产一致——dstu-sync
`sync/state.rs:33` 只设 `busy_timeout(5s)`，`:237` 用 `TransactionBehavior::Immediate`，`Connection::busy_handler` 只出现在
`#[cfg(test)]`（`:560` 之后，用来让竞争确定性地暂停）。

- 生产开库：F3 `Connection`（`ctx.storage` 与 `openStartupDatabase`）以 better-sqlite3 `timeout: 5000` 打开，即同一个
  `sqlite3_busy_timeout`，profile 的 `busyTimeoutMs` 可覆盖；事务用 `begin('immediate')`。纯 JS，不需要任何预编译。
- `nativeSqliteBusy`（`native/sqlite-busy/`，`sqlite3_busy_handler` 的 N-API 扩展）只给等价性测试复现 Rust 的
  `#[cfg(test)]` 握手用：预编译只有 linux-x64（darwin-arm64 的测试用预编译由 W06 补），打包后 `loadExtension` 也看不到
  app.asar 内的路径。`dstu.native` 仍登记该服务（存储测试经 `ctx.nativeSqliteBusy` 取用），绑定在第一次
  `setBusyHandler` 时才加载，装载插件不会触碰它；没有预编译的平台上调用报
  `no prebuilt f7-sqlite-busy binding for <platform> (test-only module; production uses busy_timeout)`。
- 守卫：`native/tests/sqlite-busy-production.test.ts` 扫描 `host/`、`electron/` 的生产源码，只允许 `native/` 自身与存储层的
  可选开库参数（`storage/connection.ts`、`storage/startup-database.ts`）出现 `nativeSqliteBusy` / `setBusyHandler(`，
  新增使用方直接失败；同时断言生产开库读回 `busy_timeout = 5000`，未传服务时 `setBusyHandler` 抛 `INVALID_PARAM`。
  以后若确需自定义 handler，要先补齐 darwin / win32 预编译和 asar 路径（方案见 `electron/W06-PROGRESS.md` 第六轮），
  再改这份决定。

---

# 可移植平台服务：`ctx.files` · `ctx.crypto` · `ctx.http`（W14）

目的：业务插件（`host/plugins/**`）不再直接 import `node:fs`、`node:crypto`、`node:os`、`node:child_process`、
`node:worker_threads`、`node:net` 等 Node 专有模块和原生模块，一律经平台服务访问文件、加密与网络，
为移动端（Capacitor + 共享 TS 内核）铺路。三个服务的写法与上面的平台服务相同：`api.ts` 冻结接口
（只用 `Uint8Array`、字符串、Web Streams、标准 `Response` 和普通对象，不出现 `Buffer`、`fs.Stats`、
`stream.Readable`、undici `Dispatcher`），`index.ts` 是桌面实现与 Cordis 插件（`ctx.reflect.provide`），
测试可直接用 `create*` 工厂。三者都已进入 `desktop.json`；插件在 `inject` 里声明 `files` / `crypto` / `http` 即可使用。

| 服务 | 插件 id | 依赖 | 桌面实现 | 移动端 |
|---|---|---|---|---|
| `ctx.files` | `dstu.platform.files` | `paths` | `createNodeFiles`（`node:fs/promises`） | 原型阶段：Capacitor Filesystem / OPFS（见下） |
| `ctx.crypto` | `dstu.platform.crypto` | 无 | `createNodeCrypto`（`node:crypto`） | **已实现**：`crypto/mobile.ts` → `createWebCrypto` |
| `ctx.http` | `dstu.platform.http` | 无 | `createDesktopHttp`（传输层 `http/proxy.ts`） | 原型阶段：原生 HTTP（见下） |

## files

接口：`host/platform/files/api.ts`。全部异步（移动端没有同步文件 API）。

| 方法 | 语义 |
|---|---|
| `readBytes(path, {maxBytes?, signal?})` / `readText(path, {invalidUtf8?})` | 读整个文件；超过 `maxBytes` 抛 `TooLarge`。`readText` 默认把非法 UTF-8 替换为 U+FFFD（同 Node `readFile(p,'utf8')`），`invalidUtf8:'error'` 时抛 `InvalidData`（同 Rust `read_to_string`）；BOM 原样保留 |
| `writeBytes` / `writeText(path, data, {createParents?, exclusive?, unixMode?})` | 覆盖写；`exclusive` 已存在抛 `AlreadyExists`；新文件默认 0o666（受 umask） |
| `append(path, data, {createParents?})` | 追加 |
| `writeAtomic(path, data, {createParents?, unixMode?, durable?})` | 同目录临时文件 → write → fsync → rename，复用 `util/durable-fs.ts` 的 `atomicWriteFile`；默认 0o600（tempfile 语义），显式 `unixMode` 精确设置；`durable` 再 fsync 父目录 |
| `openRead(path, {start?, end?, chunkSize?})` | `ReadableStream<Uint8Array>`，`end` 不含，默认 64 KiB 一块；`cancel()` 关闭句柄 |
| `openWrite(path, {mode?, createParents?})` | `WritableStream<Uint8Array>`；`mode` = `overwrite` / `append` / `exclusive` / `atomic`（`close()` 时 fsync + rename，`abort()` 删除临时文件，目标不变） |
| `stat(path, {followSymlinks?})` / `exists(path)` | `FileStat {kind, size, modifiedMs, createdMs, unixMode}`；`exists` 同 Rust `Path::exists`（元数据错误返回 false，但越界仍抛） |
| `readDir(path)` / `walk(path, {maxDepth?, includeDirectories?})` | 按名称 UTF-16 码元排序；`walk` 先序、不跟随符号链接进入目录，条目带 `relativePath`（`/` 分隔）与 `depth` |
| `mkdir(path, {recursive?=true})` / `rename(from, to, {overwrite?, createParents?})` / `copyFile(from, to, {overwrite?})` / `rm(path, {recursive?, force?})` | `rm` 非递归时只删文件或空目录；拒绝删除允许根或作用域根本身（`InvalidPath`） |
| `scope(dir)` → `FileScope` | 以目录为根的视图：路径相对该目录（`/` 分隔，Windows 也认 `\`），`..` 越出作用域抛 `OutsideRoots`；`resolve(rel)`、`scope(rel)`；条目 `path` 是相对作用域的路径。**接收不可信文件名（ZIP 条目、模型工具参数、导入包）时用它** |
| `grant(path)` → `{revoke()}` | 临时放行外壳对话框选择的文件/目录（导入、导出、自定义备份目录）。只能传来自对话框或用户显式配置的路径 |
| `roots` / `isAllowed(path)` / `flavor` | 当前允许根（含 grant）、包含判断、路径风味 |
| `backupRoot` | 默认备份根：`appData` 根下的 `recovery/backups`（Rust `default_recovery_backup_dir`），在 A/B 数据槽之外；只给路径不建目录，读写无需 `grant()`。桌面 = `ctx.paths.recoveryBackupsDir`，移动端 = `<AppInfo.dataDir>/recovery/backups`（OPFS）。用户自定义备份目录桌面先 `grant(dir)`，移动端没有（`grant()` 抛 `UnsupportedOnPlatform`）；服务没有 `appData` 根时读取抛 `UnsupportedOnPlatform` |

**允许根**（桌面由 `standardRoots(ctx.paths, platform)` 推导）：`appData`（`ctx.paths.appDataDir`，含全部数据槽）、
`appLocalData`、`appConfig`、`appCache`、`appLog`、`temp`（`ctx.paths.os.temp`）、`legacy`
（Rust 旧版散落位置 `<dataLocal|data|config|home|temp>/deep-student`，如 `sync_state.db`、旧 `.device_id`）、`granted`。

**包含判断**（`files/path.ts`，纯函数，移动端复用）：绝对路径按组件规范化（折叠分隔符、丢弃 `.`、词法消解 `..`），
再按组件判断是否落在某个根内（`/a/bc` 不在 `/a/b` 内），参照 W07 `attachment-utils.ts` 的 `rustComponents` / `isInside`。
Windows：只认 `X:\` 与 `\\server\share\` 根，`\\?\` 前缀去掉后同等处理，`\\.\` 设备路径、`C:foo`、`\foo` 不是绝对路径；
大小写不敏感；拒绝含 `:`（备用数据流）、`<>"|?*`/控制字符、以 `.` 或空格结尾（Win32 会悄悄去掉）、`CON`/`NUL`/`COM1` 等设备名的组件。
桌面实现另外对**真实路径**再判一次：最深的已存在祖先 `realpath` 后拼接其余组件，必须落在某个根的真实路径内
（macOS `/var` → `/private/var` 两边一致）。跟随型操作（读、写、stat、列目录、复制）解析到目标本身，
条目型操作（`rm`、`rename`、`lstat`、`mkdir`）只解析父目录：根内指向根外的符号链接本身可以删除，但不能经由它读写。
这是防误用护栏，两次判断之间有 TOCTOU 窗口，不防与本进程竞争的恶意本地程序。

**错误**：唯一错误类型 `FileError {kind, operation, path, osCode}`。`kind` 与 Rust `io::ErrorKind` 同名
（`NotFound`、`AlreadyExists`、`PermissionDenied`、`NotADirectory`、`IsADirectory`、`DirectoryNotEmpty`、`StorageFull`、
`ReadOnlyFilesystem`、`CrossesDevices`、`InvalidData`、`Other`），另加 `OutsideRoots`、`InvalidPath`、`TooLarge`。
`message` 沿用平台既有 `ioMessage`（Rust `io::Error` Display，如 `No such file or directory (os error 2)`）。
中止（`signal`）原样抛 `AbortError`。`isFileNotFound(error)` 替代 `error.code === 'ENOENT'`。

**移动端实现（原型阶段）**：

- 线程：Capacitor 插件只能在主 WebView 线程调用，而 host 跑在 Web Worker 里。两种做法，原型阶段实测后选定：
  (a) worker 内的 `ctx.files` 经 `messagePortTransport` 把调用转给主线程适配器（与 shell 请求同一模式）；
  (b) host 自有数据放 OPFS（worker 内可用 `createSyncAccessHandle`，也是 SQLite WASM 的推荐存储），
  只有用户可见的导入/导出文件走 Capacitor。建议 (b) 为主、(a) 处理导入导出。
- 根：启动时 `Filesystem.getUri({ directory: Directory.Data | Directory.Cache | Directory.Library, path: '' })`，
  映射到 `appData` / `appCache` / `temp`；`legacy` 不存在；风味固定 `posix`。只做词法包含判断（应用沙箱内没有符号链接问题）。
- 方法映射：`readText` → `readFile({ path, encoding: Encoding.UTF8 })`；`readBytes` → `readFile({ path })` 得到 base64，
  用 `ctx.crypto.fromBase64` 解码；`writeBytes` → `writeFile({ path, data: toBase64(bytes), recursive: createParents })`；
  `exclusive` 先 `stat`；`append` → `appendFile`；`writeAtomic` / `openWrite({mode:'atomic'})` → 写临时文件后 `rename`；
  `openRead` → `fetch(Capacitor.convertFileSrc(uri))` 的 `Response.body`（`start`/`end` 用 `Range` 头），避免大文件经桥接 base64；
  `openWrite` → 分块 `appendFile`；`stat` → `stat`（`type`/`size`/`mtime`/`ctime`）；`readDir` → `readdir`；
  `mkdir` / `rm` / `rename` / `copyFile` → `mkdir` / `rmdir` 或 `deleteFile` / `rename` / `copy`。
  OPFS 版本：`navigator.storage.getDirectory()` 逐级 `getDirectoryHandle` / `getFileHandle`，`createWritable()` 天然是 `WritableStream`。
- 错误按同一 `FileErrorKind` 映射（Capacitor 的 `OS-PLUG-FILE-0008` 等错误码 → `NotFound` 等），`osCode` 填原生码。

## crypto

接口：`host/platform/crypto/api.ts`。两个实现输出逐字节一致，`tests/crypto.test.ts` 对两者跑同一套向量
（FIPS 180、RFC 2202/4231、GCM 规范 Test Case 3/4/16、RFC 4648），并互相加解密。

| 方法 | 语义 |
|---|---|
| `digest(alg, data)` / `sha256` / `sha256Hex` / `sha1Hex` | 异步摘要，`alg` = `SHA-1`/`SHA-256`/`SHA-384`/`SHA-512`（WebCrypto 名）；字符串按 UTF-8 |
| `digestSync` / `sha256HexSync` / `createHasher(alg)` | 同步与增量摘要；`Hasher.update().digest()/digestHex()`，结束后再用抛 `HasherFinalized` |
| `hmac(alg, key, data)` / `hmacSync` | HMAC；空密钥按 RFC 2104 补零（WebCrypto 本身拒绝零长度密钥，Web 实现用等价的全零块密钥） |
| `randomBytes(n)` / `randomUUID()` / `randomInt(min, max)` | 同步（WebCrypto 的 `getRandomValues` / `randomUUID` 是同步的）；`randomInt` 为 `[min,max)`，约束同 `node:crypto`（安全整数、`max-min < 2^48`），Web 实现用 48 位拒绝采样 |
| `aesGcmEncrypt({key, iv, plaintext, additionalData?, tagLength?})` | 返回 `ciphertext ‖ tag`（WebCrypto 格式）；密钥 16/24/32 字节，`iv` 非空，`tagLength` 12–16（默认 16） |
| `aesGcmDecrypt({key, iv, ciphertext, additionalData?, tagLength?})` | 认证失败抛 `DecryptFailed`；参数非法在触碰密码学之前抛 `InvalidKey` / `InvalidIv` / `InvalidArgument` |
| `timingSafeEqual(a, b)` | 定长比较；长度不同直接 false |
| `toHex` / `fromHex` / `toBase64` / `fromBase64` / `utf8Encode` / `utf8Decode` | 编码。`fromHex` 遇非法字符抛错（不像 Buffer 截断）；`fromBase64` 为 WHATWG forgiving-base64（忽略 ASCII 空白、`=` 可省、`alphabet: 'standard' \| 'url' \| 'either'`）；`toBase64` 默认 standard 补 `=`、url 不补（同 Node `base64` / `base64url`）；`utf8Decode` 默认替换非法序列，`fatal: true` 抛错 |

- 返回值一律是普通 `Uint8Array`（Node 实现也把 `Buffer` 转成同内存视图），不能再对结果调用 `.toString('hex')`。
- 同步还是异步：一次性大块数据用异步 `digest`（移动端走原生 WebCrypto）；必须同步的旧调用点用 `*Sync`；流式数据用 `createHasher`。
  WebCrypto 没有同步与增量摘要，Web 实现的这部分用已有依赖 `@noble/hashes`（纯 JS，不依赖 Node）；
  异步方法只调用注入的 WebCrypto 对象（测试用代理逐个核对调用路径）。
- 需要 Rust `base64::STANDARD` 的严格语义（canonical 填充、逐字错误文案）时继续用 `host/platform/util` 的 `decodeBase64Standard`。
- 编码函数也可不经 ctx 直接 import：`host/platform/crypto/encoding.ts`（纯函数，可移植）。
- `SecureStore` 的 `<key>.enc`（`nonce ‖ AES-256-GCM ‖ tag`）可以用 `aesGcmEncrypt/Decrypt` 逐字节读写（有测试），
  移动端实现 secrets 时不需要 `node:crypto`。
- 移动端：`crypto/mobile.ts`（`platforms: ['mobile']`）提供 Web 实现，已进入 `mobile.json`；
  `crypto/tests/portability.test.ts` 用扫描器断言它的运行时闭包不触达任何 Node 模块。

## http

接口：`host/platform/http/api.ts`。

| 方法 | 语义 |
|---|---|
| `fetch(url, init?)` | WHATWG fetch 语义，返回标准 `Response`；网络失败、超时、中止的错误与全局 `fetch` 相同（`TypeError` / `TimeoutError` / `AbortError`），迁移只需把 `fetch` 换成 `ctx.http.fetch`。`init`：`method`、`headers`、`body`（string / `Uint8Array` / `ArrayBuffer` / `Blob` / `FormData` / `URLSearchParams` / `ReadableStream`）、`signal`、`redirect`、`timeoutMs`（覆盖整条重定向链，默认 300 s；`null` 不设总超时，只受 `signal` 约束）、`destination` |
| `fetchBytes(url, {maxBytes?, ...init})` | 一次读完：`{url, status, ok, headers(小写名), bytes}`；超过 `maxBytes`（先看 Content-Length，读取中复核）抛 `TooLarge` |
| `isPublicUrl(url)` | net-policy `isSafeRemoteUrl` |

- 只接受 http/https，否则抛 `HttpError('InvalidUrl')`。`HttpError` 继承 `TypeError`，只认 fetch 网络错误的旧代码表现不变。
- 桌面 webhook 专用 `postAllowlistedDirect(endpoint, allowedHosts, body, headers)`（`http/allowlisted-direct.ts`，从 http 入口导出）：
  仅供用户显式配置的 receiver，host 精确匹配白名单（不支持通配符）；允许白名单内私网，HTTPS 必需（localhost/127.0.0.1/::1 可用 HTTP），
  拒绝 URL 内凭据。每次请求独立 Agent，完全绕过环境/系统代理、不跟随重定向，30 秒总超时覆盖正文读取，TLS 正常验签。
  不用于模型/网页提供的任意 URL，不改变 `ctx.http` 既有策略。webhook provider 从 `connectors.webhook.allowed_hosts` 读取 JSON 字符串数组，
  按 registry 的敏感 `secretSettingKey` 读取安全存储；submit/lookup 均发送 HMAC-SHA256 与系统幂等键，回执读取上限 1 MiB。
- `destination: 'any'`（默认）：任意目标——用户配置的服务、局域网 Ollama/WebDAV、本机 MCP 桥。
  `destination: 'public'`：URL 来自不可信内容（模型输出、网页/文档链接、远程图片）时必须使用。先按 `isSafeRemoteUrl`
  拒绝私网、链路本地、云元数据和解析失败的地址（回环放行，同 Rust `is_blocked_internal_ip`），`follow` 时由策略层逐跳跟随：
  每一跳重新判定，只对 GET/HEAD 跟随（其他方法遇到重定向抛 `RedirectBlocked`，不重放请求体），跨源去掉
  `authorization`/`cookie` 等凭据头，最多 10 跳。已知局限：DNS 判定与真正连接之间可能被 DNS rebinding 绕过（Rust 同样如此）。
- `destination: 'public-pinned'`（W14，完整规格见 `http/PINNED.md`）：用途同 `public`（`web_fetch` 这类 URL 来自不可信内容的请求），
  另外挡住 DNS rebinding。由传输层自己解析主机名（IP 字面量不解析），**全部**解析结果都必须允许（`pickPinnedAddress`：
  net-policy `isBlockedInternalIp` 拒绝的地址一律拒绝，回环默认也拒绝），然后直连第一个地址。不走任何代理（环境变量与系统代理都不生效），
  每个请求单独建连接、不复用连接池；TLS SNI、证书校验与 `Host` 头仍用 URL 的主机名。重定向：`follow` 只对 GET/HEAD、最多 10 跳，
  每一跳重新解析、校验、钉住；`manual` 原样返回 3xx，调用方对 `Location` 再发一次 `public-pinned` 请求，同样会重新校验。
  拒绝时抛 `HttpError('BlockedDestination')`，`reason` 为 `dns-failed` / `no-address` / `blocked-address`（`address` 字段是被拒的地址）。
  与 `public` 的区别：`public` 放行回环（同 Rust `is_blocked_internal_ip`），判定与连接分两步（会被 rebinding 绕过），并且经过代理；
  `public-pinned` 默认拒绝回环，判定与连接用同一个地址，并且不经代理。
- `allowLoopback`（默认 false，只对 `public-pinned` 生效，其他 destination 忽略）：额外放行回环地址，私网、链路本地等仍然拒绝。
  只在用户已批准访问本机、且请求 URL 本身指向本机（回环字面量或 `localhost`）时打开。传输层不核对 URL，由调用方按 URL 决定；
  若按解析结果决定，一个解析到 `127.0.0.1` 的公网域名也会被放行。
- **`UnsupportedOnPlatform`**：策略层没有钉住传输时（`createHttpService` 未传 `pinnedTransport`，目前除桌面外的所有实现），
  `public-pinned` 请求抛 `HttpError('UnsupportedOnPlatform')`，**不会退化成 `public`**。消息以
  `UNSUPPORTED_ON_PLATFORM: http.destination.publicPinned is not available on <platform>` 开头，`capability`
  （`PUBLIC_PINNED_CAPABILITY`）与 `platform` 字段和平台能力清单（`mobile/src/capabilities.ts`）一致。这个前缀与存储层
  `StorageError`、插件装载降级原因的 `UNSUPPORTED_ON_PLATFORM` 同名同语义（见「共享错误」）。调用方按 `error.kind` 判断，
  例如移动端的 `web_fetch` 应提示“当前平台不支持”，不要换成不钉住的请求重试。
- 代理：传输层是 `http/proxy.ts` 的 `createProxyHttpClient`（由 llm 插件下沉；llm `src/http_proxy.ts` / `src/system_proxy.ts`
  保留原名 re-export，`createLlmHttpClient` 把创建日志接回 llm 日志出口）——`HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY`，
  环境变量全空时读取 macOS/Windows 系统代理及其例外列表（`http/system-proxy.ts`），reqwest 风格的重定向与默认超时、
  `accept-encoding: identity`。**这里没有第二套代理逻辑**；测试用本地代理服务器验证了环境变量、NO_PROXY 与系统代理三条路由。
  目前 Host/外壳里还有另外几处各自的代理实现（`media/src/bilibili-attempt.ts`、`llm-providers/src/openai-codex/manager.ts`、
  `electron/shell/http-client.ts`、`electron/shell/updater.ts`），第二阶段统一到 `ctx.http`。
- 传输层在首次请求时创建，插件卸载时 `close()` 释放连接池。测试可用 `createHttpService({ transport })` 注入传输层，
  或 `createDesktopHttp({ env: {}, platformProxy: async () => null })` 隔离开发者机器上的代理设置。

**移动端实现（原型阶段）**：策略层（`createHttpService`）本身可移植，只需换传输层与 `isPublicUrl`：

- 传输层：`CapacitorHttp.request({ url, method, headers, data, responseType: 'arraybuffer', connectTimeout, readTimeout })`
  （原生 HTTP，绕过 WebView CORS，自动使用系统代理），把结果包装成标准 `Response`。Capacitor 插件只在主线程可用，
  worker 内经 `messagePortTransport` 转发。原生 HTTP 一次性返回响应体，`fetchBytes` 是自然形态；
  **LLM 流式（SSE）需要逐块响应**，`CapacitorHttp` 不支持流式，需要原生流式插件或在 WebView 内直接 `fetch`
  （受 provider 的 CORS 策略限制）——这是移动端原型要验证的风险项。
- `isPublicUrl`：WebView 里没有 DNS 解析 API，纯 JS 只能判定 IP 字面量与 `localhost` 类主机名；完整判定需要原生 DNS 插件，
  或在原生侧连接后检查对端地址。原型阶段先做字面量判定并在报告中标注风险。

## 插件平台声明与移动端 profile

- 插件在元数据里声明可装配的平台：`meta: { id, platforms: ['desktop', 'mobile'] }`。**缺省视为 `['desktop']`**，
  所以现有插件不改动就保持原样进入 `desktop.json`，也不会被误装进移动端。只在移动端运行的平台实现声明 `['mobile']`。
  天然只属于桌面的插件（Agent 工作区 shell、MCP stdio、浏览器自动化、大型文档处理、备份治理等）显式声明
  `['desktop']`，扫描器据此豁免它们的 Node 依赖。
- 类型：`PluginMeta.platforms`、`PluginPlatform`、`PLUGIN_PLATFORMS` 定义在 kernel（`host/kernel/core.ts`，经 `api.ts` 导出）；
  缺省值与校验在 `host/profiles/platforms.ts`（`pluginPlatforms(meta)`、`supportsPlatform`）。
  扫描器静态读取该字段，必须写成数组字面量或同文件 `const` 数组。
- 生成：`node host/profiles/generate.ts` 同时生成 `desktop.json` 与 `mobile.json`，`--check` 两个都检查。
  只收录 `platforms` 含目标平台的插件；生成移动端时，目录下有 `mobile.ts` 就用它代替 `index.ts`（同一服务的移动端实现，
  必须声明 `mobile`）。`desktop.json` 的输出与原来相同（本次只多了三个新服务）。
- 现状：`mobile.json` 有 `dstu.platform.crypto`（`crypto/mobile.ts`）与 `dstu.integration`（第一个装进移动端的业务插件）。
  其余插件的标注由插件 owner 在闭包干净后完成。
- 可移植入口：`host/kernel/core.ts`（`definePlugin`、`CommandError`、类型与常量）与 `host/kernel/api.ts` 运行时都不加载 Node；
  `host/platform/errors/api.ts` 同样干净；工具函数用 `host/platform/util/portable.ts`——`util/index.ts` 另含 ZIP（`zip.ts`）、
  QR PNG（`qr.ts`）与返回 `Buffer` 的 `decodeBase64Standard`，属桌面入口。
- 门禁：`node scripts/portability/scan.mjs --profile host/profiles/mobile.json` 检查 profile 中每个模块的运行时闭包
  不触达 Node（`import type` 不计），`crypto/tests/portability.test.ts` 已在测试里执行同一检查。

## 迁移指南：业务插件从 Node 模块迁到平台服务

第二阶段批量迁移的步骤（每个插件一个提交或一个 PR）：

1. 看本插件的现状：`node scripts/portability/scan.mjs --plugins notes --report /tmp/notes.md`（按文件列出依赖与行号）。
2. 在插件 `inject` 里加需要的服务（`'files'`、`'crypto'`、`'http'`），类型从 `host/platform/<服务>/api.ts` `import type`。
3. 按下表替换；同步 I/O 必须改成异步（工作量的大头，扫描报告里的「同步调用」列）。
4. 测试里用工厂或把平台插件装进测试宿主：`createNodeFiles({ roots: [{ name: 'appData', path: tmp }] })`、
   `createNodeCrypto()`（或 `createWebCrypto()`，两者行为一致）、`createDesktopHttp({ env: {}, platformProxy: async () => null })`；
   `createTestHost({ plugins: [paths, files, crypto, http, yourPlugin] })`。
5. 插件的运行时闭包干净后（还取决于下文「门户模块」的拆分），在元数据声明 `platforms: ['desktop', 'mobile']`，
   运行 `node host/profiles/generate.ts` 与 `node scripts/portability/scan.mjs --profile host/profiles/mobile.json`。
6. 运行 `node scripts/portability/scan.mjs --write-baseline` 收紧基线，和代码一起提交。

| 现在的写法 | 改为 |
|---|---|
| `createHash('sha256').update(x).digest('hex')`、各插件的 `sha256Hex` 副本（17 份） | `ctx.crypto.sha256HexSync(x)`（同步调用点）或 `await ctx.crypto.sha256Hex(x)` |
| `createHash('sha1')…` / 大文件分块 `hash.update(chunk)` | `ctx.crypto.digestSync('SHA-1', x)` / `ctx.crypto.createHasher('SHA-256')` |
| `randomUUID()` / `randomBytes(n)` / `randomInt(a, b)` | `ctx.crypto.randomUUID()` / `ctx.crypto.randomBytes(n)`（返回 `Uint8Array`）/ `ctx.crypto.randomInt(a, b)` |
| `buf.toString('hex')` / `Buffer.from(hex, 'hex')` | `ctx.crypto.toHex(bytes)` / `ctx.crypto.fromHex(hex)` |
| `Buffer.from(s, 'base64')` / `buf.toString('base64')` / `'base64url'` | `ctx.crypto.fromBase64(s)`（Rust 严格语义用 `decodeBase64Standard`）/ `ctx.crypto.toBase64(bytes)` / `{ alphabet: 'url' }` |
| `Buffer.from(s, 'utf8')` / `buf.toString('utf8')` / `Buffer.byteLength(s, 'utf8')` | `ctx.crypto.utf8Encode(s)` / `ctx.crypto.utf8Decode(bytes)` / `utf8ByteLength(s)`（`host/platform/util`） |
| `crypto.timingSafeEqual(a, b)` | `ctx.crypto.timingSafeEqual(a, b)` |
| `readFile(p, 'utf8')` / `readFileSync` | `await ctx.files.readText(p)`（Rust `read_to_string` 语义加 `{ invalidUtf8: 'error' }`） |
| `readFile(p)` / `createReadStream(p, {start, end})` | `await ctx.files.readBytes(p, { maxBytes })` / `await ctx.files.openRead(p, { start, end: end + 1 })`（`end` 不含） |
| `writeFile(p, data)` + `mkdir(dirname(p), {recursive:true})` | `await ctx.files.writeBytes(p, data, { createParents: true })` |
| 各插件的原子写副本（agent-workspace、agent-orchestration、backup） | `await ctx.files.writeAtomic(p, data, { createParents: true })` |
| `existsSync(p)` / `statSync(p).isDirectory()` | `await ctx.files.exists(p)` / `(await ctx.files.stat(p)).kind === 'directory'` |
| `readdirSync(dir, {withFileTypes:true})` / 手写递归遍历 | `await ctx.files.readDir(dir)` / `for await (const entry of ctx.files.walk(dir))` |
| `rmSync(p, {recursive:true, force:true})` / `renameSync` / `copyFileSync` | `ctx.files.rm(p, { recursive: true, force: true })` / `rename` / `copyFile` |
| `(error as NodeJS.ErrnoException).code === 'ENOENT'` | `isFileNotFound(error)` 或 `error instanceof FileError && error.kind === 'NotFound'` |
| `join(root, untrustedName)` 再判断是否越界 | `ctx.files.scope(root).writeBytes(untrustedName, bytes)`（越界抛 `OutsideRoots`） |
| 读写外壳对话框选择的路径 | `const grant = ctx.files.grant(picked); try { … } finally { grant.revoke(); }` |
| `fetch(url, init)` / 插件内自建 undici `ProxyAgent` | `ctx.http.fetch(url, init)`（代理统一处理）；内容中的 URL 加 `{ destination: 'public' }` |
| 读完整响应并限大小 | `await ctx.http.fetchBytes(url, { maxBytes, destination: 'public' })` |
| `os.homedir()` / `os.tmpdir()` / `process.platform` | `ctx.paths.os.home` / `ctx.paths.os.temp` / `ctx.app.platform` |
| `import { performance } from 'node:perf_hooks'` / `setTimeout` from `node:timers/promises` | 全局 `performance` / `new Promise((r) => setTimeout(r, ms))` 或 `AbortSignal.timeout(ms)` |
| `NodeJS.Timeout` / `NodeJS.Platform` | `ReturnType<typeof setTimeout>` / `AppInfo['platform']` |
| `child_process` / `worker_threads` / `net` 服务端 | 声明 `platforms: ['desktop']`，或把这部分拆成桌面平台服务、插件只依赖接口 |

示例一（文件 + 哈希，before → after）：

```ts
// before
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function saveAsset(slotDir: string, bytes: Uint8Array): Promise<string> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const target = join(slotDir, 'assets', hash.slice(0, 2), hash);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return hash;
}

// after（inject: ['files', 'crypto']）
async function saveAsset(ctx: Context, slotDir: string, bytes: Uint8Array): Promise<string> {
  const hash = await ctx.crypto.sha256Hex(bytes);
  await ctx.files.scope(slotDir).writeBytes(`assets/${hash.slice(0, 2)}/${hash}`, bytes, { createParents: true });
  return hash;
}
```

示例二（远程图片下载，before → after）：

```ts
// before
const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
const bytes = new Uint8Array(await response.arrayBuffer());
const text = Buffer.from(bytes).toString('base64');

// after（inject: ['http', 'crypto']）：URL 来自模型输出，必须 destination: 'public'
const { ok, bytes } = await ctx.http.fetchBytes(url, { timeoutMs: 10_000, maxBytes: 20 * 1024 * 1024, destination: 'public' });
const text = ctx.crypto.toBase64(bytes);
```

**门户模块（先于插件迁移解决）**：扫描报告「传递依赖」一节显示，插件即使自身干净，也会经由下列以值导入的模块
在运行时加载 Node 模块：

- 已解决（W14 第二轮）：`host/kernel/api.ts`（iLink 移到 `host/plugins/ilink/api.ts`，QR 移到 `platform/util/qr.ts`，
  `ShellError` 拆到 `shell-error.ts`）、`host/platform/errors/api.ts`；新增 `host/kernel/core.ts` 与 `host/platform/util/portable.ts`。
- `host/platform/util/index.ts`（24 个插件）：为兼容仍导出 ZIP / QR / `Buffer` 版 base64。插件把值导入改到
  `util/portable.ts`（只改 import 路径；用到 ZIP、QR 或依赖 `Buffer` 结果的除外）即可去掉这条依赖。
- `host/platform/storage/api.ts`（16 个插件）：值导出把 `connection.ts`（better-sqlite3）、`worker-pool.ts`（`worker_threads`）等带进来；
  插件应只 `import type`，值经 `ctx.storage` 获取。
- 各插件的 `api.ts`（llm、chat、sync、agent-skills …）同理：跨插件只应 `import type` 或引用纯函数文件。

**建议顺序**：门户模块拆分 → 学习伴侣范围内低工作量的插件（memory、review、sync-support、llm-providers、chat-pipeline、chat、llm）
→ 中等（vfs-repos、notes、qbank、vfs、anki）→ 同步链路（sync-providers、sync）。不在学习伴侣范围、带 `child_process` /
`worker_threads` 的插件（agent-workspace、agent-skills、mcp、browser、media 的文档处理部分、backup）优先评估声明仅桌面。

## 可移植性扫描与边界接入

扫描器：`scripts/portability/scan.mjs`（核心 `lib/portability.mjs`，测试 `node --test scripts/portability/scan.test.mjs`）。

- 统计 `host/plugins/<插件>/` 生产代码（不含 `tests/`、`__fixtures__/`、`*.test.*`，口径同 `boundary-rules.mjs` 的 `isTestFile`）
  中的四类依赖：Node 内置模块（按 `service` / `desktop-only` / `web-standard` 分档）、原生模块（better-sqlite3、koffi、
  `@lancedb/*`、sharp、electron …）、Node 专用包（undici、`@smithy/node-http-handler`、jsdom …）、Node 全局量
  （`Buffer`、`process`、`NodeJS.*` …，值引用与类型位置分开）。只有 `import type` / `export type` / `import('x').T`
  算类型依赖（`verbatimModuleSyntax` 下 `import { type X }` 仍会在运行时加载模块）。
- 输出：控制台摘要；`--json <file>`（逐文件结果，含行号与替代方案）；`--report <file>`（可读报告：总览、依赖分布、按插件排序的
  工作量、仅桌面候选、传递依赖门户）；当前报告见 `scripts/portability/REPORT.md`。
- 基线：`scripts/portability/baseline.json` 记录每个生产文件已有的依赖键（`node-builtin:fs`、`node-global:Buffer` …，按出现与否，
  不按次数，避免行号漂移）。`--check` 只报告基线之外的新增（文件, 依赖键），有则退出 1；已声明 `platforms: ['desktop']`
  的插件豁免。依赖消除后运行 `--write-baseline` 收紧（基线只应变小）。
- profile 检查：`--profile host/profiles/mobile.json`，profile 中任一模块的运行时闭包触达 Node 即退出 1。

**接入 W09 的边界检查**（`scripts/electron-migration/lib/boundary-rules.mjs` 归 W09，W14 不改）。两种方式任选：

1. 门禁里直接加两条命令：`node scripts/portability/scan.mjs --check` 与
   `node scripts/portability/scan.mjs --profile host/profiles/mobile.json`。
2. 在 `boundary-rules.mjs` 加规则 `node-portability`，逐文件复用扫描核心：

```js
import { analyzeSource, declaredPlatforms, findingKey } from '../../portability/lib/portability.mjs';
// RULES['node-portability'] = '业务插件不得新增 Node 专有依赖（走 ctx.files / ctx.crypto / ctx.http；仅桌面插件声明 platforms）';
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/portability/baseline.json'), 'utf8')).files;
// 在 checkFile(rel, text) 中，对 host/plugins/<p>/ 的非测试文件：
if (plugin && !test && !isDeclaredDesktopOnly(plugin)) {   // isDeclaredDesktopOnly：declaredPlatforms(读 index.ts) 等于 ['desktop']，按插件缓存
  const allowed = new Set(baseline[rel] ?? []);
  for (const finding of analyzeSource(rel, text).findings) {
    if (!allowed.has(findingKey(finding))) out.push({ rule: 'node-portability', file: rel, line: finding.line, col: 1, message: `${RULES['node-portability']}：${finding.specifier}` });
  }
}
```

当前基线数字（提交时）：26 个插件、1430 个生产文件；1008 个（70.5%）不 import 任何 Node 专有模块/原生模块/Node 专用包，
893 个（62.5%）运行时可移植（另外也不在值位置用 `Buffer`/`process`）；基线 541 个文件、1166 条；有 Node 依赖的文件中
`*Sync(` 调用 1235 处；估算总工作量约 74 人日，其中学习伴侣范围约 35 人日（口径见报告）。
与主代理实测的「1375 个文件、74%」不完全一致，属于统计口径差异：本扫描把 `node:path`、`node:perf_hooks` 等也计为
Node 专有依赖（不计 `node:path` 时为 72.0%），文件范围以 `isSourceFile` / `isTestFile` 为准。

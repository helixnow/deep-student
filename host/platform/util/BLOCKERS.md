# F4 共享 JSON / base64 解码原语

## F4-V2-JSON（L11 V2-PDF-JSON、L12 R12-08、F3-V2-01..03、L23 P04）

不新增依赖（原先申请的 jsonc-parser 已撤回，lossless-json 也未获批）。正式出口为 `host/platform/util/api.ts`
（`index.ts` 同名转出）：

- `JsonReader`：serde_json 1.0.149 `Deserializer<StrRead>` 的流式读取面，由 typed decoder 按 serde derive
  顺序逐字段消费，所以字段类型错误、已知字段重复会先于后续语法错误和尾随字符报出（R4 c5304d793
  的 `version:false` 加尾随 x、已知字段重复且第二个值是 `!` 两个反例）。数字按 `ParserNumber` 分类，
  `-0` 算 F64；u64/i64 用 bigint 保持全精度。已消费文本按 UTF-8 字节计（emoji 计 4），
  peek_error 只计尚未消费的第一个字节，不是整个字符。
- `parseJsonDocument` / `readValue` + `objectLastWins`：Value/arbitrary_precision（保留数字 raw、成员序列、last-wins）。
- `skipIgnoredValue()`：精确 IgnoredAny，独立迭代栈；不构造节点、不做数字有限性/字符串代理项配对检查、
  不扣 typed 深度，但仍检查词法/结构。旧 `skipValue` / `nextKey` 隐式丢弃语义不变，不能代替此方法。
- `endArray()` / `readEnumVariant()` / `endEnumObject()`：固定位置 struct/tuple 和外标签 enum 的收尾接缝，
  不用 `nextItem` / `nextKey` 预读多余值来模拟错误位置；defaults/invalid_length/变体校验由字段所有者完成。
- 已知字段集合、alias 冲突、default、必填、`deny_unknown_fields` 由各 struct 所有者用 reader 实现；
  原语不把 Value 规则和 struct 规则混在一起。

第一个生产消费方是 F4 `settings/backup-config.ts`（`backup.config`、`backup.auto_backup_status`），
回归测试走真实 settings 和 kernel invoke：`settings/tests/backup-decoding.test.ts`。

**迁移边界：** R4 c5304d793 的历史 -0、emoji 列和首错反例针对当时 L23 私有 parser，
不据旧记录宣称新 main 的 L23 仍有同样失败。业务 owner 是否/何时改用共享 reader 由该 owner 负责；
F4 不跨 lane 改实现，也不新增第三个 parser。

**未闭合（不宣称等价）：**
- 没有和 Rust 实际输出做差分对照（不能运行 cargo）。位置与 Display 按 serde_json 1.0.149
  的 `de.rs`/`read.rs`/`error.rs` 及 serde_derive 1.0.228 源码逐条实现，测试只覆盖其中列出的情形。
- EOF/控制字符/代理项/enum/固定长度数组已有明确向量，不把已测向量推广为所有 Unicode/字节域/错误分支签收。
- `deserialize_struct` 的数组形式由 owner 用 `beginArray/nextItem/endArray` 按原字段声明实现，
  不能把 `Option` 在 map 可缺省等同于 seq 有 serde(default)。

## from_slice 字节读取（WP-130，供方候选）

`parseJsonDocumentBytes(bytes)` / `JsonReader.fromSlice(bytes)` 复用同一个 reader：输入按每字节一个单元读取，
位置按字节推进，字符串内容收集原始字节，闭合引号后按 `as_str`（read.rs:868）校验 UTF-8。
同时把 `\u` 四位 hex 改为 SliceRead::decode_hex_escape（read.rs:621-635）：不足 4 字节先消费到末尾报 EOF，
否则先读满 4 字节再判 hex；string API 的 `"\uX000"` 由 column 4 改为 column 7（与 IgnoredAny 原有用例一致）。

**未闭合：**
- 只验证了 Value 路径（parseJsonDocumentBytes）和 readString/skipIgnoredValue 的少量用例；typed DTO 的 from_slice 解码未逐一签收。
- 没有 Rust 实际输出差分（不运行 cargo）。
- string API 仍以 UTF-16 码点推进：`parse_ident`、`-` 后数字、`\ud800` 后不是 `\u` 时遇到非 ASCII 字符，
  Rust 只消费 1 字节，这里消费整个字符，column 偏大（多字节宽度 − 1）。字节 API 无此差异。本包未改 string API 的这几处。
- L02 尚未接入；接入与 HTTP 测试由 L02 另包完成。

## base64（F3 请求 2、L01/L04）

`decodeBase64Standard` 有两个版本，错误文案相同：`util/base64-core.ts` 返回 `Uint8Array`，从 `util/portable.ts`、
`util/api.ts`、`util/index.ts` 发布；`util/base64.ts` 返回 `Buffer`，只从桌面入口 `util/node.ts` 发布，
`secrets/crypto-service.ts` 保留它的 re-export。

## 公开数值语义（typed 与 Value 不混用）

- `readNumber(expected): JsonNumber` / `readUnsigned` / `readSigned` 仍走 typed ParserNumber：
  u64/i64 的 `.value` 为 bigint，f64 的 `.value` 为有限 number，均保留 `.raw`。
  `-0` / 小数 / 指数是 F64；`1e400` 报 number out of range。没有新增 arbitrary typed 变体。
- `readValue(): JsonNode` / `parseJsonDocument(text): JsonNode` 走任意精度 Value 词法：
  数字 `.value` 类型为 `JsonValueNumber = JsonNumber | {kind:'arbitrary',raw:string}`。
  超 f64 有限范围时只有 raw，没有 `.value` 数值，不制造 Infinity 占位；其余数字分类/数值是投影提示，
  **raw 才是精度依据**，不是完整 serde_json::Number 的 from_value 解码/序列化语义。
- Value 序列化需保留数值 token 及 Rust 数字规范化（如 E/指数正号、整数 -0），不能把 raw 加引号变业务 string；
  from_value 到 f64/usize/i64 等字段则由 owner 按对应 Rust 实现做类型/范围判断，不能统一拒绝或统一 Number。
  特别是 from_str typed 与 from_value 的接受/报错路径不同，不用 parser 的投影 kind 一刀切。
- 不放宽输入 null，不把 f32ToJsonNumber 的出站非有限→null 规则用于输入，也不更改冻结 JsonValue 全局类型。

### L21 请求的正式保存接缝（2026-11-05）

- `util/api.ts` / `util/index.ts` 新增 `jsonNumberToRawJSON(JsonValueNumber): JsonRawNumber`：
  原子以标准 JSON.rawJSON 保留数字，不新增 arbitrary.value；合法 1e999 保存为数字 1e+999，
  不是字符串或 null。已有 u64/i64 bigint replacer 可与之共用；不能 clone/spread 原子后再序列化。
  原子不作为 IPC DTO；跨进程/最终 wire 数值策略仍由字段 owner 明确处理，不继承存储原子的语义。
- `stringifyJsonValue(JsonNode): string` 给需要 compact Value/preserve_order 的保存路径，
  不先经过普通 JS 对象（整数样式键会被 JS 重排）。现有 F4 本地化错误字符串改用同一实现，
  没有新增 parser 或另维护第二套数值 formatter。
- 该接缝只处理已验证的 Value 树/数字；L21 AuditOperation.uint 的 typed/enum 域判断仍由 L21 完成。
  不以合法 Value 数字的持久化能力放宽 typed 数值输入，不把坏 JSON fallback 推广到合法 1e999。
- 定向 job `20261105005822-d0b386` Node 18 passed、`20261105005835-ec4a61` Electron 4 passed，
  均 exit 0。覆盖 raw native 原子、bigint replacer、-0/float 原文/指数、精确大整数、对象首键序与
  last-wins、typed 溢出继续拒绝。不是 L21 真实 audit/save 消费签收；待正常同树联合接入复验。

## 当前 consumer 联合接线阻塞（2026-11-05，完整 tsc 已核）

C2 要求固定新合并树 `51a041d88c5c77df93a31a402c459149533707ea`（main
`c6309183c4cddc06b3647530f3306f7906f2295b`），完整 typecheck 作业 `20261105001519-08b811`
已完成，**exit 2：10 条 TS2339 / 8 个位置 / 5 个文件 / 4 个 owner**，无 F4 路径错误。
完整原输出保留在 `/home/dsdev/.oc-jobs/done/20261105001519-08b811.log`，不是 gate-excerpt 截断摘要。
作业等待期间 TS/package/config 未改动，固定树相对当前工作区只有本文档 diff。
这是 F4 新联合类型与新 main consumer 的组合失败，不声称不含候选的 main 本身有这些错误。

| owner / 文件位置 | 当前消费路径 | 必须由 owner 决定的语义 |
|---|---|---|
| L21 `backup/repository/audit.ts:199:33` | `decodeAuditOperation` 的 `uint`，读取 internally tagged enum 中 u32/u64/usize 字段 | 先 readValue 不等于 typed ParserNumber；按该 enum 实际 serde 路径判数字类型/范围，不以非 f64 就假定有 bigint `.value` |
| L22 `integration/src/stream-context.ts:220:96` | `encodeValue`，从 JsonNode 序列化 Value | arbitrary 与其他数值 token 保留/规范化，而不是 `.value.toString()`、Infinity 或 JSON 字符串占位 |
| L18 `media/src/text-formats.ts:59:48` | `prettyJson`，JSON 文本抽取的 Value pretty 输出 | arbitrary_precision Value 数字不等同于 f64，不能改写为 null 或舍入 |
| L18 `media/src/vlm-serde.ts:58:75` | `f64(node)`，Value 到 bbox 字段读取 | 按真实 from_str/from_value 路径解码数值，不能把所有非 f64 kind 都当有 bigint `.value` |
| L18 `media/src/vlm-serde.ts:202:92` | `valueFromNode`，Value 投影为旧 JsonValue | 确认内部/IPC 边界与精度保留方案，不无条件 Number，不伪造 Infinity 来抹类型错 |
| L18 `media/src/vlm-serde.ts:241:99` | `serializeJsonNode`，Value compact 输出/检查点 | 同 Value 数字规范化；与该文件真实 typed VlmPageAnalysis 的 f64 serializer 区分 |
| L14 `qbank/src/question-import-service.ts:175:45 / 175:84 / 175:104` | `nodeToValue` / `valueFromStr`（同一语句三条诊断） | 明确旧 JsonValue 域能否表达原 Value，不能直接读联合所有成员的 `.value` |
| L14 `qbank/src/question-import-service.ts:589:22` | `isSchemaVersionTwo`，Value::as_i64 比较 2 | 显式判定原 Rust 的整数/范围规则，不能用“非 f64”当作“必有 bigint value” |

历史首次上报 `2026-11-04T163253228Z-F4-security.md` 仅列 L22/L14；随后
`2026-11-04T204709875Z-F4-security.md` 已补 L18，旧两 owner 清单不是当前完整范围。
本次完整 tsc 又确认 L21 `audit.ts:199:33`，联合范围必须包含上述四个 owner，不能只修前三者后声称清零。
F4 不修改这些 lane，不增补伪造 value/Infinity。按 C2 指令只转架构/C1 实际接管者，
不向 parked lane 再追加执行消息；需组合树联合处理后正常 main 再独立复验。

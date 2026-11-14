# V2-02 / X6-UD-0040：ToolCall 提供方与跨 owner 最小接缝

状态：提供方修复候选；**不是模型→L05 端到端闭合**。
依据 C1 在 main `9b3c18601` 的来源定位，本 lane 不编辑 L02/F2/L05 文件，也不恢复停放会话。

## 已确认来源与 Rust 行为

- OpenAI 标准 `function.arguments: string`：Rust `providers/mod.rs` 直接 clone ToolCall。
  本 lane 原路径保留原字符串（包括空白、`1E0` 或尚未组成合法 JSON 的增量），不应在
  提供方提前 parse/规范化。此路径首次确认的普通 JSON.parse 损失在 L02，不误派 L01。
- 非标准 `arguments: object`：本地 parser 暂用 number，但 WeakMap 保存每容器/键的
  原数字字面量；原 `structuredClone(tc)` 丢掉旁带。现改用 `cloneProviderToolCall`。
- Anthropic `content_block_start.input`：Rust `mod.rs:2773` clone Value；捕获 scalar input
  时其数字原文在父容器上，必须先读该字段的精确信息，而不是拿出 number 再 clone。
- Anthropic stop（`:2801-2823`）：空白 buffer 且存在 base input 才用它；否则尝试解析
  buffer 为 Value，失败才 `{}`，然后 serde_json::to_string。合法 null 不是失败。
  签名事件先于 ToolCall，stop 后移除 pending 的原顺序不变。
- serde_json arbitrary_precision 不是原 JSON 文本回放：压缩空白、重复键 last-wins，
  `1E0` / `1e0` 规范化为 `1e+0`，整数 `-0` 变 0，`1.0` 保留浮点形式，完整大整数和
  超 f64 的合法数字原数值保持。依据 serde_json1.0.149 de.rs:938-953,1027-1059。

## 现有公开事件能承载什么

`StreamEvent.ToolCall.value` 仍是 L01 `JsonValue`；标准 arguments 字符串能直接无损携带
上述 JSON 数字 token。非标准对象的精确信息目前是 **同一 Host 内 WeakMap 旁带**，不是
普通 number 本身。默认 `structuredClone`、`JSON.stringify`、IPC/进程传输不会携带旁带。
不得声称普通事件类型已能原生携带 bigint / JsonFloat，或只改 clone 就已全链等价。

## 最小增量公开面（仅 api.ts 两个函数，不改 StreamEvent 联合类型）

```ts
import { cloneProviderToolCall, stringifyProviderToolCall } from '../llm-providers/api.ts';
```

1. `cloneProviderToolCall<T extends JsonValue>(value: T): T`：输入是 adapter 直接产出的
   ToolCall.value 或保留旁带的前次副本；输出是同形独立副本，保数字原文元数据。
   不解析标准 arguments 字符串，不能修复之前已普通 JSON.parse/clone 丢掉的信息。
2. `stringifyProviderToolCall(value: JsonValue): string`：将这种完整 ToolCall / 对象参数
   投影到已发布的共享 DbJson bigint/JsonFloat 表示，再调用已有
   `platform/util/lossless-json.ts::stringifyJsonLossless`（即 `sync/api.ts` 转出的同一函数）输出数值 token。**不是** bigint 转字符串值；
   不写第二个 parser/serializer。已脱离源 holder 的裸 scalar number 无原始词法可恢复。

L02 或实际 owner 应在聚合前用前者，在需要序列化或跨 owner 交接的确切点用后者；
如需继续对参数运算，使用现有共享无损 parser 读取其 JSON 文本。不可先用普通 clone/
JSON.stringify，再调用这两个函数期待恢复精度。

这只是最小兼容接缝提案及提供方出口，消费点仍需 owner 同批接入。若实际 owner 选择
端到端 DbJson 类型合同，应作为协调后的 ToolCall 专用变更实施，不由 L01 单边扩整个
JsonValue/所有事件。通用 sink 可能是 Host listener，不在 sink 前擅自 wire 化。

## 提供方具体修复与保留范围

- OpenAI emit 的工具副本使用上述精确 clone，**标准字符串内容不变**。
- Anthropic baseInput 在原 holder 上转成现有共享 DbJson；partial buffer 先经现有
  Value 接受集校验，再复用 `parseJsonLossless` 和共享 serializer，支持根标量及嵌套
  数值。保留非法 JSON→`{}`、空白 buffer/baseInput、null 和 signature-before-tool。
- tests/tool-call-numbers.test.ts 通过真实 `ctx.llmAdapters` 解析至 ToolCall 输出；
  非标准对象的 consumer-seam 测试确认大整数与 JsonFloat 类型，不测替身算法。

## 仍开放 / 不得扩签

- L02 标准字符串的 `tool_calls.ts:81 JSON.parse`、聚合中的普通复制/序列化需实际 owner
  处理；L01 不改 L02 文件，不自行派停放 L02，不宣称这些分支已端到端保精确。
- F2 最终边界归实际 owner；本 lane 不修改它的数字/wire 合同。
- 预解析 `args_json` 来源未知、未查协议仍未知；不将未知路径归成已确认提供方损失。
- main 尚无 `chatToolRuntime` 提供方的已知缺口，不因 adapter 单元绿变成完整模型→L05
  可执行链；恢复后的独立复验仍按原 finding 的指定范围，不签整个 decoder。
- 其他 provider/非流式 ToolCall 变换未包含在本轮指定复制/序列化点中，不从此回归绿
  外推；既有 Usage 同批、typed raw text/首错/IgnoredAny 和文档 pending 仍保持开放。

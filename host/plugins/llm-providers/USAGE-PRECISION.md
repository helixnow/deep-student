# V2-02 / X6-UD-0040：stream usage 最小同批变更提案

状态：**提案，待 L02/L03/F3 确认同批实现；未改公共类型，未声称闭环**。
依据：D3 要求 Host 内部保精确，不需另行批准这个原则。本提案只协调生产消费点和落库边界。

## 1. 公共类型：只拆出 Usage variant

不改全局 `JsonValue`，不新造通用 JSON。复用 L20 已发布的无损表示及实现
（`host/plugins/sync/api.ts:23-26`）：`DbJson`、`JsonFloat(value, source)`、
`cloneDbJson`、`stringifyJsonLossless`。L01 在自己的 api.ts 仅起领域别名：

```ts
export type ProviderUsage = import('../sync/api.ts').DbJson;
// StreamEvent 的其他分支不变；从原联合分支中移出 Usage：
// | { type: 'Usage'; value: ProviderUsage }
```

表示约定沿用现有实现：安全整数 number；大整数 bigint；小数/指数为已有
`JsonFloat`（保留 source，不能从 value 重建）；对象、数组、null 等照旧。
`9007199254740993`、`1.0`、`1e400`、未知字段和 `original` 均须保留，不能只拷贝
白名单 token 字段。`-0` 按本项目 arbitrary_precision 的整数 0 处理。

L01 从已验证的原文/扫描元数据构造该表示，不从已舍入的 number 反推。
复用 L20 数字表示不代表复用其 parser 的全部接受集：L01 仍负责 serde 词法、深度、
数字归类和 struct 校验。跨插件只用 `api.ts`，不复制/导入 L20 实现文件。
此依赖是公共工具复用，不要求注入/启动 sync 服务；若工具所有者要迁入 F4，则由所有者
移动现有实现，L01/L02 同批改 import，不再写第二份。

## 2. L01 生产点（本 lane 负责）

- `src/providers/openai-chat.ts:178-179`、`openai-responses.ts:655-690`：直接透传的
  usage 从原文取得精确值，不能 `structuredClone` 已舍入的 JsonValue。
- `anthropic.ts::buildUsageEvent/_buildMergedUsageEvent`：内部 token 比较/max/合并用
  bigint，保留当前 Rust 的 i64 → i32 截断规则；`original` 无损。不得先 i64At → Number
  再装回 ProviderUsage；由 exact i64 值直接构造。
- `adapters/gemini-openai-converter.ts`：流式三项主计数按 Rust 截为 i32（安全 number），
  其余原始 i64 字段保持精确；非流式转换中按 Rust 明确 `as i32` 的字段才收窄。
- L01 提供 usage 专用的 `cloneProviderUsage` / `stringifyProviderUsage` 公共别名，复用
  上述工具；提供非流式响应原文的 usage 解码入口，避免 L02 已 `JSON.parse` 后才取 usage。
  不把未知数值字段变成字符串，也不加第二个“近似值”分支或 feature flag。

## 3. L02 生产消费点（请求同批改动）

| 位置 | 最小改动 |
|---|---|
| `api.ts::LlmStreamHooks.onUsage`、`Model2EventSnapshot.usage` | 类型改为 L01 `ProviderUsage`；回调是 Host 内部调用，不能 Number 化 |
| `src/model2_stream_events.ts:52-55` 与 `snapshot():29` | dispatch 存储用 `cloneProviderUsage`，hook 收精确值；snapshot() 目前整体 `structuredClone(this.state)` 也必须替换 usage 的领域 clone；只改 dispatch 不足以保留 JsonFloat 原型 |
| `src/single_shot_stream.ts::SingleShotCompletion/Accumulated/mergeUsage` | usage 字段同类型；对象判断排除 JsonFloat；keepExisting 必须严格为 incoming.as_i64()==Some(0) **且** existing.as_i64() 非零（single_shot_stream.rs:338-342）。双方均先判 i64；JsonFloat(0,'0.0')、超 i64 的 bigint 均不能套任意数值零/非零判断。保留既有分支顺序 |
| `src/single_shot_stream.ts:713-714` 非流式 | 从响应原文取得精确 usage；不从普通 JSON.parse/normalize 后的对象恢复 |
| `src/usage.ts::extractUsageTokens` | 按下述 Rust 收窄点改算术与 presence 选择；这里的最终 u32 结果可精确用 number，无需把整个 UsageTokens 改为 bigint |
| `src/model2_streaming_service.ts:101-109` | 从精确 snapshot 提取 u32，再调用 F3 正式服务；不得 raw bigint → Number → 提取。日志同样在正确的 Rust 收窄点之后记录 |
| `_usage` 事件的最终 IPC 发送、公开 completion 的最终 IPC 返回 | 只有真正 serializer/wire 层才输出 JSON 数字；内部 hook/snapshot 不共用已舍入 wire 对象。复用 lossless serializer，bigint 输出数字 token，JsonFloat 输出 source。若 kernel 只接普通值，由最终 IPC adapter 解码该文本为 wire 值；不能放在通用 sink 前，因为 sink 也可能是 Host 消费者 |

Rust 原证据：`llm_manager/model2_pipeline.rs:9614-9750`：

- prompt/completion/total/reasoning：先按 `get(a).or_else(get(b))` **选第一个存在字段**，
  再 `as_u64`（0..u64::MAX，JsonFloat 即使 value 为整数也拒绝），最后 `as u32`，
  即 `Number(BigInt.asUintN(32, exact))`，不是 clamp。
- cached/cache_write：每一候选独立 `as_u64`，精确 max 后 `min(u32::MAX)`；显式 0 保留。
- 当前 TS `usage.ts:29-32` 所有字段一律 Math.min 的方式与 Rust 不同；并且 `?? asU32(next)`
  会在已存在但类型无效的首字段后错误尝试下一别名。这两处应与精度变更同批修。
- fallback/total 减法均在 Rust 规定的 u32/usize 位置执行，不以数值“大概合理”替代。

## 4. L03 / F3：算术、SQL、最终 wire 不可断链

- L03 `chat-pipeline/src/llm-adapter.ts:367-370`、`variant-adapter.ts::onUsage` 收到的是
  Host hook 值；`token-usage.ts::parseApiUsage` 的 `asU64` 需接受 bigint，拒绝
  JsonFloat 并核 u64 范围，先精确再按该函数的 Rust `as u32` / clamp 分支转换。
  它有自己的“有效字段组合”顺序，不能套用 L02 的 presence 链算法。
- F3（首版缺口已解除）：main `5b1b19055` 已有 `storage/api.ts:668-680` 的
  `LlmUsageService`，且 `storage/index.ts:157-165` 真正 reflect.provide('llmUsage')。
  直接消费现有 `cacheDebugEnabled()` / `recordLlmUsageCacheExtWithIdentity(record)`，
  不再请求第二个 recorder。精确输入仍须是 L02 **已按 Rust 收窄后的 u32**
  prompt/completion/reasoning/cached/cacheWrite，加 identity 等字段；输出/错误按原
  collector 保留，由 owner 落库。服务已发布不等于整条精度/SQL/wire 已同批验证。
- `dstu-storage/src/llm_usage/types.rs::UsageRecord` 的 token 列是 u32：SQL 可绑定精确的
  安全 number 或 bigint，不需要改列类型。`total_tokens` 加法按 Rust u32 release 行为，
  不是无限 number 加法。SQL 聚合超出 JS 安全整数时由 F3 safeIntegers 读 bigint，真正
  IPC 层才按 D3 转 wire；禁止 L01/L02 直接写 SQL 或改 SQL 拼写规避 owner。
- 若持久化的是 raw usage JSON，绑定 lossless JSON 文本，不得 JSON.stringify(bigint)，
  也不得 replacer 把 bigint 改为字符串；不要新增 Rust 原链不存在的 raw usage 落库。

## 4.1 R1 ba85d0d48 窄静态审读补充（不是实现签收）

- 当时 F3 已有底层 collector、尚缺正式面；后续 main `5b1b19055` 已发布上述服务，
  此前“缺正式面”不再是当前阻塞。不另写仓储/collector，仍用现接口完成同批验证。
- F1 kernel 现 debug 校验拒绝 JsonFloat/非有限 number，内部 event listeners 收到原 value。
  请 F1 确认真正 IPC adapter 对已有 lossless 表示的接纳、校验和编码位置；不能在通用
  sink.emit 前转换，也不能为绕 debug 校验提前破坏内部 listener/hook 值。
- L20 共享工具 `cloneDbJson` 目前普通对象用 `out[key] = ...`，自有 `__proto__` 键不能
  保真。未知 usage 字段全保留依赖工具 owner 修同一个工具，并给 parse→clone→serialize
  的 `{"__proto__":{"x":9007199254740993}}` 向量（键存在、原型未改变、数值精确）。
  L01 不复制实现，不用“usage 通常没有这个键”豁免原 Rust Value 合法输入。

## 5. 同批验收向量（先写生产入口测试，非重跑旧回执）

1. OpenAI/Responses 原文 `prompt_tokens=9007199254740993`：L01 event、L02 snapshot、
   Host hook 上保持 bigint `9007199254740993n`；L02 提取/SQL u32 是 1，而不是 0。
2. `prompt_tokens=1.0,input_tokens=7`：L02 presence 链不能回落到 7；按 Rust total/fallback
   得到结果。L03 有不同的解析分支，按它自己的 Rust 用例核验。
3. `cached_tokens=u64::MAX`、`cache_write_tokens=0`：内部 exact max，最终 u32 为
   4294967295 / 0，SQL 中可只读核验，显式 0 不是缺失。
4. `9007199254740992` 与 `9007199254740993` 在每个内部层都可区分；wire 中按 D3
   的舍入只影响外部副本，不得回写 snapshot/hook。
5. `JsonFloat(1, '1.0')` 经过 clone、merge、hook 仍为 JsonFloat；`1e400` 的 source
   仍在；非流式响应走同一精确入口，最终 lossless 文本不是字符串化的大整数。

实施顺序：L02/L03/F3 确认各自文件/接口 → L01 发布 Usage 专用类型与生产解码 → 消费方
同批改动 → 生产入口向量及真实 SQL/wire 复验 → R1 main 后按原 V2-02/UD-0040 签收。
这不是“等待是否允许保精确”；不单边改类型是为了避免产出没人能正确消费的半条链。

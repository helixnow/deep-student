# R3 #7：双适配器流处理平行逻辑盘点 + 第一刀抽取设计

> Wave2-A 第 3 轮子任务 #7。只读对照 `src-tauri/src/chat_v2/pipeline/llm_adapter.rs`
> 与 `src-tauri/src/chat_v2/pipeline/variant_adapter.rs`，本轮**不迁移**任何现有逻辑；
> 骨架文件见 `src-tauri/src/chat_v2/pipeline/stream_filter_core.rs`（未在 pipeline.rs 声明
> `mod`，属死代码占位，第 4 轮接线时由负责人补 `mod stream_filter_core;`）。

## 0. 结论速览

- **平行点共 14 条**（见 §1 清单），其中 **#1–#5（内容过滤与 think 路由）是逐行级复制**，
  合计约 400 行重复代码，为第一刀抽取范围。
- 两侧的 `on_reasoning_chunk` 目前都是**裸转发**（不过 `wrap_token_filter`、不做任何
  标签剥离）——这正是第 4 轮"挂 reasoning 过滤"的落点，抽核心后一行接入。
- 第一刀原则：抽**纯状态机**（无 `Mutex`、无 emitter、无块生命周期），输入 chunk、
  输出路由片段；两适配器保留各自的锁与发射落点。块生命周期、工具调用节流留作第二刀。

## 1. 平行逻辑清单

两侧的根本差异只有"落点"：`ChatV2LLMAdapter` 自持累积状态（多个 `Mutex` 字段）并直接
调 `self.emitter`；`VariantLLMAdapter` 把累积/块 ID/工具收集全部委托给
`VariantExecutionContext`（`ctx.append_*` / `ctx.emit_*`，事件自动带 variant_id）。
除落点外，以下 14 条逻辑平行存在：

| # | 逻辑 | llm_adapter.rs | variant_adapter.rs | 差异备注 |
|---|------|----------------|--------------------|----------|
| 1 | `wrap_token_filter` 应用：content chunk 进 `process()`；结束态 `flush()` 尾巴回灌 think 缓冲；重置调 `reset()` | 1122–1129 / 383–393 / 563–566 | 431–437 / 104–114 / 409–412 | 逐行等价 |
| 2 | `<think>`/`<thinking>` 标签状态机 `process_think_tag_buffer()`：跨 chunk 边界缓冲、开/闭标签双模式最早匹配、不完整前缀保留 | 922–1107 | 213–364 | 约 180 行逐行复制；variant 侧已复用 LLM 侧的 `ends_with_potential_think_start/end` 静态函数 |
| 3 | `flush_think_tag_buffer()`：结束态残留冲刷（未闭合标签归 thinking，否则归 content） | 426–470 | 136–169 | 仅落点不同 |
| 4 | `on_content_chunk`：touch → 空判 → wrap 过滤 → 入缓冲 → 跑状态机 | 1116–1140 | 425–449 | 逐行等价 |
| 5 | `on_reasoning_chunk`：touch → `enable_thinking` 判 → 惰性建 thinking 块 → 累积 + emit | 1142–1176 | 451–473 | LLM 侧多 `reasoning_content_observed` 标志与 `/` 进度打点；**两侧 reasoning 均未过任何过滤器（R4 挂点）** |
| 6 | thinking 块惰性启动 | `ensure_thinking_started` 308–329 | `ensure_thinking_started_for_tag` 172–189（`on_reasoning_chunk` 内另有内联副本 457–467） | 状态存放不同（自持 `Option<String>` vs `initialized: bool` + ctx） |
| 7 | content 块惰性启动（必先 finalize thinking） | 332–354 | 192–208 | 同上 |
| 8 | `finalize_thinking` + `finalized_thinking_block_id` 备份（保证收块阶段拿得到 ID） | 357–371 | 78–93 | 等价 |
| 9 | `finalize_all_inner` 结束序：filter.flush → 冲 think 缓冲 → 结束 thinking → 结束 content（可带权威 `{"content": …}`） | 382–423 | 103–133 | 顺序完全一致；variant 侧多防重复 end 注释 |
| 10 | `on_usage` → `parse_api_usage` | 1369–1382（解析函数 20–154） | 610–632 | 解析已共享（variant 直接调用 llm_adapter 的 pub fn）；仅存放（自持 vs `ctx.set_usage`）与日志不同 |
| 11 | 工具 preparing 块：`on_tool_call_start` 幂等去重 + builtin 检索工具跳过 + `on_tool_call_args_delta` 500 字符节流 + `on_tool_call` 时冲残留缓冲 | 1180–1297 / 284–305 / 1320–1355 | 475–560 / 562–598 | 等价；variant 复用 `is_builtin_retrieval_tool` / `generate_block_id` |
| 12 | `touch_activity` / `idle_elapsed`（F2 空闲超时） | 268–281 | 62–76 | 逐行等价 |
| 13 | `on_complete` → `finalize_all_with_authoritative_content` | 1393–1398 | 634–636 | 等价 |
| 14 | 重置路径（`reset_stream_state` vs `reset_for_new_round`）：think 状态、wrap filter、活动时间戳的重置项重叠 | 540–601 | 390–416 | 语义不同（外层重试 vs 新一轮），不宜合并入口，但可共用核心的 `reset()` |

### LLM 侧独有（不在抽取范围）

- 服务端 web_search 块（`handle_web_search`、items 去重缓存、sources 持久化，673–827）
- Gemini 3 `thought_signature` 缓存（1299–1309）
- OpenAI Responses reasoning items 相邻配对（1311–1318 与 `on_tool_call_start` 内配对段）
- `reasoning_content_observed`（空字符串 reasoning 字段也要保留的语义）
- `api_usage` 自持存储与各 getter

variant 侧无独有流处理逻辑，全部是 LLM 侧的子集换落点。

## 2. 第一刀抽取设计（`stream_filter_core.rs`）

### 2.1 切割原则

抽 **#1–#5：内容过滤与 think 路由**，即"chunk 进、路由片段出"的纯状态机。不抽：

- 块生命周期（#6–#9）：两侧块 ID 的存放机制不同（自持 vs ctx），强行统一需要引入
  trait 抽象 emitter 落点，改动面大且触碰事件时序——留第二刀。
- 工具调用节流（#11）：与 preparing 块 ID 映射耦合，同理留第二刀。
- `touch_activity`（#12）：3 行，重复成本低于抽取成本。

### 2.2 核心接口（骨架已建）

```rust
pub enum RoutedPiece {
    Thinking(String), // 归 thinking 块：调用方 append_reasoning + emit THINKING chunk
    Content(String),  // 归 content 块：调用方 append_content + emit CONTENT chunk
}

pub struct StreamFilterCore {
    wrap_token_filter: ModelWrapTokenStreamFilter, // 平行点 #1
    in_think_tag: bool,                            // 平行点 #2
    think_tag_buffer: String,                      // 平行点 #2
    enable_thinking: bool,
}

impl StreamFilterCore {
    pub fn new(policy: ModelWrapTokenPolicy, enable_thinking: bool) -> Self;
    pub fn process_content(&mut self, chunk: &str) -> Vec<RoutedPiece>;   // #1+#2+#4
    pub fn process_reasoning(&mut self, chunk: &str) -> Vec<RoutedPiece>; // R4 reasoning 过滤挂点
    pub fn flush(&mut self) -> Vec<RoutedPiece>;                          // #1 尾巴 + #3
    pub fn reset(&mut self);                                              // #14 共用重置
}
```

关键决策：

1. **核心不持锁、不持 emitter**。返回 `Vec<RoutedPiece>`，由适配器在自己的锁纪律下
   完成累积与发射。两适配器现在各持 3 把相关 `Mutex`（filter / in_think_tag / buffer），
   接线后收敛为 1 把 `Mutex<StreamFilterCore>`，缩小锁序面。
2. **`enable_thinking=false` 时 Thinking 片段直接丢弃**（与现状一致：两侧
   `process_think_tag_buffer` 内 `!self.enable_thinking` 即不累积不发射），调用方无需再判。
3. **`process_reasoning` 当前为直通**（返回单个 `Thinking` 片段），签名与
   `process_content` 对齐——第 4 轮把 reasoning 过滤（wrap token 剥离、必要时
   `<think>` 标签清洗）填进函数体即可，两适配器调用点零改动。
4. `ends_with_potential_think_start/end` 与标签查找逻辑第 4 轮从 `ChatV2LLMAdapter`
   **移动**（非复制）进核心并保持 `pub(crate)` 转发，负例测试（HTML `<table>`/`<td>`
   误匹配防护）随迁不删。

## 3. 第 4 轮最小落地建议

按依赖序，三步，均不触碰事件时序：

1. **填实核心**：把 `process_think_tag_buffer` / `flush_think_tag_buffer` /
   `ends_with_potential_*` 的查找逻辑迁成核心的纯函数体（以 llm_adapter 版为准，两版
   语义一致）；`pipeline.rs` 补一行 `mod stream_filter_core;`；为核心补纯逻辑单测
   （跨 chunk 标签边界、HTML 负例、未闭合标签 flush）。
2. **两适配器接线**：`on_content_chunk` / `finalize_all_inner` / 重置路径改调核心，
   删除各自的 `in_think_tag` / `think_tag_buffer` / `wrap_token_filter` 三字段
   （净删约 400 行）。落点代码（append/emit/锁）不动。
3. **挂 reasoning 过滤**：在 `process_reasoning` 内启用 wrap token 过滤与标签清洗，
   两侧 `on_reasoning_chunk` 把裸 `text` 换成核心输出。LLM 侧
   `reasoning_content_observed` 标志保留在适配器层（属"字段是否出现"语义，非过滤语义）。

第二刀（第 4 轮之后再议）：块生命周期 trait 化（#6–#9）、工具 args 节流下沉（#11）。

## 4. 风险与红线

- 核心迁移必须**保持"最早匹配标签优先"与"不完整前缀保留"语义**，否则跨 chunk 边界
  的 think 内容会漏到 content 块（用户可见思维链泄漏）。
- `finalize_all_inner` 的顺序（filter.flush → 冲缓冲 → thinking end → content end）
  是前端块状态机的隐式合同，接线时不得重排。
- 过滤器负例测试不删（本轮红线），迁移时随文件移动。
- variant 侧 `on_reasoning_chunk` 无 observed 标志是**既有差异而非 bug**
  （`VariantExecutionContext::get_accumulated_reasoning` 自有判空语义），接线时不要"顺手对齐"。

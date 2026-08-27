# R6 #7 — 遥测面二检（model2 身份解析 × cache-hit-report.py）

基线 tip：`4b784bb4`。本席读集：`src-tauri/src/llm_manager/model2_pipeline.rs`
（`chat_v2_session_scope_and_generation` / `chat_v2_stream_identity` / 记账点
:6101-6143）、`src-tauri/src/llm_usage/`（mod / repo / collector 写路径）、
`chat_v2/pipeline/tool_loop.rs`（`build_run_scoped_stream_event` + 单变体记账
:1525/:1587）、`multi_variant.rs`（:859/:1238 两处事件构造）、
`migrations/llm_usage/`（V20260130 init / V20260824 / V20260826）、
`scripts/cache-hit-report.py`，对照 `r5-model2-telemetry.md`、
`r5-review-model2.md` 与台账 P7 段。按轮规未编译、未测试、未运行脚本、
未 commit。

## 结论速览：补丁

主体**确认**（R5 遥测身份分列与报表脚本口径一致），另发现并落地
**两处明确 bug 修复**，均在本席独占文件 `scripts/cache-hit-report.py`：

| 项 | 裁决 |
|---|---|
| Rust ↔ Python 解析器对拍 | **确认**（唯一分歧即 bug 2，已修） |
| 三路写入点归属 / 报表分组假设 | **确认**（详见第一节） |
| 缺列降级、NULL≠0、列索引 0–12 | **确认**（逐列核对无错位） |
| 前缀流身份 = 会话×变体，run 不入身份 | **确认**（与写入侧 retry 语义一致） |
| bug 1：`--days` 截止串时间戳形状混用 | **已修**（fetch 的 WHERE 子句） |
| bug 2：非数字代际后缀时读写两侧分组分歧 | **已修**（`parse_stream_event_scope`） |

## 一、写入侧对拍：报表的分组假设全部成立

报表的核心假设是「前缀流 = (session_id, variant_id)，run 不入身份」。逐路
核对写入点：

1. **单变体 chat_v2**（`tool_loop.rs:1525` 成功轮 / `:1587` 失败轮）：
   `record_llm_usage_cache_ext(..., Some(ctx.session_id), ...)` —— session 是
   真实会话，variant / run 落 NULL。报表侧 `stream_key = (session, "")`，
   单变体一会话一条前缀流，跨轮 steady 归组正确。
2. **多变体与其他 model2 调用方**（`model2_pipeline.rs:6101-6143`，
   `task_context != "chat_v2"` 门防双计费）：`chat_v2_stream_identity` 解析
   分列；解析失败（非 `chat_v2_event_` 前缀，如 review 流）fallback 整个
   事件名当 session_id、variant/run 落 NULL —— 与报表「无法解析按原值整体
   分组」的降级口径互为镜像。
3. **多变体事件构造**（`multi_variant.rs:859/:1238`）：`_var_` 段传
   `ctx.variant_id()`，注释明言 retry 复用 variant id、每次尝试换 run
   UUID —— 报表把 run 排除出前缀流身份、只用于 per-session 行计数，
   与写入侧语义一致（纳入 run 即复刻「stream_event 当 session」老 bug）。

一处需要澄清的非问题：单变体路径的 stream_event `_var_` 段是
`assistant_message_id`（`tool_loop.rs:1151-1156`，每轮更换）。R5 审阅翻案
R5-M2-1 打的正是这一点——但只打 **CACHE_DEBUG 指纹 scope key**（跨 turn
对比不发生）；usage 行不受影响，因为单变体记账走 tool_loop（上面第 1 路），
从不经过 model2 的 stream_event 解析。仅在更早的「双计费」历史时期若存在
model2 写入的单变体行，其解析出的 variant 会是消息作用域（该会话 cold 被
高估）；这是历史数据噪声，读侧无法与真实多变体行区分，不改。

## 二、解析器对拍：chat_v2_stream_identity ↔ parse_stream_event_scope

逐规则核对（Rust `model2_pipeline.rs:3185-3213` ↔ Python
`parse_stream_event_scope`）：

| 规则 | Rust | Python | 一致性 |
|---|---|---|---|
| 前缀 | `strip_prefix("chat_v2_event_")?` | `startswith` + 切片 | 一致 |
| 代际 marker 定位 | `rsplit_once`（最右） | `rfind`（最右） | 一致 |
| 代际数字校验 | `parse::<u64>().ok()?` → 整体判非法 | 旧代码非数字时**继续拆列** | **分歧 = bug 2** |
| 会话/变体切分 | `rsplit_once("_var_")` | `rpartition("_var_")` | 一致（均取最右） |
| 变体/run 切分 | `rsplit_once("_run_")` | `rpartition("_run_")` | 一致 |
| 旧格式（无 `_run_`） | variant 有、run None | 同 | 一致 |
| legacy（无 `_var_`） | 仅 session | 同 | 一致 |
| 非 chat_v2 前缀 | `None`（调用方 fallback） | 原值返回 | 一致（语义等价） |

`GENERATION_MARKER = "__stream_generation__"` 与
`CHAT_V2_STREAM_GENERATION_MARKER`（`llm_manager/mod.rs:45`）逐字一致。
`row_identity` 显式列（索引 11/12）优先、解析结果补齐缺位的次序，与
「新行 session_id 已是真实会话（无前缀、解析恒等）」兼容。

## 三、两处明确 bug（已修，均限 scripts/cache-hit-report.py）

### bug 1：`--days` 截止串与存量时间戳形状混用（fetch）

`llm_usage_logs.timestamp` 由 repo / collector 统一写
`created_at.to_rfc3339()`（`repo.rs:36/:143`、`collector.rs:277`），形如
`2026-08-26T10:30:00.123+00:00`（'T' 分隔）；而旧代码的截止串
`datetime('now', '-N days')` 生成 `2026-08-19 16:45:00`（空格分隔）。TEXT
列做**字典序**比较，`'T'(0x54) > ' '(0x20)`，于是截止日**当天**的行无论
时刻早晚全部通过比较——`--days N` 实际语义变成「自 N 天前当日 0 点起」，
最多多算近一天，直接虚增报表行集。修复：截止串改
`strftime('%Y-%m-%dT%H:%M:%S', 'now', ?1)`，与存量同形状后字典序即时间序
（行带小数秒时同秒边界仍判「不早于」，语义正确）。

顺带记录：Rust 侧 `repo.rs:214/:638` 的两条查询用的是同一 idiom，存在同样
的整天多含；在 #7 车道（脚本独占）之外，只记录不改，留给后续轮裁决。

### bug 2：非数字代际后缀时读写两侧分组分歧（parse_stream_event_scope）

Rust `chat_v2_stream_identity` 对 `__stream_generation__` 后缀非数字的事件
名整体判非法（`parse::<u64>().ok()?`），写入侧走 fallback ——**整个事件名
落 session_id**。Python 旧代码在同样形状下只是不剥 marker、然后继续拆
`_var_` / `_run_`，把 marker 残渣拆进 run 段：同一行在写入侧按原值整体
分组、在报表侧却被拆成三列，违反脚本 docstring 自称的「与
model2_pipeline 同口径」。修复：marker 存在但后缀非 ASCII 数字时直接按
原值返回（不拆列），并用 `isascii()` 排除 `str.isdigit()` 会放行而 Rust
u64 解析会拒绝的全角/上标数字。该形状当前构造器
（`build_run_scoped_stream_event`，代际为 u64 Display）不会产出，属防御
一致性修复，风险为零。残余极小分歧记录在案不追：u64 解析接受前导 `+`
（`"+73"` 合法）而 `isdigit` 拒绝——写入侧永不产生带号代际。

## 四、检查过并判「非 bug」的点

- **hit_rate 分母含未测量行的 prompt**：docstring 明示 token-weighted
  across all requests；混桶时命中率偏保守是设计取舍，非 bug。
- **`cached = min(cached, prompt)` 桶级钳制**：docstring 已声明 gateway
  quirks（cached 可超 prompt），钳制方向安全。
- **`max(r[4], 0)` 无 None 风险**：`prompt_tokens INTEGER NOT NULL DEFAULT 0`
  （V20260130 init:36）。
- **时间排序**：RFC3339 字典序在秒级/小数秒级均与时间序一致；存量若混有
  `Z` 与 `+00:00` 两种后缀，仅影响同一秒内的 tie 顺序，不改变 cold/steady
  判定的实质。
- **per-session 循环内 `steady` 遮蔽外层同名变量**：外层 `steady` 在
  cold/steady 段打印后不再使用，遮蔽无害（可读性小瑕，不动）。
- **列索引**：fetch SELECT 13 列顺序与消费点（r[4] prompt、r[6] cached、
  r[8] adapter、r[9] provider、r[10] write、r[11]/r[12] 身份）逐一核对无
  错位；缺列时 `NULL AS ...` 占位保持索引稳定。
- **缺列降级**：`variant_id`/`run_id`（V20260826）与 `cache_write_tokens`
  （V20260824）的 pragma 探测 + NULL 占位 + 头部降级说明，与迁移加法纪律
  和 R5 审阅「消费口径核对一致」结论相符。
- **`--session`**：同时匹配原始列值与解析还原后的会话 id，覆盖新旧两代行。

## 验证状态

- 只读对拍 + 两处脚本修复；按轮规未运行 python / cargo / 任何测试。
- 改动仅 `scripts/cache-hit-report.py` 两个 hunk（fetch 的 WHERE 子句、
  `parse_stream_event_scope` 的代际校验），无产品代码改动。
- 未 commit / push（父代理收轮）。

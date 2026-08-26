# 质量评审：LLM 用量记账 / cache_write_tokens / 采集与落库

- 对照：`v0.9.44` → `origin/cursor/0824-cde6` @ `2d41ea8b`
- 范围：`src-tauri/src/llm_usage/**`（含必要的采集侧调用链与迁移证据）
- diff 规模：模块内 5 个文件，+463/−29；新增迁移 `V20260824__add_cache_write_tokens.sql`

## 结论

**通过，质量良好。** 本块改造做了三件事：① `llm_usage_logs` 新增可空列
`cache_write_tokens`（缓存写入量）；② 把 v0.9.44 里硬编码的 `adapter=NULL`、
`token_source="api"` 换成调用方真实标注；③ 为「ALTER 已落盘但 refinery 史未记账」
的中断残留补了修复路径。NULL≠0 的语义在写入、读回、迁移、修复、测试五个层面
全部贯穿，未发现漏计或重复计的回归。采集侧 v0.9.44 的 9 个 `record_llm_usage`
调用点 1:1 迁移到新入口，逐一核对无参数错位。下述问题均非阻断项。

## 核实过的关键点

### 1. NULL≠0 语义完整，且顺带修掉了 v0.9.44 的「真实 0 被折叠」缺陷

- 迁移只有一条 `ALTER TABLE llm_usage_logs ADD COLUMN cache_write_tokens INTEGER`，
  无 `DEFAULT 0`、无回填——旧行保持 NULL（无测量）。`database.rs` 的残留修复测试
  显式断言迁移后旧行 `cache_write_tokens IS NULL`，coordinator 侧 e2e 测试
  （`coordinator.rs` `test_llm_usage_v20260824_recovers_column_without_history_and_reruns`）
  还额外断言显式写 0 的新行读回 `Some(0)`，两个方向都钉住了。
- 三条写入路径（`collector.rs` `insert_records`、`repo.rs` `insert_usage` /
  `insert_usage_in_tx`）均直接落 `record.cache_write_tokens: Option<u32>`，
  未调用 `with_cache_write_tokens` 即 NULL。19 个参数位逐条核对，三处 SQL 与
  params 对齐一致。
- 读回路径 `get_recent_usage_page` 把新列追加在 SELECT 末尾（索引 16/17/18），
  不动旧列序——索引映射核对无误。
- **超预期的修复**：v0.9.44 的采集侧会把「API 实测的 0」折叠成 NULL——
  `model2_pipeline.rs` 旧版 `extract_usage_tokens` 用 `> 0` 门槛，
  `providers/mod.rs` 旧版 `build_usage_event` 写
  `if cached_tokens > 0 { json!(...) } else { Value::Null }`。0824 分支改为
  「字段存在即已测量」（`filter(|v| *v >= 0)` + `[..].flatten().max()`），
  显式 0 保留为 `Some(0)`。`extract_usage_tokens_preserves_measured_zero_cache_values`
  与 `build_usage_event_preserves_observed_zero_cache_values` 两个测试分别锁定
  「测得 0 ≠ 未测量」两侧。这是本块最有价值的正确性修复之一，
  虽然主体在模块外（providers / model2_pipeline），但与本列的语义声明互为因果。

### 2. token_source / adapter：从「全量伪装 api」到真实标注

v0.9.44 中 `llm_usage_logs.token_source` 恒为硬编码 `"api"`（估算行伪装成实测）、
`adapter` 恒为 NULL。现在：

- `UsageRecord` 新增 `adapter: Option<String>`、`token_source: Option<String>`，
  写入时 `token_source.as_deref().unwrap_or("api")` 回退 schema 默认。
- 全部 9 个生产调用点迁移后均显式标注：chat_v2 `tool_loop` 传
  `round_usage.source`（api/tiktoken/heuristic/mixed）；`model2_pipeline` 按
  `captured_usage.is_some()` 判 api/heuristic；`exam_engine` 更细，双端实测=api、
  双端缺失=heuristic、半测半估=mixed；embedding/reranker 按 usage 是否上报判定；
  `voice_input.rs` 的 0/0 占位行显式标 heuristic（旧版这行会落 "api"，
  注释里也点明了这个动机）。
- adapter 统一用 `effective_api_protocol_for_config` 的四个协议字符串
  （openai_chat_completions / openai_responses / anthropic_messages /
  google_generate_content），embedding/rerank 用专有标识；配置无法解析时留 NULL
  而非猜测。注意这与 init schema 注释里 adapter 的旧词表
  （"openai_compatible, native 等"）是一次词表更替——因旧数据恒为 NULL，
  无历史冲突，可接受，但 init.sql 的列注释已过时（见问题 C）。

### 3. 中断残留修复（database.rs `repair_cache_write_migration_residue`）有真实依据

我最初怀疑这个修复是防御过度——refinery 若在同一事务内执行迁移与史记录，
残留态不可能出现。核对 vendored `refinery-core`（`traits/sync.rs` 84–99 行）后确认：
**`set_grouped(false)` 模式下迁移 SQL 与 history INSERT 是两个独立事务**
（每个 `transaction.execute([update])` 各自开启/提交一个 rusqlite 事务），
进程在两者之间被杀即产生「列在、账不在」，重放会撞 duplicate column。修复是必要的。

修复实现的收敛条件足够窄：表存在 ∧ 列存在 ∧ history 表存在 ∧ 20260824 未记账
∧ 前驱 20260525 已记账，才补账；且用 `INSERT OR IGNORE`、记录内嵌迁移的真实
name/checksum（`checksum().to_string()` 与 refinery 读取端 `parse::<u64>()` 对齐；
`chrono::to_rfc3339()` 产物可被 refinery 的 `time::Rfc3339` 解析，不会触发其
`unwrap()` panic）。前提「该迁移只有一条 ADD COLUMN」当前成立，注释也写明了这一
依赖——若日后有人往 V20260824 的 SQL 里加语句，这个推断即失效，风险已被文档化。

与 coordinator 侧 `pre_repair_llm_usage_schema` 的同款修复构成双保险：
正常 App 路径走 coordinator，直接实例化 `LlmUsageDatabase` 的测试/独立消费方
走本模块。两份逻辑判定条件一致（我逐条比对过）。代价是同一规则维护两份
（见问题 B'）。

### 4. 漏计 / 重复计

- **无漏计**：v0.9.44 的 9 个调用点全部迁移（tool_loop×2、model2_pipeline×4、
  exam_engine×1、rag_extension×2），另有 voice_input 走 `record_usage_record`
  直录，未丢失任何路径。失败轮的部分用量（`retain_failed_round_usage`）现在
  连同 cache_write 与真实 source 一起入账。
- **无新增重复计**：model2_pipeline 流式路径的
  `task_context != Some("chat_v2")` 去重闸门（chat_v2 用量由 tool_loop 统一记录）
  在 v0.9.44 已存在，本次原样保留。
- `TokenUsage::accumulate` 对 cache_write 的合并规则（Some+Some 相加、
  None+Some 取 Some、None+None 保持 None）与 cached/reasoning 一致，
  不会把未测量轮污染成 0。tool_loop 落库用的是 per-round 的 `round_usage`
  而非累计值，无轮间重复。
- 中转站同一份写入量以多种格式重复上报时用 `max()` 归一
  （providers / llm_adapter / model2 三处提取逻辑一致），防重复计的取向正确。

### 5. 同步与备份

`llm_usage_logs` 在 sync 分类里是 RowSync，可空 ADD COLUMN 是对行同步最安全的
schema 变更；`llm_usage_daily` 是 DerivedRebuild 且生产代码无写入方（仅测试写），
所以日汇总表未加 `total_cache_write_tokens` 不构成实际缺口。

## 问题与风险（按重要性排序）

**A（中）落库就绪，消费面缺位——「报表算 write/read 比」目前是前瞻性说法。**
types.rs / mod.rs / 迁移 SQL 里反复出现「报表据此计算缓存 write/read 比」，
但现状是：`get_usage_summary` / trends / by_model / daily 没有任何
`SUM(cache_write_tokens)` 聚合；handlers.rs 零改动；前端仅在
`llmUsageApi.ts` 的 `UsageRecord` 类型上声明了 `cacheWriteTokens?`（带正确的
「缺省=未测量」注释），无任何 UI 或计算消费；`adapter` / `tokenSource` 连前端
类型声明都没有。当前唯一出口是 `llm_usage_recent` 原始记录与 chat 内
`llm_usage_query` 工具的 recent 页。数据采集先行、报表后补是合理的分期，
但注释把未来时写成了现在时，读者会误以为报表已存在。建议后续补
summary 聚合（SQL 的 `SUM` 天然忽略 NULL，聚合层无需特殊处理）或改注释措辞。

**B（低-中）三份手工同步的 INSERT SQL 是结构性风险。**
`collector::insert_records`、`repo::insert_usage`、`repo::insert_usage_in_tx`
是三段几乎相同的 19 参数 INSERT，本次同时改三处且改对了，但每次加列都要
三处联动 + 人工数占位符（本次 diff 里 `?10, ?11, ?12` → `?10, ?11, ?12, ?13`
这类重排就是易错点）。collector 与 repo 的 provider 推断还是两套不一致的启发式
（`extract_provider` 前缀匹配 vs `infer_provider` 包含匹配，如 `o3` 系仅后者认识）
——这是既有问题，本次未恶化，但新字段让两套代码的漂移面又大了一点。
顺带：`insert_usage_batch` 对单条失败静默吞错只计数（既有行为），
与 collector 整事务回滚的语义不一致。

**B'（低-中）残留修复逻辑双份维护。**
database.rs 与 coordinator.rs 各有一份判定条件相同的 V20260824 修复。
当前一致，但没有共享实现或交叉引用注释之外的机制保证将来同步演化。
若再出现类似的「单条 DDL 迁移」，这个模式会继续复制。

**C（低）exam_engine 路径「能拿到却没采」cache_write。**
`exam_engine.rs` 从同一个 usage JSON 里提取了 `cached_tokens`
（且注释解释了整卷 OCR 逐页同前缀、命中率有意义），却用 `record_llm_usage_ext`
而非 `record_llm_usage_cache_ext`——同一 JSON 里若出现
`cache_creation_input_tokens` / `input_tokens_details.cache_write_tokens` 会漏采。
与 mod.rs 文档「能拿到 cache_write_tokens 的调用方请使用 record_llm_usage_cache_ext」
轻微自相矛盾。实际影响小（OCR 供应商基本不上报缓存写入），但既然读缓存都采了，
写缓存顺手可得。另：init.sql 里 adapter 列的注释词表已过时（见核实点 2），
值得在下次触碰该文件时更新。

**D（低）token_source 回退 "api" 放在写入层，防御深度不足。**
回退逻辑 `unwrap_or("api")` 意味着：任何未来新增的、忘记标注的调用方，
其估算行会再次被伪装成 api 实测——恰是本次修复要消灭的问题。当前所有生产
调用方都已显式标注，回退只剩理论触发面；但 collector 的
`record_from_api_response(_extended)` 两个便捷方法（当前无生产调用方）不支持
标注 token_source/adapter/cache_write，是现成的「绕过标注」入口。
更稳的做法是回退为 `"unknown"` 或让 `UsageRecord.token_source` 非 Option；
测试 `plain_source == "api"` 反而把这个兜底行为固化成了契约。设计权衡，非缺陷。
附带的读回不对称：写入 None → 库里 "api" → 读回 `Some("api")`，
无法区分「显式声明」与「兜底默认」。

**E（低）三层包装函数 12–13 个位置参数，错位不可编译期发现。**
`record_llm_usage` → `_ext` → `_cache_ext` 逐层追加参数，相邻的
`Option<u32>` 有五个、`Option<String>` 有两对——把 `cache_write_tokens` 传进
`cached_tokens` 的位置编译器不会报错。我逐调用点核对本次无错位，
`#[allow(clippy::too_many_arguments)]` 压掉了唯一的机器信号。
参数继续增长时应改 struct/builder 传参。

**F（信息）跨供应商 prompt_tokens 口径混合是既有问题，本列未解决也未恶化。**
Anthropic 的 `input_tokens` 不含 cache read/write（cached/cache_write 与 prompt
不相交、需额外计费），OpenAI 语义下 cached ⊆ prompt。`SUM(prompt_tokens)`
跨供应商口径不一致，`cost_estimate` 也未按 Anthropic 写入 1.25x 修正。
新列为将来的成本修正提供了数据基础，本次范围内不要求解决，记录备查。

**G（信息）语义边角：无测量的 0 被标为 "heuristic"。**
embedding/reranker/voice_input 在 API 未上报 usage 时落 `0 + heuristic`——
严格说这是「未测量的占位 0」而非「启发式估算出 0」，`TokenSource` 枚举没有
unmeasured 值，用 heuristic 表达「非 API 实测」是现有词表下的最优解，
但消费报表时应知道 heuristic 行里混着这类占位 0。

## 测试覆盖评估

模块内新增 5 个针对性测试，覆盖设计意图的每个断点：collector 两个
（真实 adapter/token_source 落库 + 未标注回退；cache_write 的 Some/NULL 双向），
repo 两个（同上 + `get_recent_usage` 回读带出新字段），database 一个
（v0.9.44 schema → 手工重放中断 ALTER → 直接初始化必须补账且旧行保持 NULL）。
断言消息直接写明规则（「无测量必须是 NULL，不得伪装成 0」「估算行不得伪装成 api」），
是行为契约而非实现细节的测试，质量高。模块外配套：coordinator e2e 残留修复 +
幂等重跑、`migration_compat_tests` 断言旧式 INSERT 不带新列时保持 NULL、
providers / model2 的「measured zero 不折叠」回归。

弱点：collector 测试依赖 `sleep(500ms)` 等待异步落库（record_batch 立即 flush，
慢机 flake 风险低但存在，与既有测试同风格）；repo 测试的 setup 跳过
V20260131–V20260525 直接拼 init + V20260824，与真实迁移序列有偏差
（对本表无影响，因中间迁移不触碰 `llm_usage_logs` 的这些列）；
「三份 INSERT SQL 一致性」本身没有测试守护（见问题 B）。

## 附：证据索引

| 主题 | 位置 |
| --- | --- |
| 新列迁移（单条可空 ALTER） | `src-tauri/migrations/llm_usage/V20260824__add_cache_write_tokens.sql` |
| 三条写入路径 | `llm_usage/collector.rs` 258–317；`llm_usage/repo.rs` 32–80、138–183 |
| 读回索引 16/17/18 | `llm_usage/repo.rs` 448–498 |
| 残留修复 + 依据 | `llm_usage/database.rs` 461–570；`vendor/refinery-core/src/traits/sync.rs` 84–99（非 grouped 双事务） |
| coordinator 同款修复 | `data_governance/migration/coordinator.rs` 3815–3855 |
| 三层记录入口 | `llm_usage/mod.rs` 109–245 |
| chat_v2 采集（成功/失败轮） | `chat_v2/pipeline/tool_loop.rs` 1378–1399、1440–1475 |
| 累加规则 | `chat_v2/types.rs` 313–355 |
| 协议提取（含 measured-zero 修复） | `providers/mod.rs` 3330–3389；`chat_v2/pipeline/llm_adapter.rs` 127–153；`llm_manager/model2_pipeline.rs` 7644–7782 |
| 去重闸门（既有，保留） | `llm_manager/model2_pipeline.rs` 5709–5739 |
| 调用点 1:1 迁移 | v0.9.44 9 处 ↔ 2d41ea8b 9 处（tool_loop 1136/1183→1378/1440；model2 4657/6120/6139/6166→5720/7260/7282/7322；exam 673→698；rag 1083/1231→1082/1240） |
| 前端仅声明未消费 | `src/api/llmUsageApi.ts` 79 |

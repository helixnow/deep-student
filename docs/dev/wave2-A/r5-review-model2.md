# R5 #5 — 审阅 #1（model2 遥测身份 / post-adapter 指纹 / P6 retention 删除）

审阅对象：工作区未提交改动中属于 #1 车道的部分——
`src-tauri/src/llm_manager/model2_pipeline.rs`、`src-tauri/src/llm_usage/`
（types / collector / repo / mod / database）、新增
`migrations/llm_usage/V20260826__add_stream_identity.sql`、
`data_governance/migration/llm_usage.rs` 注册表，对照
`docs/dev/wave2-A/r5-model2-telemetry.md` 的自述。基线 `2d70b400`。
只读审阅，未运行编译/测试，未改产品代码。

## 结论速览

| 项 | 裁决 |
|---|---|
| 遥测身份分列（session / variant / run） | **确认**。解析器与 `build_run_scoped_stream_event` 的构造格式逐段核对一致，与既有 `chat_v2_session_scope_and_generation` 同口径（同为 `rsplit_once`）；三条 INSERT 路径与读路径列序/索引逐一核对无错位；`task_context != "chat_v2"` 门保证不与 tool_loop 的记录点双重入账。 |
| post-adapter 四段指纹 | **实现确认，一处宣称翻案**（R5-M2-1）：代码正确，但「scope key = session::variant 即 provider 端 prompt cache 的真实存活作用域」的说法过强——该 key 实际按 assistant 消息/变体轮转，**跨 turn 对比不会发生**，每个新 turn 都记 `baseline`。 |
| P6 retention 删除 | **确认**。在 HEAD 上核实两函数（`model2_pipeline.rs:3193/3205`）除定义外全仓零引用，纯死代码；删除安全，`model_supports_prompt_cache_breakpoint` 在 `providers/mod.rs:1553` 仍有活调用点不受牵连；接线硬约束注释（仅官方端点、仅 30m、必须快照测试）已留在原位。 |
| coordinator.rs 是否误改 | **未改**。`git status` 全部 12 个改动文件中没有 `data_governance/migration/coordinator.rs`；该文件对 `llm_usage_logs` 的 INSERT 全部在 `#[cfg(test)]` 内且列名显式，加法新列不影响。 |
| 车道纪律 | **合规**。`model2_pipeline.rs` 的 diff 全部是 #1 内容（测试 + 身份解析 + 指纹 + retention 删除 + 单一记录点改造）；旧 migration 文件零触碰（新 SQL 为 untracked 新文件）；工作区内 `helpers.rs`/`history.rs`（#8）、`providers/mod.rs`（#2）、`cache-hit-report.py`（#3）、`TauriAdapter.ts`（#9）均属其他任务车道，与 #1 无文件交叠。 |

## 一、遥测身份：逐点核实

1. **格式对齐**。`chat_v2::pipeline::tool_loop::build_run_scoped_stream_event`
   （tool_loop.rs:302）构造 `chat_v2_event_{session}_var_{scope}_run_{run}`
   加可选 `__stream_generation__{n}`；新解析器 `chat_v2_stream_identity`
   先按 marker 剥代际（非数字则整体判非法，与既有解析器同规则），再
   `rsplit_once("_var_")` / `rsplit_once("_run_")` 还原三列。方向与既有
   `chat_v2_session_scope_and_generation`（3160 行，同用 `rsplit_once("_var_")`）
   一致，两函数对同一事件名还原出相同 session——自述「同口径」属实。
   依赖「ID 本身不含 `_var_`/`_run_`」这一假设，但 session/变体/run 实际均为
   UUID 系 ID，且这是既有解析器的同一预设，不新增风险。
2. **记录点唯一且不双记**。`record_llm_usage_cache_ext_with_identity` 调用点
   （model2_pipeline.rs:6125）位于 `task_context != Some("chat_v2")` 门内：
   单变体 Chat V2 的用量仍由 tool_loop.rs:1525/1587 以真实 `ctx.session_id`
   记录（两处传 `Some(ctx.session_id.clone())`，本就正确，零改动是对的）；
   本记录点只覆盖多变体（`chat_v2_variant`）与非 chat_v2 调用方。修复后
   多变体行的 session_id 从 stream_event 变为真实会话 ID，
   `get_session_usage_summary`（repo.rs:413，按 caller_id 聚合）首次能把
   多变体用量归入会话汇总，且因上述门不会与 tool_loop 行重复计数。
3. **落库三路对齐**。collector.rs 单条 INSERT（21 列/21 参，variant/run 在
   ?17/?18，参数序逐一对上）；repo.rs 两条 INSERT 同构；
   `get_recent_usage_page` SELECT 新列追加在尾部，`row.get(19)/get(20)`
   与列位核对无误，其余既有索引未移位。`UsageRecord` 全仓仅两处结构体
   字面量（mod.rs 测试、repo.rs 读路径），均已补新字段，无漏改编译点。
   serde 侧新字段为 `Option` + `skip_serializing_if`，camelCase 序列化对
   前端/同步消费者向后兼容。
4. **回退语义**。非 `chat_v2_event_` 前缀（review 流等）回退为「事件名整体
   作 session_id、variant/run 落 NULL」，与旧行为字节等价；旧格式
   （无 `_run_`）与 legacy（无 `_var_`）分支均有测试覆盖，测试用例手推
   全部成立（含代际后缀非数字判非法一例）。
5. **Migration 加法纪律**。新 SQL 只 `ADD COLUMN` ×2 + 两个部分索引，
   不触旧文件；注册表 `V20260826_ADD_STREAM_IDENTITY` 带
   expected_columns/expected_indexes（与 V20260824 同模式）；
   `CURRENT_SCHEMA_VERSION` 提到 20260826；注册表测试 7→8、latest、
   pending 序列全部同步；repo.rs 测试库建表链补执行新 SQL。列名与
   #3 的 `cache-hit-report.py` 消费口径（`variant_id`/`run_id`、缺列 NULL
   降级）核对一致。

## 二、指纹：实现确认 + 一处翻案

实现本身正确：指纹点移到 `prepare_provider_request` 之后对 `preq.body`
取段（与 `log_and_emit_llm_request` 同源，即真实发送体）；四段切分兼容
`messages`/`input`/`contents` 三种消息载体与四种 system 载体；分叉判定按
前缀顺序 system → tools → history → current_user；Mutex 毒化用
`into_inner` 兜底；256 作用域上限整体清空有注释交代；env 关闭时仅一次
`env::var` 查询，代价可忽略（自述「零开销」略夸张，不足为病）。三个
测试用例手推均成立。

**R5-M2-1（翻案，低危，建议下轮修正）**：自述与代码注释都称 scope key
`session::variant`「跨 run 存续，这正是 provider 端 prompt cache 的真实
存活作用域」。核对构造点后不成立：单变体路径 scope 是
`ctx.assistant_message_id`（tool_loop.rs:1153），多变体路径是变体消息 ID
（multi_variant.rs:861/1240）——两者都**每个 assistant 消息（每 turn）换新**。
于是指纹对比的实际覆盖是：同一 turn 内工具循环的多轮请求 + 同 turn 重试
（run 换、scope 不换，这部分收益真实存在）；而 provider 缓存最主要的
steady-state 场景——turn N+1 复用 turn N 前缀——每次都落 `baseline`，
永远不产出 `first_divergent_segment` 判定。属宣称过强 + 覆盖缺口，非错误
数据。修正方向二选一：(a) 文档与注释降格为「turn 内多轮 + 重试作用域」；
(b) 对可解析出 session 的事件把 scope key 退到 session 维度（多变体需
并入 variant 防交叉污染，可用 `session::variant` 仅在 variant 存在时启用、
单变体退 `session`——注意单变体 scope 恰是消息 ID 而非 variant，需从
tool_loop 侧区分，改动不止 model2 一文件，故留下轮）。

小注（不构成问题）：Anthropic 工具结果以 role:"user" 回传，工具轮的
尾部 user 消息会被计入 `current_user` 段——分叉定位仍正确（上一轮真实
用户消息随之进 history，divergence 指向 history），只是段名与直觉略有
出入，可在文档补一句。

## 三、P6 retention 删除：确认

- 在 HEAD（`2d70b400`）用 `git show` 核实：
  `provider_accepts_prompt_cache_retention`（3193 行）与
  `apply_openai_prompt_cache_retention`（3205 行）除定义外全仓无任何调用，
  自述「零调用点」属实；写死 `ttl:"24h"` 亦属实，撞上任务卡明令禁止项。
- 任务卡「优先删除」，删除路线正确执行：无新增网络行为，「无需快照测试」
  的推理成立（快照测试是接线路线的配套要求）。
- 连带影响核实：`model_supports_prompt_cache_breakpoint` 在
  `providers/mod.rs:1553` 仍有活调用（#2 车道）并有测试，不产生死代码
  连锁；原位注释把三条接线硬约束（仅官方 OpenAI 端点、GPT-5.6+ 仅
  `ttl:"30m"` 禁 24h、必须快照测试）钉在了未来复活者必经之路上，防复活
  设计合格。

## 四、新发现：V20260826 中断收敛缺口（R5-M2-2，P2，下轮跟进）

仓里为「ALTER 已落盘、refinery history 未落盘」的中断态专门建了两处
显式收敛，且都**硬编码只认 V20260824**：

- `llm_usage/database.rs:491` `repair_cache_write_migration_residue`
  （直开路径，`const VERSION: i32 = 20260824`）；
- `data_governance/migration/coordinator.rs:3843` `pre_repair_llm_usage_schema`
  （主路径，注释明言「V20260824 位于通用历史兼容重放边界之后，必须
  显式收敛」）。

V20260826 与 V20260824 同为重放边界之后的 ADD COLUMN 迁移，具有完全
相同的中断形态：残留态下重跑会以 `duplicate column name: variant_id`
硬失败，且两条收敛路径都不会认领。另注意 V20260826 是**两条** ALTER，
「列存在即证明整个迁移已落盘」的 V20260824 式证明不能直接照搬——收敛
逻辑需按列各自 `add_column_if_missing`（索引本身已 `IF NOT EXISTS`
可重放）再补记 history。本轮 #1 不能修：coordinator.rs 明确在车道之外
（本轮红线，且实际也没碰，正确），database.rs 的收敛函数虽在 llm_usage
内但与 coordinator 侧必须成对改，拆开改只堵一半。建议下轮开一条
显式授权 coordinator.rs + database.rs 的任务项一并收敛，并仿照
`test_direct_initializer_repairs_v20260824_column_without_history` /
`test_llm_usage_v20260824_recovers_column_without_history_and_reruns`
补两侧测试。

风险定级 P2 而非 P1 的理由：触发前提是 20260826 迁移恰在 DDL 落盘与
history 落盘之间中断，窗口极窄；但一旦命中是 llm_usage 库初始化硬失败，
且 V20260824 的两处修复证明这个窗口在真实用户处发生过。

## 五、边界与纪律核查清单

- `coordinator.rs`：**未被改动**（本轮重点排查项，通过）。其 8254/8299 行
  对 `llm_usage_logs` 的 INSERT 均在 `#[cfg(test)]`、列名显式，新列可空
  不影响；同理 `database.rs` 四处未改的 INSERT 全在测试模块。
- 旧 migration 文件：零触碰（唯一 SQL 变更是 untracked 新文件）。
- `model2_pipeline.rs` 独占：diff 内容全部可归属 #1 三件事，无夹带。
- `tool_loop.rs` / 其他 `record_llm_usage_cache_ext` 调用方：零改动，
  且经核实它们本就传真实 session_id，不改是正确决策而非遗漏。
- 自述文档与代码的偏差：仅 R5-M2-1 一处（scope key 宣称过强）；其余
  自述条目（含「repo.rs 既有 insert/read 测试暴露列名笔误」的风险自评）
  与代码逐条相符。

## 六、裁决

**确认（maintain），带两条记录**：R5-M2-1（指纹作用域宣称过强 +
跨 turn 对比缺口，文档/注释必改、代码可选改，下轮）与 R5-M2-2
（V20260826 中断收敛缺口，P2，下轮需 coordinator.rs 授权）。三件交付物
的核心逻辑、落库对齐、删除安全性与车道纪律全部核实通过，无需翻案回退。

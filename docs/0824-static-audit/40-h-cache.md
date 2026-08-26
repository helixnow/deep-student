# 40 — H cache 深挖:schema 冻结、append-only、会话恢复

- 审计对象:主题仓 H cache(#175 文档枝 + #183 `cursor/sota-p0-cache-telemetry-6117`,Step 2 经 `e54603a0` 合入,合并记录见 `docs/0824-MERGE-PLAN.md`)。
- 基准:`origin/cursor/0824-cde6` @ `2d41ea8b`。本审计分支与基准的非文档差异为空(`git diff --stat origin/cursor/0824-cde6 HEAD -- src-tauri src scripts` 为空),以下行号即基准行号。
- 方法:纯静态阅读,未运行编译/测试,未改任何产品代码。

## 0. 背景:H cache 要守什么

Provider 侧 prompt cache 以「请求前缀字节完全一致」为命中条件:system 是第 0 字节,tools 紧随其后(Anthropic 把 tools 纳入缓存前缀)。H 的核心策略是把三段易漂移的前缀来源分别冻结并持久化:

| 前缀来源 | 冻结机制 | 持久化键(session.metadata) |
|---|---|---|
| tools 顺序与字节 | 会话级名字序基线 + 窗口级字节冻结 | `frozenToolSchemaOrder` |
| system 内 available_skills 目录 | 会话首次生成后冻结 | `availableSkillsSnapshot` |
| 历史头部工具输出占位符化边界 | microcompact 锚点只随 compaction 推进 | `microcompactAnchor` |

三个键名常量前后端各自定义并逐字对齐(`types.rs:459/470/481` 与 `progressiveDisclosure.ts:653`)。

## 1. schema 冻结(名字序 + 字节级双层)

### 1.1 名字序冻结

```26:28:src-tauri/src/chat_v2/pipeline/tool_loop.rs
pub(crate) fn sort_tool_schemas_for_prompt_cache(tools: &mut [Value]) {
    tools.sort_by(|a, b| tool_schema_sort_key(a).cmp(tool_schema_sort_key(b)));
}
```

`freeze_tool_schema_order_for_prompt_cache`(`tool_loop.rs:39-72`):基线为空(会话首轮)按字母序建立;基线非空时已发出工具严格按冻结序排,新工具排在全部基线之后、同批彼此按名字排(确定性),随后把新名字追加进基线。排序键 `tool_schema_sort_key`(`tool_loop.rs:15-21`)优先读 OpenAI function 格式的 `function.name`,顶层 `name` 仅作回退——修掉了 G6 时代「只读顶层 name 恒为空串、排序退化为 no-op」的旧坑。空 key 工具不进基线(`tool_loop.rs:65-67`),不会向基线塞空串。

### 1.2 字节级冻结(窗口内)

`freeze_tool_schemas_for_prompt_cache`(`tool_loop.rs:105-132`)在名字序之上把已发出工具的**序列化字节**在稳定窗口(一次 `execute_with_tools` 工具环)内冻结:首见工具记入 `frozen_schemas`,已发出工具**无条件**回写冻结副本。无条件回写的理由写得很清楚:serde_json 开启 preserve_order 后,键序不同的 `Value` 可以 `==` 相等但序列化字节不同,只在 `!=` 时回写不足以保证逐字节不变(`tool_loop.rs:96-98`)。同名 schema 窗口中途变化(MCP 刷新、load_skills 披露不同版本)只打 info 日志并延迟到下一窗口生效。

### 1.3 两个生产调用面

- 单变体工具环:环外初始化载入会话基线 + 窗口级空字节表(`tool_loop.rs:330-337`),环内每轮对 `custom_tools` 做双层冻结后把名字序基线写回会话级状态,字节表保持窗口级不持久化(`tool_loop.rs:985-995`)。
- 多变体管线:`multi_variant.rs:1274-1323` 首轮建基线,`multi_variant.rs:1679-1685` 环内 load_skills 刷新后再冻结并写回。注意多变体路径只调用名字序冻结(`freeze_tool_schema_order_for_prompt_cache`),没有字节级冻结——见第 4 节观察 O3。

## 2. append-only 语义

### 2.1 合并原语

```78:87:src-tauri/src/chat_v2/pipeline/tool_loop.rs
pub(crate) fn merge_frozen_tool_schema_order_baseline(
    entry: &mut Vec<String>,
    baseline: &[String],
) {
    for name in baseline {
        if !entry.iter().any(|existing| existing == name) {
            entry.push(name.clone());
        }
    }
}
```

只追加缺失名,绝不删除或重排已有条目。这一个函数被三层复用,保证「内存 ↔ 内存」「内存 ↔ 持久化」的合并语义完全一致:

1. **进程内共享基线**(`helpers.rs:1058-1081` `store_session_frozen_tool_schema_order`):并行变体各持局部副本,写回时对共享 entry 做 append-only 合并,任一变体已发出的前缀不被其他变体打乱。合并是相对序——变体 B 的工具面若是基线子集,按基线过滤后顺序仍与 B 已发出字节一致。
2. **恢复期竞争**(`helpers.rs:1038-1046`):内存 miss 后不持锁读库,读库期间并行变体可能已建内存基线,回填用同一 append-only 合并,只补缺失名、不覆盖。
3. **持久化侧**(`repo.rs:2686-2734`):IMMEDIATE 事务内读-合并-写,防并发写回互相丢失;对 metadata 只 upsert `frozenToolSchemaOrder` 单键,authority/plan 等其他键原样保留;合并后长度不变即无新增,跳过写库(`repo.rs:2712-2716`,发送热路径每窗口都调用,避免无意义行重写);故意不推进 `updated_at`,不扰动会话列表排序(`repo.rs:2731-2732`)。

### 2.2 容错降级方向一致

解析侧(`repo.rs:32-43`)缺键/非对象/元素非字符串一律降级为空基线 = 会话首轮语义;读库失败(`helpers.rs:1026-1036`)与写库失败(`helpers.rs:1072-1080`)都只打 warn,绝不阻断发送。降级代价是下一进程退回冷基线(缓存 miss 一次),不是功能故障——方向正确。

## 3. 会话恢复(跨进程前缀复用)

provider 侧 prompt cache 跨进程存活,所以桌面 App 重启后三个状态都必须从 session.metadata 恢复,禁止按 live 状态重算:

### 3.1 tools 基线

`load_session_frozen_tool_schema_order`(`helpers.rs:1017-1047`):内存命中直接返回;miss 时从 `repo.rs:2658-2676` 读持久化基线回填。`pipeline.rs:1153-1181` 的 `frozen_tool_schema_order_survives_memory_clear` 直接模拟「清空内存 → 从库恢复 → 基线不变」及「推进后再清 → 恢复推进后的值」。

### 3.2 available_skills 目录快照(前后端协作)

- 前端热路径读模块级 Map(`progressiveDisclosure.ts:647-667`),TauriAdapter 重建(切会话再回来)不丢;
- 构建 system 时若无快照则按 live 生成并异步调 `chat_v2_freeze_available_skills_snapshot` 冻结(`TauriAdapter.ts:5288-5341`);
- 后端 first-write-wins:已存在快照(**含空串**——安装前发过消息的会话合法冻结为无目录)绝不覆盖,返回持久化权威值,前端以返回值回灌内存(`repo.rs:2786-2814`、`TauriAdapter.ts:5329-5332`),多窗口竞争收敛正确;
- 重启后 loadSession 从 `session.metadata` 回灌(`TauriAdapter.ts:3717-3721`),`typeof === 'string'` 判空串安全;
- 命令做了 session_id 前缀校验(`sess_/agent_/subagent_`,`manage_session.rs:392-399`),并已注册进 `permissions/application-commands.toml`。

空串与缺键的区分在两侧解析里都是显式的(`repo.rs:50-55` 返回 `Option<String>`;前端 Map `has` 判断),没有把「冻结为无目录」误判成「从未冻结」的通路。

### 3.3 microcompact 锚点

`resolve_microcompact_eligible_turns`(`helpers.rs:946-1007`):内存 miss → 读持久化锚点,用 `entry().or_insert` 只填空位(恢复期并行变体已建锚时不覆盖);锚点推进决策是纯函数 `advance_microcompact_anchor`(`helpers.rs:1280-1298`)——lineage(活跃 compaction id)未变则锚点冻结,生效值与当前批量值取 min 防御历史变短(编辑/换分支)越界;lineage 变化或首次观察才批量推进到 `U - K`。变化才持久化(`repo.rs:2860-2884` 值相等跳过写库)。生产消费点在 `history.rs:556-561`,占位符化本身(`helpers.rs:1315` 起)保证最近 `MICROCOMPACT_KEEP_RECENT_USER_TURNS = 3` 轮永远保原文、不动数据库、不破坏 tool call/result 配对。`pipeline.rs:1185-1240` 的恢复测试锁死「重启后 eligible 不跳变」。

### 3.4 测试覆盖

`prefix_snapshot_tests.rs` 四个字节级回归(system 跨轮字节相等、volatile 不漏进 system、已发出 tools 是后续轮严格字节前缀且覆盖 JSON 持久化往返、system+tools 组合前缀只允许尾部追加);`tool_loop.rs:3782-3902` 覆盖窗口内字节冻结与双窗口交错;`helpers.rs:1608-1830` 覆盖占位符化与锚点推进。Step 3/5 合并后回归记录 `prefix_snapshot` 4/4、`llm_adapter` 6/6 均绿(见 MERGE-PLAN)。

## 4. 遥测面(简查)

`V20260824__add_cache_write_tokens.sql:14` 为 `llm_usage_logs` 加 nullable 的 `cache_write_tokens`;`record_llm_usage_cache_ext` 在 `llm_usage/mod.rs`、`model2_pipeline.rs`、`tool_loop.rs` 三处接线;Step 19 的 rel-llmusage(`920dd665`)加固了 NULL≠0(未测量 ≠ 零)语义;`scripts/cache-hit-report.py` 头注明确把全 NULL 报为「无测量」而非 0%,并按 write≫read 判定前缀不稳定。口径自洽。

## 5. 观察项(均不构成本轮改码理由)

- **O1(低)内存驻留无清理**:`sessionAvailableSkillsSnapshots` Map 的 `clearSessionAvailableSkillsSnapshot` 仅测试调用,无生产调用点;后端 `frozen_tool_schema_orders`/`microcompact_anchors` 两个进程级 HashMap(`pipeline.rs:182/192`)同样只增不清。会话删除后条目残留至进程退出。条目是短字符串/小结构,session_id 唯一不会串号,纯内存占用问题,量级可忽略。
- **O2(低)首次冻结依赖会话行已存在**:`freeze_session_available_skills_snapshot` 对不存在的 session 返回 SessionNotFound,前端仅 warn、本进程继续用内存快照(`TauriAdapter.ts:5334-5340`)。若创建会话与首次发送存在竞态,代价只是重启后退回 live 重算(缓存 miss 一次),降级方向与全链一致。
- **O3(低,设计取舍)字节级冻结仅窗口级、且多变体路径未接**:跨窗口 schema 变化会打断 tools 段缓存一次,这是「窗口内字节冻结、跨窗口采纳新字节」的明示设计(`tool_loop.rs:102-104`);多变体管线只有名字序冻结,同名 schema 字节漂移仍可能打断变体请求的 tools 前缀——影响面小(变体历史短、缓存收益本就低),可作后续增强而非缺陷。
- **O4(极低)基线永不收缩**:卸载/消失的工具名永久留在 `frozenToolSchemaOrder`,只按现存工具过滤排序,无正确性影响,metadata 体积增长以工具名计,有界。
- **O5(核对项)助记**:`merge_session_frozen_tool_schema_order` 与 `set_session_microcompact_anchor`、`freeze_session_available_skills_snapshot` 三者都遵守「单键 upsert + 不推进 updated_at + IMMEDIATE 事务」,行为一致,无一处例外。

## 结论

H cache 的三大机制在 `origin/cursor/0824-cde6` 上实现完整、语义自洽:schema 冻结是「会话级名字序 append-only 基线 + 窗口级字节冻结」双层结构,append-only 合并原语被内存共享、恢复竞态、持久化三层统一复用,会话恢复对 tools 基线/skills 目录快照/microcompact 锚点三个持久化键都有内存 miss 回灌路径与 first-write-wins/entry-or-insert 竞态收敛,失败一律降级为冷缓存而非阻断发送;字节级回归测试(prefix_snapshot、窗口冻结、重启恢复)齐备。观察项 O1–O4 均为低危或明示设计取舍,不构成缺陷。**本轮不改代码**。

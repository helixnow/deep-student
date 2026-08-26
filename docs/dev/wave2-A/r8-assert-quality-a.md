# Wave2-A 第 8 轮 #7：fork / skill / crash 测试断言质量静态复核

- 模型：`gpt-5.6-sol-xhigh-fast`
- 基线：`c1cde7e3`
- 范围：
  - `prefix_generation_fork_tests.rs`
  - `prefix_generation_fork_finale_tests.rs`
  - `skill_replay_digest_tests.rs`
  - `skill_replay_edit_delete_tests.rs`
  - `llm_content_crash_tests.rs`
- 规模：35 个测试函数、219 处 `assert!` / `assert_eq!` / `assert_ne!`
- 方法：只读源码，按“断言 oracle 是否独立、是否触达生产行为、典型错误实现能否假绿、
  可观测量是否完整”复核。
- 纪律：**未运行测试、编译或格式化；仅做源码/报告静态检查；未改测试/产品代码；
  未 commit。**

## 结论

这些测试作为**合同样例和场景清单**很详细，但不能把全部未来“绿”解释为生产实现已经
通过回归验证：

| 组 | 测试 / 断言数 | 核心生产路径触达 | 断言质量裁决 |
|---|---:|---|---|
| fork | 8 / 80 | 冻结/append-only 原语有触达；收敛、代际、恢复、advance 均为本地副本 | **低**：核心产品突变大面积假绿 |
| skill | 14 / 104 | r7 终局和 edit/delete 直打生产门禁、渲染及插入原语；生产锚点写入与 history 消费接线未触达 | **中上（门禁）/低（全链宣称）** |
| crash | 13 / 35 | 核心行为全部由假结构体和手写副本模拟 | **低**：场景覆盖宽，产品回归敏感度接近零 |

总裁决：**不建议把这 35 条作为 fork/crash 落地正确性的验收证据。** skill 门禁本体已有
一批有效生产断言；其余大量断言只证明测试内副本自洽。最需要修的不是“再加 assert”，
而是把现有高价值断言迁到生产 seam 上。

## 1. 高优先级问题

### AQ-A-1（高）：fork 的 80 处断言没有调用生产收敛函数

两个文件都定义了自己的 `converge_orders_by_variant_index`：

- `prefix_generation_fork_tests.rs:68-78`
- `prefix_generation_fork_finale_tests.rs:66-76`

而现势生产实现已经存在于
`helpers.rs:1153-1225` 的 `converge_session_tool_face_prefix`。测试文件头仍写着
“产品落地后改调生产函数”，迁移尚未发生。

本地副本与生产实现并非等价测试面：

1. 副本输入只有 `Vec<Vec<String>>`，无法验证生产的 `(variant_index, snapshot)`
   排序（`helpers.rs:1160-1162`）。
2. 副本不覆盖生产 entry 的既有 generation/order、锁内合并及 `generation += 1`
   （`:1191-1212`）。
3. 副本完全遗漏 digest 共识采纳（`:1177-1188`）；这正是 r6 曾发现过死接线的面。
4. 副本不调用真实 repo advance，不验证 DB、事务、metadata 其他键保留或写失败降级。
5. 测试调用副本与断言期望都由同一份测试代码定义，生产函数即使被删除、改成按完成序
   合并、停止 bump，8 条仍可全绿。

特别弱的三个“看似集成”场景：

- `steady_state_survives_many_rounds_and_variant_index_shuffles`
  （finale `:318-367`）洗牌的是两个**完全相等**的 order，且副本根本没有 index
  参数；错误地忽略/反排 variant index 也会绿。
- `restart_between_fork_and_next_round_preserves_xy_visibility_and_generation`
  （`:374-420`）只清空局部 `HashMap`，随后调用局部 `snapshot_from_metadata`；
  未触达 pipeline 内存表、真实 DB 或生产 load。
- `stale_pre_fork_writeback_cannot_regress_steady_state`
  （`:427-473`）调用的是本地 `advance_snapshot_into_metadata`。所谓“跳过写库”和
  metadata 字节不动只是局部函数返回 `false` 后没有修改 `Value`，不能证明 SQL 未写、
  `updated_at` 未推或并发 advance 安全。

### AQ-A-2（高）：crash 的全部断言都只验证假件自身

`llm_content_crash_tests.rs` 没有调用以下任一生产入口：

- `persist_user_llm_content_early`（`persistence.rs:275-310`）
- `persist_replay_sidecar`（`persistence.rs:212-250`）
- repo 的 replay 列 UPDATE/读取
- `history.rs:252-281` 的真实 override
- `pipeline.rs:1000-1018` 的阶段 4.6 → provider 调用次序

核心 fake 的行为是直接赋值：

- early persist：`:103-109` 把 live 字段 clone 到 row；
- send：`:125-127` 再从同一字段 clone；
- save-point rebuild：`:136-142` 明写“保留原 llm_content”；
- replay：`:176-180` 手写生产 filter 的副本。

因此多条核心断言由构造保证：

- “early persist 后 replay == live”比较的是同一源字符串的两次 clone；
- “save point 不抹 sidecar”验证的是 fake 结构体字面量主动复制该字段；
- “多字节逐字节保真”没有经过 SQLite/序列化/读取边界，只比较 String clone；
- “旧库不阻断发送”中的 fake 方法无返回值、无错误分支，天然不可能阻断；
- “编辑重发不复活旧值”先手工置 `None`、再手工置新值，没有调用编辑事务或 repo；
- “multi_variant 仍有窗口”只是测试刻意不调用 fake early persist，生产路径是否已经
  增删调用点都不会影响结果。

这组测试的价值是崩溃点谱系写得清楚；回归价值则很弱。删除生产阶段 4.6 调用、
UPDATE 错行、读侧不认 sidecar、旧库错误不再吞掉等真实回归均不会使 13 条变红。

### AQ-A-3（中高）：skill 的门禁断言有效，但“完整生命周期”未真正贯通

有效部分：

- `skill_replay_digest_tests.rs:508-745` 直接调用生产
  `rebuild_anchored_skill_messages_gated_with_signal` 和生产 `skill_body_digest`；
- `skill_replay_edit_delete_tests.rs` 的 7 条均直打生产 gate，末条还直打生产
  `insert_transient_skill_messages`；
- 对 skip/restore、顺序、信号去重、legacy 兼容、精确字节恢复均有明确正反断言，
  oracle 也不是 gate 的本地复制。这部分能捕获 `history.rs:898-933` 的真实回归。

但文件所称“锚定 → meta JSON 落库 → 反序列化 → 门禁重放 → 信号聚合 → 插入层”
只覆盖了中间纯函数：

1. `anchors_for_turn` / `production_anchors` 由测试直接构造 digest map，没有触达
   `tool_loop.rs:707-735` 与 `:1967-2009` 的两个生产锚点写点。生产若漏写 digest，
   gate 测试仍绿。
2. “落库”只是 `serde_json::to_string(&anchors)` 后立即反序列化，没有把 anchors
   放入 assistant metadata、写 repo、再由 history 读取。
3. `deleted_live_skill_with_replay_snapshot_still_replays_old_bytes`
   （edit/delete `:273-295`）把预先合并好的 map 直接传给 gate；它不验证三个消费点
   的 `replay_skill_contents.or(skill_contents)` 快照优先级。优先级反转仍会绿。
4. mixed turn/tool 用例手动调用 gate 两次，能测 gate 的共享 Vec 去重，却不能测
   `load_chat_history_pass` 的 tool_call_id 关联、三个消费点共享聚合器或 pending
   锚点 drain。
5. 断言只观察 `mismatched_skill_ids`，没有调用
   `record_skill_digest_prefix_generation_signal`；所以“切代信号”落 repo、幂等折叠及
   下轮消费不在这批测试的证明范围。

因此应把该组描述收窄为“生产门禁与插入原语单元测试”，或补一条真实 history/repo
贯通用例后再称完整生命周期。

## 2. 中低优先级问题

### AQ-A-4：仍保留的 FNV 契约副本已不能验证生产 digest

`skill_replay_digest_tests.rs:127-178` 自建 FNV digest 与 gate，前 4 个测试主要围绕
该副本。生产现已使用 `types.rs:1195-1203` 的 SHA-256，并把 `skill_id` 与 body
联合取摘要。

具体后果：

- 修改/破坏生产 `skill_body_digest` 不会影响 `digest_is_deterministic...`
  （`:447-476`）。
- 没有测试生产 digest 的 id 绑定；相同 body、不同 id 应不同，是当前生产合同的重要
  一半。
- 注释“生产替换摘要算法时本测试原样保留”不成立：测试永远只测自己的 FNV。
- “对任意字节变化敏感”是过强表述；有限样本只能证明列出的 6 个输入未碰撞，任何
  固定长度 hash 都不能由单测证明对任意不同输入无碰撞。

这些测试可保留为历史合同样例，但不能计作生产 digest 覆盖。应将性质断言直接改打
`skill_body_digest(id, body)`，并增加“同正文换 id”样本。

### AQ-A-5：部分“字节相等”断言是同构构造，不具备足够判别力

fork 的 `variant_discloses` 从同一个 baseline、同一固定 description 构造两个工具数组，
再断言序列化字节相等。它证明 serde 对相同 Value 确定，却没有证明两个生产 variant
真的从同一快照出发或 provider body 前缀相等。生产 fan-out 接线断掉仍会绿。

skill 的字节断言较好，因为 gate 的 actual 来自生产函数；但 expected 多数也调用
`make_transient_skill_message`。这能验证 gate 选择/顺序，却不能独立保护渲染模板。
`matching_digest_replays_byte_identical_to_live` 额外钉了完整 content、role、metadata，
是此处较强的独立 oracle，其他用例不必重复宣称模板本身已被验证。

crash 的 String 等值本身就是字节等值；`:570-578` 再比较 `as_bytes()` 和长度没有增加
经过持久化边界的证据。

### AQ-A-6：隐私断言是字符串包含检查，精度不足

`edit_lifecycle_anchor_persist_reload_gate_skips_edited_body_and_signals`
（edit/delete `:117-125`）用：

- `!persisted.contains("列方程")`
- `persisted.contains("skillContentDigests")`

来证明“只落 digest、不落正文”。它能抓住当前明文正文整体泄漏，但不能抓编码后泄漏、
其他正文片段泄漏或新增了不应持久化的字段。更稳的 oracle 是把 JSON parse 成对象，
断言允许的键集合、digest 值与不存在的 body/content 字段；若合同要求严格形状，可直接
与完整预期 JSON 比较。

## 3. 各组值得保留的断言

本次裁决不是认为场景设计无价值。以下断言具有较好的边界意识，迁到生产 seam 后可直接
保留：

- fork：X/Y 刻意逆字母序、同时断言正确序与错误序不等；真分叉只 bump 一次；
  单写者/前缀链不 bump；迟到低代快照不回退。
- skill：mismatch 与 missing 分档；恢复必须精确到 CRLF/尾换行等字节；turn/tool
  重复 id 信号去重；全部 skip 时插入层 no-op，并有命中路径正对照。
- crash：崩溃点按“早写前 / 早写后发送前 / 发送后保存前 / 正常保存点”分层；
  empty 与 whitespace 分档；legacy 多 CONTENT 块的 `find_map` 后置 filter 角落；
  编辑失效、旧库、multi_variant 缺口均有明确“语义变化时应翻转”标记。

问题集中在**这些好 oracle 被接到了测试副本，而非生产被测对象**。

## 4. 最小整改顺序

1. **fork 先抽生产纯内核**：把“按 index 排序 + order 收敛 + fork 判定 + digest
   共识”提成生产纯函数，现有 80 处断言改调它。至少新增一例输入顺序与 index 顺序
   相反且尾部不同，确保排序错误必红。另留 1 条真实 DB 用例覆盖 load/converge/
   advance/restart/迟到写回。
2. **crash 改成 repo/pipeline seam**：无需真的杀进程；创建测试 DB 和真实 user block，
   设置真实 ctx 编译值，调用 production early persist，然后故意不调用 save_results，
   再走真实 replay 读取。旧库场景使用确实缺列的 schema，验证 Result 与后续发送门控；
   保存点和编辑场景复用现有 history/repo 测试夹具。
3. **skill 删除双实现 oracle**：前 4 条改打生产 digest/gate；补一条由生产锚点写点产出
   anchors、经 metadata/repo、再由 `load_chat_history_pass` 消费的贯通测试。快照优先级
   必须让 replay/live 两张 map 同时存在且正文不同，才有判别力。
4. **将留档缺口与目标合同分组**：`绿·留档` 用例名称或模块显式标记
   `current_behavior`，避免未来修复后红灯被误判为回归；合同预演在实现落地后必须改打
   production，不应长期保留 fake。

## 5. 已验证 / 未验证

静态已确认：

- 当前 tip 的五个文件均已在 `pipeline.rs:92-104` 挂载；
- fork 两文件核心收敛、metadata、advance 为测试内副本；
- crash 文件核心时序、写读均为 fake；
- skill r7 终局与 edit/delete 直打生产 gate，但生产锚点写入、history 消费、repo 信号
  未由这五个文件贯通；
- 上述典型生产突变对相应测试的“可存活”关系可由调用图直接推出。

未验证：

- 未编译，故不声称这些测试当前可编译；
- 未执行，故不声称任何一条实际绿/红；
- 未做 mutation test；“假绿”判断是按静态调用边界推演；
- 未审 `llm_content_retry_gap_tests.rs`，它不在本席用户指定的 crash 文件范围。

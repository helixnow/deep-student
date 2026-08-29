# R10-#4 全 PR 交叉终审:目录生命周期 / TauriAdapter 快照段

- 作者:0824 Wave2-A 第 10 轮子代理 #4(`claude-fable-5-thinking-xhigh`)
- 日期:2026-08-26
- 基线:`cursor/0824-wave2-agent-cache-a875` @ `659b8c54`(第 9 轮扫尾 tip);
  官方基座 `origin/cursor/0824-cde6` @ `061b4815`
- 独占可写面:仅本文档。**未改任何 TS / Rust 产品代码**,未碰 Composer
  移动热区与桌面行为,未碰 hooks / 负例测试 / coordinator.rs。
- 铁律遵守:未执行 tsc / vitest / cargo / npm / 任何安装与编译(本机
  rustc 1.83.0 ≠ 项目要求 1.98,无 node_modules);未 commit / push。
  全部结论为静态取证(读码 / grep / git diff / git log)。
- 对照输入:r4-catalog-atomic / r4-catalog-compaction / r4-catalog-delta
  (含 §7 R9 勘误)/ r4-review-frontend / r5-catalog-pending /
  r5-digest-generation-signal / r6-catalog / r9-open-items。

---

## 0. 结论速览

| 终审专项 | 判定 | 关键证据 |
|---|---|---|
| first-write-wins 未回退 | **确认** | 后端覆盖门闩唯一且严格(§3);既有负例测试一字未动;前端普通路径逐字节复用、绝不按 live 重算(§1);r5 落地提交(`4b784bb4`)之后相关段零 diff(§4) |
| delta 未接线 | **确认** | `computeAvailableSkillsDelta` / `generateAvailableSkillsDeltaPrompt` / `extractCatalogSkillIds` 全仓(src/)零外部调用方,`skills/index.ts` 未再导出,测试文件亦未引用(§2) |
| pending 只在 loadSession 检测 | **确认** | `readAvailableSkillsSnapshotPendingGeneration` 全仓唯一调用点 `TauriAdapter.ts:3811`(loadSession 回灌段内);无 compact 响应 / 事件面检测点(§1.3) |

无翻案,无代码改动需求。一处文档措辞漂移(r5-catalog-pending 的
「pending 键只有 compaction 会写」在 r5-#8 落地后已不完整)记入 §5,
属文档口径备注,非缺陷。

---

## 1. TauriAdapter 快照段(`ensureAvailableSkillsSnapshotFrozen`,:5437-5497)

### 1.1 发送等待点链路唯一性(复核 r4-review / r6-catalog,现行号)

- `ensureAvailableSkillsSnapshotFrozen`(:5437)唯一调用方
  `buildSystemPromptWithSkills`(:5395),后者唯一调用方 `buildSendOptions`
  (:4927,async);
- `buildSendOptions` 调用点恰好 8 个、全部 `await`:
  `:2775 / :2946 / :3019 / :3328 / :3517 / :3658 / :4281 / :4341`
  (与 r6-catalog §1.1 记录的行号逐个一致,零漂移——该文件自
  `4b784bb4` 起未再改动,见 §4);仓外仅
  `chatInteractionTestPlugin.ts:1323` 注释提及;
- 前端 `chat_v2_freeze_available_skills_snapshot` 的 invoke 全仓唯一
  (:5456)。**不存在绕过冻结确认闸的发送路径,R4 原子首发不变式在位。**

### 1.2 first-write-wins 前端侧:普通路径无回退(逐行核对)

- 快路径(:5441-5444):`persisted !== undefined && pendingGeneration ===
  undefined` → 直接 `getSessionAvailableSkillsPrompt` 逐字节复用冻结
  内存快照,零 RPC、零重算——R4 行为原样;
- 冻结路径二分(:5449-5452):**仅** `pendingGeneration !== undefined`
  时才 `generateAvailableSkillsPrompt()` 按 live 重生成(且不写内存
  Map,失败时旧代字节不被污染);无 pending 的首冻 / 失败重试用
  `getSessionAvailableSkillsPrompt` 的同一内存字节;
- inflight 共享(:5454-5468):同 session 并发发送共享同一 freeze
  Promise,`finally` 清句柄 + 空 `catch` 防 unhandled rejection,错误由
  await 处抛出(:5473-5477,消息含 `fail-closed`)——失败先于状态表
  更新,pending 不丢、内存字节保留,与 r5-catalog-pending 宣称一致;
- 竞争输家回灌(:5491-5495):普通路径仅 `effective !== snapshot` 时
  hydrate 生效值并返回它;换代路径(:5485-5489)无条件回灌。两侧收敛
  到后端持久化权威,**没有任何路径能把 live 重算字节在未经 freeze 门闩
  的情况下发出**。

进入「按 live 重算」的唯一门是 `pendingGeneration`,而它只能来自
loadSession 从 metadata 解析出的有效 pending 键(见 §1.3),该键只有
后端 `mark_session_available_skills_snapshot_stale_with_conn` 会写。
门闩镜像(前端 :233-242 `raw > generation` / 后端 :2876-2878
`filter(pending > generation)`)与键名字面量(:208-209、:217-218 ↔
repo.rs :69、:79)复核仍逐字一致(r6-catalog §2.1 对拍表在本 tip 依然
成立)。

### 1.3 pending 检测点唯一性(专项)

grep 全仓(src/):

- `readAvailableSkillsSnapshotPendingGeneration` 定义 :233,唯一调用
  :3811——位于 `loadSession` 的 metadata 回灌段(:3798-3816),且在
  `typeof persistedSkillsSnapshot === 'string'` 守卫内。守卫不构成漏检:
  后端 mark 原语对从未冻结的会话 no-op(repo.rs :2943-2945),
  「有 pending 无 snapshot」的 metadata 组合在 DB 中不可能存在;
- `persistedAvailableSkillsSnapshotGenerations` 写入点恰好两个:
  loadSession(:3809,连 generation 带 pending 从 metadata 重读)与
  freeze continuation(:5482,兑现后清 pending);全仓无 `.delete(`;
- TauriAdapter 内无 compact 之后的 loadSession / metadata 重读调用
  (r6-catalog §2.4 结论在本 tip 复核维持):**会话中途**后端写入的
  pending(自动 compaction 或 digest 漂移信号)要等该窗口下次
  loadSession 才被拾取,老窗口在此之前继续用旧代字节发送——晚兑现
  只是晚享收益,不产生错误覆盖,与 r9-open-items §2 挂账口径一致
  (该表所记行号 `:194/:218/:233/:3804` 现漂移为 `:196/:217/:233/:3811`,
  语义无变)。

## 2. progressiveDisclosure:delta 未接线(专项)

- `extractCatalogSkillIds`(:758)/ `computeAvailableSkillsDelta`(:783)/
  `generateAvailableSkillsDeltaPrompt`(:816)三符号在 `src/` 全仓的
  命中**全部**落在 `progressiveDisclosure.ts` 文件内(定义 + 模块内
  互调);
- `skills/index.ts` 再导出清单(:147-151)含 `getSessionAvailableSkillsPrompt`
  / `hasSessionAvailableSkillsSnapshot` / `hydrateSessionAvailableSkillsSnapshot`
  / `clearSessionAvailableSkillsSnapshot`,**不含**任何 delta 符号;
- 测试文件 `progressiveDisclosureConfig.test.ts` 亦未引用 delta 符号。

即 delta 仍是「原语齐备、零消费方」状态,与 r4-catalog-delta §7.2
勘误(「仍开,需 TS+Rust 对席」)、r6-catalog §3.2(传输面前置:瞬态
技能消息渲染在 Rust pipeline 侧,接线需 SendOptions 新字段 + Rust
注入点,超单席独占面)、r9-open-items §2 乙类挂账三处口径完全吻合。
**本轮终检禁止新开产品面,维持不接线,无违规提前接线迹象。**

delta 代码本体维持 r4-review / r6-catalog 双重确认结论(只读快照 Map、
不触发冻结副作用、解析/生成转义对称、口径链与目录可用段同序),本席
抽查 :760 正则与 :790-795 过滤链与两份复核记录一致,不重复展开。

## 3. repo.rs freeze 原语与 pending>generation 覆盖门(后端侧)

### 3.1 覆盖门闩(:2865-2911)

- `effective_pending = pending.filter(|p| *p > generation)`(:2876-2878),
  严格大于,脏数据(pending <= generation)按无标记处理;
- 已冻结(含空串)且无有效 pending → 返回持久化权威值、绝不覆盖
  (:2879-2883);
- 有效 pending → 覆盖快照、`generation := pending`、删 pending 键
  (:2894-2905)——**唯一合法覆盖路径**,且兑现后新代内 first-write-wins
  立即恢复;
- 普通首冻不写代号键(缺键即第 0 代,旧会话 metadata 字节形态不变);
  只 merge 目录相关键、不推进 `updated_at`(:2908)。
- 事务形态:公开入口 `freeze_session_available_skills_snapshot`(:2851)
  IMMEDIATE 事务内读-判-写(:2856-2861),与 R2 以来的写事务纪律一致。

### 3.2 pending 写点清点(全仓)

`mark_session_available_skills_snapshot_stale_with_conn`(:2937-2972,
从未冻结 no-op / 有效 pending 幂等折叠 / `saturating_add(1)` 只写一键)
的生产调用点恰好两个:

1. `compaction.rs:1114`——`persist_prepared_compaction` 事务内、
   `set_session_last_compaction_with_conn` 之后、`tx.commit()`(:1137)
   之前,`?` 失败整体回滚(R4-#6 原样,r4-review 已核,本席复核行号
   无漂移);
2. `helpers.rs:1276`——`record_skill_digest_prefix_generation_signal`
   (r5-#8,技能正文 digest mismatch 信号):自建 IMMEDIATE 事务调同一
   原语,写库失败仅 warn 降级、**绝不阻断发送**(:1272-1295)。

第 2 写点是 r4 三份目录文档之后新增的**设计内**生产者:
r5-digest-generation-signal 全文即为其立据,r9-open-items §3 已归档
定性(「digest 冲突走 catalog pending 而非 tool-face generation」为
设计裁决非缺陷,防后续会话误当 bug 重开)。两个写点共用同一原语,
幂等折叠与覆盖门闩语义完全一致,freeze 侧不区分标记来源——
**first-write-wins 的破坏面没有因第二写点而扩大**。

### 3.3 测试与命令面(在位性核对)

- 既有负例 `available_skills_snapshot_freeze_is_first_write_wins`
  (:4931-4981,含空串快照不可追加断言)与
  `..._survives_process_restart`(:4899 起)、
  `..._preserves_other_session_metadata`(:4984 起)在本 tip 原样在位;
- R4-#6 三新测试在位:`..._explicit_generation_bump_via_compaction_marker`
  (:5035)、`..._stale_marker_is_noop_when_never_frozen`(:5145)、
  `..._empty_freeze_then_compaction_marker_allows_catalog`(:5203)——
  仍为只写未跑(见 §6);
- 命令 `chat_v2_freeze_available_skills_snapshot`:handler
  `manage_session.rs:387`(session_id 前缀校验 `sess_/agent_/subagent_`)
  注册于 `lib.rs:2083`,前端 invoke 参数 `{ sessionId, snapshot }`
  camelCase 映射一致。

## 4. 变更冻结取证:三段代码在复核基线之后零漂移

r4-review-frontend 基线 `6069675e`、r6-catalog 基线 `4b784bb4`。本席以
git 历史核对复核结论到本 tip(`659b8c54`)的有效性:

| 文件 | 最后触碰提交 | r5 落地(`4b784bb4`)→ HEAD |
|---|---|---|
| `progressiveDisclosure.ts` | `2d70b400`(R4 落地) | **零 diff** |
| `TauriAdapter.ts` | `4b784bb4`(R5-#9 落地:Set→Map、pending 兑现) | **零 diff** |
| `repo.rs` | `2d70b400`(available_skills 段;之后无该段改动) | **零 diff** |
| `compaction.rs` | (R4-#6 落地后未再触碰目录段) | **零 diff** |
| `helpers.rs` | `618634a6`(+46/−12) | 有 diff,但 hunks 全落 converge 段(:17 / :1114-1116 / :1129-1195 区),diff 内 grep `available_skills|record_skill_digest|mark_session` **零命中**——目录信号函数未被二次改动 |

即:r4-review-frontend 与 r6-catalog 两轮复核所确认的目录生命周期代码,
在第 6–9 轮(digest converge 二修、write-only 反例、文档轮)中**一行
未再变**。两份复核结论对本 tip 依然有效,本席终审为第三次独立确认。

工作区状态:仅 `docs/dev/wave2-A-ledger.md` 修改与 4 个第 10 轮新文档
untracked,无任何产品代码未提交改动。

## 5. 文档偏差与新观察(非翻案)

1. **r5-catalog-pending「不变量核对」首条措辞已不完整**:原文写
   「该键只有 compaction 落盘事务会写」。同轮 r5-#8 落地后,
   `helpers.rs:1276`(digest 漂移信号)成为第二个生产写点。语义结论
   (「进入再 freeze 的唯一门是有效 pending,普通路径不回退」)**不受
   影响**——两个写点走同一 mark 原语、同一门闩;但字面宣称过时。
   r5-digest-generation-signal 与 r9-open-items §3 已各自立据,本席
   不改 r5 文档正文(不在可写面),在此挂勘误指针即可。
2. **r9-open-items §2 pending 挂账行的行号漂移**:`:194/:218/:233/:3804`
   现为 `:196/:217/:233/:3811`(R5 落地后 TauriAdapter 内部行号自然
   下移),语义零变,后续引用以符号名为准。
3. r4-catalog-delta §4 键名过时问题**已闭合**(R9-#3 追加 §7 勘误节,
   本席读到勘误在位,指向 r4-catalog-compaction 双键与 freeze 原语
   兑现形态)——r4-review-frontend 遗留项 1 不再挂账。

## 6. 遗留项状态终表(目录链条,供 r10-delivery / 台账引用)

| 项 | 状态(本席终检口径) |
|---|---|
| #7 delta 发送路径接线 | **仍开(设计内不接)**。零消费方复核见 §2;需 TS(SendOptions 字段)+ Rust(瞬态注入点)对席,本会话红线明确不做(r9-open-items 乙类) |
| pending 只在 loadSession 检测(中途 compaction/digest 信号要等 reload 兑现) | **仍开(设计内窄口)**。检测点唯一性核实见 §1.3;扩展需 compaction 成功事件面,与 delta 接线同面同轮处理 |
| `clearSessionAvailableSkillsSnapshot` 不清 persisted 表 | **仍开(潜伏级)**。本轮 grep 复核:生产零调用(仅 `progressiveDisclosureConfig.test.ts` 与 index.ts 再导出);引入生产调用时必须同步 `persistedAvailableSkillsSnapshotGenerations.delete(sessionId)`,否则打穿「表有项 ⟹ 内存已同步」不变式(r6-catalog §1.3) |
| 键常量三处字面量(repo.rs / TauriAdapter;未来收口 progressiveDisclosure) | **仍开(低危)**。本席第三次对拍逐字一致;漂移风险靠对拍记录 + 验证轮测试兜底 |
| r5-catalog-pending 措辞勘误(§5.1) | **新挂(文档债,一行勘误量级)**。留给可写该文档的轮次或人工收口 |
| 全部 Rust/TS 目录链条测试零执行 | **仍开(环境阻断)**。rustc 1.83 ≠ 1.98、无 node_modules,本轮铁律停测;repo 四测试 + 前端快照测试为首批补跑对象 |

## 7. 已验证 / 未验证声明

### 已验证(本席独立静态取证,不沿用前两轮记录)

- 冻结闸链路唯一性 + 8 个 await 调用点(grep 现行号,与 r6 记录零漂移);
- 快路径 / 冻结二分 / fail-closed 先于表更新 / 输家回灌(:5437-5497 逐行);
- pending 检测点全仓唯一(:3811)+ persisted 表两写入点、无 delete;
- delta 三符号 src/ 全仓零外部调用 + index.ts 不含再导出 + 测试不引用;
- 后端覆盖门闩(:2876-2878)、mark 原语两生产写点清点、negative 测试
  与三新测试在位、命令注册与参数映射;
- 前后端键名 / 缺键 = 0 / 严格大于门闩第三次对拍;
- git 历史证明五文件目录段自各自复核基线后零漂移(§4 表)。

### 未验证(诚实归因)

- 未跑 tsc / vitest / cargo check / cargo test:全部目录链条代码与测试
  仍无编译或运行时证据(沿 R4–R9 未验证债务,与 r9-pr-body Draft 口径
  一致);
- 多窗口竞争、compaction → reload → 兑现、digest 信号 → 换代的端到端
  行为均为静态推演(r6-catalog §2.3 竞态分析在本 tip 代码未变前提下
  继续有效),无真实请求对拍。

# R6-#6 目录生命周期二检：原子首发 / pending 兑现 / delta / repo 换代键

- 作者：Wave2-A 第 6 轮子代理 #6（claude-fable-5-thinking-high）。
- 基线：`cursor/0824-wave2-agent-cache-a875` tip `4b784bb4`，工作区无未提交改动
  （本席开工时 `git status` 仅 untracked `ROUND-06-TASKS.md`）。
- 可写面：本文档 + `progressiveDisclosure.ts`（仅限明确 bug）。
  **裁决：未发现明确 bug，`progressiveDisclosure.ts` 零改动**；本席未碰
  `TauriAdapter.ts` / `repo.rs` / `compaction.rs`（均不在可写面）。
- 铁律遵守：未执行 tsc / vitest / cargo / 任何编译测试；全部结论为静态证据
  （读代码 / grep / 交叉核对 r4-catalog-{atomic,compaction,delta}.md、
  r5-catalog-pending.md、r4-review-frontend.md）。

## 结论速览

| 检查面 | 判定 | 备注 |
|---|---|---|
| R4-#5 原子首发（TauriAdapter） | **确认** | 8 调用点 await 在位，无绕过路径；fail-closed 语义与文档一致 |
| R5-#9 pending 兑现（TauriAdapter） | **确认** | 前端门闩镜像后端 effective_pending；失败不丢换代意图；两处并发竞态分析为良性（见 §2.3） |
| R4-#7 delta（progressiveDisclosure） | **确认（代码）**；接线仍未做 | 解析/渲染对称复核通过；**新发现一处接线前置缺口**（§3.2，设计缺口非代码 bug） |
| R4-#6 换代键（repo.rs + compaction.rs） | **确认** | 状态机、幂等折叠、first-write-wins 负例、三新测试、分支继承（§4.3 本轮新析）全部核对通过 |

无翻案，无补丁。遗留项状态更新见 §5。

---

## 1. R4-#5 原子首发：确认

### 1.1 调用点覆盖（重新全量 grep，非沿用 r4-review 结论）

`buildSendOptions(` 全仓命中：定义 `TauriAdapter.ts:4927`（async）+ 8 个调用点
`:2775 / :2946 / :3019 / :3328 / :3517 / :3658 / :4281 / :4341`，**全部带
`await`**；仓外仅 `chatInteractionTestPlugin.ts:1323` 注释提及。行号相对
r4-review 快照（:2676 等）整体下移约 100 行，属 R5 改动的自然漂移，数量与
await 形态不变。

冻结闸链路唯一：`ensureAvailableSkillsSnapshotFrozen`（:5437）仅被
`buildSystemPromptWithSkills`（:5395）调用，后者仅被 `buildSendOptions`
（:5143 `systemPromptOverride: await ...`）调用。全仓无第二个
`chat_v2_freeze_available_skills_snapshot` 前端调用点，旧符号
`persistAvailableSkillsSnapshot` 零残留——不存在绕过冻结确认的发送路径。

### 1.2 fail-closed 与可恢复性

- 冻结 RPC 失败在 :5473-5477 包装抛错（消息含 `fail-closed`），沿
  `buildSystemPromptWithSkills → buildSendOptions` 冒泡进各 send/retry 入口
  既有 catch（r4-review 已逐路径核对，本轮抽查 `executeRetry` 链路未变）。
- inflight 句柄 `freeze.finally(delete)`（:5461-5464）+ `.catch(() => {})`
  防 unhandled rejection（:5465-5467）：失败后句柄清除、persisted 表未写
  （continuation 在 await 之后），下次发送重试冻结。普通路径重试用内存快照
  同一字节（`getSessionAvailableSkillsPrompt` 幂等返回冻结值），与文档一致。

### 1.3 不变式「persisted 表有项 ⟹ 内存快照已同步」成立

persisted 表（`persistedAvailableSkillsSnapshotGenerations`，:196）只有两个
写入点，且都与内存快照写入同段：

- `loadSession` :3801-3816——先 `hydrateSessionAvailableSkillsSnapshot`
  （:3802）再 set 表项（:3809），同一同步块内；
- 冻结 continuation :5482-5495——set 表项后，换代路径无条件回灌、普通路径
  竞争输家回灌、赢家的内存本就是发出的 snapshot 字节。

全仓无 `persistedAvailableSkillsSnapshotGenerations.delete(`；
`clearSessionAvailableSkillsSnapshot` 生产零调用（仅
`progressiveDisclosureConfig.test.ts`）。因此「快路径 :5443 直接返回
`getSessionAvailableSkillsPrompt`」不会踩到「表已确认、内存却缺项 → 静默
live 重算并跳过冻结发出」的坑——该风险仍只在**未来引入生产清理调用**时
出现（R5 遗留 1 维持潜伏级，见 §5）。

## 2. R5-#9 pending 兑现：确认

### 2.1 前端门闩与后端镜像（逐条对拍）

| 语义 | 后端 repo.rs | 前端 TauriAdapter.ts | 一致性 |
|---|---|---|---|
| 键名 | :69 `availableSkillsSnapshotGeneration` / :79 `availableSkillsSnapshotPendingGeneration` | :208-209 / :217-218 字面量 | **逐字相同** |
| 缺键代号 | :84-89 `as_u64().unwrap_or(0)` | :221-226 非整数/负数 → 0 | 同语义（u64 vs 非负整数，JSON number 交集内等价） |
| 有效 pending | :2876-2878 `filter(pending > generation)` | :233-242 `raw > generation` 才返回 | **镜像成立**——前端不会在后端必然拒绝覆盖的场景白白重算 |

### 2.2 兑现路径逐行核对（:5437-5497）

- 快路径（:5441-5444）：有表项且无 pending → 逐字节复用，零 RPC——R4 普通
  first-write-wins 无回退，与 r5 文档宣称一致；
- 冻结入口二分（:5449-5452）：pending 有效 → `generateAvailableSkillsPrompt()`
  按 live 重生成（**不写内存 Map**——失败时旧代内存字节不被污染，宣称属实）；
  否则 `getSessionAvailableSkillsPrompt`（首冻/重试同字节）；
- 成功后（:5482-5484）`generation := pending ?? 原值 ?? 0` 并以省略方式清
  pending；失败在 :5473 抛出**先于**表更新——pending 保留，重试重新按 live
  生成，换代意图不丢（「仅兑现成功后清除」逐行成立）；
- 换代路径无条件回灌 effective（:5485-5489）：赢家 = 刚生成的 live 目录，
  输家 = 抢先窗口的新代冻结值——两窗口 generation 记录同为 P，与后端一致。

### 2.3 并发竞态两例（本轮新推演，均良性，不构成翻案）

1. **普通首冻与 loadSession 交错**：A 在 loadSession 完成前进入首冻
   （persisted 缺项，内存 miss → live 生成并冻结内存），其 RPC 若命中 DB 中
   已有的 snapshot@G + pending P，后端按换代兑现（A 的 live 字节成为新代）；
   A 的 continuation 却记 `{generation: 0}`（入口快照的 persisted 是
   undefined）。**后果**：表中代号偏低，但该字段仅在 loadSession 重算 pending
   时参与比较，而 loadSession 总是连 generation 带 pending 一起从 metadata
   重读——自愈，字节面全程一致。这正是 r5 文档「意外消费路径成为设计内路径」
   的表内投影，r5 未写明表值暂偏低这一细节，本文补记。
2. **兑现与普通 continuation 的表写序竞争**（1 的尾部）：两个 caller 各自
   `set` 相同或不同代号，最终值取后完成者。同样只影响表内代号、不影响任何
   已发字节，且下次 loadSession 校正。

### 2.4 跨代收敛仍需 reload（限定维持，未劣化）

pending 的唯一检测点仍是 loadSession（:3811）；`chat_v2_compact_session` /
自动 compaction 后本窗口不重读 metadata（TauriAdapter 内无 compact 后
loadSession 调用，本轮 grep 复核）。会话中途换代声明要等下次进入会话才兑现
——与 r5 遗留 2 一致，晚兑现只是晚享收益，无错误覆盖。

## 3. R4-#7 delta：代码确认；接线缺口升级为「需先定传输面」

### 3.1 代码面复核（progressiveDisclosure.ts :719-834）

- **只读纪律**：`computeAvailableSkillsDelta`（:783）直接
  `sessionAvailableSkillsSnapshots.get`，未调会产生冻结副作用的
  `getSessionAvailableSkillsPrompt`、未调 hydrate/freeze——属实；
- **解析/生成对称**：`extractCatalogSkillIds`（:758）正则
  `/<skill\s+([^>]*?)\/?>/g` + `\bavailable="false"` 排除 + `\bid="([^"]*)"`
  提取。本席独立重推注入面：id/reason 经 `escapeXmlAttr` 转义 `" < >`，
  描述行经 `escapeXmlText` 转义 `<`，故属性值内不可能出现裸 `id="` /
  `available="false"` 字面量、描述行不可能出现 `<skill`、`>` 不会提前终结
  `[^>]*`——无误判面，与 r4-review 结论一致；
- **unescapeXmlAttr 互逆**（:741）：`&amp;` 最后替换；`&lt;` 原文的转义态
  `&amp;lt;` 不含子串 `&lt;`（唯一 `&` 后跟 `a`），回环正确；
- **口径一致**：added 过滤链（:790-795）`isSkillPromptVisible →
  !disableAutoInvoke → isSkillRequiresSatisfied` 与
  `generateAvailableSkillsPrompt` 可用段（:573-583）逐条同序；
- **与兑现衔接**：换代兑现后 `hydrateSessionAvailableSkillsSnapshot` 换新
  内存字节 → 基线解析自动换新 → delta 收缩为空，两通道零接口衔接成立。

**未发现明确 bug，按任务卡不改此文件。**

### 3.2 新发现：接线不只是「TauriAdapter 加一行」，先要定传输面

r4-catalog-delta §6 的接线示意（TS 侧调 `generateAvailableSkillsDeltaPrompt`
拼到「当前 user 消息尾部瞬态段，与已加载技能瞬态消息同位」）隐含一个未写明
的前置：**瞬态技能消息的渲染与注入在 Rust pipeline 侧**（tool_loop.rs /
history.rs 的锚定重建链，grep「瞬态技能」命中 helpers/history/tool_loop/
persistence/constants 五文件），前端 `SKILL_INSTRUCTION_TYPE_ID` refs 只是
UI/历史兼容缓存（TauriAdapter:5162 注释自证），发送时反而被过滤
（:2801/:3062/:4067）。而 delta 生成器与其输入（live registry、冻结快照
内存 Map）都只在前端进程。

因此接线必须先二选一：

1. **前端渲染、SendOptions 新增字段透传**（如 `availableSkillsDeltaPrompt`），
   Rust 侧在拼接瞬态技能消息处追加——字符串纯透传，不落历史，改动面
   TauriAdapter + send 命令参数 + tool_loop 注入点；顺序按 §6 建议
   （瞬态技能指令在前、delta 在后）；
2. 后端自行计算 delta——**不可行**，与 r4-catalog-compaction「后端拿不到
   live registry」同一论证，直接排除。

即实际可走的只有 1，但它触及 send 命令签名与 Rust 注入点，超出任何单席
「仅 TauriAdapter」或「仅 progressiveDisclosure」的独占面。**建议下一个
接线轮把此项排为跨 TS/Rust 的成对席位**，避免再次因独占面卡住（R4→R5→R6
三轮顺延的根因即此）。

## 4. R4-#6 换代键（repo.rs / compaction.rs）：确认

### 4.1 原语语义（:2865-2911 / :2937-2972）

- freeze：`effective_pending` 严格大于门闩（:2876-2878）；已冻结且无有效
  pending → 返回持久化权威（:2879-2883，代内 first-write-wins 原样）；有效
  pending → 覆盖快照、`generation := pending`、删 pending 键（:2899-2904，
  唯一合法覆盖路径）；普通首冻不写代号键（缺键即 0，旧会话字节形态不变）；
  故意不推 `updated_at`（:2908）。
- mark：从未冻结 no-op 返回 None（:2943-2945）；已有有效 pending 幂等返回
  （:2948-2953，多次 compaction 折叠）；否则 `generation.saturating_add(1)`
  只写 pending 一键（:2954-2967）。
- 调用点唯一：`compaction.rs:1114`，在 `persist_prepared_compaction` 事务内
  `set_session_last_compaction_with_conn` 之后、`tx.commit()` 之前，`?` 失败
  整体回滚——与 r4-catalog-compaction 状态机逐条吻合。
- 测试四件套在位（只写不跑）：`..._freeze_is_first_write_wins`（:4931，
  一字未动）+ 三新测试 :5035（显式换代 + 幂等折叠 + 其他键保留 + 新代内
  拒绝竞争 + 二次 compaction pending=2）/ :5145（never-frozen no-op + 首冻
  不写代号键）/ :5203（空串换代后允许出目录）。
- 命令面：`chat_v2_freeze_available_skills_snapshot`（manage_session.rs:387）
  session_id 前缀校验 + 注册在 lib.rs:2083，前端 invoke 参数
  `{ sessionId, snapshot }` 与 Tauri camelCase 映射一致。

### 4.2 与前端契约的字节面核对

键名字面量、缺键=0、严格大于门闩三项已在 §2.1 对拍；后端换代兑现「覆盖 +
推代 + 清标记」与前端「成功后 set {generation: pending}」互为镜像；输家
退化为新代内 first-write-wins 拒绝时，前端拿 effective 回灌——两侧状态机
无缝。

### 4.3 分支复制继承（本轮新析，此前三份文档均未覆盖）

`branch_session_in_db`（manage_session.rs:1424-1427）**整体 clone 源会话
metadata**，故目录三键随分支自然继承。推演结论：**继承是正确行为**——

- 继承快照/代号：分支会话 system 字节与源一致，provider 按内容前缀命中的
  cache 可跨分支复用（与 :1421-1423 注释对 frozenToolSchemaOrder 的论证
  同构）；
- 继承 pending：源会话既已声明换代（其冻结目录已过期），分支背着同一份
  过期目录，首发时各自兑现、各自按 live 生成——若两者 live registry 相同
  （同进程必然），兑现出同一字节，缓存继续共享；若分支不继承 pending 反而
  会造成源已换代、分支永背旧目录的分叉。无需改动。

## 5. 遗留项状态（目录链条相关，供 #10 台账）

| 项 | 状态 |
|---|---|
| #7 delta 发送路径接线（R4-9/R5-8） | **仍开**，且本轮升级认识：需跨 TS/Rust 传输面（§3.2），建议接线轮成对席位 |
| r4-catalog-delta §4 键名/API 形态过时（r4-review 遗留 1） | **仍开**——本轮复核 §4 仍写单键 `availableSkillsCatalogGeneration` + 独立 refresh API，无「已被 #6 取代」指针；本席可写面不含该文档，仅在此再挂一笔 |
| `clearSessionAvailableSkillsSnapshot` 不清 persisted 表（R5 遗留 1） | **仍开（潜伏级）**——生产零调用维持（本轮 grep 复核仅测试调用）；引入生产调用时必须同步 delete 表项，否则打穿 §1.3 不变式 |
| 跨代收敛需 reload / 无 compaction 成功事件（R5 遗留 2） | **仍开**——本轮确认 compact 后无 loadSession 调用，pending 检测点未增 |
| 键常量收口到 progressiveDisclosure（R5 遗留 3） | **仍开**——generation 双键字面量仍在 TauriAdapter :208/:217；三处（repo.rs / TauriAdapter / 未来 progressiveDisclosure）字面量漂移风险靠 §2.1 对拍与后续验证轮测试兜底 |

## 6. 已验证（静态）/ 未验证

### 已验证（本席独立取证）

- 8 个 `buildSendOptions` await 调用点与冻结闸链路唯一性（§1.1 grep）；
- persisted 表两写入点与内存 Map 同步不变式、全仓无 delete、旧符号零残留；
- 前后端键名/缺键语义/门闩三项逐字对拍（§2.1）；兑现路径失败序（抛错先于
  表更新）逐行核对；
- delta 解析注入面独立重推（转义矩阵 → 无误判面）、`&amp;lt;` 回环手工验证、
  delta 两导出全仓零消费（接线未做）；
- repo 原语/调用点/四测试/命令注册行号、分支 metadata 整体 clone（§4.3）；
- 瞬态技能消息渲染归属 Rust 侧、前端 skill_instruction refs 发送前被过滤
  （§3.2 的证据基础）。

### 未验证（诚实归因）

- 未跑 tsc / vitest / cargo check / cargo test：TauriAdapter async 链、repo
  四测试、delta 单元语义均仅为源码存在（沿 R4/R5 未验证债务，验证轮统一清）；
- §2.3 两条竞态推演与 §4.3 分支继承推演为纯静态论证，无运行时对拍；
- pending 兑现端到端（compaction → 下次 loadSession → live 重生成 → freeze
  覆盖 → provider 侧新前缀）无任何真实请求证据。

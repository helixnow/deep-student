# Wave2-E 会话主台账（0824 Anki/qbank）

> 本文件为 Wave2-E 会话的**主台账**，只追加风格：后续轮次在文末追加章节，不改写已有段落。
> 来源声明（用户已确认）：`docs/0824-quality-review/*` **不在官方 tip**（审计文档未合入）。
> 本台账的问题清单**源 = 本轮（第 1 轮）静态二检报告（r1-01 ~ r1-09）+ 任务卡痛点，非 quality-review 原件**。

---

## 1. 会话身份与基线

| 项 | 值 |
| --- | --- |
| 会话 | 0824 Wave2-E（Anki 制卡 / APKG / qbank） |
| 工作区 | `/workspace` |
| 分支 | `cursor/0824-wave2-anki-qbank-a875`（tip = `a07fbad8`，仅一个开枝 chore 提交） |
| 基线 | `origin/cursor/0824-cde6` @ `061b4815`（Step 23 收口后 tip，`git merge-base` 实测确认） |
| PR | draft PR #349 |
| 第 1 轮模型 | 全部 `claude-fable-5-thinking-high`（9 个角色：二检×2、锚定×5、调研×1、台账×1） |
| 第 1 轮硬规则 | 未跑任何编译/测试/npm/cargo/CI；未改产品代码；未 commit 产品改动（父代理提交文档） |
| 第 1 轮产出 | `docs/dev/wave2-E-r1-01` ~ `-09` 九份报告 + 本台账 |

---

## 2. Step 22 二检结论表（本域 8 个 pick）

祖先链核验：`git merge-base --is-ancestor <sha> HEAD` 对 8 个 SHA **全部为 YES**（本台账写作时实测复核）。
逐条语义核对来自 r1-01（QA/CardAgent 五 pick）与 r1-02（APKG/金标/qbank 三 SHA）。

| # | SHA | 主题（MERGE-PLAN Step 22 段） | 结论 | 关键证据 |
| --- | --- | --- | --- | --- |
| 1 | `1a5b6f6a` | #328 QA：disabled 模式 `_qa_flags` 持久化修复 | **仍在** | `streaming_anki_service.rs` L2045-2051（merge_flags 之后移除）+ 三态契约测试 L4672-4730（r1-01 §1） |
| 2 | `d9a314cb` | #328 续：测试 rustfmt | **仍在** | tip L4676-4679 多行形态与提交产物逐字一致（r1-01 §2） |
| 3 | `7077075a` | #336 critic QA flag 持久化按 enable_qa_pass 门控 | **仍在** | `anki_critic.rs` L692 sanitize + L945-954 接线 + 三条单测；后续 `d8a606c2` 触碰为纯加法加固（r1-01 §3）。注意：门控语义本身正确但制造了 P0-2 污染路径 A（见 §3） |
| 4 | `307449e2` | #338 四项红线（FSRS opt-in / 协议中立 / lossless-only / maxCards） | **仍在** | 四项逐一核实，`git diff 307449e2 HEAD` 对全部相关文件为空（r1-01 §4） |
| 5 | `4756e93c` | #341 rustfmt 收口 | **仍在** | `git diff 4756e93c HEAD` 对三个文件均为空 diff（r1-01 §5） |
| 6 | `d8a606c2` | #329 APKG 导入与 gold 溯源加固 | **仍在** | 媒体逐字节比对复用、`has_critic_revision_marker` 过滤、classify 第 1 步排除、前端 camelCase 契约、occlusion UI 文案均在位（r1-02 §一） |
| 7 | `08beff7e` | #335 更正 occlusion 导出文案 | **仍在** | 纯文档/注释修改落地完整；确系只改文案不是真闭环（断链证据归 P0-1，r1-02 §一/§三） |
| 8 | `3fcebbb1` | #332 练习进度按视图隔离 | **仍在** | `questionBankStore.ts` `practiceSessions` 按 `[examId, viewInstanceId]` 分片 + fail-closed + 回归测试均在（r1-02 §一、r1-06 §6） |

**丢失 pick：0 个（8/8 仍在，无回退）。**

冲突点核查（Step 22 冲突 1，`streaming_anki_service.rs` 测试区加法保留）：**两侧测试都在、语义完好、互不覆盖**——
HEAD 侧 `parse_and_save_card_honors_qa_pass_flag_persistence_contract`（L4672-4730）与 incoming 侧
`parse_and_save_card_rejects_mid_string_truncation_as_error`（L4734-4766）、`parse_and_save_card_still_repairs_lossless_damage`
（L4768-4792）、wrapper 两测试（L4546-4593）相邻共存；各用独立 task_id/document_id + `release_document_tracker`
清理，无共享状态；辅助函数（`qa_flag_codes`/`seed_task`/`fingerprint_options`）各只有一处定义，静态未见编译级冲突（r1-01 冲突点核查节）。

---

## 3. P0–P4 问题归组

每条格式：现状 + 证据行号（tip 现行代码）→ 第 N 轮负责人 → 是否仍开放。

### P0-1 遮挡断链（入库不写 text/images；导出不识 `_occlusion`）——仍开放

- 入库侧断链（r1-03 §3）：`parse_and_save_card` 的 occlusion 分支（`streaming_anki_service.rs:2008-2019`）只 merge
  `extra_fields`（`_occlusion` spec）+ tag；**断点 1**：`OcclusionCardFields.text`（含 `{{cN::label}}` 候选 Cloze）完全未消费；
  **断点 2**：`AnkiCard.images` 硬编码 `Vec::new()`（:2078）。`extract_occlusion_draft_fields`
  （`anki_image_occlusion.rs:708-717`）调 `build_card_fields(&validated, None, None)`，`image_file_name=None`，Text 无 `<img>`。
- 导出侧断链（r1-05 §3）：`apkg_exporter_service.rs` 与 `anki_connect_service.rs` 全文 **0 次**出现
  `_occlusion`/`OCCLUSION_FIELD`；媒体收集（apkg :1112-1168 / ankiconnect :881-1076）只看 `card.images`（恒空），
  `_occlusion.imageRef` 图片不进包；无原生 IO note type。遮挡卡随普通导出流出为退化普通卡 + 泄漏 `_occlusion` 原文（与 P1-1 叠加）。
- 现状文案（#335/d8a606c2）已诚实化，但仅覆盖预览面；导出面无拦截/提示（r1-02 §三）。
- **负责人：第 2 轮**（streaming 入库接线 + apkg/ankiconnect 导出闭环，文件分权见 §6；note type 形态先做第 2 轮契约裁决，见 P4 分歧）。

### P0-2 gold 污染（marker 可滤，但 qa_pass=false 洗白 + 无 actor + 无正向用户证明）——仍开放（部分达成）

- 已达成：带 `llm_critic_revised` 标记的 critic 修订卡已被排除——`anki_critic.rs:787` 收集器 filter +
  `anki_gold_set.rs:397-404` classify 第 1 步双保险，有测试锁定（r1-02 §二问题 1）。
- 仍开放三洞（r1-02 §二问题 2/3、r1-04 §2）：
  1. **洗白路径 A**：`enable_qa_pass=false` 时 `sanitize_plan_for_disabled_qa_pass`（`anki_critic.rs:692-709`，门控点 :949-955）
     剥整个 `_qa_flags`（连 marker 一起），revise 内容照常落盘；下一个同文档任务挖掘时该卡无标记 →
     被当成 EditedMinor/Major 用户修正对回灌 critic prompt。**模型自改伪装用户金标。**
  2. **无 actor**：`chatanki_update_library_card`（`chatanki_executor.rs:3594-3714`）等写入方零来源标记，
     与用户编辑数据上不可区分；「用户编辑」纯靠「内容 ≠ `_original_generation` 快照」推断（r1-04 §1 关键观察）。
  3. **导入注入面**：`apkg_importer_service.rs:2087-2104` 对 `_` 前缀协议字段零剥离，外部包可自带伪造
     `_original_generation` 被挖成修正对（间接 prompt 注入）。
- 修复方案已备：r1-04 §5 `_content_provenance` 最小加法方案（字段、两道闸、旧卡保守策略、9 条测试反例清单）+
  r1-02 §四清单（导入剥离、导出对称剥离、`critic_revised` 真值化）。
- **负责人：第 2 轮**（gold 溯源单人负责，见 §6）。

### P1-1 `_` 字段泄漏（`_occlusion`/`_qa_flags`/`_original_generation` 进导出产物）——仍开放

- APKG 两条路径均泄漏：过滤名单 `RESERVED_IMPORT_METADATA_FIELDS` 仅 13 个 `Anki*` 键
  （`apkg_exporter_service.rs:39-62`），extra_keys 追加点 :1309-1317 / :1612-1617 不滤 `_` 前缀；
  `resolve_card_field_value` :455-459 对 JSON 值特意跳过清洗，三字段 JSON 原样进 note（r1-05 §1/§2 泄漏矩阵）。
- AnkiConnect 标准模型不泄漏，但 `normalize_key`（:145-149）使 `_occlusion`→`occlusion`，与 Anki 23.10+ 原生 IO
  note type 的 `Occlusion` 字段碰撞时灌入错误语法（r1-05 §2.2）。
- 修法已备：`is_internal_protocol_field` 统一谓词 + 导出入口规范化层三道闸（r1-05 §5.3）。
- **负责人：第 2 轮**（apkg 与 ankiconnect 分权两人，见 §6）。

### P1-2 CriticSummary 事件缺 5 字段 + 前端全空——仍开放

- 后端：`emit_critic_summary`（`streaming_anki_service.rs:3034-3058`）手工 json! 重建载荷，漏
  `gold_references / gold_references_truncated / routed_config_id / routed_model / routed_degraded` 5 字段
  （struct 自带 Serialize，`anki_critic.rs:276-304`；5 字段只进日志 :986-1000）（r1-03 §5）。
- 前端：`AnkiCardsBlockData` 无字段、`TauriAdapter.handleAnkiGenerationEvent`（:1441-1858）无分支静默落空、
  全仓 `criticSummary` 在 `src/` 零命中；locale `agent.critic.title/summary/skippedOverBudget/goldReferences/degraded`
  全孤儿（r1-09 §3/§4）。
- **负责人：后端补 emit 字段 = 第 2 轮（streaming）；前端接入（Adapter 分支 + 块字段 + 摘要条 UI）= 第 3 轮**（r1-09 §7 插入点 1-3）。

### P1-3 GenerationStats 纯内存 / 任务台混合态 / Promise.all 绑死——仍开放

- GenerationStats：纯内存 + 一次性事件，不落库、失败/取消路径不发、delimiter 重试只留第二次、前端无消费者
  （`streaming_anki_service.rs:668/:3009-3030`，TaskCompleted 只带 card_count :3086）（r1-03 §6）。
  → **第 2 轮**（streaming 负责人，`complete_task_successfully` 增参或落任务行 + 失败路径补发）。
- 任务台混合态：`classify`（`src/features/anki-tasks/types.ts:40-44`）`failedTasks>0` 无条件短路，
  failed+running 混合态丢失运行事实——轮询降频 5s→30s（AnkiTasksApp.tsx:225）、防休眠误解除（:325-335）、
  暂停/取消行内入口全藏（SessionRow :313/:327）、环形图口径错（:365-372）（r1-09 §1）。
  → **第 3 轮**（r1-09 §7 插入点 5：运行判定与关注判定解耦）。
- Promise.all 绑死：`AnkiTasksApp.load()`（:215-241）list 与 stats 一损俱损，stats-only failure 丢弃已成功的列表数据
  （r1-09 §2）。→ **第 3 轮**（插入点 6：`Promise.allSettled` 或局部 `.catch`，先例 SessionRow.tsx:71）。

### P1-4 verdict 原语（qbank 判分三路分叉）——仍开放

- 可抽原语已有雏形：`regrade_submission_in_tx`（`question_bank_service.rs:712`）已收敛差值计数/状态 CASE/同步标记/
  mastery/刷新统计，A 路去重分支与 C 路共用；**唯一未接入 B 路（AI 管线）**（r1-06 §1）。
- pipeline 计数分叉：`qbank_grading/pipeline.rs:242-267` 只做 NULL→true +1，**false→true 不加、true→false 不减**，
  且以题目级旧值做增量基准（提交竞态方向可能错）；AI 路**完全不写 mastery 事件**（r1-06 §2）。
- mastery tombstone：换判时 `me_qbank_{submission_id}` 幂等键 DO NOTHING，事件流停在首判 outcome；
  现成范式 `revert_fsrs_rating_for_log`（mastery/service.rs:227-264）软删+重算可照抄（r1-06 §3）。
- RowSync 不推进：三处写点（insert :2474-2488 / 人工改判 :755-760 / AI :228-231）均不写
  `updated_at/local_version`，跨设备 LWW 时改判结果可能被对端旧行覆盖（r1-06 §4）。
- 建议签名 `apply_submission_verdict_in_tx` 已给出（r1-06 §2）。
- **负责人：第 4 轮**（qbank 后端修复，与 P1-5 前端联动同轮）。

### P1-5 daily 口径分叉 + handleMarkCorrect 缺 recordPracticeAnswer——仍开放

- 口径分叉 7 维对比表见 r1-07 §一：前端首答锁定 vs 后端全天 `MAX(correct)`、改判不回补、白名单门禁、无日界线等；
  收敛点 = 下次 `getDailyPractice` 全量覆盖（r1-07 §二「再练一组」会回补）。
- `handleMarkCorrect`（`ExamContentView.tsx:1002-1005`）→ hook `markCorrect` 直调裸 `submitAnswer`，
  绕开 L970 的 `recordPracticeAnswer` 与 mock_exam results 回写；**注意**：单补一行是无效修复——
  `recordPracticeAnswer` 首答锁（store L1947/L1928）会吞掉改判，需先给 action 加「改判修正」语义（r1-07 §三）。
- 后端配套缺口：`DailyPracticeResult` 缺 `answered_question_ids`（`query_daily_progress` L2702-2713 已算出未返回）；
  `SubmitAnswerResult` 无 daily 字段，前端无法原子回写权威值（r1-06 §5、r1-07 §六）。
- **负责人：第 4 轮**（r1-07 §七插入点 1/3/5；后端回带权威 daily 需与 P1-4 同人或同轮协调）。

### P2-1 daily_target 建议先改名「按当前目标查看」——仍开放

- 现状：`qbank:dailyTarget:{examId}` localStorage 单值无日期维度，整月按**当前**目标重算达标格，
  目标上调即历史绿格变黄（r1-07 §五）。
- 裁决：**B 案先行**（i18n 2-3 文件 + `DailyPracticeMode.tsx` L448 一处，零后端零迁移）；
  A 案（按 exam_id+date 持久化 target）挂后端 daily 持久化统一包，不单独抢跑（r1-07 §五两案对比）。
- **负责人：第 4 轮**（r1-07 §七插入点 4）。

### P2-2 i18n/a11y 孤儿词条——仍开放

- 孤儿清单（r1-09 §4）：`agent.critic.title/summary/skippedOverBudget/goldReferences/degraded`、
  `agent.occlusion.*` 全家、`chatV2.json` occlusion 四键（两套语义重复都没人用）；
  「带警告完成」词条不存在（第 3 轮做状态呈现需新增非复用）。
- a11y：occlusion 预览 `<img alt="">`（ankiCardsBlock.tsx:540，`agent.occlusion.imageAlt` 备而未用）、
  `ImageOcclusionOverlay.tsx:123` 硬编码中文 aria-label（`agent.occlusion.revealBox` 备而未用）（r1-09 §3.3）。
- **负责人：第 3 轮**（r1-09 §7 插入点 3/4；critic 词条随 P1-2 前端接入一并消费；
  `goldReferences` 依赖第 2 轮后端补 emit）。

### P2-3 nullable 深挖——本轮未深挖，标「第 5 轮」

第 1 轮九份报告均未覆盖 nullable 专项（qbank/anki 字段可空性契约梳理）。**标记：第 5 轮。** 仍开放。

### P3 options 双解析——本轮未深挖，标「第 5 轮」

第 1 轮仅在 r1-01 §3 顺带记录 critic 侧「从同一份 options JSON 二次解析 `StructuredOutputOptions`」现象
（`anki_critic.rs:945-954`），未做全链双解析面梳理。**标记：第 5 轮。** 仍开放。

### P4 SOTA 对标 Top5 + 遮挡形态裁决——仍开放（调研已完成）

r1-08 差距清单 17 项，Top5（按优先级与可落地性）：

| # | 能力 | 优先级 | 归轮 |
| --- | --- | --- | --- |
| 1 | Image Occlusion 完整闭环（=P0-1 的产品面） | P0 | 第 2 轮（真闭环） |
| 2 | FSRS 记忆态可视化（Stability/Difficulty/Retrievability 三分布 + True Retention + 参数只读展示，S1） | P0 | 第 5 轮（可静态做） |
| 3 | 复习按键流补齐（双键简化模式、I 键单卡信息、逐卡用时前端显示、撤销可发现性，S2） | P0 | 第 5 轮（可静态做） |
| 4 | 模板能力矩阵 + cloze hint 渐进（S3） | P1 | 第 5 轮 |
| 5 | qbank 工具 bounded output 契约回补（三种截断形态描述精确化，S5；含 RemNote 式隔离队列语义 S4 候补） | P1 | 第 5 轮 |

**遮挡形态分歧（第 2 轮契约裁决，必须先裁后写码）**：

- **SOTA 组（r1-08 §5）主张对标 Anki 官方 IO-as-Cloze**：直接生成原生 IO note type
  （Cloze kind + Occlusion 字段 `{{cN::image-occlusion:rect:left=…}}` 序列化），理由是「真闭环 = 桌面 Anki
  可复习遮挡卡」，且我们 0–1 坐标系与 Anki 同构、`clozeIndex` 直映 cloze 序号，转换器可先行；
  明言「普通 Cloze 文本 overlay 不成立（无法携带几何信息、渲染不出遮罩）」。
- **导出组（r1-05 §5.2）主张「先 Cloze」**：第 2 轮先用既有 Cloze 基建（`<img>` + `{{c1::label}}` Text，
  「看图回忆标签」语义，遮罩视觉留给前端），原生 IO 因 notetype JSON 构造 + 旧版 Anki/AnkiDroid 兼容性
  推为第 3 轮增强。
- 两案对「闭环」定义不同（可复习标签卡 vs 可复习遮挡卡）。**裁决归第 2 轮开工前的契约会签**（apkg 负责人 +
  streaming 负责人共同裁决，台账记录裁决结果后方可动 `build_card_fields`/导出转换器）。

### 开放度小结

| 组 | 条目 | 仍开放 |
| --- | --- | --- |
| P0 | P0-1、P0-2 | **2/2 开放**（P0-2 为部分达成仍开放） |
| P1 | P1-1 ~ P1-5 | **5/5 开放** |
| P2 | P2-1 ~ P2-3 | 3/3 开放 |
| P3 | options 双解析 | 1/1 开放（第 5 轮深挖） |
| P4 | SOTA Top5 + 形态裁决 | 调研完成；落地全部开放 |

---

## 4. 红线自证（第 1 轮）

均为静态 grep/逐行证据，引自 r1-01 与 r1-09：

1. **闪卡只读预览无写回**（r1-09 §5）：`save_to_library` 在 flashcard-preview 域零命中（仅 locale 按钮文案与
   anki_cards 管线调试场景名）；`FlashcardPreviewBlock.tsx` 零 action/零 invoke/零回写；
   `buildFlashcardPreviewIntent.ts` 头注释明示持久化归 anki_cards 管线；`generative-ui.ts` 第 8 条硬约束在位；
   `ChatV2AnkiAdapter` 文件不存在（Glob 零命中），6 处文本命中全为退役注释与守护测试
   （`cardGenerationSurfaces.source.test.ts` / `pdfSelectionToolbar.source.test.ts` 断言 not.toMatch import）。
2. **startGeneration 两入口完好**（r1-09 §6）：划词制卡 `selectionCardGeneration.ts:121` +
   共享文本入口 `generateCardsFromText.ts:50`，均直启 `start_enhanced_document_processing`，
   各有单测 + 源码级守护测试钉死。
3. **Step 22 语义未回退**（r1-01 红线复核表）：enableQaPass 门控、FSRS opt-in（仅 `Some(true)`/`=== true`）、
   协议中立（cardforge 无 END 标记，夹具双侧钉死；遗留 END 仅模板编辑器预览链路非 CardAgent）、
   maxCards 全局配额、lossless-only（截断→Err/错误卡无静默路径）五条全部未回退；
   `git diff <pick> HEAD` 对相关文件为空 diff；pick 后唯一触碰提交 `d8a606c2` 为加固方向。
4. **禁改区**：九份报告一致声明未触碰 coordinator.rs、tool_loop/hooks、缓存链、移动 chrome、workbench 壳；
   第 1 轮零产品代码改动。

---

## 5. 已验证 / 未验证

### 已验证（仅静态，未运行任何代码）

- 8 个 Step 22 pick 的祖先链（`git merge-base --is-ancestor` 8/8 YES）与 tip 落地语义逐行核对（r1-01/r1-02）。
- `git diff <pick> HEAD` 空 diff 证明（307449e2/4756e93c 相关文件）。
- 冲突点测试区两侧共存、无共享状态、辅助函数无重复定义（静态检视）。
- 泄漏矩阵、遮挡断链、gold 污染路径 A/B、qbank 三路判分分叉、daily 口径分叉、混合态连锁后果、
  CriticSummary/GenerationStats 前端零消费——全部为行号级代码证据。
- SOTA 调研来源均带 URL（r1-08 §6）。

### 未验证（本轮禁令未跑）

- **任何编译**：typecheck / vite build / cargo check 未在本枝 tip 跑过（基线 `061b4815` 的四门禁是 Step 23 在
  `f83e541b` 上的历史记录，不代表本枝）。
- **任何测试**：cargo test / vitest 全未跑——尤其冲突点所在 `streaming_anki_service` 测试模块、
  `anki_critic`/`document_processing_service` 新测试是否编译通过，仅有静态检视结论（r1-01 行动建议 4）。
- 运行时行为（事件派发、导出产物字节级内容、AnkiConnect 实机交互、qbank 判分竞态）均未动态复现。
- 第 2 轮起动手前应先在本枝跑四门禁作为基线快照。

---

## 6. 第 2 轮任务卡摘要

原则：**真闭环默认**（文案诚实化不再作为交付标准，改产品语义为准）；**文件分权、同文件单人**（避免冲突）。

| 角色 | 独占文件面 | 任务要点 |
| --- | --- | --- |
| streaming 负责人 | `src-tauri/src/streaming_anki_service.rs`（+`anki_image_occlusion.rs` 接线点） | ① P0-1 入库接线：occlusion 分支消费 `fields.text`、`imageRef` → `AnkiCard.images`（r1-03 §9-1，测试 :5095-5133 扩展断言非删除）；② P1-2 后端：`emit_critic_summary` 改 struct 序列化补 5 字段（r1-03 §9-2）；③ P1-3 GenerationStats 持久化/失败路径补发（r1-03 §9-3）；④ token 常量表单源化（r1-03 §9-4，可选） |
| apkg 负责人 | `src-tauri/src/apkg_exporter_service.rs`（+`apkg_importer_service.rs` 导入剥离） | ① P1-1：`is_internal_protocol_field` 统一谓词 + 导出入口规范化三道闸（r1-05 §5.3）；② P0-1 导出闭环：遮挡卡专用转换器 + `collect_media_entries` 媒体解析（r1-05 §5.1 表 #1-5、§5.4）；③ P0-2 配套：导入侧剥离 `_` 前缀协议字段 + 「导入包携带 `_original_generation` 不得被挖成金标」单测（r1-02 §四-3） |
| ankiconnect 负责人 | `src-tauri/src/anki_connect_service.rs` | ① P1-1：`build_fields_with_model_names`/`normalize_key` 剔除 `_` 前缀键，杜绝 `Occlusion` 碰撞（r1-05 §5.1 表 #6）；② P0-1：`add_notes_to_anki_detailed` 遮挡卡专用转换 + picture 附件（表 #7，依赖形态裁决） |
| gold 溯源负责人 | `src-tauri/src/anki_critic.rs`、`src-tauri/src/anki_gold_set.rs`（+`chatanki_executor.rs`/`cmd/enhanced_anki.rs` 写入点打点） | P0-2 全案：`_content_provenance` 字段 + 写入点三处 + 收集器/classify 两道闸 + 旧卡保守策略 + 9 条测试反例（r1-04 §5 全文照办）；`critic_revised` 真值化（r1-02 §四-5） |

跨人契约（开工前会签，台账追加记录）：

1. **遮挡 note type 形态裁决**（P4 分歧）：IO-as-Cloze（SOTA 组）vs 先 Cloze 后 IO（导出组）——裁决结果决定
   streaming 接线的 Text 形态与 apkg/ankiconnect 转换器目标，三人必须同一结论后动工。
2. `sanitize_plan_for_disabled_qa_pass` 只剥 `QA_FLAGS_FIELD` 不剥 `_content_provenance`
   （7077075a 语义切分回归测试，gold 负责人写，streaming 负责人复核）。
3. 回归红线不得松动：lossless-only 拒收、qa_pass 门控三态、brace-depth 切卡器全套（r1-03 §9 第 3 轮回归清单）。
4. 第 2 轮解禁编译/测试后，先跑四门禁基线快照，再动代码。

未排进第 2 轮（归属已定，此处备忘）：混合态/Promise.all/CriticSummary 前端/occlusion a11y = 第 3 轮；
qbank verdict 原语 + daily 口径 + P2-1 B 案 = 第 4 轮；nullable/P3 options 双解析/SOTA 静态子集 S1-S5 = 第 5 轮。

---

*（以上为第 1 轮内容。后续轮次只追加，不改写。）*

---

## 7. 第 2 轮（P0 落地，2026-08-26）

模型：全部 `claude-fable-5-thinking-high`。未跑编译/测试。draft PR #349。

### 已落地

| 项 | 状态 | 证据 |
| --- | --- | --- |
| P0-1 入库消费 text + images | 已落 | `parse_and_save_card` 空 text 填 fields.text；images 从 imageRef 填 |
| P0-1 APKG `_` 过滤 + Cloze 转换 + imageRef 补媒体 | 已落 | `is_internal_protocol_field` + `normalize_cards_for_export` |
| P0-1 AnkiConnect 过滤 + 遮挡 note | 已落 | `build_fields_with_model_names` 跳过 `_` 键 |
| P0-1 IO 坐标 | 已翻案修正 | `format_anki_io_cloze` 改为 Anki 官方 0–1（`left=.1`），禁止百分数 |
| P0-1 导入伪造 gold | 已落 | importer 剥离 `_original_generation`/`_content_provenance`/`_qa_flags` |
| P0-2 `_content_provenance` + classify 三分支 | 已落 | 无 user 证明 → Unlabeled；llm_critic 不进 Edited* |
| P0-2 sanitize 不剥 provenance | 已落 | 仍只剥 `_qa_flags`（7077075a 不回退） |
| P0-2 chatanki_update_library_card 打 user 戳 | 已落 | 仅该函数体 |
| 旧卡兼容 | 无阻断 | r2-09：KeptUnedited 未误杀 |
| lossless-only | 未放宽 | r2-08 |

### 第 2 轮仍开放（非阻断，记入后轮）

1. APKG 未建 IO 五字段 notetype；曾把 IO 语法写入 Extra（第 3 轮 apkg 负责人去掉 Extra 倾倒，IO 函数保留给后续 notetype）。
2. 入库提前拼 `<img src=basename>`（契约想延后到导出）；可复习主路径仍成立。
3. VFS `source_id` 形态 imageRef 导出时未走资源服务解析（测试多用真实路径）。第 6 轮或有资源服务的后续轮处理；本会话不碰 coordinator.rs。
4. UI 编辑路径尚未打 user 戳（仅 chatanki 工具面）。

### 已验证（静态）

- 真闭环契约文档 + 入库/导出/gold diff 行号级审阅
- IO 坐标与 Anki to-cloze.ts 对齐（0–1）
- 兼容审：无 `_occlusion` 旧卡恒等；无 provenance 旧卡不崩

### 未验证

- 任何 cargo test / typecheck / 真实 Anki 导入
- `occlusion_export_roundtrip` / `gold_provenance_excludes_critic` 只写不跑

---

*Goal 未完成。不因第 2 轮落地而变更。*

---

## 8. 第 3 轮（可观测与任务台，2026-08-26）

模型：全部 `claude-fable-5-thinking-high`。未跑编译/测试。

### 已落地

| 项 | 状态 |
| --- | --- |
| P1-1 Extra 不再倾倒 IO 语法 | 已落；`_` 三道闸仍在 |
| P1-2 CriticSummary 后端全字段 serde | 已落 gold_references / routed_* |
| P1-2 前端 Adapter + Banner + locale | 已落；QA badge 语义未破坏 |
| P1-3 TaskCompleted 带计数 + completed_with_warnings | 已落（status 仍 Completed） |
| P1-3 classify 混合态优先 active | 已落 |
| P1-3 list/stats 拆开 allSettled | 已落 |
| 事件链兼容 | 无阻断（r3-08） |
| 只读预览 | 仍完好（r3-09） |

### 仍开放

- `agent.occlusion.*` 仍孤儿（第 5 轮 a11y）
- VFS imageRef 解析、IO notetype、UI 编辑 user 戳
- 任务台 locale 部分用 defaultValue 兜底

### 已验证 / 未验证

- 已验证：静态 diff + 事件标签旧前端可忽略
- 未验证：未跑 vitest/cargo；真实事件时序未测

---

*Goal 未完成。*

---

## 9. 第 4 轮（qbank 判分统一，2026-08-26）

模型：全部 `claude-fable-5-thinking-high`。未跑编译/测试。

### 已落地

| 项 | 状态 |
| --- | --- |
| P1-4 `apply_submission_verdict_in_tx` | 已抽；pipeline AI 路改走原语 |
| 计数三向 + RowSync local_version | 已落 |
| daily_progress 挂 SubmitAnswerResult | 已落 |
| mastery 换判 tombstone+_rN | 已接线到原语 |
| recordPracticeAnswer 差量修正 | 已落 |
| handleMarkCorrect 回写 + mock_exam results | 已落 |
| P2-1 B 案「按当前目标查看」 | 已落 |

### 备注

- r4-09 事务审阅写于落地前提交 tip，所列 B1–B4 已被本轮代码覆盖；以 diff 为准。
- INSERT 侧 RowSync / device_id 未动（非本轮独占）。

### 已验证 / 未验证

- 已验证：静态签名与调用点
- 未验证：`qbank_verdict_three_paths` 等只写不跑

---

*Goal 未完成。*

---

## 10. 第 5 轮（i18n / 读侧 / 契约 / SOTA 子集，2026-08-26）

模型：全部 `claude-fable-5-thinking-high`。首次派出时 4 个代理环境不可达且工作区回滚到 r4 tip；本轮已全量重跑落地。未按规则跑产品测试套件。

**过程违规（记入，不补救空转）**：nullable 代理为自证执行了 `cargo check` 并装环境依赖。本会话第 1–7 轮禁止编译；不据此宣称门禁已绿，也不重跑。

### 已落地

| 项 | 状态 |
| --- | --- |
| P2-2 QA i18n | `qaFlags.lint.<code>` + badge 按 code 解析，message 诊断保留 |
| P2-2 遮挡 a11y | overlay aria + img alt 接 `agent.occlusion.*` |
| P2-3 nullable 读侧 | anki_cards 读路径 Option 防御，无新 migration |
| P3 options 单点化 | `from_options_json` 解析 AnkiGenerationOptions 再投影；qa_pass 默认 true |
| P4 工具契约 | history old/new_value 形状 + fieldsTruncated 嵌套路径说明 |
| P4 复习 UX | UndoNudge + 用时 60s 显示封顶；键盘流已存在 |
| P4 FSRS 可视化 | FsrsParamsPanel 只读到期队列聚合；opt-in 未动 |
| P4 隔离队列 | Library 未入队/已入队分区；enqueue 复用现路径 |

### 95% 对账（P0–P4）

| ID | 状态 | 第 6 轮首位欠账 |
| --- | --- | --- |
| P0-1 遮挡闭环 | 部分 | VFS imageRef 未走资源服务；IO 五字段 notetype 未建 |
| P0-2 gold | 部分 | UI 编辑路径尚未打 user 戳 |
| P1-1 `_` 过滤 | 已落 | Extra 已不倾倒 IO |
| P1-2 CriticSummary | 已落 | — |
| P1-3 任务台 | 已落 | locale 部分 defaultValue |
| P1-4 verdict | 已落 | INSERT 侧 RowSync 未动 |
| P1-5 daily | 已落 | — |
| P2-1 target | 已落 B 案 | — |
| P2-2 i18n/a11y | 已落 | TemplateCardFace alt 仍空 |
| P2-3 nullable | 已落读侧 | — |
| P3 options | 已落薄委托 | critic 注释仍提二次解析 |
| P4 SOTA | 第一批已落 | 双键模式 / I 键 / 用时落库未做 |

### 第 6 轮首位

1. VFS imageRef 导出解析（不碰 coordinator）
2. UI 编辑路径 user provenance 戳
3. occlusion 导出文案「草稿预览」是否过时（#335 文案 vs 真闭环）

### 已验证 / 未验证

- 已验证：静态 diff
- 未验证：未跑 vitest/cargo 套件（nullable 代理私自 cargo check 不作本会话门禁证据）

---

*Goal 未完成。*

---

## 11. 第 6 轮二检 · SOTA 三项复核（r6-10，2026-08-26）

模型：`claude-fable-5-thinking-high`。只读复核，零补丁；未跑测试/编译；未改 workbench 壳 / preview。
复核基线 tip：`35ea482a`。详报：`docs/dev/wave2-E-r6-10-sota.md`。

### 结论：SOTA 三项全部仍在，接线完整，零阻断缺陷

| # | 项 | 状态 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 复习 UX（UndoNudge + 用时显示封顶） | **仍在** | UndoNudge 在 `ReviewSessionScreen.tsx:732-737` 挂载，回执 `logId/rating` 契约与 store 撤销弹栈（fsrsReviewStore.ts:1396-1408）逐行核对通过；显示封顶 60s 仅 UI，落库仍走 `MAX_ANSWER_DURATION_MS`（:89/:1158），两口径互不污染 |
| 2 | FSRS 可视化（FsrsParamsPanel） | **仍在** | `StatisticsScreen.tsx:487` 挂载；`fsrs_get_due` 契约本轮新核：参数 `limit` 匹配、`get_due_inner` 钳 500 与面板 `DUE_SAMPLE_LIMIT` 一致、`FsrsDueCard` flatten+camelCase 使 stability/difficulty 落顶层；全文件仅一处只读 invoke，零写零上传 |
| 3 | 隔离队列（Library 分区） | **仍在** | `partitionLibraryQueues` 稳定分区（libraryView.ts:49-56）；LibraryScreen `visibleItems` 顺序与渲染/键盘导航/连选一致（:166-178）；区头整批入队复用 `bulkEnqueue`（:350-353），未新开后端命令 |

### 非阻断观察（留档，不出补丁）

- FsrsParamsPanel `withParams/withoutParams` 用 min/max 组合，半残行（只有一个参数）时两数不闭合；
  后端评分恒成对写 stability/difficulty，实际不可达，属防御性写法。
- UndoNudge / FsrsParamsPanel / Library 分区区头文案走 `t(key, { defaultValue })`（第 5 轮 locale
  非独占的既定约束）；正式词条落 locale 归后续 locale 独占轮。

### 红线复核

显示封顶不影响统计、FSRS opt-in 未动、面板只读 —— 三条第 5 轮红线均未回退；本轮零代码改动。

### 已验证 / 未验证

- 已验证（静态）：三项挂载点、store/后端契约、locale 键真实性（`session.again/hard/good/easy`、
  `session.undo` 双语在位）、a11y 属性、渲染顺序契约。
- 未验证：运行时行为与相关 vitest 套件（本轮禁令未跑）。

---

## 12. 第 6 轮二检补丁汇总（2026-08-26）

模型：全部 `claude-fable-5-thinking-high`。未跑本会话测试套件。

| 面 | 结论 | 当轮补丁 |
| --- | --- | --- |
| 遮挡入库 | 无翻案 | `vlm://` 占位不入 images |
| APKG / AnkiConnect | Extra 无 IO；无泄漏 | 无代码 |
| gold | 三分支完好 | `update_anki_card` 打 user 戳 |
| CriticSummary | 前端接到 gold_references | 注释校正 |
| 任务台 | 混合态不再短路 | SessionRow aria-label |
| verdict | 三路一致 | 测试/注释收紧 |
| daily | 改判不再被首答锁吞 | hook 透传 dailyProgress 并权威回写 |
| i18n/读侧 | 英 UI 不直出中文 lint | 模板 description 读侧 Option |
| SOTA | 三项仍在 | 无代码 |

过程：i18n 代理再次私自 cargo check，不作门禁证据。

---

*Goal 未完成。*

---

## 13. 第 7 轮（测试落盘，只写不跑，2026-08-26）

模型：全部 `claude-fable-5-thinking-high`。本轮**零产品代码改动、零 commit、
零测试执行**（例外违规见下）；产出 = 测试源码 + r7-01 ~ r7-07 报告 +
测试台账 `docs/dev/wave2-E-r7-09-test-ledger.md`（清单/命令/红绿/缺口详见该文件）。

### 测试落盘清单（新建 3 文件 + 扩展 5 文件，新增 42 用例，存量零删改）

| 文件 | 性质 | 新增 | 覆盖 |
| --- | --- | --- | --- |
| `tests/occlusion_export_roundtrip.rs` | 扩展 r2 | 4 | 入库 images 接线、`vlm://` 不入 images、IO 0–1 clamp/舍入、生成→导出全链 |
| `tests/gold_provenance_excludes_critic.rs` | 扩展 r2 | 3 | qa_pass 洗白真管线、update_anki_card user 戳、import/sync actor 产品符号 + 对齐锁 |
| `tests/qa_pass_critic_combo.rs` | 新建 | 11 | 三 QA 留痕来源 × enable_qa_pass 两态（wire 真开关 + fail-open） |
| `tests/qbank_verdict_three_paths.rs` | 扩展 r4 | 6 | grading_method 状态机、B→C 交接终态种子、幂等零写入、钳 0、守卫 |
| `tests/mastery_qbank_correction.rs` | 新建 | 3 | pub 补偿入口破首判锁 / 幂等 / 与产品链互操作 |
| `tests/anki_nullable_card_reads.rs` | 新建 | 5 | 手建历史 schema × 六条读 API NULL 兜底 |
| `classify.mixed.test.ts` | 扩展 r3 | 6 | 8 组合真值表、hasWarnings 正交、全划分 |
| `recordPracticeAnswer.regrade.test.ts` | 扩展 r4 | 4 | 差量×权威覆盖交织时序、apply 字段边界、daily/timed 隔离 |

### 第 8 轮执行（命令 5 条，详见 r7-09 §3）

cargo test 两组（anki 三件套 / qbank+mastery+nullable 三件套）+ vitest 两组
（anki-tasks+store / chat 块+overlay 存量回归）+ `npm run typecheck`。

### 预期红绿（静态推断，r7-09 §4）

8 文件全绿预期；引用的产品 pub 符号已逐一核对在位。首跑最大风险是编译红
（六个 Rust 文件中五个从未编译，`anki_nullable_card_reads` 手建 schema
对列风险最高）；断言红多为契约演进信号（对齐锁、f32 舍入字面值、lint
阈值、EMA 常数、真值表 vs 注释优先级）。

### 缺口与欠账（r7-09 §5）

B 路 AI 判分仍不可直接集成测（Window + harness=false 需改 Cargo.toml，
manual/auto 转移表已文档化）；in-crate 欠账三项（map_due_row 双保险、
load_review_cards_for_states 私有语义、is_error_card）；vlm 占位 text 残留
未锁（防误红）；前端 r3/r5 存量零扩展仅回归；r7-08 截至台账落盘无产物。

### 过程违规（记录在案，不作门禁证据）

mastery 代理跑了 `cargo check --test mastery_qbank_correction`（与第 5/6 轮
cargo check 违规同类处理）；其余代理经 `git status` 佐证只落盘未执行。

---

*Goal 未完成。*

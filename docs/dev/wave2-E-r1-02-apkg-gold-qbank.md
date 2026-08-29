# Wave2-E 第 1 轮 二检报告：APKG / 金标溯源 / qbank（0824）

- 审阅员：二检员-APKG/金标/qbank（第 1 轮）
- 分支：`cursor/0824-wave2-anki-qbank-a875`（tip = `a07fbad8`，基线 `061b4815`）
- 方式：纯静态审阅（`git show` + tip 落地文件核对），未运行任何编译/测试
- 三 SHA 祖先链检查：`git merge-base --is-ancestor` 确认 d8a606c2 / 08beff7e / 3fcebbb1 均在 tip 祖先链上

---

## 一、三 SHA 实证表

| SHA | 主题 | 在 tip 祖先链 | tip 落地核对（语义仍在） | 结论 |
| --- | --- | --- | --- | --- |
| `d8a606c2` | #329 APKG 导入与 gold 溯源加固 | 是 | ① `apkg_importer_service.rs`：同名媒体逐字节比对复用、`MEDIA_SKIP_REASON_FILENAME_CONFLICT`（tip 现存 6 处引用）、`media_files_have_equal_contents`、`copy_media_entry` 均在位；② `anki_gold_set.rs:42-46` 常量 `ORIGINAL_GENERATION_FIELD`/`CRITIC_REVISED_QA_CODE`，`:315-325` `has_critic_revision_marker`，`:397-404` classify 第 1 步排除 critic_revised；③ `anki_critic.rs:787` 收集器过滤 `has_critic_revision_marker`，`:805` `critic_revised: false`；④ 前端 `anki.commands.ts`/`libraryStore.ts` 的 `importedCards` camelCase 契约修复在位；⑤ occlusion UI 文案（`遮挡草稿预览`/`当前不会导出为可复习的 Anki 图像遮挡卡`）在 tip 的 `zh-CN/anki.json:1104-1106`、`zh-CN/chatV2.json:765-766`、`en-US` 对应位置在位 | 落地完整，无回退 |
| `08beff7e` | #335 更正 occlusion 导出文案 | 是 | 纯文档/注释修改：9 个 `docs/research/anki-ai-native/**` 文档 + `src-tauri/src/lib.rs:12` 模块注释（"cloze 导出约定"→"cloze 候选字段"）。tip 上 `anki_image_occlusion.rs` 模块头文档明确写"生产管线目前没有把候选 Text、图片媒体和 _occlusion 转换为 APKG/AnkiConnect 可复习 note……不得宣称与 Anki 图像遮挡导出兼容" | 落地完整；确系只改文案，不是真闭环（断链证据见第三节） |
| `3fcebbb1` | #332 练习进度按视图隔离 | 是 | `questionBankStore.ts`（tip 28 处命中）：全局单槽 `practiceSession` 已删除，改为 `practiceSessions: Record<key, PracticeSessionProgress>`，键 = `JSON.stringify([examId, viewInstanceId])`（`getPracticeSessionKey`）；`ensurePracticeSession` 带题目白名单，`recordPracticeSessionAnswer` 对归属不符/题目串库 fail-closed 返回 null，新增 `releasePracticeSession`。接线在位：`useQuestionBankSession.ts:189-221` 每 hook 实例生成 `qbank_view_<id>` 并在卸载时释放；`ExamContentView.tsx` 将 `practiceSessionOwner` 传给 `QuestionBankEditor`（`:99/:479/:610/:1143`） | 落地完整，全局槽确已修 |

---

## 二、P0-2 裁决（最高优先）

### 问题 1：d8a606c2 是否已排除 `llm_critic_revised`？——**YES（带标记的卡已排除）**

行号证据（均为 tip 现行代码）：

- `src-tauri/src/anki_gold_set.rs:46`：`pub const CRITIC_REVISED_QA_CODE: &str = "llm_critic_revised";`
- `src-tauri/src/anki_gold_set.rs:315-325`：`has_critic_revision_marker` 解析 `_qa_flags` 数组，仅结构化 `code == "llm_critic_revised"` 触发排除（`message` 里出现同字符串不触发，有测试锁定，`:957-978`）。
- `src-tauri/src/anki_critic.rs:787`：收集器 `gold_references_from_cards` 的过滤链新增 `.filter(|card| !gold::has_critic_revision_marker(&card.extra_fields))`。
- `src-tauri/src/anki_gold_set.rs:397-404`：`classify_candidate` 决策树第 1 步，`critic_revised == true` 直接 `Unlabeled`（"模型自动修订不得进入用户金标"），双保险。
- 测试：`anki_critic.rs:1699-1722`（`gold_references_exclude_critic_revised_cards`）、`anki_gold_set.rs:1072-1084`（`critic_revised_content_is_never_mined_as_user_gold`）。

### 问题 2：内容修改是否记录来源/actor？——**NO**

卡片内容没有通用的"最后修改者"字段。整个溯源体系只有一个负向标记（critic revise 写 `llm_critic_revised` 到 `_qa_flags`，`anki_critic.rs:656-661`）。以下写入方一律不留 actor：

- 用户 UI 编辑（无标记，靠"无标记即用户"反推）；
- **Chat 代理工具 `chatanki_update_library_card`**（`chat_v2/tools/chatanki_executor.rs:3594-3714`）：LLM 可带版本锁修改任意库卡 front/back/text，走 `update_anki_card_if_version_for_library` 落库，全程不写任何来源标记——与用户编辑在数据上不可区分；
- APKG 导入卡（无标记；且见下条注入面）。

### 问题 3：「只有可证明用户编辑才能进 gold mining」——**NO，不成立**

d8a606c2 是真实收紧（带标记的 critic 自改已挡住），但"可证明用户编辑"这一正向命题不成立，现行语义实际是"排除已知的一种非用户修改"。三个可实证的漏洞：

1. **`enable_qa_pass=false` 时 critic 修订洗掉标记后仍落盘**。
   `anki_critic.rs:692-709`（`sanitize_plan_for_disabled_qa_pass`）：`retain_mut` 先 `card.extra_fields.remove(QA_FLAGS_FIELD)`——把 `llm_critic_revised` 一并剥掉——再按内容 diff 决定保留。revise 卡内容有 diff，必然保留并落盘（调用点 `anki_critic.rs:949-955` + CAS 写库 `:960-965`）。该卡携带生成期 `_original_generation`（`streaming_anki_service.rs:2053-2067` 首次入库固化），内容又被 critic 改过 → 下一个同文档任务跑 `collect_gold_references`（`anki_critic.rs:827-850`，`get_cards_for_document` 拉全量兄弟卡）时，`has_critic_revision_marker` 查不到标记，直接被当成 `EditedMinor/Major` 用户修正对回灌 prompt。**模型自改伪装成用户金标，正是 d8a606c2 声称要堵的洞，在 qa_pass 关闭路径上仍然开着。**
2. **代理工具编辑不可区分**。`chatanki_update_library_card`（证据同上）修改带 `_original_generation` 的卡后，diff 归因为"用户编辑"，被挖成金标。LLM 编辑 → 金标 → 回灌 critic prompt 的自我强化环没有被切断。
3. **APKG 导入可注入伪造 `_original_generation`**。`apkg_importer_service.rs:2087-2104`：导入器把外部包 note 的字段名原样写进 `extra_fields`（仅跳过 Front/Back/Text 核心字段），对 `_` 前缀机器协议字段（`_original_generation`/`_qa_flags`/`_occlusion`）**零剥离/零校验**（全文件 grep `_original_generation|_qa_flags` 为 0 命中）。恶意或撞名的外部包可让导入卡自带一份与正文不同的 `_original_generation` → 在该文档上后续制卡时被挖成"用户修正对"注入 prompt（间接 prompt 注入面 + 金标污染面）。注：`streaming_anki_service.rs:4868-4901` 的测试只保护了"生成路径不覆盖已有快照"，反而说明模板/导入值会被原样保留。

**综合裁决：P0-2 = 部分达成。对已打标的 critic 修订 YES；对"只有可证明用户编辑进金标"NO。**

---

## 三、#335 文案 vs 真闭环差距

### 改了哪些字符串（文案侧，跨 d8a606c2 与 08beff7e 两笔）

- `src/locales/zh-CN/anki.json:1104-1106`（d8a606c2）：`图像遮挡`→`图像遮挡草稿预览`；`previewBadge`→`遮挡草稿预览`；draftHint 从"请在导出前检查遮挡位置和答案"→"这是应用内草稿预览；**当前不会导出为可复习的 Anki 图像遮挡卡**"。
- `src/locales/zh-CN/chatV2.json:765-766`、`en-US/anki.json`、`en-US/chatV2.json` 同步（d8a606c2）。
- `src-tauri/src/lib.rs:12`（08beff7e）：模块注释"cloze 导出约定"→"cloze 候选字段"。
- `src-tauri/src/anki_image_occlusion.rs` 模块头/函数文档（d8a606c2）：删除"与既有 APKG 导出器兼容""保证任何 Anki 版本可导入可复习"等声明，改为"当前生产入库/导出尚未消费完整字段集合……不得宣称与 Anki 图像遮挡导出兼容"。
- `docs/research/anki-ai-native/**` 9 个文档（08beff7e）：`wrapup/23-occlusion-grounding.md` 等，把"最终仍复用 Cloze 卡导出"改为"候选 Cloze Text、图片媒体以及 _occlusion 到 APKG/AnkiConnect 的转换均未接，不会导出为可复习的 Anki 遮挡卡"。

### 断链证据（哪些路径仍把遮挡当普通卡处理、闭环缺哪几段）

1. **候选 Text 在入库时被丢弃**：`streaming_anki_service.rs:2006-2019` 只把 `fields.extra_fields`（即 `_occlusion` spec + 可选 `Extra`）和 tag 合并进卡，`OcclusionCardFields.text`（含 `{{cN::label}}` 的候选 Cloze 正文）根本没有消费者——遮挡卡入库后就是一张普通 front/back 卡外挂一段 spec JSON。
2. **APKG 导出器零遮挡语义**：`apkg_exporter_service.rs` 全文件 grep `occlusion` 0 命中。更糟的是导出器会把 extra_fields 键**通用化导出**（`:1309-1313`、`:1612-1615` 把非核心 extra 键追加为 note 字段），所以 `_occlusion` 的原始 JSON 会作为纯文本字段泄进导出的 APKG note——既不是遮挡卡，还带协议垃圾。
3. **AnkiConnect 同步零遮挡语义**：`anki_connect_service.rs` 全文件 grep `occlusion` 0 命中；"同步到 Anki"路径同样按普通卡处理。
4. 闭环缺的三段（tip 模块文档自认，`anki_image_occlusion.rs:19-30`）：候选 `Text` 消费、图片媒体打包、`_occlusion` → 原生 IO note type（或 cloze mask）转换 + 端到端测试。

**结论：#335（连同 d8a606c2 的 UI 文案部分）把宣称收敛到与实现一致，方向正确；但产品上"遮挡草稿"卡仍会随普通导出/同步流出（作为退化普通卡 + 泄漏 `_occlusion` 原文），文案只在预览面说了实话，导出面没有拦截或提示。**

---

## 四、第 2 轮 gold 溯源必须落地清单

按优先级：

1. **堵 `enable_qa_pass=false` 洗标记洞（P0）**：`sanitize_plan_for_disabled_qa_pass`（`anki_critic.rs:692-709`）不得在剥离 `_qa_flags` 时连 `llm_critic_revised` 一起洗掉。二选一：
   - revise 卡保留最小来源标记（`_qa_flags` 只留 `llm_critic_revised` 条目，剥掉其余 lint 留痕）；或
   - 新增独立来源字段（见第 2 条），使来源与 QA 留痕解耦——qa_pass 开关只应关"留痕"，不应关"溯源"。
2. **新增结构化来源字段（P0）**：卡片内容写路径统一记录 `_content_source`（或等价字段）∈ {`generated`, `user_edit`, `critic_revise`, `agent_tool`, `import`} + 最后修改时间。落点：
   - `chatanki_update_library_card`（`chatanki_executor.rs:3594` 起）打 `agent_tool`；
   - 用户 UI 编辑命令打 `user_edit`；
   - critic 写回打 `critic_revise`（与现有 `_qa_flags` 冗余无妨）；
   - 挖掘端 `gold_references_from_cards`/`classify_candidate` 改为**白名单**：只有 `user_edit` 进 `EditedMinor/Major`，而非现在的"排除已知一种黑名单"。
3. **APKG 导入剥离机器协议字段（P0）**：`apkg_importer_service.rs:2087-2104` 构造 extra_fields 时丢弃（或改名隔离）`_` 前缀键，至少覆盖 `_original_generation`、`_qa_flags`、`_occlusion`；补"导入包携带 `_original_generation` 不得被挖成金标"的单测。
4. **导出端对称剥离（P1）**：`apkg_exporter_service.rs` 通用 extra 字段导出（`:1309`、`:1612`）跳过 `_` 前缀机器字段，防止 `_qa_flags`/`_original_generation`/`_occlusion` 原文泄进导出包（隐私 + 协议卫生）。
5. **收集器 `critic_revised` 字段真值化（P2）**：`anki_critic.rs:805` 现在恒 `false`（靠前置 filter 兜底）；来源字段落地后应直接映射真实值，让 `classify_candidate` 第 1 步在此路径上也生效，去掉对 filter 顺序的隐式依赖。
6. **遮挡导出闭环或出口拦截（P1，属 #335 后续）**：在转换器接通前，导出/同步路径对带 `image-occlusion` tag 或 `_occlusion` 字段的卡给出明确跳过或降级提示，与预览文案对齐；否则"当前不会导出为可复习的遮挡卡"对导出面而言仍是半句实话。

---

## 五、附：本轮未发现的问题面（负面清单）

- d8a606c2 媒体同名冲突逻辑本身语义正确：先读包内条目再判复用，杜绝"清单缺条目但本地恰有同名文件被误报成功"；解压炸弹上限在临时文件路径同样生效。
- #332 未见跨库串题风险：`recordPracticeSessionAnswer` 对 owner/questionId 双重校验 fail-closed；`releasePracticeSession` 在 hook 卸载时清分片，无泄漏增长面（进程内、非持久化）。
- 三个提交均未触碰禁改区（coordinator.rs、tool_loop/hooks、移动 chrome、workbench 壳）。

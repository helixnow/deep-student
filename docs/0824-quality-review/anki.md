# Deep Student 0824 制卡 / Anki / 闪卡预览质量评审

对照范围：`v0.9.44` → `origin/cursor/0824-cde6 @ 2d41ea8b`。结论基于该区间的真实改动及目标树源码；这里只评新增或被新增能力实际放大的问题。

## 结论

整体判定为 **FAIL：功能骨架接上了，但没有干净收口**。

最严重的不是 UI 细节，而是两条语义链没有闭合：

1. 图像遮挡目前只在 Deep Student 内形成 `_occlusion` 叠层预览，生产入库主动丢掉遮挡模块生成的 Cloze `Text`，导出端也不认识 `_occlusion` 或其图片引用。因此它不是可导入 Anki 后继续复习的图像遮挡卡，与模块注释的“任何 Anki 版本可导入可复习”相冲突。
2. critic 自动修订会被后续 gold-set 挖掘误认成“用户编辑”，再作为 grounded 金标回灌给 critic。当前数据模型没有编辑者来源，稳定的 `llm_critic_revised` 标记也未用于排除，形成自举污染。

此外，`enableQaPass=false` 的公开语义确实翻车；critic 摘要事件、国际化字符串和 options 解析层均有“后端做了、前端/收尾没接完”的痕迹。Generative UI 的只读闪卡本身反而是这块里边界最清楚的一项。

## 发现

### P0 — 图像遮挡只完成了应用内预览，Anki 导出闭环实际上不存在

`anki_image_occlusion::build_card_fields` 会生成三样东西：Cloze `text`、`_occlusion` JSON 和 `image-occlusion` tag（`src-tauri/src/anki_image_occlusion.rs:416-471`）；`extract_occlusion_draft_fields` 也完整返回这个结构（`:704-716`）。

生产入库却只合并 `fields.extra_fields` 和 `fields.tags`，明确不写 `fields.text`，也不向 `AnkiCard.images` 放入图片（`src-tauri/src/streaming_anki_service.rs:1929-1942,1986-2002`）。全目标树中 `OcclusionCardFields.text` 除构造和单测外没有消费者。于是卡片在 Deep Student 中能靠 `_occlusion.imageRef` 画遮罩，但持久化卡片本身仍是模型原先生成的普通 front/back/text。

导出端同样没有 `_occlusion` 处理：

- ChatAnki 导出只是原样透传 `text/images/extra_fields`（`src/features/chat/anki/index.tsx:298-320,340-347`）。
- `apkg_exporter_service.rs` 没有解析 `_occlusion`、没有把 `imageRef` 打包成媒体、也没有据此创建 Cloze `Text`。
- AnkiConnect 路径只按目标 note type/model 的既有字段取值；它也不会把 `_occlusion` 转成图片遮挡 note。

因此当前效果是“应用内有遮罩预览，导出后仍是普通卡”，不是端到端 image occlusion。`src-tauri/src/anki_image_occlusion.rs:25-31` 关于复用 Cloze 导出、保证可导入可复习的说明与生产接线不符；`src/locales/*/anki.json` 的 `agent.occlusion.draftHint` 又要求用户“导出前检查”，进一步强化了一个尚不存在的导出承诺。

修复不能只补 UI：入库/导出必须选择一个明确契约。要么真正消费 `OcclusionCardFields.text`、解析并打包 `imageRef`、导出可复习的 Cloze/IO note；要么把功能明确降级命名为“图片遮挡草稿预览”，禁止宣称 Anki 遮挡闭环。

### P0 — critic 修订会污染它自己的“用户金标”

每张成功生成的卡在首次入库前都会写入 `_original_generation`（`src-tauri/src/streaming_anki_service.rs:1970-1984`）。critic 的 `revise` 随后修改 front/back/text，保留该原始快照，并追加 `llm_critic_revised`（`src-tauri/src/anki_critic.rs:587-669,907-932`）。

gold-set 分类没有编辑者概念：只要 original 与 current 不同，就直接标为 `EditedMinor` / `EditedMajor`，且内容 diff 优先于五分钟时间宽限（`src-tauri/src/anki_gold_set.rs:357-365,429-458`）。生产收集器从同文档兄弟任务取卡时，只排除当前任务和错误卡；它没有检查 `_qa_flags` 中的 `llm_critic_revised`（`src-tauri/src/anki_critic.rs:731-783`）。只要 critic 修订后的卡通过“金标端干净”筛选，它就有资格成为后续任务的 grounded reference。

这与代码注释反复声称的“用户实际编辑过”“用户修正记录”不一致。它会把模型自己的改写伪装成人类修正，再教回同一个评审链，造成来源错误和反馈回路。

应至少排除带 `llm_critic_revised` 的候选；更稳妥的方案是给内容修改记录明确保存 actor/provenance，只把可证明来自用户的编辑送入 gold mining。仅依赖 `updated_at` 或内容差异无法区分用户、critic、同步和其他自动写手。

### P1 — 新增内部协议字段会泄漏到 APKG note model

0824 把 `_qa_flags`、`_occlusion`、`_original_generation` 都定义为下划线前缀的内部字段；前端也按此前缀把它们排除出正文和编辑器（`src/features/chat/plugins/blocks/components/ankiQaFlags.ts:149-155`）。

导出边界没有采用同一规则。单模板 APKG 导出会把所有非“Anki 导入保留字段”的 `extra_fields` key 追加进 model 字段（`src-tauri/src/apkg_exporter_service.rs:39-62,1292-1322`）；多模板导出也做同样的追加（`:1609-1624`）。过滤名单只有 13 个 `Anki*` 调度/来源字段，不过滤下划线内部字段。ChatAnki 前端又原样传递整个 `extra_fields`（`src/features/chat/anki/index.tsx:305-320`）。

结果是有模板的导出可把 QA 审计 JSON、遮挡 spec，甚至每张卡最多 16 KiB 的原始生成快照变成 Anki note 的真实字段。它们虽未必出现在卡面，却会污染模型字段表、增大包体，并在 Anki 编辑器中暴露本应内部使用的数据。

应在统一导出规范化层过滤内部字段，而不是只在 React 编辑器过滤；若某个内部字段确实需要用于导出，应由专门转换器消费后移除，不能原样下放。

### P1 — `enableQaPass=false` 与公开契约相反

run/start schema 明确写着：默认开启，用户明确不要 QA 留痕时传 `false`（`src/features/chat/skills/builtin/index.ts:283-292,374-383`）。

后端在 `false` 时只先删除字段规则已有的 `_qa_flags`（`src-tauri/src/streaming_anki_service.rs:1904-1907`），随后仍无条件执行单卡 lint、文档级重复检测，并再次 `merge_flags`（`:1944-1968`）。只要确定性规则命中，`_qa_flags` 仍会落库。critic revise 后的 relint 也不读取这个开关（`src-tauri/src/anki_critic.rs:657-668`）。

这不是措辞偏差，而是布尔开关行为错误。应让 `false` 包住所有 QA lint/merge 留痕；若产品只想关字段规则而保留确定性 lint，就必须改参数名和公开说明，不能继续称“不要 QA 留痕”。

### P1 — critic 的失败、跳过和 grounded 信息在产品 UI 中不可见

后端 `CriticSummary` 已统计 examined/kept/revised/flagged、预算跳过、持久化失败、降级原因、gold reference 数量和模型路由（`src-tauri/src/anki_critic.rs:269-299`）。但发送事件时又漏掉 `gold_references`、`gold_references_truncated` 和全部 routed 字段（`src-tauri/src/streaming_anki_service.rs:2949-2974`）。

更关键的是，产品态前端没有消费 `CriticSummary`：

- `AnkiCardsBlockData` 没有 critic summary 字段（`src/features/chat/plugins/blocks/ankiCardsBlock.tsx:125-188`）。
- `TauriAdapter.handleAnkiGenerationEvent` 会规范化并路由事件，却只处理 NewCard、进度、任务/文档终态等分支，`CriticSummary` 最终不更新 block（`src/features/chat/adapters/TauriAdapter.ts:1441-1467,1663-1858`）。
- `agent.critic` 词条中只有 `flaggedFlag` / `revisedFlag` 被 QA badge 使用；title、summary、skippedOverBudget、goldReferences、degraded 没有产品消费者（`src/features/chat/plugins/blocks/components/AnkiQaFlagBadge.tsx:39-43`，`src/locales/*/anki.json:1089-1097`）。

因此用户显式要求 critic 后，即使模型超时、解析降级、预算内一张都没评、CAS 写回失败，界面仍只表现为普通成功收尾。单卡 flag 能显示已成功落盘的结果，不能替代任务级可观测性。

### P2 — QA 与遮挡国际化/无障碍只铺了词条，没有接到组件

确定性 QA 的 `message` 明确定义为中文并由 Rust 直接生成（`src-tauri/src/anki_qa_lint.rs:184-205,848-965`）；前端除两个 critic code 外，对普通 lint 直接展示 `flag.message`（`src/features/chat/plugins/blocks/components/AnkiQaFlagBadge.tsx:81-87`）。英文界面会出现中文 QA 详情。稳定 `code` 已经存在，正确边界应是前端按 code 本地化，动态数字作为参数传递，而不是持久化单语言文案后原样显示。

遮挡侧的问题更直接：

- `ImageOcclusionOverlay` 把按钮 aria-label 写死为中文“揭开遮挡区域”（`src/components/anki/ImageOcclusionOverlay.tsx:118-130`）。
- 图片使用 `alt=""`；加载失败占位又是 `aria-hidden`（`src/features/chat/plugins/blocks/ankiCardsBlock.tsx:519-558`）。
- `agent.occlusion.imageAlt/revealBox/revealedBox/imageUnavailable/invalidSpec/...` 中英文词条虽然齐全，但目标树 TS/TSX 没有消费者（`src/locales/*/anki.json:1103-1123`）。
- 无标签时 Rust 与 TS 都补中文“区域 N”（`src-tauri/src/anki_image_occlusion.rs:100-101,325-329`；`src/components/anki/utils/imageOcclusion.ts:136-142`）。

这说明 locale 文件先加了，实际渲染层没有收口；现有测试还用硬编码中文 label 查询，反而把错误固化了（`src/components/anki/__tests__/ImageOcclusionOverlay.test.tsx:35-37,51-52`）。

### P2 — 可空 JSON 迁移能升级旧库，但读侧仍不是持久防线

V20260824 会把升级时已有的 `tags_json/images_json/extra_fields_json` NULL/空串归一为 `[]/[]/{}`，且不改有效 QA/遮挡数据（`src-tauri/migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql:5-21`）。公共 mapper 也已用 `Option<String>` 防御（`src-tauri/src/database/mod.rs:242-270`）。

但高频读取仍直接把可空列取成 `String`：任务、文档、ID 和最近卡片路径分别见 `src-tauri/src/database/mod.rs:4865-4914,4917-4966,5018-5074,7463-7505`；`FsrsReviewService::get_card_tags` 的 `.optional()` 只表示“无行”，行存在且列为 NULL 时仍会类型报错（`src-tauri/src/fsrs_review_service.rs:1903-1920`）。

这会直接影响 critic 的 `get_cards_for_task/get_cards_for_document`、导出选择和状态恢复。一次性迁移不能防住迁移后由历史导入或 RowSync 再写入的 NULL，而 `anki_cards` 正是 RowSync 表，`images_json/extra_fields_json` 采用 LWW（`src-tauri/src/data_governance/sync/classification.rs:662-674`）。所以“v0.9.44 存量库可升级”成立，“读侧已完全兼容”不成立。

### P3 — options 扩展层已经迁回主 struct，旧 workaround 与注释仍保留

`anki_protocol::StructuredOutputOptions` 的注释称不能给 `AnkiGenerationOptions` 加字段，未来再迁回（`src-tauri/src/anki_protocol.rs:88-116`）；`anki_critic.rs:26-30,67-94` 也沿用同一理由。

但目标树的 `AnkiGenerationOptions` 已经直接包含 `output_protocol`、`enable_qa_pass`、`enable_critic_pass`、alias、budget 和 routing（`src-tauri/src/models.rs:1328-1352`），`chatanki_executor` 的穷举字面量也已全部补齐（`src-tauri/src/chat_v2/tools/chatanki_executor.rs:10966-11013`）。运行时仍对同一 JSON 再做两套局部 serde 解析。

这不是当前主故障，但属于典型“迁了一半”：注释已失真，选项来源重复，后续新增校验或默认值时容易再次漂移。应统一从已解析的 `AnkiGenerationOptions` 读取，或至少删除过期理由并把 wire 解析集中在一处。

## 只读闪卡与相对 v0.9.44 的归因

Generative UI 的 `flashcard-preview` 没有发现保存/编辑回流：组件 props 只有 front/back/tags/deckName，渲染中没有按钮或持久化 handler（`src/features/generative-ui/components/FlashcardPreviewBlock.tsx:7-55`）；intent builder 只生成 preview block（`src/features/generative-ui/utils/buildFlashcardPreviewIntent.ts:20-36`）；即使外部 intent 注入旧 `save-to-library` action，resolver 也不注册它（`tests/vitest/generative-ui/flashcardDisplayOnly.test.ts:29-50`）。这一部分的“只读”文字、组件和 handler 边界是一致的。

相对基线应区分两项旧债：

- “恢复卡住任务”写“超过 1 小时、重置为待处理”，后端实际为 10 分钟并写 `Paused`，在 v0.9.44 已完整存在；0824 没有引入或加重。
- `common:debug.chat_anki_panel.action.save` 的“保存到卡库”死 i18n key 在 v0.9.44 已存在且当时就无 TS/TSX 消费者。它仍应清理，但不能据此指控 0824 的只读 preview 暗藏保存能力。

0824 真正新增的回归/缺口，是 QA false 失效、critic/gold 来源混淆、遮挡导出断链，以及新增内部字段与旧导出器组合后产生的字段泄漏。恢复文案和旧 save key 只是本轮没有顺手清掉的历史债。

## 修复顺序

1. 先阻断 critic 自动修订进入用户 gold reference，并补 actor/provenance 回归。
2. 明确遮挡产品契约；若承诺 Anki 可复习，就补齐图片媒体、Cloze/IO 字段和 APKG/AnkiConnect 端到端测试。
3. 在所有导出边界统一过滤 `_` 内部字段，再由专用转换器消费确需导出的协议数据。
4. 修正 `enableQaPass=false`，并覆盖“字段规则 + 确定性 lint + critic relint”的组合测试。
5. 接通并完整序列化 `CriticSummary`，让降级、预算跳过和写回失败对用户可见。
6. 收口 QA/遮挡 i18n、可访问名称和 nullable JSON 读侧；最后删除重复 options parser 与过期注释。

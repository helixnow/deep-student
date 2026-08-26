# 仓 D #215：Anki / Flashcards 静态审计

审计对象为当前 0824 合并树中的 Anki 生成、任务管理、ChatAnki 卡片块与
Generative UI 闪卡预览。本文只记录静态源码事实；未运行 Tauri、未连接真实 Anki
或私人卡库。

## 结论

**WARN**

核心边界成立：确定性 QA、opt-in critic、图像遮挡生产接线仍在；Generative UI
闪卡保持只读；生产制卡入口统一走 `cardAgent.startGeneration`，没有复活
`ChatV2AnkiAdapter`；历史卡片的可空 JSON 元数据也有读侧和迁移双重兼容。

但有三项确定性问题需要后续产品修复：

1. `enableQaPass=false` 只先删除字段规则生成的 `_qa_flags`，随后仍无条件运行
   确定性 lint 并重新写入 `_qa_flags`，与公开 schema 的“不要 QA 留痕时传
   false”不一致。
2. 制卡任务页“恢复卡住任务”的提示写“超过 1 小时、重置为待处理”，后端实际
   阈值为 10 分钟，写入状态为 `Paused`；删除会话虽然有二次点击，但确认态只显示
   “确认?”，没有展示该操作会物理删除卡片、任务及 FSRS 历史。
3. `common:debug.chat_anki_panel.action.save` 的“保存到卡库”中英文词条无源码
   消费者，是残留死 key；它不代表 `FlashcardPreviewBlock` 存在保存能力。

**本轮不改代码。**

## 逐项证据

### 1. QA：主链已接，但关闭开关语义不完整

- `src-tauri/src/anki_qa_lint.rs:1-17` 定义默认 flag、不丢卡，并把结构化结果写入
  `extra_fields["_qa_flags"]`；`src-tauri/src/anki_qa_lint.rs:90-146` 枚举 26 个
  稳定 lint code。
- `src-tauri/src/anki_protocol.rs:98-117` 将 `enable_qa_pass` 缺省为开启。
- `src-tauri/src/streaming_anki_service.rs:1944-1968` 在入库前执行单卡 lint、
  文档级重复/近重复检测，并合并 `_qa_flags`；`1986-2008` 随后才构造并写入卡片。
- `src/features/chat/plugins/blocks/components/ankiQaFlags.ts:75-109` 防御性解析
  `_qa_flags`，`149-155` 把下划线协议字段排除出正文和可编辑字段；
  `src/features/chat/plugins/blocks/ankiCardsBlock.tsx:2083-2102` 生成块级 QA 摘要。
- **WARN：** `src/features/chat/skills/builtin/index.ts:283-292,374-383` 对模型公开的
  契约称 `enableQaPass=false` 用于不要 QA 留痕；但
  `src-tauri/src/streaming_anki_service.rs:1904-1907` 删除已有 flag 后，
  `1944-1968` 未受该布尔值保护，又无条件写回确定性 lint flag。应统一实现与文案：
  要么真正关闭全部 QA 留痕，要么把参数明确改称“仅关闭字段规则留痕”。

### 2. Critic：生产调用点存在，默认关闭是明确边界

- `src-tauri/src/chat_v2/tools/chatanki_executor.rs:10999-11013` 将 run/start 的
  `enableCriticPass` 透传进生成 options，并明确默认关闭。
- `src-tauri/src/streaming_anki_service.rs:655-685` 在任务成功收尾时，仅当开关开启且
  已生成卡片才调用 `run_critic_pass`；critic 失败降级为 keep，不阻断制卡完成。
- `src-tauri/src/anki_critic.rs:825-905` 只评审本任务成功入库的非错误卡，并对模型
  超时、坏输出和预算不足做降级；`907-932` 用送审时 `updated_at` 做 CAS，避免覆盖
  用户在评审期间的编辑。
- `src/features/chat/plugins/blocks/components/ankiQaFlags.ts:19-23` 固定
  `llm_critic` / `llm_critic_revised` 审计 code。

结论为 **PASS（opt-in）**，不能表述成“默认每次制卡都运行 LLM critic”。

### 3. 图像遮挡：直接图片有坐标优先链与安全预览，但不是完整原生闭环

- `src-tauri/src/chat_v2/tools/chatanki_executor.rs:9586-9613` 要求 VLM 可选输出
  `[OCCLUSION_BOXES]` 归一化坐标；`9699-9725` 对直接图片优先采用校验后的 VLM
  坐标，失败才回退 IMAGE_DESC 网格草稿，并明确 PDF 页面尚无稳定逐页
  `image_ref`。
- `src-tauri/src/streaming_anki_service.rs:1203-1206,1275-1297` 只让分段首张成功卡
  消费遮挡草稿；`1929-1942` 仅合并 `_occlusion` 与 tag，不篡改
  front/back/text。
- `src/components/anki/utils/imageOcclusion.ts:55-73,86-175` 拒绝越界、非有限、
  退化或全坏数据并限制盒数量；`src/components/anki/ImageOcclusionOverlay.tsx:52-83`
  按同一 `clozeIndex` 成组揭开，`86-130` 阻止键盘/鼠标事件冒泡到外层翻面或编辑。
- `src/features/chat/plugins/blocks/ankiCardsBlock.tsx:2089-2102,2793-2808` 在折叠态也
  渲染最多五张可安全解析的遮挡预览。
- `src/components/anki/ImageOcclusionOverlay.tsx:1-9` 明确首版不做拖拽编辑和复习调度。

结论为 **PASS（当前草稿/预览范围）**；PDF 页图、遮挡编辑器和原生 Anki Image
Occlusion note type 仍不应宣称已闭环。

### 4. Generative UI 闪卡只读，`FlashcardPreviewBlock` 没有保存按钮

- `src/features/generative-ui/components/FlashcardPreviewBlock.tsx:7-17` 的 props 只有
  id/front/back/tags/deckName；`22-55` 只渲染 `Card`、文本和 `Badge`，没有
  `Button`、`onClick`、handler 或持久化调用。
- `src/features/generative-ui/utils/buildFlashcardPreviewIntent.ts:1-5` 明确声明只读，
  持久化归 `anki_cards` 管线；`20-36` 构造的 intent 只有
  `flashcard-preview` block。
- `src/features/generative-ui/blocks/index.ts:89-94` 只注册预览组件。
- `tests/vitest/generative-ui/flashcardDisplayOnly.test.ts:6-27` 锁定构建结果没有
  `save-to-library` handler；`29-50` 进一步锁定外部 intent 即使塞入旧 action，
  也不会注册保存 handler。

结论为 **PASS**。ChatAnki 的 `anki_cards` 块另有受控保存/编辑路径，不应与这个
display-only GenUI block 混为一谈。

### 5. 无生产 `ChatV2AnkiAdapter`，入口统一走 `cardAgent.startGeneration`

- `src/features/chat/services/selectionCardGeneration.ts:93-131` 的聊天划词入口直接调用
  `cardAgent.startGeneration`。
- `src/features/anki/generateCardsFromText.ts:38-57` 的笔记、错题和作文共享入口也直接
  调用同一方法。
- `src/components/anki/cardforge/engines/CardAgent.ts:399-440` 的
  `startGeneration` 调用 `start_enhanced_document_processing`，启动成功即返回
  `documentId`，不在前端阻塞收集卡片。
- `src/features/anki/__tests__/cardGenerationSurfaces.source.test.ts:24-46` 锁定主要
  制卡表面使用共享入口；`49-78` 递归断言 `src/` 不存在
  `ChatV2AnkiAdapter` 模块文件，且各生产表面不得导入它。

当前 `src/` 中该名字只出现在退役说明和负向守卫，没有模块、import、实例化或生产
调用。结论为 **PASS**。

### 6. Anki 可空 metadata：实际是三个可空 JSON 存储字段，兼容成立

这里没有名为 `metadata` 的单独 `anki_cards` 列；相关元数据实际存放在
`tags_json`、`images_json`、`extra_fields_json`。

- `src-tauri/src/database/mod.rs:242-270` 将三列读取为 `Option<String>`，NULL、坏
  JSON 都安全降级为空集合；`278-307` 的 Agent/卡库记录映射采用同样策略。
- `src-tauri/migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql:1-21`
  只把 NULL/空串归一化为 `[]`/`{}`，明确不改写有效 `_qa_flags` 与
  `_occlusion`；`23-31` 同时兼容历史来源字段 NULL。
- `src-tauri/src/data_governance/migration/mistakes.rs:275-284` 把该迁移注册为幂等。
- `src-tauri/src/database/mod.rs:8706-8778` 的回归测试把三列强制置 NULL，并验证卡库
  读取、Agent 读取与 FSRS enqueue 均不会失败。

结论为 **PASS**。

### 7. 制卡任务页危险写操作

- 暂停、恢复、取消和重试由
  `src/features/anki-tasks/components/SessionRow.tsx:112-146` 汇总调用。取消虽是单击，
  但后端 `src-tauri/src/enhanced_anki_service.rs:745-820` 明确只停止生成、把未完成
  任务置 `Cancelled`，保留任务记录和已生成卡片；失败面板仍可重试，因此不是数据
  删除操作。
- 真正破坏性的“删除会话”在
  `src/features/anki-tasks/components/SessionRow.tsx:148-158` 采用 3 秒内二次点击；
  `357-371,435-444` 在确认态使用 danger 样式。可是后端
  `src-tauri/src/database/mod.rs:6012-6046` 会在一个事务里物理删除 FSRS review
  logs、FSRS states、全部卡片和全部 document tasks。
- **WARN：** 当前确认态只使用
  `src/locales/zh-CN/anki.json:776` 的“确认?”；同文件 `763` 已有“相关数据将被清除”
  的完整 `confirmDelete` 文案，却没有被 `SessionRow` 使用。二次点击机制存在，但
  风险说明不足。
- **WARN：** 页面在 `src/features/anki-tasks/AnkiTasksApp.tsx:295-310` 单击调用
  `recover_stuck_document_tasks`；提示
  `src/locales/zh-CN/anki.json:780` 称“超过 1 小时、重置为待处理状态”。后端
  `src-tauri/src/database/mod.rs:7300-7344` 实际默认阈值为 10 分钟，并把状态更新为
  `Paused`。该动作不删数据，但 UI 对写入条件和结果都陈述错误。

结论为 **WARN**：删除已有最小二次确认，不是无保护直删；仍应显示完整不可逆影响，
并统一恢复动作的阈值、目标状态和文案，同时补行为测试。

### 8. “保存到卡库”是死 key，不是隐藏按钮

- 唯一精确中文命中位于
  `src/locales/zh-CN/common.json:3099-3161` 的旧
  `debug.chat_anki_panel` 分组，其中 `action.save` 在 `3151`；
  英文对称词条在 `src/locales/en-US/common.json:3205-3211`。
- 静态全仓检索 `src/**/*.{ts,tsx}` 没有 `chat_anki_panel` 消费者，也没有对该完整
  key 的直接或动态引用。
- 与之相反，当前产品契约明确拒绝旧 handler：
  `tests/vitest/generative-ui/flashcardDisplayOnly.test.ts:29-50`；组件本身也由
  `src/features/generative-ui/components/FlashcardPreviewBlock.tsx:17-55` 证明无按钮。

所以“保存到卡库”是调试面板遗留的 **死 i18n key**，不是可达产品能力。建议后续
中英文成对删除，并保留 display-only 契约测试。

## 后续修复优先级

1. 对齐 `enableQaPass=false` 的实现与公开契约。
2. 对齐卡住任务恢复的 10 分钟/Paused 实际语义与 UI 文案（或反向修改后端以符合
   产品决定）。
3. 删除会话确认态改用完整风险文案，并增加“第一次不删除、第二次才调用、超时复位”
   的测试。
4. 成对清理 `debug.chat_anki_panel.action.save` 死 key。

以上均留待产品分支处理；**本轮不改代码**。

# 制卡任务、CardAgent 启动与 streaming Anki 质量评审

对比 `v0.9.44` 与 `2d41ea8b` 后，这块不能简单判为“改造完成且质量良好”。启动链路和流解析器都有实质进步，但新链路存在两处跨层高风险冲突，并保留了会把失败伪装成完成的生命周期缺口。总体判断是：**方向正确、收益明显，但当前仍有必须修正的缺陷与较大的收口空间。**

## 默认 FSRS 回流实际会上传历史复习数据，和代码中的隐私承诺相反

这是本次最需要优先处理的问题。`EnhancedAnkiService` 对 `fsrs_feedback == None` 按开启处理，并把生成的画像直接拼进 `custom_requirements`（`src-tauri/src/enhanced_anki_service.rs:154-186`）。画像不只有聚合数字，还包含高遗忘卡片的正面摘要、标签、lapses 等信息；渲染文案却明确写着“数据仅本地，不上传”（`src-tauri/src/anki_fsrs_feedback.rs:323-359`、`486-497`）。

该声明与真实数据流不符：`custom_requirements` 被放入 system message（`src-tauri/src/streaming_anki_service.rs:824-834`），随后随 `messages` 进入模型请求体（`1048-1066`、`1084-1168`）。只要配置的是远端模型，历史卡片片段和复习画像就会离开本机，而且与本次用户主动提交的材料并非同一份数据。

风险还被默认值放大：CardAgent 的公开输入没有 `fsrs_feedback` 选项（`src/components/anki/cardforge/types/index.ts:33-46`），划词、笔记、错题、作文等 `startGeneration` 调用方无法显式关闭。旧版没有这条默认外送链路，因此这是实质隐私回归，而不只是文案问题。

建议至少做到：远端模型下默认关闭或首次明确授权；前端公开可控开关；删除“不上传”的错误承诺；优先只传匿名聚合信号，不传历史卡片原文。没有这些约束前，不宜把 FSRS 回流作为默认生产行为。

## CardAgent 与 Structured Output 在同一请求里下发了互相矛盾的协议

CardAgent 现在把 `buildCardGenerationSystemPrompt()` 放进 `custom_anki_prompt`（`src/components/anki/cardforge/engines/CardAgent.ts:479-521`）。这份 prompt 明确要求每张 JSON 后输出 `<<<ANKI_CARD_JSON_END>>>`，并要求除 JSON 和结束标记外不输出其他内容（`src/components/anki/cardforge/prompts/index.ts:63-78`）。

与此同时，后端会按供应商能力自动选择 `json_schema`（`src-tauri/src/streaming_anki_service.rs:509-531`），Structured Output 的 user 指令要求输出 `{"cards":[...]}` wrapper、不使用分隔符；但后端仍把上述 CardAgent prompt 原样追加到 system message（`805-818`）。因此真实的 CardAgent 生产请求同时包含“必须输出 END 分隔符”和“必须输出 schema wrapper”两套协议。

这不是理论上的测试盲点：现有 `build_prompt_structured_omits_delimiter_and_uses_wrapper` 只断言 `payload.user` 不含分隔符，并未检查完整 system + user 消息（`src-tauri/src/streaming_anki_service.rs:4277-4293`），所以无法发现生产组合中的冲突。强约束供应商可能以 schema 为准，弱约束或兼容端点则可能混合输出；后端的 delimiter 回退只覆盖 HTTP 400/404/422，并不能修复“请求成功但模型遵循了另一套协议”的情况。

输出协议应只由后端单点生成。CardAgent 的基础 prompt 必须协议中立，不能携带 END-only 规则；并应增加一条使用真实 CardAgent options 组装完整请求消息的跨层测试。

## JSON“修复”会把被截断的答案静默保存成正常卡

新的 brace-depth 切卡、wrapper 展开、特殊 token 保守清理和 1 MB 缓冲上限，整体上明显优于旧版；相关单测也覆盖了转义引号、多字节字符、无分隔符多卡等关键边界。这部分是本次 streaming 改造中质量最扎实的地方。

但 `parse_and_save_card` 在 serde 失败后调用 `repair_json`，成功后直接走正常卡入库（`src-tauri/src/streaming_anki_service.rs:1762-1784`）。该修复器不仅补结构符，还会给“字符串中途截断”补引号和括号；测试甚至明确接受 `{"front":"未闭合` 这类输入（`src-tauri/src/anki_protocol.rs:1100-1108`）。如果流在 back 正文中途因 token 上限或断连结束，残缺答案会被补成合法 JSON，既不是错误卡，也没有 repaired/truncated 标记。

随后任务仍按成功收尾并写成 `Completed`（`src-tauri/src/streaming_anki_service.rs:655-693`）。这比生成错误卡更危险，因为用户在任务台看到的是完成状态，无法知道内容已被截断。建议只自动修复可证明不损失字段内容的尾逗号、外围垃圾和已闭合字符串后的缺失括号；字符串中途截断必须落错误卡或至少持久化可见的 repair 标记，不能静默升级为正常卡。

## `maxCards` 的公开语义仍被实现成“每分段上限”

`GenerateCardsInput.maxCards` 对外写的是“最大卡片数量”，但 CardAgent 只设置 `max_cards_per_mistake`，没有设置 `max_cards_total`（`src/components/anki/cardforge/engines/CardAgent.ts:505-533`）。后端只有在 `max_cards_total` 存在时才会给多个 segment 分配全局额度（`src-tauri/src/document_processing_service.rs:83-96`）。

旧划词入口通常是短文本，这个偏差不容易暴露；0824 又把笔记、错题和作文等长材料接到同一 `startGeneration` 后，影响被显著放大。例如调用方传 `maxCards: 10`，分成 4 段后实际可生成最多 40 张；未传时默认值 50 同样是每段 50。这个行为既违反类型契约，也会放大模型费用和任务时长。

CardAgent 应把调用方的 `maxCards` 写入 `max_cards_total`，由已有的后端分配逻辑拆到各段；`input.maxCards || 50` 也应改为显式校验后的空值回退，避免把 0、负数等非法输入变成含混语义。需要补一条多分段端到端额度测试，当前只断言了单次 invoke 中 `max_cards_per_mistake` 等于 10。

## 任务台的“关注/完成”仍没有承接 streaming 的真实质量结果

streaming 新增了 `failed_cards`、`dropped_fragments`、`duplicate_cards` 等统计并发出 `GenerationStats`（`src-tauri/src/streaming_anki_service.rs:104-117`、`2924-2946`），但任务台既不监听该事件，也不持久化这些指标。单卡解析失败时会创建错误卡，整个 segment 仍返回 `Ok(stats)` 并标为 `Completed`。会话查询的 `failedTasks` 只统计任务状态为 Failed / Truncated / Cancelled 的分段（`src-tauri/src/database/mod.rs:7356-7363`），所以“所有输出都是错误卡”的会话仍可能显示为已完成。

这使新的统计更像调试遥测，而不是产品生命周期的一部分。至少应把每会话错误卡数、丢弃残片数或“带警告完成”持久化到任务汇总，并让任务台进入关注态；否则非阻塞 `startGeneration` 把结果责任交给任务台后，任务台仍无法诚实表达结果质量。

状态模型本身也仍是互斥分类：`classify` 先看 `failedTasks`，再看 active/paused（`src/features/anki-tasks/types.ts:40-43`）。因此一个同时有失败段和运行段的文档会被归为 attention，活跃轮询判断也随之变成 false（`src/features/anki-tasks/AnkiTasksApp.tsx:215-229`），行内 pause/cancel 入口则因 `group !== active` 消失。此次把“失败 + 暂停”场景的重试按钮改为常显是正确修复，但只修了按钮，没有修复“运行中”和“需关注”可以同时成立的事实。现有新增测试也只覆盖失败 + 暂停，不覆盖失败 + 运行。

## 任务台错误态改造是进步，但加载仍被非关键统计绑死

首次加载失败不再伪装成空列表，刷新失败保留旧数据并展示 stale banner，这比旧版静默吞错可靠得多；新增测试也覆盖了首次失败、重试恢复和旧数据保留。失败任务重试入口常显、粗指针 44 px 目标也属于有效可用性改进。

不过 `list_document_sessions` 与 `get_anki_stats` 仍放在同一个 `Promise.all`（`src/features/anki-tasks/AnkiTasksApp.tsx:215-234`）。只要全局统计查询失败，即使会话列表已经成功返回，新的结果也会被整体丢弃，任务台会显示整页加载失败或继续展示旧任务。这对以任务跟踪为主职责的页面不合理：会话生命周期数据应独立成功，统计卡片可以单独降级。现有 load-error 测试只模拟列表失败，没有覆盖 stats-only failure。

## 改造中值得保留的部分

划词链路从“阻塞收集全部卡片后才提示已开始”迁到 `startGeneration` 后，后端创建任务并返回 documentId 即结束前台等待；它不再依赖 CardAgent 事件监听初始化，且划词、笔记、错题、作文复用了同一启动入口。`generateCards` 与 `startGeneration` 共用 options 构造也减少了两条路径漂移，旧的 `{{DOCUMENT_CONTENT}}` 假占位符和 `system_prompt` 误用得到清理。这些都是相对旧版明确且正确的架构改进。

streaming 侧的字符串感知 brace-depth 解析、长卡缓冲保护、wrapper 流式拆卡、模型特殊 token 的保守处理，以及任务台对真实加载失败的展示，都有针对性测试支撑。问题不在于改造方向，而在于跨层契约没有一起收口：隐私数据、输出协议、修复语义、全局数量上限和任务终态分别在各层看似合理，组合起来却产生了错误行为。

因此建议把“FSRS 默认外送”和“Structured Output 协议冲突”作为合入阻断项；截断修复与全局卡片上限作为高优先级正确性问题；再补齐 per-session 质量终态、混合状态模型和独立加载降级。完成这些后，这块才能从“功能扩展明显但有风险”提升到可认为改造质量良好。

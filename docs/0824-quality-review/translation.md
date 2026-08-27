# 翻译域改造质量评审

结论：方向正确，前端重复规则明显收敛，但还不能算完全收口。当前没有会直接阻断翻译主链路的问题；比较明确的是两项中风险语义缺口（提示词来源、分段边界），流状态桥和持久化值校验也有继续加固的必要。该范围的 Rust 文件在两版间没有改动，实际增量是前端 7 个文件新增/调整 413 行、删除 1 行，因此后端长文本切分、事件协议本身不应算作本次改造成果。

最值得肯定的是把语言列表、对齐算法、会话偏好解析和提示词判定提成了纯模块。`resolveSessionPrefs` 将“会话值 → 用户偏好 → 内建默认”集中在一处（`src/translation/sessionPrefs.ts:25-33`），比各调用点各自回退更不容易产生 dirty 签名和界面状态不一致；`alignTexts` 还显式返回 `usedSentenceFallback`（`src/translation/segmentation.ts:29-39`），让启发式降级不再静默发生。语言表也确实覆盖了当前后端 `lang_full_name` 的全部公开选项：前端清单见 `src/translation/languages.ts:23-49`，后端映射见 `src-tauri/src/translation/pipeline.rs:662-692`，在目标版本中没有发现实际 code 不匹配。新增纯函数测试能锁住这些基本意图，也比把规则埋在组件内更容易演进。

但提示词目前用“文案相等”代替“来源状态”，这是最需要修正的设计。`isPromptCustomized` 仅通过 trim 后是否命中已知模板字符串来判断用户是否编辑过（`src/translation/promptPresets.ts:21-30`）；模板文案一旦在后续版本调整，旧版本保存的默认文案就会被误认成自定义内容，并作为 `prompt_override` 覆盖后端领域预设。反方向上，用户恰好写出与任一模板相同的自定义指令又会被吞掉。更直观的不一致是前端只为 general/academic/technical/literary/casual 配置展示模板（`src/translation/promptPresets.ts:12-19`），后端还拥有 legal、medical 的专属 system prompt（`src-tauri/src/translation/pipeline.rs:695-729`）；选择法律或医学领域时，编辑器回落显示通用模板，实际执行的却是后端专属模板。即使 academic 等领域，前端展示模板也不是后端实际模板全文。用户在这个“非实际 prompt”上改一个字，就会从后端领域预设切换成整段前端 override，行为跳变过大。建议持久化结构化来源，例如 `domain-default + domain + version` 或 `custom + text`，让界面按同一 prompt id 展示有效预设；字符串比对只用于一次性旧数据迁移，不应继续承担运行时真值判断。

统一分段提升了两处视图的一致性，但规则对真实文本仍偏理想化。段落仅按 `/\n{2,}/` 切分（`src/translation/segmentation.ts:11-13`），Windows 的 `\r\n\r\n`、空白行含空格的 `\n  \n` 都不会被识别为段落边界。句子降级又会把任意英文句点当终止符，并在分桶时统一用空格拼回（`src/translation/segmentation.ts:15-21,66-79`），所以小数、缩写、URL 容易被误切，Markdown 换行和 CJK 原始间距也会丢失。现有测试只覆盖纯 LF、规则标点，以及“段落数不等但句子数恰好相等”的样例（`src/translation/translationBehavior.test.ts:54-79`），并没有真正覆盖较多一侧被分桶的核心路径。建议先统一换行并支持空白行，再让切分结果保留原始 separator/offset；至少补齐 CRLF、带空格空行、小数/缩写、无标点长句、两侧句数悬殊和空文本用例。若运行环境允许，可优先使用 `Intl.Segmenter`，保留当前规则作兜底。

流状态桥的接口契约也有歧义。订阅函数注释声称“无活跃流时返回 null”（`src/translation/translationStreamBridge.ts:54-60`），但 `useTranslationStream` 在挂载后的任意 state（包括初始空闲态和完成态）都会发布快照（`src/translation/useTranslationStream.ts:552-562`），只在 key 变化或卸载时清除（`src/translation/useTranslationStream.ts:564-569`）。因此“有快照”并不等于“有活跃流”，`updatedAt` 也不足以区分初始化、进行中、完成、失败或主动清空；同一 key 若出现两个发布者，任一实例卸载还会无条件清掉另一实例的值。当前用 resourceId 分区的方向合理，但应给快照增加 phase/sessionId/revision（或 owner token），清理时校验所有权，并用测试覆盖挂载、开始、完成、取消、切 key、卸载和同 key 多发布者。

语言表和偏好解析还可以进一步形成真正的契约。目前 `code` 仍是普通 `string`、导出数组可变（`src/translation/languages.ts:9-13,23-55`），而 `resolveSessionPrefs` 对持久化输入只做 truthy 回退（`src/translation/sessionPrefs.ts:25-33`）；旧数据或损坏的 localStorage 中若有未知语言、非法 formality，类型声明不会提供运行时保护。建议把清单声明成 readonly `as const` 并派生语言联合类型，对 session/prefs 做白名单归一化，同时增加前端清单与后端映射/i18n key 的契约检查。这样“单一事实来源”才不只是两个前端选择器共用一个数组。

整体上，这次改造在去重、可测试性和一致性上有实质收益，适合保留；优先把提示词来源改为显式状态、修正分段边界，再补流桥生命周期语义。其余类型与契约加固可随后完成。以上为静态对照结论，按要求未执行测试或门禁。

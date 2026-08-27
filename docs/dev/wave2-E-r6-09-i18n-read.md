# Wave2-E R6-09：第 6 轮复核「i18n / nullable / options」

- 轮次：0824 Wave2-E 第 6 轮复核
- 独占范围：`src/features/chat/plugins/blocks/components/AnkiQaFlagBadge.tsx`、
  `src/components/anki/ImageOcclusionOverlay.tsx`、`src-tauri/src/anki_protocol.rs`、
  `src-tauri/src/database/mod.rs`（仅 anki 读路径，且仅在发现漏网 Option 时改动）
- 约束：无新 migration；未跑测试、未 commit（仅 `cargo check` 编译验证，
  与 r5-03 同口径）

## 复核结论总览

| 项 | 结论 |
| --- | --- |
| QA code 本地化（AnkiQaFlagBadge） | ✅ 无缺口，r5-01 落地完整 |
| aria / alt（ImageOcclusionOverlay 等） | ✅ 无缺口，r5-02 落地完整 |
| options 单点（anki_protocol） | ✅ 无缺口，r5-04 落地完整；两处范围外过期注释记录待后续 |
| nullable 读侧（database/mod.rs anki 读路径） | ⚠️ 发现 1 处漏网，本轮已补（见 §5） |

## 1. QA code 本地化复核（AnkiQaFlagBadge.tsx）

- `LINT_LABEL_KEYS` 25 个 code 与后端 `anki_qa_lint.rs` `codes::ALL` 逐一核对：
  完全一致（`codes::ALL` 共 26 项，`legacy_flags_unparsed` 按 r5-01 设计
  故意不收录——其 message 就是待展示的原始历史标记内容）。
- zh-CN / en-US `anki.json` 的 `qaFlags.lint.*` 各 25 条，key 与 code 逐字对应；
  两语言叶子 key parity 由 `localeKeys.test.ts` 的全量叶子对比断言守护
  （`flattenLeafKeys(en) == flattenLeafKeys(zh)`，自动覆盖新增词条）。
- 数字参数抽取（`LINT_NUMERIC_PARAM_NAMES` 9 个 code）与后端 message 中
  数字出现顺序逐条核对（`长度 {n} 小于最小长度 {min}`、
  `front 长度 {n} 超过…阈值 {limit}`、`CJK {cjk}% / Latin {latin}%` 等）：
  顺序契约成立；抽取失败（数字不足）回退原始 message，不渲染带空洞模板。
- 解析顺序 critic → lint code → message 回退 → 旧 rule 名 → 裸 code：
  与 r5-01 文档一致，无回归。
- UI 词条（`qaFlags.cardBadge` / `cardFlagsAria` / `showDetails` /
  `hideDetails` / `severity.*` / `fieldLabel` / `flaggedCards` / `hint`）
  两语言均存在；severity 以图标形状 + 文本双通道传达，徽标为
  button（aria-expanded / aria-controls），无硬编码文案。

**结论：无缺口，未改动。**

## 2. aria / alt 复核（ImageOcclusionOverlay.tsx）

- 遮挡态按钮 `aria-label={t('agent.occlusion.revealBox', {index})}`：
  r5-02 接线在位，两语言词条存在，无硬编码中文残留
  （grep `揭开遮挡区域` 组件零命中）。
- 键盘激活（Enter/Space + preventDefault 防双触发）、stopPropagation
  防外层翻面均在位。
- 已揭开盒仍是无 role 的 div（可见文本 `box.label` 可被读屏以静态文本读出）；
  `agent.occlusion.revealedBox` 词条继续备而未用——r3-09 / r5-02 两轮
  已显式决策"不越权加功能"，本轮维持该决策，不算缺口。
  若后续要接线，需同时给 div 一个可命名 role（generic 元素的
  aria-label 会被读屏忽略），属功能变更而非补漏。

**结论：无缺口，未改动。**

## 3. options 单点复核（anki_protocol.rs）

- `StructuredOutputOptions` 已无 `Deserialize` 派生与自带 wire 契约；
  `from_options_json` 单点复用 `AnkiGenerationOptions` serde 定义后仅投影
  `output_protocol` / `enable_qa_pass` 两字段，解析失败回退默认
  （auto + QA 开）。r5-04 落地完整。
- 三个调用点（`streaming_anki_service.rs` ×2、`anki_critic.rs` ×1）行为核对：
  `from_options_json("{}")`（测试路径）缺必填字段 → 回退默认 →
  `qa_pass_enabled() == true`，与旧语义一致。
- `models.rs` 上两字段为唯一 wire 定义（serde-default +
  skip_serializing_if，无 rename，wire 名保持 snake_case）。

**范围外过期注释（记录，本轮不改非独占文件）：**

1. `models.rs:1333-1335`：`output_protocol` 字段注释仍称
   "wire 契约与 `StructuredOutputOptions` 对任务 options JSON 的
   **二次解析**一致"——二次解析已在 r5-04 删除，现为薄投影；
2. `anki_model_routing.rs:19-23`：模块注释仍引用
   "复用 `StructuredOutputOptions` 的 serde-default 二次解析模式"与
   已废止的"禁改文件"约束（`sidekick_model_routing` 自身的二次解析
   是否收敛到 `AnkiGenerationOptions` 亦属后续轮次决策）；
3. `anki_critic.rs:35-37`：`CriticOptions` 仍是独立二次解析
   （r5-04 已记录，收敛属后续轮次）。

**结论：独占文件内无缺口，未改动 anki_protocol.rs。**

## 4. nullable 读侧复核（database/mod.rs anki 读路径）

对 `anki_cards` 全部读 mapper 逐一核对（r5-03 范围回归）：

- 共享 mapper `map_anki_card_row` / `map_anki_library_record_row` /
  `map_retemplate_card_row`：`front` / `back` 均
  `Option<String> + unwrap_or_default`，三个 JSON 列 Option + 软解析 ✅；
- 内联 mapper：`get_cards_for_task` / `get_cards_for_document` /
  `get_cards_by_ids` / `get_recent_anki_cards` / `list_anki_library_cards` ✅；
- 走共享 mapper 的查询（`get_cards_for_document_for_session`、
  `get_anki_card_with_document`、`get_anki_card_for_session`、
  `get_anki_card_for_owned_document_session`、CAS 更新/删除的
  current 回读、retemplate 双分支、`load_anki_library_card_record`、
  `list_anki_agent_library_cards`）✅；
- 仅取非目标列（COUNT / id / 聚合）的查询不涉及 ✅。

**anki_cards 读路径无漏网。**

## 5. 本轮补的缺口：custom_anki_templates.description（漏网 Option）

**问题**：`custom_anki_templates.description` 列在全部建表语句中均无
NOT NULL 约束（`description TEXT,`），但模型 `CustomAnkiTemplate.description`
是 `String`，两处 mapper 直取 `row.get(2)?`：

- `get_all_custom_templates`（原 :2573）
- `get_custom_template_by_id`（原 :2648）

NULL description 的行会让整条查询以 `InvalidColumnType` 失败——
`get_all_custom_templates` 是全量列取，一行坏数据拖垮整个模板库读取。
NULL 来源真实存在：同步场景测试
（`tests/sync_realistic_scenarios.rs:449`）就以省略 description 的
INSERT 写入模板行；旧库/对端同步同理。

**修复**（与 r5-03 同语义，仅读侧）：两处改为
`row.get::<_, Option<String>>(2)?.unwrap_or_default()`，NULL 兜底空串。
写路径、SQL、函数签名、schema 零改动；无新 migration。

同文件其余 `description: row.get(2)?`（`SubLibrary` 等）属 RAG 分库
读路径，非 anki 范围，未动。模板表其余列（name / version /
preview_* / *_json / created_at 等）schema 均 NOT NULL（含默认值），
`author` / `preview_data_json` 模型侧本就是 Option，无需改。
`user_modified` / `user_deleted` 由 `ALTER … NOT NULL DEFAULT 0`
补列（存量行自动回填），`i64` 直读安全。

## 6. 验证

- `cargo check` 编译通过（40s，仅存量 warning；未跑测试，按本轮约束）。
- 前端两个独占文件零改动，无需验证。

## 7. 问题回复：英文 UI 是否仍直出中文 lint message？

**否——常规路径已不直出；仅设计内的回退路径会出现中文，符合
"应否，除非缺词条回退"的预期。** 具体：

1. 全部 25 个稳定 lint code 在英文界面按 `qaFlags.lint.<code>` 出英文文案
   （数字参数从后端中文 message 抽取插值），中文诊断不落 UI；
2. 会出现后端中文 message 的四条回退路径，全部是刻意设计：
   - `legacy_flags_unparsed`：message 本身就是待展示的原始历史标记内容，
     翻译反而丢信息；
   - 未来新增、词条未收录的 code：回退 message 好过裸 code；
   - 数字参数抽取失败（message 数字少于该 code 声明的参数数）：
     回退 message，不渲染带空洞模板;
   - 旧字段规则条目（`{field, rule, message}` 历史数据）带 message 时
     优先展示 message（r5-01 文档明确的"不变"行为，历史数据保真）。

无需进一步整改；若后端未来给 `LintIssue` 增加结构化 params 字段，
可淘汰数字抽取的软契约，属后续轮次。

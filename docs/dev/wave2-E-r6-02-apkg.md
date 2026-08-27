# 0824 Wave2-E 第 6 轮 · 报告 02：遮挡 APKG 复核（`_` 过滤 / Extra / imageRef / 旧卡）

- 角色：遮挡 APKG 闭环复核（第 6 轮，只读复核：未编译/未测试/未 commit）
- 独占文件：`src-tauri/src/apkg_exporter_service.rs`、
  `src-tauri/src/apkg_importer_service.rs`
- 本轮改动：**零**。四项复核全部通过，文案已是真闭环口径，无需补丁
  （见 §5 文案核查）。
- 依据：`wave2-E-r2-03-apkg.md`（遮挡导出闭环）、
  `wave2-E-r3-01-apkg-extra.md`（Extra 泄漏修正）、
  `wave2-E-r2-09-compat-review.md`（旧卡兼容）。

## 结论速览

| 复核项 | 结论 |
| --- | --- |
| **Extra 是否含 IO 语法** | **否**。转换器不写 Extra；`format_io_rects` 为 `#[allow(dead_code)]` 保留态，无生产调用点；端到端测试断言 `notes.flds` 不含 `image-occlusion:rect` |
| `_` 过滤 | 三道闸原位齐全（入口规范化 retain、两条路径字段表 filter、取值兜底闸） |
| imageRef 媒体 | `occlusion_media_file_name` 解析 basename + `vlm://` 占位拒收；`images` 为空时在 `_occlusion` 删除前补收；缺图容忍进 `missing_media` 报告 |
| 旧卡兼容 | 无 `_occlusion`/无 `_` 键的卡走恒等变换；导入侧仅剥离 3 个可信凭证键，lossless 语义未变 |
| **文案是否还称纯草稿** | **否**。两个独占文件内无「草稿/预览/draft」措辞；注释均为 r2/r3 之后的「可复习标准 Cloze」真闭环口径 |
| IO notetype | 未落地（预期内）：`format_io_rects` docstring 明确保留给后续官方 Image Occlusion notetype 的专用 Occlusion 字段。`create_template_model` 无现成的安全一行加法（IO notetype 需要专用字段表 + Occlusion 模板 + model_type 语义，非一行可达），按任务约束不建巨大新模型 |

## 1. `_` 过滤：三道闸逐一确认

`is_internal_protocol_field(name) = name.starts_with('_') || is_reserved_import_metadata_field(name)`
（13 个 `Anki*` 保留键大小写不敏感），三个消费点全部原位：

1. **导出入口规范化**：`normalize_cards_for_export` 在单模板
   （`export_cards_to_apkg_with_full_template_report`）与多模板
   （`export_multi_template_apkg_report`）两个入口均在媒体克隆**之前**调用；
   先跑 `convert_occlusion_card_for_export` 消费 `_occlusion`，再
   `retain(|k, _| !k.starts_with('_'))` 删全部 `_` 键。刻意不删 `Anki*`
   调度键（`card_sched_restore` 回写复习进度仍要读），它们由字段表层单独拦截；
2. **model 字段表**：两条路径的 extra_keys 追加点均
   `.filter(|key| !is_internal_protocol_field(key))`，`_` 键与 `Anki*`
   键都进不了 model.flds；
3. **取值兜底闸**：`resolve_card_field_value` 通用 `_ =>` 分支开头命中
   `is_internal_protocol_field` 即返回空串，防未来新入口/自定义模板字段名
   绕过前两层。

规范化只作用于按值传入的导出副本，不写回卡片库——`_original_generation`
等库内留痕保留，与 gold 挖掘管线不冲突。

对应测试原位：`internal_protocol_field_predicate_covers_underscore_and_reserved_keys`
（`_occlusion`/`_qa_flags`/`AnkiNoteId`/`ankiivl` 命中，`Subject`/`Extra`/
`Occlusion` 不误伤）、端到端 `occlusion_card_exports_reviewable_cloze_note_with_media`
断言 model.flds 无 `_` 前缀字段且 `notes.flds` 不含 `_occlusion`。

## 2. Extra 无 IO 语法：确认「否」

- `convert_occlusion_card_for_export` 只做媒体补收集 + 可复习 Cloze Text
  两件事，函数尾部注释明示「IO 矩形语法刻意不写入 Extra」；
- `format_io_rects`（`validate_spec` → `format_anki_io_cloze` 委托链）
  带 `#[allow(dead_code)]`，全文件唯一引用在测试；docstring 写明保留给
  后续官方 IO notetype 的专用 Occlusion 字段；
- Extra 取值链路为纯既有语义：有 Extra 键原样导出（
  `occlusion_conversion_leaves_human_extra_untouched` 钉死逐字节不变）；
  无 Extra 键由 `"extra"` 分支回退 `clean_template_placeholders(&card.back)`
  （`occlusion_conversion_builds_cloze_text_media_without_io_extra` 断言
  回退值不含 `image-occlusion:rect`）；
- 端到端泄漏回归闸：解包 apkg 后 `!note_flds.contains("image-occlusion:rect")`
  （notes.flds 含 Extra 列，一并覆盖）。

## 3. imageRef 媒体链路

- `occlusion_media_file_name`：trim 后拒收空串与 `vlm://` 内部占位引用
  （VLM 块不选图时无图降级）；`/tmp/media/diagram.png`、
  `vfs://images/diagram.png` 均取末段 basename，与 `collect_media_entries`
  文件名口径一致（测试
  `occlusion_media_file_name_resolves_basename_and_rejects_placeholders`）；
- 媒体补收集发生在 `_occlusion` 被 retain 删除**之前**（时序注释明确），
  且仅在 `card.images` 为空时补，避免与调用方已解析的媒体路径重复；
- Text 两种来源（沿用 `card.text` / labels 现拼）都确保带
  `<img src="包内文件名">`（文件名过 `escape_occlusion_html_attr`）；
- 缺图容忍：文件缺失/不可读/超 256 MiB 上限时进 `missing_media` +
  `warnings`，note 本身照常导出（端到端测试
  `occlusion_card_with_missing_image_still_exports_text`：
  `exported_media == 0`、`missing_media.len() == 1`、Text 完整保留）；
- 正常路径端到端：`exported_media == 1`，media 清单 `"0" → "diagram.png"`，
  两个 cloze 序号生成 ord 0/1 两张卡（可复习闭环成立）。

## 4. 旧卡兼容

- **导出侧**：无 `_occlusion` 时 `parse_occlusion_field` 返回 `None`，
  转换器直接返回；无 `_` 键时 retain 恒等。测试
  `normalize_keeps_cards_without_occlusion_unchanged` 钉死整卡恒等变换；
- **导入侧**（`apkg_importer_service`）：本身不处理遮挡（预期内——
  官方 IO notetype 的 Occlusion 字段会按普通 extra_field 无损导入），
  仅剥离 3 个可信凭证键（`_original_generation`/`_content_provenance`/
  `_qa_flags`，防外部包伪造本机金标凭证），注释明确「不无差别剥离所有
  `_` 前缀字段，维持 lossless-only 最小侵入」。外部包若带 `_occlusion`
  字段会被无损导入，再导出时走转换器降级为可复习 Cloze（spec 非法则
  `parse_occlusion_field`/`validate_spec` 兜底），无放大风险；
- 调度键往返：导入注入 7 个 `AnkiSched*` 键 + 6 个 `Anki*` 身份键，
  与导出侧 `RESERVED_IMPORT_METADATA_FIELDS`（13 键）严格一致，
  再导出时字段表层过滤、`card_sched_restore` 读取回写，闭环无断点。

## 5. 文案核查：不再称「草稿预览」

全文检索两个独占文件：无「草稿」「预览」「draft」「仅供预览」「不可复习」
任何变体（仅有的 `preview_front/preview_back/preview_data_json` 是
`AnkiCard` 结构体字段名，与文案无关）。注释口径已与真闭环一致：

- 转换器 docstring：「把 `_occlusion` spec 转成**可复习的标准 Cloze note**」；
- `format_io_rects` docstring：「IO 语法届时写入 IO notetype 的专用
  Occlusion 字段」——即 IO overlay 揭底体验仍依赖官方 notetype，
  当前导出产物是可复习 Cloze 而非交互遮罩，这一限制表述准确；
- 导出报告（`ApkgExportReport`）字段注释与 `missing_media` 告警文案
  均为媒体完整性口径，无草稿措辞。

「草稿」措辞存在于 `anki_image_occlusion.rs`/`streaming_anki_service.rs`
（VLM → 生成层的内部 draft marker 管线），那是对内部中间态的准确描述
（草稿 marker 被消费后落成 `_occlusion` + text），非导出文案，且在
本轮独占文件之外，不属于本次补丁范围。

## 6. 遗留

- 官方 Image Occlusion notetype 导出路径仍未落地：`format_io_rects`
  保留待接。落地时需在 `create_template_model` 之外新建 IO 专用 model
  （Occlusion/Image/Header/Back Extra 字段表 + `image-occlusion` 模板），
  不是安全一行加法，须单独排轮；
- 本轮零改动，无新测试断言待验证；既有断言以 r3/r5 轮为准。

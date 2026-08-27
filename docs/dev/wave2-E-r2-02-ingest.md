# Wave2-E 第 2 轮 #02：遮挡草稿入库（text + images 消费）

只写代码与测试源码，未执行任何编译/测试。改动限定在两个独占文件：
`src-tauri/src/anki_image_occlusion.rs` 与 `src-tauri/src/streaming_anki_service.rs`。

## anki_image_occlusion.rs

### 函数改动

- `extract_occlusion_draft_fields`（marker → 卡片字段入口）：
  把 `validated.image_ref` 经新私有 helper `image_ref_basename`（剥离
  `/` 与 `\` 路径段、去空白）后传入
  `build_card_fields(&validated, Some(basename), None)`，使返回的 `text`
  形如 `<img src="diagram.png"><br>{{c1::…}} {{c2::…}}`。
  引用以分隔符结尾（无文件名部分）时得 `None`，`text` 退化为纯 cloze。

- 新增 pub `fn format_anki_io_cloze(spec: &ValidatedOcclusionSpec) -> String`：
  每盒渲染为 Anki 23.10+ 原生 IO 语法
  `{{cN::image-occlusion:rect:left=L:top=T:width=W:height=H}}`，
  L/T/W/H 为归一化坐标 ×100 的百分数（私有 helper `format_io_percent`：
  夹取 [0,100]、最多 4 位小数、去尾零，如 `25.0000` → `25`）。
  多盒无分隔符直接拼接（Anki 官方编辑器惯例）。仅字符串构造，
  导出侧尚未消费。

- 新增 pub `fn occlusion_image_ref_from_fields(extra: &HashMap<String,String>) -> Option<String>`：
  解析 `extra_fields["_occlusion"]` JSON 的 `imageRef`（serde camelCase
  契约），容忍旧数据的 `image_ref` snake_case 键；无字段/坏 JSON/空引用
  返回 `None`。

- 新增私有 helper：`format_io_percent(f32) -> String`、
  `image_ref_basename(&str) -> Option<&str>`。

### 注释改动

- 模块头（第 2 点「草稿字段」与「当前产品边界」段）：改为「生产入库
  （`parse_and_save_card`）现已消费 text 与 images（`_occlusion.imageRef`）；
  导出侧尚未把字段转换为 Anki 官方 IO note，接线打通前不得宣称完全兼容」。
- `build_card_fields` 与 `extract_occlusion_draft_fields` 的 doc 注释同步。

### 新增测试（本文件 `#[cfg(test)] mod tests`，只写不跑）

- `test_format_anki_io_cloze_percent_coordinates`
- `test_format_anki_io_cloze_rounds_to_four_decimals_and_trims_zeros`
- `test_occlusion_image_ref_from_fields_camel_and_snake_case`
- `test_occlusion_image_ref_from_fields_missing_or_invalid`
- `test_extract_occlusion_draft_fields_uses_image_basename_in_text`
- `test_extract_occlusion_draft_fields_basename_handles_backslash_and_plain_ref`

旧测试全部保留（`test_build_draft_marker_from_vlm_spec_binds_real_image` 等
只断言 `_occlusion` 回读，不受 text 增加 `<img>` 影响）。

## streaming_anki_service.rs

### `parse_and_save_card` 改动（原约 2006–2078 行区域）

- occlusion 分支（`if let Some(fields) = occlusion_fields`）：在既有
  extra_fields entry-once 合并与 tag 去重追加之后，新增：若
  `cleaned_extra_fields` 尚无非空 `text` 且 `fields.text` 非空，则写入
  `cleaned_extra_fields["text"]`。模型/模板已产出的 text 不被覆盖；
  front/back 不动。该写入发生在 lint / 原文快照之前，`card.text` 照常从
  `cleaned_extra_fields.get("text")` 取值。

- `AnkiCard.images` 构造：不再无条件 `Vec::new()`。新建 `images` 向量，
  仅当其为空且 `occlusion_image_ref_from_fields(&cleaned_extra_fields)`
  解析到 `imageRef` 时 push 完整引用（`_occlusion` 里保留完整 ref，
  basename 只用于 `<img src>`）。未来上游已填充 images 时不追加覆盖。

未触碰：lossless-only JSON 修复、QA 门控（`qa_pass_enabled` /
`QA_FLAGS_FIELD` 移除时机）、maxCards、`strip_model_special_tokens`
token 剥离算法、错误卡路径（仍 `images: Vec::new()`）。未新增
save_to_library 调用（不变量 6/7）。

### 测试改动

- 扩展 `vlm_occlusion_draft_is_merged_into_extra_fields_without_rewriting_card`
  （旧断言全保留）：新增断言 `card.text == fields.text`、text 以
  `<img src="image-source-1"><br>` 开头且含 `{{c1::`、
  `card.images == ["image-source-1"]`。
- 新增 `plain_card_without_occlusion_keeps_images_empty`：无 `_occlusion`
  的普通卡 images 为空、无 `_occlusion` 字段、text 为 None。
- 新增 `occlusion_draft_does_not_overwrite_model_written_text`：模板声明
  Text 字段、模型 JSON 自带 cloze text，传入 occlusion 草稿后 text 保持
  模型原文（无 `<img>`），`_occlusion` 照常合并、images 仍取 imageRef。

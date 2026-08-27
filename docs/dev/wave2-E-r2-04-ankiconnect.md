# 0824 Wave2-E 第 2 轮 · r2-04：AnkiConnect 遮挡闭环 + 内部协议字段过滤

- 角色：遮挡 AnkiConnect（只写不跑，未编译/未测试/未 commit）
- 独占文件：`src-tauri/src/anki_connect_service.rs`（唯一改动文件）
- 上游锚定：`docs/dev/wave2-E-r1-05-export.md` §2.2 / §3 / §5（缺口 #6、#7）
- 禁改区确认：apkg_*、streaming_*、anki_image_occlusion.rs、critic、gold、前端、缓存均未触碰；
  仅以只读方式调用 `anki_image_occlusion` 的 pub API。

## 契约回顾

1. 可复习主路径 = 标准 Cloze（`<img src="文件名"><br>{{cN::label}}`），不硬依赖 Anki 端
   Image Occlusion 模型，modelName 沿用调用方给定的 Cloze/当前模型。
2. `_` 前缀机器协议键（`_occlusion`/`_qa_flags`/`_original_generation`）一律不发给 Anki，
   杜绝 `normalize_key("_occlusion") == "occlusion"` 撞官方 IO 模型 `Occlusion` 字段的泄漏
   （r1-05 §2.2 泄漏矩阵最后一列）。
3. 13 个 `Anki*` 导入元数据保留键同样不作为字段值来源。
4. 旧卡/无遮挡卡行为不变；调整只作用于本次同步的内存克隆，不写回卡片库、不改缓存。

## 改动明细（均在 `src-tauri/src/anki_connect_service.rs`）

### 1. 内部协议字段谓词（新增，行 151-183）

- `RESERVED_IMPORT_METADATA_FIELDS: [&str; 13]`（行 154-168）：与
  `apkg_exporter_service::RESERVED_IMPORT_METADATA_FIELDS` 名单逐字一致
  （AnkiNoteId…AnkiLapses）。
- `is_reserved_import_metadata_field`（行 170-174）：大小写不敏感匹配。
- `is_internal_protocol_field`（行 182-184）：`_` 前缀 **或** 保留键 → 内部协议字段。

### 2. fields 过滤点：`build_fields_with_model_names`（行 223 起，过滤在行 237）

`lower_extra` 构建时对 `card.extra_fields` 先做
`.filter(|(k, _)| !is_internal_protocol_field(k))`（**行 237**）。
由于 `lower_extra` / `normalized_extra` 是所有模型字段取值的唯一 extra 来源，
一处过滤即覆盖 exact / lower / normalized 三条匹配路径：

- `_occlusion` 不再能通过 normalized 匹配灌进 `Occlusion` 字段；
- `AnkiNoteId` 等保留键即使模型恰好有同名字段也只会得到空串；
- `build_basic_fields` 只写 Front/Back/Text/Extra 四个固定键，本就无泄漏面，未改。

### 3. 遮挡 note 闭环（新增，行 915-1020；接线在行 1385-1386）

- `is_occlusion_card`（行 919）：带 `_occlusion` 键 **或** tag `image-occlusion`。
- `rebuild_occlusion_cloze_text`（行 935）：`parse_occlusion_field` 的 spec →
  `validate_spec`（默认 `OcclusionConfig`）→ `build_card_fields(&validated, image_file_name, None)`
  只取 `.text`，产出标准 Cloze 文本；spec 缺失/校验失败返回 `None`。
- `prepare_occlusion_note`（行 963）：
  1. **Cloze Text**：优先沿用 `card.text`（`build_fields_with_model_names` 的 Cloze 分支
     本就把 `card.text` 写进 `Text` 字段且覆盖 extra 同名键）；仅当发出的 Text 值
     不含 `{{c` 标记时才用 `rebuild_occlusion_cloze_text` 兜底重建
     （`<img>` 的 src 取 `imageRef` 的 basename，与媒体库文件名对齐）；
     重建也失败时写 warning 降级。
  2. **媒体挂接**：`_occlusion.imageRef`（trim 后非空且非 `vlm://` 占位）追加进
     本卡克隆的 `card.images`，随后由**现有** `prepare_note_media`（行 1035，
     picture/audio 附件构造在其 card.images 分支）统一处理——字段已按文件名引用则
     `storeMediaFile` 上传，未引用则作为 `picture` 附件挂到 note；
     读取失败/非本地路径（如 VFS id）按既有逻辑降级为 warnings，不阻断同步。
  3. `_occlusion` JSON 本体绝不发出（源头已被 §2 过滤）；坏 JSON 写 warning 并按普通卡同步。
- 接线点：`add_notes_to_anki_detailed` note 构建循环内、fields 构建之后、
  `prepare_note_media` 之前（**行 1385-1386**）。循环变量改为 `for mut card in cards`。

### 4. 不硬依赖 Image Occlusion 模型

未新增任何 `createModel`/模型切换逻辑；遮挡卡沿用 `card_models` / `note_type`
给定的模型名（预期为 Cloze），本改动只调整字段值与媒体输入。Anki 端没有 IO 模型
时同步照常进行。

## 测试（`#[cfg(test)] mod tests` 追加，只写不跑）

| 测试名 | 断言要点 |
| --- | --- |
| `internal_protocol_field_predicate_covers_underscore_and_reserved_keys` | `_` 前缀与 13 保留键判真（大小写不敏感）；`Occlusion`/`Front` 判假 |
| `occlusion_json_never_leaks_into_emitted_fields` | 模型含 `Occlusion`/`AnkiNoteId` 字段时值均为空串；所有发出值不含 `_occlusion`/`imageRef`；Text 含 `{{c` |
| `occlusion_card_prefers_card_text_and_mounts_image_ref` | Text 原样保留 `card.text`；imageRef 进 `card.images`；零告警 |
| `occlusion_card_without_cloze_text_rebuilds_from_spec` | 旧数据（无 card.text）Text 重建为 `<img src="diagram.png"><br>{{c1::…}} {{c2::…}}`；imageRef 进 images |
| `occlusion_pending_image_ref_is_not_mounted` | `vlm://pending-image` 不挂媒体；Cloze 文本仍重建（无 `<img>`） |
| `occlusion_invalid_spec_degrades_with_warning` | 坏 `_occlusion` JSON：字段零改动、不挂媒体、写 warning |
| `plain_card_regression_prepare_occlusion_note_is_noop` | 普通卡：字段/images/warnings 全部不变；正常 extra 键（`Extra`）照常发出 |

## 红线自查

- 不改缓存：`model_field_names_cache` 及其读写逻辑零改动。
- 不加写回流：`prepare_occlusion_note` 只改同步循环内已 move 的 `AnkiCard` 克隆与
  fields map，无任何 DB/前端写回路径。
- 协议中立：`_occlusion` 仍是库内唯一事实来源，本轮只在导出边界消费+过滤，
  未改其 schema 或写入点。
- APKG 侧（r1-05 缺口 #1-#5、#8、#9）不在本文件独占范围内，留待对应负责人。

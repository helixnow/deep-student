# 0824 Wave2-E 第 6 轮 · r6-03：AnkiConnect 复核（`_` 过滤 / 遮挡 Cloze / `_occlusion` 泄漏 / 旧卡 noop）

- 角色：第 6 轮静态复核（只读复核，未编译/未测试/未 commit）
- 独占文件：`src-tauri/src/anki_connect_service.rs`（本轮零改动）
- 复核对象：r2-04 落地的遮挡闭环 + 内部协议字段过滤（`docs/dev/wave2-E-r2-04-ankiconnect.md`）
- 结论先行：**`_occlusion` → `Occlusion` 字段的泄漏不再存在**；四项复核全部通过，
  未发现需当轮补的问题。

## 1. `_` 过滤复核 —— 通过

- 谓词 `is_internal_protocol_field`（行 182-184）：`_` 前缀 **或** 13 个 `Anki*`
  保留键（`is_reserved_import_metadata_field` 大小写不敏感，行 170-174）。
- 保留键名单（行 154-168）与 `apkg_exporter_service::RESERVED_IMPORT_METADATA_FIELDS`
  （该文件行 42-56）逐字一致，13 项无增减、无拼写漂移；两侧谓词语义也一致
  （均为 `starts_with('_') || is_reserved(...)`）。
- 过滤位置唯一且完备：`card.extra_fields` 进入发往 Anki 字段值的**唯一**入口是
  `build_fields_with_model_names` 的 `lower_extra` 构建（行 234-239），过滤在
  `.filter(|(k, _)| !is_internal_protocol_field(k))`（行 237）。`normalized_extra`
  （行 255-258）由 `lower_extra` 派生，故 exact-lower / normalized / fallback
  （行 294-298）三条取值路径全部继承过滤。
- 全文件 `extra_fields` 其余消费点核对（grep 全量）：行 920 / 975（`is_occlusion_card`
  与坏 spec 告警的**键存在性**只读检查）、行 972（`parse_occlusion_field` 只读解析），
  均不产出字段值；`build_basic_fields`（行 186-221）只写 Front/Back/Text/Extra
  固定键，不读 extra_fields，无泄漏面。
- 误伤面核对：`Occlusion`、`Front` 等正常字段名不带 `_` 前缀、不在保留名单，判假
  （测试 `internal_protocol_field_predicate_covers_underscore_and_reserved_keys` 已锚定）。

## 2. 遮挡 Cloze 复核 —— 通过

`prepare_occlusion_note`（行 963-1020）：

- 识别（`is_occlusion_card`，行 919-926）：`_occlusion` 键（常量取自
  `anki_image_occlusion::OCCLUSION_FIELD`，无字面量漂移）或 tag
  `image-occlusion`（`OCCLUSION_TAG`），与产出侧契约一致。
- Text 优先级正确：仅当模型发出的 `Text` 值（大小写不敏感找键，行 996-999）不含
  `{{c` 标记时才重建；作者态 `card.text` 原样保留
  （测试 `occlusion_card_prefers_card_text_and_mounts_image_ref`）。
- 重建链路（`rebuild_occlusion_cloze_text`，行 935-947）：`parse_occlusion_field`
  → `validate_spec`（默认 `OcclusionConfig`，继承盒数/坐标/IoU/序号全套校验）→
  `build_card_fields(&validated, image_file_name, None)` 只取 `.text`，产出
  `<img src="basename"><br>{{cN::label}}` 标准 Cloze；三个 pub API 签名与
  `anki_image_occlusion.rs`（行 212 / 438 / 485）实际定义核对一致。
- 媒体挂接：`imageRef` trim 后非空且非 `vlm://` 占位（`OCCLUSION_PENDING_IMAGE_SCHEME`，
  与 `parse_occlusion_boxes_from_vlm` 的 `vlm://pending-image` 占位一致）才并入
  `card.images`（幂等去重，行 989-993），后续复用 `prepare_note_media` 既有
  storeMediaFile / picture 附件逻辑；占位引用不挂媒体但 Cloze 仍重建
  （测试 `occlusion_pending_image_ref_is_not_mounted`）。
- 降级路径：坏 `_occlusion` JSON → warning + 按普通卡同步（行 973-982）；重建失败
  → warning「可能在 Anki 中不可复习」（行 1011-1016）。均不阻断同步。

## 3. `_occlusion` 泄漏复核 —— **泄漏不再存在**

逐路径核对 `Note` 的四个出口（fields / tags / picture / audio）：

- **fields**：键集合 = 模型字段名（`build_fields_with_model_names` 按
  `model_field_names` 迭代）或固定四键（`build_basic_fields`），`_occlusion`
  永远不可能成为键；值侧经 §1 过滤，`normalize_key("_occlusion") == "occlusion"`
  的碰撞路径在源头被切断——官方 IO 模型的 `Occlusion` 字段只会得到空串。
  `prepare_occlusion_note` 后续插入的值只有重建 Cloze 文本（label + basename，
  不含 spec JSON）；`prepare_note_media` 只改写媒体引用。
- **tags**：`card.tags` 原样发送，含 `image-occlusion` 语义 tag，属公开契约非泄漏。
- **picture/audio**：附件 filename 取 `card.images` 的 basename，data 为文件
  base64，与 spec JSON 无关。
- 测试锚点：`occlusion_json_never_leaks_into_emitted_fields` 断言模型同时带
  `Occlusion` + `AnkiNoteId` 字段时值均为空串，且**所有**发出值不含
  `imageRef`/`_occlusion` 子串——正是 r1-05 §2.2 泄漏矩阵的针对性回归。

## 4. 旧卡 noop 复核 —— 通过

- 非遮挡卡 `prepare_occlusion_note` 首行早退（行 968-970），fields / images /
  warnings 零改动（测试 `plain_card_regression_prepare_occlusion_note_is_noop`，
  并验证正常 extra 键 `Extra` 照常发出）。
- 突变只作用于同步循环内已 move 的克隆（`for mut card in cards`，行 1368），
  无任何 DB / 前端写回路径；`model_field_names_cache` 读写逻辑零改动。
- 唯一的既有行为收紧：旧导入卡的 `Anki*` 保留键值不再灌进恰好同名的模型字段
  （得到空串）——这是 r2 契约 #3 的**目标行为**，非回归。

## 5. 非缺陷备忘（不当轮补的边缘观察）

1. `media_basename`（行 906-912）用 `std::path::Path`（平台原生分隔符），而
   `anki_image_occlusion::image_ref_basename` 同时切 `/` 与 `\`。同一台机器产出
   与同步的数据分隔符一致，实际无分歧；仅跨平台搬迁库文件的理论场景有差异。
2. `vfs://` 等非本地路径 imageRef：挂入 images 后在 `prepare_note_media` 读文件
   失败降级为 warning（图片在 Anki 侧缺失），r2-04 §3.2 已声明为已知限制。
3. 目标模型无 `Text` 字段（如 Basic）时遮挡卡不重建 Cloze 也不告警，按 front/back
   同步——符合 r2 契约「不硬依赖 IO/Cloze 模型」，可复习性由 front/back 保底。
4. 带前导空白的 extra 键（如 `" _occlusion"`）可绕过 `starts_with('_')`，但库内
   spec 写入点（`build_card_fields`）恒用精确键 `_occlusion`，不存在内部协议
   JSON 经此泄漏的现实路径；此类键只可能承载用户数据，不属协议泄漏面。

## 6. 红线自查

- 本轮为纯复核：独占文件零改动，未触碰 apkg_*、anki_image_occlusion、前端。
- 未运行测试、未编译、未 commit（按本轮指令）。

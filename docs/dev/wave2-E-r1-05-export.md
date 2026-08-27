# 0824 Wave2-E 第 1 轮 · 锚定报告 05：导出侧（APKG / AnkiConnect）内部字段泄漏与遮挡卡闭环缺口

- 角色：锚定员-导出（静态审阅，未编译/未测试）
- 审阅对象：
  - `src-tauri/src/apkg_exporter_service.rs`
  - `src-tauri/src/anki_connect_service.rs`
  - `src-tauri/src/anki_image_occlusion.rs`（`build_card_fields` 及常量）
  - `src-tauri/src/streaming_anki_service.rs`（`_occlusion`/`_qa_flags`/`_original_generation` 写入点）
  - `src/features/chat/anki/index.tsx`（前端透传层）

## 结论速览

| 问题 | 结论 |
| --- | --- |
| `_occlusion` 是否泄漏到导出产物 | **APKG：是（带 template_id 的卡与单模板路径均泄漏）；AnkiConnect：标准模型不泄漏，但存在 `Occlusion` 字段名碰撞泄漏风险** |
| `_qa_flags` / `_original_generation` 是否泄漏 | **APKG：是（同一机制）；AnkiConnect：否（normalize 后无碰撞目标）** |
| 是否打包 `_occlusion.imageRef` 媒体 | **否**（两条导出路径的媒体都只看 `card.images`；遮挡卡入库时 `images` 恒为空） |
| 能否产出可复习 Cloze/IO note | **否**（遮挡 Cloze `Text` 从未写入卡片；无图、无原生 IO note type） |
| 前端透传层是否丢 images/text/_occlusion | **否**（APKG 与 AnkiConnect 两条映射均完整透传） |

---

## 1. 导出过滤名单原文摘录（现有 13 个 Anki* 字段）

`src-tauri/src/apkg_exporter_service.rs:39-62`：

```rust
/// 导入时由 apkg_importer_service 注入的元数据保留字段。
/// 再导出时必须过滤，避免这些键污染 Anki model 字段表。
/// 后 7 个为调度信息键，与 apkg_importer_service::ANKI_SCHED_METADATA_KEYS 一致。
const RESERVED_IMPORT_METADATA_FIELDS: [&str; 13] = [
    "AnkiNoteId",
    "AnkiCardId",
    "AnkiCardOrd",
    "AnkiDeckId",
    "AnkiModelId",
    "AnkiModelName",
    "AnkiSchedType",
    "AnkiQueue",
    "AnkiDue",
    "AnkiIvl",
    "AnkiFactor",
    "AnkiReps",
    "AnkiLapses",
];

fn is_reserved_import_metadata_field(name: &str) -> bool {
    RESERVED_IMPORT_METADATA_FIELDS
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(name))
}
```

该名单在导出侧仅两处消费（生产代码；2363-2367 为测试）：

- **单模板路径** `export_cards_to_apkg_with_full_template_report`，行 1309-1317：

```rust
// 过滤导入时注入的 Anki* 元数据保留字段，避免再导出时污染 model 字段表。
let mut extra_keys: Vec<String> = cards
    .iter()
    .flat_map(|c| c.extra_fields.keys().cloned())
    .filter(|key| !is_reserved_import_metadata_field(key))
    .collect();
```

- **多模板路径** `export_multi_template_apkg`（带 template_id 分组），行 1612-1617：

```rust
// 追加该组卡片的 extra_fields keys（不在 fields 中的），
// 并过滤导入时注入的 Anki* 元数据保留字段
let mut extra_keys: Vec<String> = group_cards.iter()
    .flat_map(|c| c.extra_fields.keys().cloned())
    .filter(|key| !is_reserved_import_metadata_field(key))
    .collect();
```

**关键事实：名单只覆盖 13 个 `Anki*` 前缀键，对 `_` 前缀的机器协议字段（`_occlusion`、`_qa_flags`、`_original_generation`）零过滤。** 三个内部字段的定义与写入点：

| 字段 | 常量定义 | 写入点（入库） |
| --- | --- | --- |
| `_occlusion` | `anki_image_occlusion.rs:41`（`OCCLUSION_FIELD`） | `build_card_fields`（`anki_image_occlusion.rs:459-462`）→ `streaming_anki_service.rs:2008-2013` merge 进 `extra_fields` |
| `_qa_flags` | `streaming_anki_service.rs:39`（`QA_FLAGS_FIELD`） | `anki_qa_lint::merge_flags`（`streaming_anki_service.rs:2045`；qa_pass 关闭时 2050 移除） |
| `_original_generation` | `anki_gold_set.rs:42`（`ORIGINAL_GENERATION_FIELD`） | `anki_gold_set::insert_original_generation_once`（`streaming_anki_service.rs:2057`） |

## 2. 泄漏矩阵（字段 × APKG × AnkiConnect）

### 2.1 APKG 泄漏机制

extra_fields 键先被追加进 model 字段表（上节两处），然后 `resolve_card_field_value`（`apkg_exporter_service.rs:376-462`）按字段名从 `extra_fields` 大小写不敏感取值；对 JSON 值还**特意跳过清洗**（455-459）：

```rust
// 保留原始值，对 JSON 数组/对象跳过 sanitize，否则做占位符清理
if raw_value.trim_start().starts_with('{') || raw_value.trim_start().starts_with('[') {
    raw_value
}
```

即 `_occlusion` 的 spec JSON、`_qa_flags` 的 lint JSON、`_original_generation` 的快照 JSON 会**原样成为 Anki note 字段值**，导入 Anki 后在编辑器可见。

例外：多模板路径中**无 template_id 的卡片**走 Basic 兜底（行 1789-1800，字段固定 `["Front","Back"]`），`_` 字段不泄漏但也整体丢弃。

### 2.2 AnkiConnect 泄漏机制

`build_fields_with_model_names`（`anki_connect_service.rs:188-266`）只为 **Anki 侧模型已有的字段名**生成值，模型字段表来自 Anki 本体或 `create_model_from_template`（`anki_connect_service.rs:689-716`，仅用 `template.fields`，不追加 extra_fields 键）。因此标准 Basic/Cloze 模型下 `_` 字段不会出现在 note 里。

但存在**碰撞风险**：`normalize_key`（145-149）会剥掉非字母数字字符，`_occlusion` → `occlusion`。若目标模型恰好有名为 `Occlusion` 的字段（**Anki 23.10+ 原生 Image Occlusion note type 正是如此**），256-260 的 normalized 匹配会把内部 spec JSON 灌进该字段——语义完全错误（原生 IO 的 `Occlusion` 字段期望 cloze 包裹的 SVG 矩形语法）。`_qa_flags`→`qaflags`、`_original_generation`→`originalgeneration` 无现实碰撞目标。

### 2.3 矩阵

| 字段 | APKG 单模板路径（1292-1322） | APKG 多模板·有 template_id（1609-1624） | APKG 多模板·无 template_id | AnkiConnect 标准模型 | AnkiConnect 模型含 "Occlusion" 字段 |
| --- | --- | --- | --- | --- | --- |
| `_occlusion` | **泄漏**（成为 model 字段+note 值） | **泄漏** | 不泄漏（连同数据整体丢弃） | 不泄漏（数据丢弃） | **泄漏**（normalize 碰撞，灌错语法） |
| `_qa_flags` | **泄漏** | **泄漏** | 不泄漏 | 不泄漏 | 不泄漏 |
| `_original_generation` | **泄漏** | **泄漏** | 不泄漏 | 不泄漏 | 不泄漏 |

## 3. `_occlusion` 消费能力与媒体打包

### 3.1 两条导出路径都不认识 `_occlusion`

grep 证明：`apkg_exporter_service.rs` 与 `anki_connect_service.rs` **全文零次出现** `_occlusion`/`OCCLUSION_FIELD`。它只被当作普通 extra_fields 键透传（APKG）或丢弃（AnkiConnect），没有任何专用转换器。`parse_occlusion_field`（`anki_image_occlusion.rs:476-479`）提供了回读入口，但导出侧无人调用。

### 3.2 imageRef 媒体不打包

- APKG 媒体收集 `collect_media_entries`（`apkg_exporter_service.rs:1112-1168`）只遍历 `card.images`；
- AnkiConnect 媒体 `prepare_note_media`（`anki_connect_service.rs:881-1076`）同样只处理字段内联引用与 `card.images`；
- 而遮挡草稿卡入库时 `images: Vec::new()`（`streaming_anki_service.rs:2078`），`_occlusion.imageRef`（VFS id/本地路径，见 `anki_image_occlusion.rs:108-117`）从未被解析进 `card.images`。

结论：**imageRef 指向的图片在两条导出路径都不进包**。

### 3.3 不能产出可复习 Cloze/IO note

`build_card_fields`（`anki_image_occlusion.rs:429-472`）确实生成了含 `{{cN::label}}` 的候选 `Text` 与 `_occlusion` spec，但生产接线点 `extract_occlusion_draft_fields`（708-717）调用 `build_card_fields(&validated, None, None)`——`image_file_name=None`，Text 里没有 `<img>`；且流式合并点（`streaming_anki_service.rs:2006-2019`）**只 merge extra_fields 和 tag，不写 `fields.text`**（注释明言"不改写模型生成的 front/back/text"）。于是导出的 note：

1. 没有遮挡 Cloze Text（候选 `OcclusionCardFields.text` 在 merge 时被丢弃）；
2. 没有图片（3.2）；
3. 没有原生 IO note type（导出侧只有 Basic/Cloze/自定义模板三类 model）。

模块头注释（`anki_image_occlusion.rs:25-30`）也自证："生产管线目前没有把候选 `Text`、图片媒体和 `_occlusion` 转换为 APKG/AnkiConnect 可复习 note"。

## 4. 前端透传层核查（`src/features/chat/anki/index.tsx`）

**不丢字段。** 两条映射均完整携带 `text`、`images`、`extra_fields`（含 `_occlusion`）：

- APKG 路径 `exportCardsAsApkg`，行 305-320：`text: card.text ?? null`、`images: card.images ?? []`、`extra_fields: card.extra_fields ?? card.fields ?? {}`；
- AnkiConnect 路径 `importCardsViaAnkiConnect`，行 392-406：同上三键完整。

`validateCardsForExport`/`filterExportableCards`（`src/components/anki/cardforge/engines/exportNormalize.ts:58-159`）只按卡片粒度过滤 error 卡，不改字段内容。**即前端把 `_occlusion` 原样递给后端，泄漏/丢弃全部发生在 Rust 导出层。**

## 5. 第 2 轮真闭环：必改函数、note type 选择、媒体解析点

### 5.1 闭环缺口函数表

| # | 文件 | 函数/位置 | 必改内容 |
| --- | --- | --- | --- |
| 1 | `apkg_exporter_service.rs` | `RESERVED_IMPORT_METADATA_FIELDS` / `is_reserved_import_metadata_field`（39-62） | 扩为统一规范化谓词：`_` 前缀一律过滤（见 §5.3） |
| 2 | `apkg_exporter_service.rs` | `export_cards_to_apkg_with_full_template_report` extra_keys 追加（1309-1322） | 换用统一谓词；对遮挡卡先经专用转换器改写 Text/images 再进字段循环 |
| 3 | `apkg_exporter_service.rs` | `export_multi_template_apkg` extra_keys 追加（1612-1624）与 `insert_note` 闭包（1711-1762） | 同上；遮挡卡组需选 Cloze/IO model 而非模板原样 |
| 4 | `apkg_exporter_service.rs` | `resolve_card_field_value`（376-462） | 兜底分支拒绝 `_` 前缀键（防御第二道闸） |
| 5 | `apkg_exporter_service.rs` | `collect_media_entries`(1112-1168) 或其调用前 | 新增 `_occlusion.imageRef` → 媒体文件名解析（见 §5.4），把解析结果并入媒体清单 |
| 6 | `anki_connect_service.rs` | `build_fields_with_model_names`（188-266）+ `normalize_key`（145-149） | lower_extra/normalized_extra 构建时剔除 `_` 前缀键，杜绝 `Occlusion` 碰撞；遮挡数据仅由专用转换器供给 |
| 7 | `anki_connect_service.rs` | `add_notes_to_anki_detailed` 的 note 构建循环（1219-1257） | 遮挡卡走专用转换：注入 Cloze Text（或原生 IO 字段）+ `picture` 附件 |
| 8 | `streaming_anki_service.rs` | occlusion merge 点（2006-2019） | （前置条件）把 `OcclusionCardFields.text` 落到 `card.text`/`extra_fields["text"]`、imageRef 落到 `card.images`，否则导出侧无米下锅 |
| 9 | `anki_image_occlusion.rs` | `extract_occlusion_draft_fields`（708-717） | 生产调用需传真实 `image_file_name`（或延后到导出转换器阶段再拼 `<img>`） |

### 5.2 note type 选择：Cloze（推荐第 2 轮）vs 原生 IO

- **推荐 Cloze**：导出侧已有完整 Cloze 基建——cloze model 构造（1342-1349）、`cloze_card_ords`、`contains_cloze_marker`；`build_card_fields` 产出的就是 `<img src="..."><br>{{c1::...}}` Cloze Text。改造面最小：Text + Extra + 媒体即可复习（"看图回忆标签"语义，遮罩视觉留给前端原生渲染）。
- **原生 IO（Anki 23.10+ `Image Occlusion`）**：真遮挡体验，但需要构造 `Occlusion`（cloze 包裹的矩形语法）/`Image`/`Header`/`Back Extra`/`Comments` 字段与专用 notetype JSON，且旧版 Anki/AnkiDroid 兼容性差、APKG 侧需写新 model 结构。建议作为第 3 轮增强，由 `_occlusion` 的归一化盒（`to_pixel_boxes` 已具备像素换算）生成矩形语法。

### 5.3 P1-1 统一规范化层设计

**原则：所有 `_` 前缀键默认是机器协议字段，一律不得出现在导出 note 字段表；确需导出的信息由专用转换器消费后移除原键。**

```rust
// 建议落点：apkg_exporter_service.rs 顶部（或独立 anki_export_normalize.rs），
// AnkiConnect 侧复用同一谓词
fn is_internal_protocol_field(name: &str) -> bool {
    name.starts_with('_') || is_reserved_import_metadata_field(name)
}
```

插入点（按数据流顺序）：

1. **导出入口规范化（新增，唯一权威层）**：`export_cards_to_apkg_with_full_template_report` / `export_multi_template_apkg` / `add_notes_to_anki_detailed` 三个入口在拿到 `Vec<AnkiCard>` 后立即做 `normalize_cards_for_export`：
   - 先跑专用转换器：`parse_occlusion_field(&card.extra_fields)` 命中 → 生成 Cloze Text（含 `<img>`）、把 imageRef 解析出的路径 push 进 `card.images`、可选生成 IO 字段；
   - 再 `extra_fields.retain(|k, _| !is_internal_protocol_field(k))`，`_occlusion`/`_qa_flags`/`_original_generation` 全部移除。
2. **model 字段表构建**（1309-1322、1612-1624）：过滤谓词从 `is_reserved_import_metadata_field` 换成 `is_internal_protocol_field`（双保险）。
3. **字段取值兜底**（`resolve_card_field_value:435-460`、`build_fields_with_model_names:197-220`）：`_` 前缀键直接跳过（第三道闸，防未来新入口绕过第 1 层）。

注意：规范化只作用于**导出流水线内的克隆数据**，不得写回卡片库——`_original_generation` 是 critic 修正对挖掘的数据源（`anki_critic.rs:168,771`），库内必须保留。

### 5.4 媒体解析点

| 阶段 | 位置 | 动作 |
| --- | --- | --- |
| imageRef → 本地路径 | 新增于导出入口规范化层（§5.3 第 1 步） | VFS id 经资源服务解析为绝对路径；本地路径直接校验存在性；`vlm://pending-image` 占位引用视为无图降级 |
| 路径 → APKG 包内文件名 | `collect_media_entries`（1112-1168） | 现有逻辑照用（按文件名去重/缺失容忍），前提是路径已进 `card.images`；`<img src>` 用 `build_card_fields` 的 `image_file_name` 参数对齐包内名 |
| 路径 → AnkiConnect | `prepare_note_media`（881-1076） | 现有 storeMediaFile/picture 附件逻辑照用，同样前提是 `card.images` 已填充 |

## 6. 禁改区确认

本轮为纯静态审阅，未改动任何产品代码；`coordinator.rs`、tool_loop、缓存、移动 chrome、workbench 壳均未触碰。

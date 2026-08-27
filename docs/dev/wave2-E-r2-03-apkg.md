# 0824 Wave2-E 第 2 轮 · 报告 03：遮挡 APKG 真闭环 + 内部协议字段过滤 + 导入伪造凭证剥离

- 角色：遮挡 APKG（第 2 轮实现，只写不跑：未编译/未测试/未 commit）
- 独占文件（本轮实际改动）：
  - `src-tauri/src/apkg_exporter_service.rs`（谓词 + 遮挡转换器 + 媒体补收集 + 测试）
  - `src-tauri/src/apkg_importer_service.rs`（仅伪造协议字段剥离 + 测试，无重构）
- 依据：`docs/dev/wave2-E-r1-05-export.md`（锚定报告 §5 闭环缺口表）
- 禁改区确认：未触碰 `streaming_anki_service.rs` / `anki_image_occlusion.rs` /
  `anki_connect_service.rs` / `anki_critic.rs` / `anki_gold_set.rs` / coordinator。

## 结论速览

| 项 | 结论 |
| --- | --- |
| 统一过滤谓词 | `is_internal_protocol_field(name)`，落点 `apkg_exporter_service.rs`（`is_reserved_import_metadata_field` 之后）：`_` 前缀一律命中 + 既有 13 个 `Anki*` 保留键 |
| `_occlusion` 泄漏 | 已堵死（三道闸：入口规范化 retain、两条路径 extra_keys 过滤、`resolve_card_field_value` 兜底拒绝） |
| 可复习主路径 | 标准 Cloze：Text = `<img src="包内文件名"><br>{{cN::label}}`；IO 矩形语法（`format_anki_io_cloze`，百分数公式）追加进 Extra |
| `_occlusion.imageRef` 媒体 | 认。`card.images` 为空时补收集 imageRef，`collect_media_entries` 既有逻辑解析为包内文件名；缺文件走 missing 报告，note 照常导出 |
| 导入伪造 gold | 已堵。`map_card` 剥离外部包携带的 `_original_generation` / `_content_provenance` / `_qa_flags`（大小写不敏感） |
| 自定义 IO notetype | 未做（本轮 Cloze 即可，见 §5） |

## 1. 统一谓词与三道闸（导出侧）

```rust
fn is_internal_protocol_field(name: &str) -> bool {
    name.starts_with('_') || is_reserved_import_metadata_field(name)
}
```

按数据流顺序的三道闸（对应 r1-05 §5.3 设计）：

1. **导出入口规范化（唯一权威层）**：`normalize_cards_for_export(&mut cards)`，
   在 `export_cards_to_apkg_with_full_template_report` 与
   `export_multi_template_apkg_report` 两个入口、**媒体克隆之前**调用。
   每张卡先跑遮挡转换器（§2），然后
   `extra_fields.retain(|k, _| !k.starts_with('_'))` 删除全部 `_` 前缀键
   （`_occlusion` / `_qa_flags` / `_original_generation` / `_content_provenance` 等）。
   注意 retain 只删 `_` 键、**不删 `Anki*` 调度键**——`card_sched_restore`
   仍要读它们回写复习进度，字段表层由谓词单独兜住。
   规范化只作用于导出流水线内的数据副本（cards 已按值传入），不写回卡片库，
   库内 `_original_generation`（critic 修正对数据源）不受影响。
2. **model 字段表构建**：单模板路径与多模板路径的 extra_keys 追加点，过滤器从
   `is_reserved_import_metadata_field` 换成 `is_internal_protocol_field`。
3. **字段取值兜底**：`resolve_card_field_value` 的通用 `_ =>` 分支开头，
   `is_internal_protocol_field(field_name)` 命中直接返回空串，防未来新入口
   或自定义模板显式声明协议字段名绕过前两层。

红线核对：只过滤 `_` 前缀与既有 13 个 `Anki*` 键，用户可见非 `_` 字段
（含名为 `Occlusion`、`Extra`、`Subject` 等）一律保留，测试有断言。

## 2. 遮挡转换器（导出组卡前）

`convert_occlusion_card_for_export(card)`（由 `normalize_cards_for_export` 调用）：

1. **parse**：`crate::anki_image_occlusion::parse_occlusion_field(&card.extra_fields)`
   （已 pub 的回读入口），返回 `None`（无 `_occlusion` 或坏 JSON）则原样返回——
   旧卡行为零变化。
2. **Cloze Text**：
   - `card.text` 已有内容 → 沿用；
   - 否则用盒 labels 现拼 `{{cN::label}}`（空格连接），与
     `anki_image_occlusion::build_card_fields` 的既有协议一致，不发明新协议；
     缺失/非法 cloze 序号按出现顺序补 1-based；空标签补 `区域 N`；
     `}}`→`} }`、`::`→`：：` 转义与该模块 `escape_cloze_label` 同口径
     （该函数未 pub，本地私有复刻，未改别人的文件）。
   - 两种来源都确保带图：Text 不含 `<img` 且 imageRef 可解析出文件名时，
     前置 `<img src="包内文件名"><br>`。
3. **IO 语法**：并行轮已在 `anki_image_occlusion.rs` 落地
   `pub fn format_anki_io_cloze(&ValidatedOcclusionSpec)`（官方 IO rect
   百分数公式，×100、最多 4 位小数去尾零、多盒直接拼接），按任务预案
   **直接调用**。本文件保留一个薄的私有包装
   `fn format_io_rects(spec: &OcclusionSpec) -> String`：先过
   `validate_spec`（该函数只接受 ValidatedOcclusionSpec），非法 spec
   （外部伪造/退化数据）返回空串——不产 IO 语法、不阻断导出：

   ```text
   {{c1::image-occlusion:rect:left=10:top=20:width=30:height=15}}
   ```

   结果追加进 `Extra`（不覆盖已有 Extra；无 Extra 键时把 `card.back` 并入，
   维持 Cloze Extra 回退 back 的既有语义）。可复习主路径不依赖它——它是
   揭底后可见的 IO 语法留档 / 第 3 轮原生 IO notetype 转换的输入。
4. **删除**：转换后 `_occlusion` 与其余 `_` 键统一由规范化层 retain 删除，
   不进 model 字段表、不进 note 字段值。

## 3. 媒体：imageRef 补收集

`collect_media_entries` 本体**未改**（保持独占文件内最小侵入）；补收集发生在
转换器里、`_occlusion` 删除之前：

- `card.images` 为空且 `occlusion_media_file_name(imageRef)` 可解析出文件名时，
  把 imageRef 原样 push 进 `card.images`；
- `occlusion_media_file_name`：取路径末段 basename（`vfs://images/diagram.png`
  → `diagram.png`，与 `collect_media_entries` 的包内文件名口径一致）；
  空引用与 `vlm://` 占位（VLM 块不选图）返回 `None`，视为无图降级；
- 缺文件/不可读/vfs id 无法在本层解引用：`collect_media_entries` 既有的
  「打开失败 → missing 清单 + 继续导出」语义兜底，不 panic，note（Text 仍在）
  照常导出，测试 `occlusion_card_with_missing_image_still_exports_text` 固化。

## 4. 导入侧：堵伪造 gold（最小改动）

`apkg_importer_service.rs` 新增：

```rust
const UNTRUSTED_IMPORT_PROTOCOL_FIELDS: [&str; 3] =
    ["_original_generation", "_content_provenance", "_qa_flags"];
```

`map_card` 的字段循环里，模型字段名命中该名单（`eq_ignore_ascii_case`）时
`continue` 剥离并 `warn!` 留痕。理由：这三个键在本地管线代表**可信凭证**——
`_original_generation` 是 gold 挖掘的"本机生成快照"（`anki_gold_set` /
`anki_critic` 消费），外部包若伪造即可让外部内容直接混入用户金标。
选择"剥离"而非"打 import provenance"：导出侧现在从不写出 `_` 前缀字段，
正常往返 APKG 不可能合法携带它们，剥离零损失且改动最小。

不剥离的：`_occlusion` 等其余 `_` 键不在可信凭证名单（无 gold/QA 语义，
解析侧另有 `validate_spec` 把关），且实际导入路径里模型字段名极少以 `_`
开头，维持 lossless-only 最小侵入；`Anki*` 元数据注入、正常媒体/字段导入
路径均未动。

## 5. 自定义 Image Occlusion notetype 评估（未做）

导出器确有自定义 model 构造能力（`create_template_model` 支持任意字段 +
cloze 型），但**路由无安全加法路径**：单模板路径整次导出只建一个 model
（IO 卡与普通卡混批时无法分流）；多模板路径按 `template_id` 分组建 model，
而遮挡卡没有专属 template_id——接原生 IO 五字段 notetype
（Occlusion/Image/Header/Back Extra/Comments）需要给两条路径加"按卡片特征
分流到额外 model"的新机制，属于大改模型表/组卡逻辑。按任务预案
（"没有安全路径就不要大改模型表，Cloze 即可"）与 r1-05 §5.2 推荐，本轮走
标准 Cloze 主路径；`format_anki_io_cloze` 的矩形语法已进 Extra，为第 3 轮
原生 IO notetype 分流备好数据。

## 6. 新增测试（`#[cfg(test)]`，只写未跑）

`apkg_exporter_service.rs`：

| 测试 | 断言 |
| --- | --- |
| `internal_protocol_field_predicate_covers_underscore_and_reserved_keys` | `_` 键与 `Anki*` 键命中；`Subject`/`Extra`/`Occlusion` 不命中 |
| `resolve_card_field_value_refuses_internal_protocol_fields` | 兜底闸门返回空串，用户字段不受影响 |
| `format_io_rects_delegates_to_validated_anki_io_syntax` | 合法 spec 输出官方 IO rect 语法（与 `format_anki_io_cloze` 契约一致）；非法 spec 返回空串不阻断 |
| `occlusion_media_file_name_resolves_basename_and_rejects_placeholders` | basename 解析、`vlm://` 与空引用降级 |
| `normalize_keeps_cards_without_occlusion_unchanged` | 旧卡（无 `_occlusion`）规范化为恒等变换 |
| `normalize_strips_underscore_fields_but_keeps_anki_sched_keys` | `_` 键全删、`AnkiIvl` 保留 |
| `occlusion_conversion_builds_cloze_text_media_and_io_extra` | Text=img+cloze、imageRef 补进 images、Extra 含 IO 语法且保留 back、`_occlusion` 已删 |
| `occlusion_conversion_prefers_existing_card_text` | card.text 优先并补 `<img>`（包内文件名） |
| `internal_protocol_fields_do_not_enter_model_field_table`（e2e） | model flds 无 `_` 键、note flds 无协议 JSON、Subject 保留、字段数对齐 |
| `occlusion_card_exports_reviewable_cloze_note_with_media`（e2e） | note 含 img+c1+c2、两张 cloze 卡（ords [0,1]）、媒体清单含 diagram.png、exported_media=1 |
| `occlusion_card_with_missing_image_still_exports_text`（e2e） | 缺图不失败、missing_media=1、Text 完整 |

`apkg_importer_service.rs`：

| 测试 | 断言 |
| --- | --- |
| `import_strips_forged_internal_protocol_fields` | 三个伪造键剥离（含大小写变体谓词）、`Subject`/`AnkiNoteId`/front/back 正常 |

## 7. 风险与后续

- AnkiConnect 路径（`anki_connect_service.rs`）不在本轮独占文件内，未动；
  并行角色已在该文件落地同名同语义的私有 `is_internal_protocol_field`
  （工作区可见），两侧口径一致、无符号冲突。
- 遮挡卡走多模板路径且模板为 Basic 时，Text 不被 Basic 模板渲染（r1-05 已知
  限制）；媒体与字段过滤仍生效，front/back 照常。
- `vfs://` imageRef 在导出层无法解引用为磁盘路径（本层无资源服务依赖），会
  进入 missing_media 报告——上游（streaming 侧，非本轮文件）落真实路径后
  自动闭环。

# 0824 Wave2-E 第 3 轮 · 报告 01：APKG Extra 字段泄漏修正（IO 语法不进 Extra）

- 角色：字段泄漏/Extra 修正（第 3 轮，只写不跑：未编译/未测试/未 commit）
- 独占文件（本轮实际改动）：`src-tauri/src/apkg_exporter_service.rs`
- 依据：`docs/dev/wave2-E-r2-03-apkg.md`（r2 报告 §2/§3；其中「IO 矩形语法
  追加进 Extra」正是本轮要撤销的行为）
- 禁改区确认：未触碰任何其它 rs/ts 文件。
  `src-tauri/tests/occlusion_export_roundtrip.rs` 检查过：它只测
  `format_anki_io_cloze` 生产函数本身与 `_` 键过滤，不断言「Extra 含 IO 语法」，
  与本轮改动无冲突，无需更新。

## 结论速览

| 项 | 结论 |
| --- | --- |
| **Extra 是否还含 IO 语法** | **否**。默认 Cloze 导出路径已彻底不写入 `image-occlusion:rect`，单测 + 端到端 apkg 断言双保险 |
| Extra 语义 | 只保留人类补充内容；无 Extra 键时由 `resolve_card_field_value` 的 `"extra"` 分支回退 `card.back`（既有语义，未改） |
| `format_io_rects` / `format_anki_io_cloze` | 保留（加 `#[allow(dead_code)]` + 注释），供后续官方 Image Occlusion notetype 专用 Occlusion 字段使用，本轮不消费 |
| `is_internal_protocol_field` 三道闸 | 全部原位（见 §3），本轮零改动 |
| 旧测试 | 已按新契约更新（见 §4） |

## 1. 问题：揭底看见机器语法

r2 的遮挡转换器 `convert_occlusion_card_for_export` 会把
`format_io_rects(&spec)` 的结果（形如
`{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1}}`）追加进
Extra 字段：已有 Extra 则 `<br>` 拼接，无 Extra 则并入 `card.back` 后插入
`Extra` 键。

默认 Cloze notetype 的答案模板会把 Extra 原样渲染在揭底区，用户翻卡后
会看到一串 IO 坐标乱码。这是机器协议内容泄漏进用户可见字段——与
`_occlusion` JSON 泄漏同性质，只是换了个出口。

## 2. 修正：转换器不再触碰 Extra

`convert_occlusion_card_for_export` 删除整个「IO 矩形语法进 Extra」块
（原 r2 版的 `format_io_rects` 调用 + `existing_extra_key` 匹配 + 插键逻辑）。
现在转换器只做三件事：

1. 媒体补收集（`card.images` 为空时补 imageRef）；
2. 可复习 Cloze Text（`card.text` 优先，否则 labels 现拼，均补 `<img>`）；
3. （不再有第三件——函数尾部留注释说明 IO 语法刻意不写 Extra。）

Extra 的取值链路回到纯既有语义：

- 用户已有 Extra（人类补充）→ 原样导出，转换器不改写不追加；
- 无 Extra 键 → `resolve_card_field_value` 的 `"extra"` 分支回退
  `clean_template_placeholders(&card.back)`。

r2 版在「无 Extra 键」分支会 `insert("Extra", back + "<br>" + io_rects)`；
删掉后不插键，回退语义由取值层天然承接，行为差异仅是少了 IO 尾巴。

`format_io_rects` 本体保留（`validate_spec` → `format_anki_io_cloze`
委托链不变），加 `#[allow(dead_code)]`（生产侧暂无调用点，测试仍直接
测它）并在 docstring 注明：留给后续官方 IO notetype 导出路径，届时写入
IO notetype 的专用 Occlusion 字段（Anki 23.10+ 原生 IO note 结构），
而不是用户可见的 Extra。

## 3. 三道闸复核（本轮零改动，仅确认）

`is_internal_protocol_field(name) = name.starts_with('_') || is_reserved_import_metadata_field(name)` 原位，三个消费点齐全：

1. **导出入口规范化**：`normalize_cards_for_export` 先跑遮挡转换器，再
   `extra_fields.retain(|k, _| !k.starts_with('_'))` 删全部 `_` 键
   （不删 `Anki*` 调度键，`card_sched_restore` 仍要读）；
2. **model 字段表**：单模板与多模板两条路径的 extra_keys 追加点均
   `.filter(|key| !is_internal_protocol_field(key))`；
3. **字段取值兜底**：`resolve_card_field_value` 通用 `_ =>` 分支开头命中
   即返回空串。

## 4. 测试更新与补测

| 测试 | 变化 |
| --- | --- |
| `occlusion_conversion_builds_cloze_text_media_and_io_extra` | 重命名为 `occlusion_conversion_builds_cloze_text_media_without_io_extra`。删除「Extra 含 IO rect」断言，改为：转换后无 `Extra` 键（大小写不敏感）、`resolve_card_field_value(card, "Extra") == "揭底说明"`（back 回退）、且不含 `image-occlusion:rect` |
| `occlusion_conversion_leaves_human_extra_untouched`（新增） | 用户已有 Extra「人工笔记：注意瓣膜方向」+ `_occlusion`：规范化后 Extra 逐字节不变，取值不含 IO 语法 |
| `occlusion_card_exports_reviewable_cloze_note_with_media`（补断言） | 端到端泄漏回归闸：解包 apkg 后 `notes.flds`（含 Extra 列）断言 `!note_flds.contains("image-occlusion:rect")` |
| `format_io_rects_delegates_to_validated_anki_io_syntax` | 不变——继续钉死 IO 语法构造器本身的公式（0–1 归一化、前导点、去尾零），该函数保留供后续 notetype |
| `internal_protocol_field_predicate_covers_underscore_and_reserved_keys` 等三道闸测试 | 不变，原位通过复核 |

## 5. 遗留

- 后续如落地官方 IO notetype 导出（`format_io_rects` 的真正消费点），
  IO 语法写入该 notetype 的 Occlusion 字段，Extra 继续只放人类内容；
- 本轮未编译未测试（任务红线），上述测试断言待 CI/后续轮次执行验证。

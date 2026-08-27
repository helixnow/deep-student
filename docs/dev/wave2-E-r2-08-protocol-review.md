# 0824 Wave2-E 第 2 轮 · 08 审阅员-协议复核报告

- 角色：Wave2-E r2「审阅员-协议」（静态复核，未编译 / 未测试 / 未改产品代码 / 未 commit）
- 复核对象：`docs/dev/wave2-E-r2-occlusion-contract.md`（唯一契约）vs 本轮工作区 diff
  （`streaming_anki_service.rs` / `anki_image_occlusion.rs` / `apkg_exporter_service.rs` /
  `anki_connect_service.rs` / `anki_gold_set.rs` / `anki_critic.rs` /
  `apkg_importer_service.rs` / `chatanki_executor.rs`）
- 参照事实：Anki 官方 `to-cloze.ts` / `imageocclusion.rs` 的 on-disk 语法为
  `{{c1::image-occlusion:rect:left=.1:top=.23:width=.4:height=.5}}`，坐标是
  **0–1 归一化小数**，不是百分数。

## 0. 总结论

- **必须翻案：4 条**（§3）。核心是 IO 坐标写成百分数、IO 语法被塞进默认导出的
  Extra 字段而五字段模型未创建、入库违约提前拼 `<img>`、导出层缺 imageRef 解析
  导致生产引用形态媒体必然缺失。
- **lossless-only 未被放宽**（§4 复核 1/5）：入库截断拒收未动，导出规范化只作用
  于克隆不写回库，导入侧仅剥离 3 个伪造凭证键且明示不无差别剥 `_` 前缀。
- `anki_protocol.rs` 本轮**零 diff**，协议中立保持；enableQaPass / FSRS / maxCards
  均未被触碰（§4 复核 2）。

---

## 1. 通过项

| # | 契约条款 | 实现证据 | 判定 |
| --- | --- | --- | --- |
| P1 | §2.1 text or_insert：模型已写非空 text 一字不动 | `streaming_anki_service.rs` occlusion merge 分支：`has_model_text` 判空后才 `insert`；测试 `occlusion_draft_does_not_overwrite_model_written_text` 锁定 | 通过 |
| P2 | §2.1 images 空时填 imageRef、非空不动 | 构造点合并语义 + `plain_card_without_occlusion_keeps_images_empty` 回归 | 通过 |
| P3 | §2.1 / §6 末条：`_occlusion` 库内保留，移除只发生在导出克隆层，规范化不写回库 | 入库照写 `_occlusion`；APKG 侧 `normalize_cards_for_export` 作用于入参 owned `Vec`；AnkiConnect 侧 `prepare_occlusion_note` 作用于同步内存克隆 | 通过 |
| P4 | §6 三道闸（消费先于移除） | 闸 1：两条 APKG 入口（`export_cards_to_apkg_with_full_template_report` :1451、`export_multi_template_apkg_report` :1712）先 `convert_occlusion_card_for_export` 再 retain 删 `_` 键；闸 2：两处 extra_keys 追加换用 `is_internal_protocol_field`；闸 3：`resolve_card_field_value` 兜底臂拒答 `_` 键 + `build_fields_with_model_names` 取值源头过滤。验收红线有实测：APKG model 字段表 / note 值 `_` 键计数为 0 | 通过 |
| P5 | §2.3 AnkiConnect 主路径 = 标准 Cloze；`_occlusion` → `Occlusion` normalize 碰撞根治 | `occlusion_json_never_leaks_into_emitted_fields`：目标模型带 `Occlusion` 字段时发出空串，spec JSON 不泄漏；用户正常字段 `Occlusion`/`Front` 不受谓词误伤（`is_internal_protocol_field("Occlusion") == false` 有断言） | 通过 |
| P6 | §2.3 / §8.5 本轮不创建、不灌值 Anki 原生 IO notetype | AnkiConnect diff 无任何 `createModel` 调用；`prepare_occlusion_note` 注释明示「不硬依赖 Anki 端 IO 模型」 | 通过 |
| P7 | §7 旧卡零行为变化（唯一允许差异 = `_` 键不再泄漏） | `convert_occlusion_card_for_export` 对 `parse_occlusion_field == None` 早退；`plain_card_regression_prepare_occlusion_note_is_noop` 断言字段逐项相等 | 通过 |
| P8 | §8.3 enableQaPass 门控不回退 | `parse_and_save_card` 的 qa 门控（校验照跑、关闭仅移除 `_qa_flags` 留痕，:2056-2060）本轮 diff 未触及；critic 侧 `sanitize_plan_for_disabled_qa_pass` 仍剥 `QA_FLAGS_FIELD` 且有回归测试 | 通过 |
| P9 | §8.2 lossless-only 不放宽（入库侧） | 截断降级错误卡逻辑（:1474-1485）与缓冲截断防线本轮零改动；入库对模型产出字段只有 or_insert，无覆盖 | 通过 |
| P10 | §8.4 `_occlusion` spec 协议与 `validate_spec` 拒绝语义不动 | `anki_image_occlusion.rs` diff 未触碰 `validate_spec`/spec schema；新增函数均为只读消费 | 通过 |
| P11 | gold provenance 主体设计（`_content_provenance` 第二道闸） | 与 `_qa_flags` 解耦、不受 qa_pass 门控剥离（`disabled_qa_pass_never_strips_content_provenance`）；critic 自改 marker/provenance 双闸排除；`classify_candidate` 编辑通道要求 actor=user；KeptUnedited 桶不看 actor（红线回归）；importer 剥离外部伪造的 `_original_generation`/`_qa_flags`/`_content_provenance` 堵金标投毒；chatanki 库卡更新后端统一盖 actor=user 戳（覆盖 payload 自带值——机器协议字段后端权威，合理） | 通过 |
| P12 | 协议中立 | `anki_protocol.rs` 本轮零 diff | 通过 |
| P13 | `vlm://` 占位引用（导出侧） | APKG `occlusion_media_file_name` 拒绝 `vlm://` 前缀；AnkiConnect `prepare_occlusion_note` 不为 `vlm://` 挂媒体（均有测试）。入库侧缺口见 D2 | 通过（仅导出侧） |

---

## 2. 偏离项（不构成翻案，但须记录/补做）

| # | 契约条款 | 实现现状 | 评估 |
| --- | --- | --- | --- |
| D1 | §6 闸 1 要求克隆上 `retain(!is_internal_protocol_field)`（含 `Anki*` 13 键） | `normalize_cards_for_export` 只删 `_` 前缀，刻意保留 `Anki*` 键（注释：`card_sched_restore` 回写复习进度需要） | **合理偏离**。契约 §6 与 §7「既有 13 个 Anki* 保留字段的过滤行为不变」内在矛盾；实现取了不破坏调度恢复的读法，字段表层（闸 2）与取值层（闸 3）已保证 `Anki*` 不进 model/note。建议下轮契约修文认可此读法 |
| D2 | §2.1 「`imageRef == "vlm://pending-image"` 占位引用不入 images」 | 入库侧 `occlusion_image_ref_from_fields` **无 `vlm://` 过滤**，若 `_occlusion` 携带占位引用会原样进 `card.images`，且 `extract_occlusion_draft_fields` 会把 basename `pending-image` 拼进 `<img src>` | 中危缺口但生产路径不可达：`chatanki_executor::append_vlmfull_occlusion_draft`（:9713-9725）在源头把占位 `image_ref` 替换为真实 `source_id`，无图则整体不产 marker。暴露面仅剩模型直出/伪造 `_occlusion` 的边缘。契约 §9 要求的入库测试「`vlm://pending-image` 不入 images」**缺失**，需补过滤 + 测试 |
| D3 | §6 闸 3 文本只要求 `build_fields_with_model_names` 跳过 `_` 键 | 实现同时过滤 `Anki*` 13 键（模型字段恰名 `AnkiNoteId` 时由发原值变为发空串） | 方向正确（与 §6 统一谓词一致），属超出条文的轻微行为收紧，已有测试锁定。记录即可 |
| D4 | §2.2 Cloze 形态 Text 应为 `build_card_fields(validated, Some(包内名), extra)` 产物 | APKG 侧 `build_occlusion_cloze_text` 用**未校验**的裸 `OcclusionSpec` 现拼 cloze（越界/超限 spec 也产 Text，仅 IO 语法走 `validate_spec`）；`escape_cloze_label` 因未 pub 被本地复刻为 `escape_occlusion_cloze_label` | 低危：绕过校验的 Text 兜底放宽了类型约束，且复刻转义函数有漂移风险。建议 pub 原函数并复用 validated 路径 |
| D5 | 导入剥离伪造协议字段的可见性 | `apkg_importer_service::map_card` 剥离 3 个伪造凭证键时仅 `warn!` 日志，未计入用户可见的导入报告 warnings | 低危：剥离本身正确（且刻意只剥凭证名单、不无差别剥 `_`，维持 lossless-only 最小侵入）；建议下轮把剥离事件上报导入报告 |
| D6 | gold 挖掘行为收紧 | 无 `_content_provenance` 的历史真实用户编辑不再产修正对（`gold_references_exclude_legacy_edits_without_provenance` 明确锁定「宁漏勿污」） | 方向符合 r1-04 污染路径 A 收口，但属既有挖掘产能的回归，需在 gold 文档/发布说明标注 |
| D7 | §9 验收清单 | `format_anki_io_cloze` 单测存在但锁定的是**错误的百分数串**（见 F1）；「贴边坐标 x+w=1」用例缺失；入库 pending 用例缺失（D2） | 随 F1 翻案一并重写 |

---

## 3. 必须翻案（4 条）

### F1 `format_anki_io_cloze` 坐标写成百分数（契约 §0/§3 直接违约，官方语法可静态证伪）

`anki_image_occlusion.rs` 新增：

```rust
fn format_io_percent(v: f32) -> String {
    let pct = (f64::from(v) * 100.0).clamp(0.0, 100.0);
    ...
}
```

产出形如 `{{c1::image-occlusion:rect:left=10:top=20:width=30:height=15}}`。
Anki 官方 `to-cloze.ts` / `imageocclusion.rs` 的 on-disk 语法是 **0–1 归一化小数**
（`left=.1:top=.23:width=.4:height=.5`）。契约 §0 已专门为此做过裁决修正并写明
「写百分数会导致 Anki 端遮罩全部放大 100 倍越出画布」。函数文档、`format_io_percent`
的 ×100 + clamp [0,100]、以及两个单测（`test_format_anki_io_cloze_percent_coordinates`、
`..._rounds_to_four_decimals_and_trims_zeros`）锁定的都是错误值域。
**翻案要求**：去掉 ×100，直接按 0–1 输出（最多 4 位小数、去尾零），重写全部相关单测与文档注释。

### F2 IO 语法去向违约：五字段模型未创建，rect 语法反被写进默认导出的 Extra（契约承诺 3 + §2.2 双重违约）

- 契约承诺 3（必达）：APKG 侧创建 IO 五字段模型（`Occlusion/Image/Header/Back Extra/Comments`，
  `model_type=1`）并把 `format_anki_io_cloze` 产物写入 `Occlusion` 字段，作为**可选形态、默认关**。
  本轮 diff 中该模型创建**完全不存在**（`create_template_model`/多模板路径均未接 IO 五字段）。
- 实现反而在 `apkg_exporter_service::convert_occlusion_card_for_export` 里把
  `format_io_rects(&spec)` 拼进**默认 Cloze 形态**的 `Extra` 字段（无 Extra 键时还并入
  `card.back` 一起塞入）。契约 §2.2 明确 Cloze 形态 `Extra = 补充说明（若有）`，IO 语法
  只属于可选 IO 形态的 `Occlusion` 字段。后果：每张遮挡卡的默认导出产物背面都会原样
  显示 `{{c1::image-occlusion:rect:left=10:...}}` 机器语法——且因 F1，数值还是错的百分数。
  测试 `occlusion_conversion_builds_cloze_text_media_and_io_extra` 把这一违约行为锁成了预期。

**翻案要求**：把 IO rect 语法从 Cloze 形态的 Extra 中移除；IO 语法只随契约定义的
IO 五字段模型（可选形态、默认关）落地，或本轮明确降级承诺 3 并改契约。二者取一，
不允许现状的「语法进 Extra 冒充落地」。

### F3 入库提前拼 `<img>`（契约 §2.1 明令「入库不拼」）

契约 §2.1 两处白纸黑字：text 行「纯 cloze 串，无 `<img>`，因 `extract_occlusion_draft_fields`
传 `image_file_name=None`」；`<img>` 拼接行「**入库不拼**。`<img src>` 的媒体文件名只有导出时
才确定……拼接统一延后到导出转换器」。本轮实现把 `extract_occlusion_draft_fields` 改为
`build_card_fields(&validated, image_ref_basename(&validated.image_ref), None)`，入库 text
直接携带 `<img src="basename">`（入库测试断言 `starts_with("<img src=\"image-source-1\"><br>")`）。

静态后果链：入库固化的 basename 与导出时的实际包内名可解耦——`collect_media_entries`
同名冲突去重、AnkiConnect `storeMediaFile` 命名、未来 VFS 解析产物都可能与 basename
不一致；且 `_original_generation` 快照（:2065-2070，晚于 occlusion merge）会把这个带
`<img>` 的 text 固化为「生成原文」，翻案后需注意历史数据形态。导出转换器本就有
「text 无 `<img>` 才补前缀」逻辑，入库拼接完全冗余。
**翻案要求**：恢复 `image_file_name=None`，入库 text 回到纯 cloze 串；相关入库测试断言同步改写。

### F4 导出规范化层缺 imageRef → 本地路径解析，媒体闭环对生产引用形态名不副实（契约承诺 2 + §2.2 媒体行违约）

契约 §2.2 媒体行：「imageRef 在规范化层**解析为本地路径**（VFS id 经资源服务；本地路径
校验存在；**解析失败降级为无图纯 cloze**，不阻断导出）→ 路径已在 `card.images` →
`collect_media_entries` 既有逻辑打包」。实现在两侧都没有解析步骤：

- APKG：`convert_occlusion_card_for_export` 把 `spec.image_ref` **原样** push 进
  `card.images`；`collect_media_entries`（:1330）直接 `fs::File::open(image_path)`。
  生产路径的 imageRef 是 VFS `source_id`（`chatanki_executor` :9717 取
  `r.source_id`，如 `image-source-42`）或 `vfs://` 形态，均不是文件系统路径 →
  open 必失败 → 媒体不进包，而 `<img src="image-source-42">` 悬空保留在 Text 里。
- AnkiConnect：`prepare_occlusion_note` 同样原样 push imageRef，交给按本地文件读取的
  `prepare_note_media`，同类失败。
- 「解析失败降级为无图纯 cloze」也未实现：测试
  `occlusion_card_with_missing_image_still_exports_text` 反而断言缺图时 `<img src="ghost.png">`
  保留——与契约降级语义相反。

现有导出测试全部用真实文件系统路径构造 imageRef，恰好绕开了生产形态，形成「测试绿但
闭环断」的静态盲区。承诺 2「Anki 端可复习的 note（含图）」对真实 VLM 遮挡卡不成立。
**翻案要求**：在规范化层接入 VFS/资源服务解析（source_id / vfs:// → 本地路径），本地路径
校验存在；解析失败按契约降级为无图纯 cloze（移除 `<img>`，保留 cloze 正文），并补
source_id 形态的导出测试。

---

## 4. 五项复核逐条回答

1. **入库/导出与 lossless-only 冲突？——无冲突，lossless 未被放宽。**
   入库截断拒收/错误卡降级逻辑零改动；入库对模型字段只有 or_insert；导出规范化
   （改 text/删 `_` 键/并 Extra）全部发生在导出克隆，不写回库；导入侧新增的剥离
   仅限 3 个伪造凭证键（`_original_generation`/`_qa_flags`/`_content_provenance`），
   注释明示「不无差别剥离所有 `_` 前缀字段，维持 lossless-only 最小侵入」，属安全
   闸而非静默修字符串（可见性建议见 D5）。无任何新增的静默字符串修剪。

2. **enableQaPass / FSRS opt-in / maxCards / 协议中立被碰到？——均未被碰。**
   qa 门控（:2056-2060）与 critic sanitize 剥 `_qa_flags` 语义原样，且新增回归测试
   锁「7077075a 不回退」；`_content_provenance` 被声明为溯源事实、豁免门控，是 r1-04
   授权的语义切分而非门控放宽；FSRS 相关代码零 diff；`max_cards_per_mistake`
   仅作为 diff 上下文出现，未改动；`anki_protocol.rs` 零 diff。

3. **`_` 字段过滤会否误伤用户字段或 cloze Text？——不会。**
   APKG `resolve_card_field_value` 的 `text/front/back/extra/tags` 专用臂在 `_` 兜底闸
   之前，cloze Text 取自 `card.text` 不经过滤；AnkiConnect 谓词对 `Occlusion`/`Front`
   等正常字段返回 false（有断言）。唯一「误伤面」是用户自造的 `_` 前缀 extra 字段会在
   导出中消失——这是契约 §6 验收红线明文授权的行为。`Anki*` 键取值收紧见 D3。

4. **契约 vs 实现偏离表（四个焦点）：**
   - 入库是否提前拼 `<img>`：**是，违约**（F3）。
   - IO notetype 是否创建：**否，未创建**；IO 语法被改道进默认 Extra（F2）。
   - 坐标单位：**百分数，违约**（F1，官方与契约均为 0–1 归一化小数）。
   - `vlm://pending` 是否入 images：导出两侧已过滤（P13）；**入库侧无过滤**，但生产
     路径在 executor 源头已替换占位引用，实际不可达（D2，需补防御 + 契约要求的测试）。
   - 另加一项焦点外发现：imageRef 无解析、缺图不降级（F4）。

5. **gold provenance 是否误伤 lossless？——否。**
   `insert_content_provenance` 只新增/覆盖机器协议字段 `_content_provenance`，不触碰
   front/back/text 等内容字段；critic sanitize 的差异判定双侧忽略 provenance，纯溯源戳
   不落盘（内容未变的卡保持既有丢弃行为）；chatanki 更新路径后端覆盖 payload 自带
   provenance 属机器字段权威写入，非用户内容改写。副作用仅是挖掘保守化（D6），
   属产能回归而非数据损失。

---

## 5. 翻案清单汇总

| # | 条目 | 落点 | 性质 |
| --- | --- | --- | --- |
| F1 | IO 坐标百分数 → 改 0–1 归一化小数 | `anki_image_occlusion.rs::format_anki_io_cloze` / `format_io_percent` + 单测 | 官方语法 + 契约 §0/§3 双违约 |
| F2 | IO 语法进默认 Extra 且五字段模型未建 → 移出 Extra，按契约 IO 形态落地或明改契约 | `apkg_exporter_service.rs::convert_occlusion_card_for_export` / `format_io_rects` + 单测 | 承诺 3 必达未达 + §2.2 违约 |
| F3 | 入库提前拼 `<img>` → 恢复 `image_file_name=None` | `anki_image_occlusion.rs::extract_occlusion_draft_fields` + 入库测试 | §2.1 明文违约 |
| F4 | imageRef 无解析、缺图不降级 → 规范化层接 VFS 解析 + 无图降级 | `apkg_exporter_service.rs` / `anki_connect_service.rs` 规范化层 + 补 source_id 形态测试 | 承诺 2 + §2.2 媒体行违约 |

lossless-only：**未被放宽**。

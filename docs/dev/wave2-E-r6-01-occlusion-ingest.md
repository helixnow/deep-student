# Wave2-E 第 6 轮 #01：遮挡入库复核（r2 接线四项 + pending 过滤补丁）

静态复核 + 最小补丁。未运行 npm/cargo/测试套件，未 commit（按本轮约定）。
改动限定两个独占文件：`src-tauri/src/anki_image_occlusion.rs`、
`src-tauri/src/streaming_anki_service.rs`（只动 occlusion 入库相关，
未触碰 CriticSummary / token 算法 / QA 门控 / maxCards）。

## 一、复核结论（四项）

| # | 复核项 | 结论 | 证据（复核时行号） |
|---|--------|------|--------------------|
| 1 | text 空才填 | **确认正确** | `streaming_anki_service.rs` occlusion 分支：`has_model_text = cleaned_extra_fields.get("text").is_some_and(\|t\| !t.trim().is_empty())`，仅 `!has_model_text && !fields.text.trim().is_empty()` 时写入。模型/模板 text 不被覆盖，front/back 不动。测试 `occlusion_draft_does_not_overwrite_model_written_text` 锁定 |
| 2 | images ← imageRef | **确认正确** | 卡片构造前：`images` 为空时经 `occlusion_image_ref_from_fields(&cleaned_extra_fields)` 解析 `_occlusion.imageRef`（camelCase 契约 + snake_case 容忍）push 完整引用；错误卡路径仍 `Vec::new()`。「已有 images 不追加覆盖」合并语义保留 |
| 3 | vlm://pending 是否入 images | **缺口确认，本轮已补**（详见下节） | 补丁前 `occlusion_image_ref_from_fields` 只滤空/纯空白，`vlm://pending-image` 会原样进 `card.images`——违反 r2 契约 §2.1「占位引用不入 images」及 §9 测试要求。即 r2-08 协议复核 D2 缺口，r3–r5 均未修复 |
| 4 | format_anki_io_cloze 是否 0–1 | **确认正确（r2-10 修正已在位）** | `format_io_coord`：`clamp(0.0, 1.0)`、4 位小数去尾零、前导点风格（`.125`），对齐官方 `to-cloze.ts` 示例；模块头明文「禁止 ×100 百分数」。测试 `test_format_anki_io_cloze_normalized_coordinates` / `…rounds_to_four_decimals_and_trims_zeros` 锁定。注意 r2-02 文档 §「函数改动」仍描述旧的 ×100 公式，以 r2-10 文档与现行代码为准 |

**翻案条数：0。** 四项均与现行代码一致或与 r2-08 D2 既有判定一致，无既有
结论需要推翻。第 3 项是「落实既有判定遗留的必修项」而非翻案：r2-08 D2 已
指出入库侧无 `vlm://` 过滤且要求「需补过滤 + 测试」，本轮补齐。r2-08 的
「生产路径不可达」分析亦复核成立——`chatanki_executor::append_vlmfull_occlusion_draft`
在构造 marker 前把占位 `image_ref` 替换为 VFS `source_id`，无图则整体不产
marker；暴露面仅剩模型直出/伪造 `_occlusion`、旧数据、未来未接线路径。

## 二、pending 过滤补丁（已实现）

### anki_image_occlusion.rs

- 新增模块常量 `VLM_PENDING_IMAGE_SCHEME = "vlm://"`（与 apkg
  `occlusion_media_file_name` 及 AnkiConnect `OCCLUSION_PENDING_IMAGE_SCHEME`
  的导出侧降级约定同前缀；两文件非本轮独占，未合并常量）。
- `occlusion_image_ref_from_fields`：trim 后引用以 `vlm://` 开头即返回
  `None`（与空引用同路径）。doc 注释同步补「占位不入 images，契约 §2.1」。
- 模块头第 2 点补一句「`vlm://` 占位引用被过滤，不入 images」。
- 新增单测 `test_occlusion_image_ref_from_fields_rejects_vlm_pending_placeholder`：
  `vlm://pending-image` → None；带前后空白的占位 → None；
  `vfs://images/diagram.png` 真实引用不受影响。

### streaming_anki_service.rs

- 生产代码零改动（过滤收敛在 helper 内）；入库点注释补一句过滤语义。
- 新增集成测试 `occlusion_pending_placeholder_image_ref_stays_out_of_images`
  （契约 §9 要求的缺失测试）：用 `build_occlusion_draft_marker("vlm://pending-image", …)`
  构造占位草稿走 `parse_and_save_card`，断言 `card.images` 为空、
  `_occlusion` 与 `image-occlusion` tag 照常合并（占位只影响 images，
  不阻断草稿入库）。

测试只写未跑（本轮禁 cargo）。既有测试不受影响自查：全仓仅
`streaming_anki_service.rs:2174` 一处生产调用 `occlusion_image_ref_from_fields`；
既有断言里喂给它的引用是 `image-source-1/2`、`vfs://images/diagram.png`、
`legacy.png`，均无 `vlm://` 前缀。

## 三、遗留（只记录，不实现）

1. **VFS source_id 解析断链（涉 coordinator.rs / vfs 层，本轮不可碰）**：
   生产接线写入 `card.images` 的是 `VfsResourceRef.source_id`——即
   `files` 表主键 id（见 `chat_v2/vfs_resolver.rs` 的
   `VfsFileRepo::get_file_with_conn(conn, &vfs_ref.source_id)`），不是文件
   系统路径也不是 basename。apkg / AnkiConnect 的媒体收集按文件名/路径
   语义消费 `card.images`，拿到裸 source_id 无法定位字节。打通需要在导出
   侧（或 `chat_v2/workspace/coordinator.rs` 一类的编排层）注入
   `VfsFileRepo::get_content_with_conn` 解析：source_id → blob 字节 →
   落盘临时媒体文件 → 文件名回填 `<img src>`。三处均非本轮独占文件，
   仅记录方案不实现。
2. **占位 text 的 `<img src="pending-image">` 残留**：`extract_occlusion_draft_fields`
   对 `vlm://pending-image` 取 basename 得 `pending-image` 拼进 `<img src>`
   （r2-08 D2 已述）。与 images 同属生产不可达边缘；本轮授权范围仅
   「pending 不入 images」，text 侧未动，留给后续轮次裁决（可选修法：
   `image_ref_basename` 对 `vlm://` 前缀返回 `None`，text 退化纯 cloze）。
3. **r2-02 文档陈旧**：其 `format_anki_io_cloze` 描述仍是 ×100 百分数
   （r2-10 已修正代码与测试），历史文档按惯例不回改，以本文档与 r2-10 为准。

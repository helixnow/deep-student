# Wave2-E 第 7 轮 r7-01：遮挡端到端测试追加（只落盘）

> 角色：0824 Wave2-E 第 7 轮「遮挡端到端测试」。模型 `claude-fable-5-thinking-high`。
> 硬规则：本轮**未跑任何测试/编译/CI**、未 commit、未切枝；只扩展了既有测试
> 源文件与新建本文档，未改任何产品代码（`anki_image_occlusion.rs` /
> `streaming_anki_service.rs` / apkg / anki_connect 均未触碰）。

---

## 1. 产出文件

| 文件 | 性质 |
| --- | --- |
| `src-tauri/tests/occlusion_export_roundtrip.rs` | **扩展**既有 integration test（r2-05 首建）。只加法：既有矩阵 1–7、三个镜像 helper、fixture 一字未删未改；文件头追加 r7 段落并重申**第 8 轮才跑** |
| `docs/dev/wave2-E-r7-01-occlusion-tests.md` | 本说明文档 |

执行约定（文件头原文保留 + r7 段落重申）：第 1–7 轮只落盘不执行，预期第 8 轮
`cd src-tauri && cargo test --test occlusion_export_roundtrip`。

## 2. 新增测试函数清单（覆盖矩阵 8–11）

| # | 测试函数 | 覆盖点 |
| --- | --- | --- |
| 8 | `test_ingest_images_wiring_populates_from_occlusion_image_ref` | **生成字段 + 入库形状**：直接测已 pub 的生产函数 `occlusion_image_ref_from_fields`（`streaming_anki_service.rs:2173-2178` 入库点用它从 `_occlusion.imageRef` 填充 `AnkiCard.images`，测试内复刻「images 为空才填充」guard）。三种形状：camelCase 生产 roundtrip 解析出完整 `vfs://` 引用；snake_case 旧数据仍可填充 images 但 `parse_occlusion_field` 按 camelCase 契约返回 `None`（旧数据只影响 images，不进遮挡转换）；**旧卡**（无 `_occlusion`）与空白引用均 `None` 不填充 |
| 9 | `test_vlm_pending_placeholder_image_ref_stays_out_of_images_end_to_end` | **vlm://pending 不入 images（端到端）**：`parse_occlusion_boxes_from_vlm`（`[OCCLUSION_BOXES]` 块 + Markdown 围栏）→ 断言占位字面值 `vlm://pending-image` → `build_occlusion_draft_marker_from_spec` → `extract_occlusion_draft_fields` → `occlusion_image_ref_from_fields` 必须 `None`（r2 契约 §2.1 / r6-01 补丁回归锁）；同时锁「占位只影响 images，不阻断入库」（`_occlusion`/tag/cloze 正文照常）；过滤是 scheme 级（任意 `vlm://`、带空白占位均拒），真实 `vfs://` 不误伤 |
| 10 | `test_io_cloze_coords_clamped_and_rounded_to_unit_interval` | **IO 0–1 坐标（白盒补充）**：绕过校验直构 `ValidatedOcclusionSpec`（字段 pub）触达 `format_anki_io_cloze` 的深度防御分支——负值/超 1 夹取到整数 `0`/`1`（无前导点无小数尾）、1/3 → `.3333`、0.6666667 → `.6667`、0.1234567 → `.1235`、0.25 → `.25` 去尾零；与 `format_anki_io_cloze_mirror` 逐字节交叉校验；反向断言无 ×100 / 负值泄漏 |
| 11 | `test_occlusion_draft_marker_pipeline_end_to_end_to_export_filter` | **生成 → 入库 → 导出全链路**：`build_occlusion_draft_marker_from_spec`（真实 `vfs://` 引用）→ `strip_occlusion_draft_markers`（marker 不进模型可见内容，正文行保留）→ `extract_occlusion_draft_fields`（`<img src="heart-diagram.png">` + cloze + tag）→ `parse_occlusion_field` 回读坐标严格逐位不漂移 → `occlusion_image_ref_from_fields` 解析 images → 导出 `_` 前缀过滤（`_occlusion` 不出导出产物，`Text` 保留） |

任务卡六个覆盖点与矩阵的映射（新旧合计）：

| 覆盖点 | 既有矩阵（r2-05） | r7 追加 |
| --- | --- | --- |
| 生成字段 | 1、2 | 8、11 |
| 入库形状 | 1、2 | 8、9、11 |
| 导出过滤 | 4 | 11 |
| 旧卡 | 5 | 8（第 3 段） |
| vlm://pending 不入 images | — （r6-01 前无 pub 过滤可测） | **9** |
| IO 0–1 坐标 | 3 | 10 |

## 3. 新增依赖的 pub API（写作时逐一在 tip `a07a44d1` 工作树确认存在且 pub）

来自 `deep_student_lib::anki_image_occlusion`，在既有 use 上只加法合并：

- `occlusion_image_ref_from_fields(&HashMap<String, String>) -> Option<String>`
  （r6-01 起含 `vlm://` scheme 过滤；`streaming_anki_service.rs:2175` 唯一生产调用点）
- `parse_occlusion_boxes_from_vlm(&str) -> Option<OcclusionSpec>`（占位引用产出方）
- `build_occlusion_draft_marker_from_spec(&OcclusionSpec, &OcclusionConfig) -> Option<String>`
- `extract_occlusion_draft_fields(&str) -> Option<OcclusionCardFields>`
- `strip_occlusion_draft_markers(&str) -> String`
- 类型 `ValidatedOcclusionSpec`（字段 pub，矩阵 10 直构用）
- 常量 `OCCLUSION_DRAFT_PREFIX` / `OCCLUSION_BOXES_OPEN` / `OCCLUSION_BOXES_CLOSE`

## 4. 设计说明与取舍

1. **矩阵 10 的直构**：`ValidatedOcclusionSpec` 按模块注释「只能通过
   `validate_spec` 构造」，但 `format_anki_io_cloze` 的 clamp [0,1] 是
   validate 之外的深度防御，正常链路不可达；测试文件内注释已说明这是白盒
   取舍。若后续封住直构（字段改私有/加 non_exhaustive），矩阵 10 需随裁决
   重写或删除（属可预期的契约演进红，非缺陷）。
2. **矩阵 9 不锁占位 text 的 `<img src="pending-image">` 残留**：该残留是
   r6-01 §三.2 记录的遗留项（修法候选：`image_ref_basename` 对 `vlm://`
   返回 None），归后续轮次裁决。本测试只断言 images 侧契约，避免第 8 轮
   若残留被修掉时误红。
3. **f32 舍入字面值**：矩阵 10 的期望串按 `f64::from(f32)` 语义手工推演
   （`1/3f32 = 0.33333334…` → `.3333`；`0.6666667f32 = 0.66666669…` →
   `.6667`；`0.1234567f32 = 0.12345670…` → `.1235`），与生产
   `format_io_coord` 的 `{:.4}` + 去尾零 + 前导点一致；另有镜像逐字节
   交叉校验兜底。
4. **guard 复刻**：矩阵 8/9 内的 `if images.is_empty() { … }` 是对
   `streaming_anki_service.rs` 入库点三行 guard 的逐行复刻，目的是把
   「已有 images 不覆盖、解析 None 则保持为空」的接线形状写进测试语义，
   而非测试测试代码本身。

## 5. 预期红/绿（第 8 轮才跑，本轮零执行）

**预期新增 4 个测试全绿（合计 11/11）**，理由：全部断言只依赖 tip 工作树上
已存在的 pub API（逐行静态核对过 `occlusion_image_ref_from_fields` 的
camelCase/snake_case/空白/`vlm://` 四路、`parse_occlusion_boxes_from_vlm`
的占位字面值与围栏容忍、`format_io_coord` 的 clamp/舍入/去尾零/前导点、
draft marker 三函数的行协议）。既有矩阵 1–7 未动，不改变其红绿预期。

已知的可能转红情形（均为契约演进信号，非本文件缺陷）：

1. 占位字面值 `vlm://pending-image` 或 scheme 常量变更 → 矩阵 9 字面断言随改；
2. `ValidatedOcclusionSpec` 封住直构 → 矩阵 10 编译红（见 §4.1）;
3. snake_case 容忍被移除（收紧为纯 camelCase）→ 矩阵 8 第 2 段随裁决更新。

## 6. 边界自证

- 只改一个测试文件 + 新建本文档；`git status` 无产品代码改动。
- 既有用例零删除零改动（矩阵 1–7 与镜像 helper 逐字保留；文件头只追加段落）。
- 未改 Cargo.toml（`tests/*.rs` 自动发现，r2-05 §1 已核）。
- 未跑 cargo/npm/CI；未 commit；未切枝（停留在 `cursor/0824-wave2-anki-qbank-a875`）。

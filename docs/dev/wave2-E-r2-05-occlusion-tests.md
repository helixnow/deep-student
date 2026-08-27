# Wave2-E 第 2 轮 r2-05：遮挡卡 fixture 级端到端测试（只落盘）

> 角色：0824 Wave2-E 第 2 轮「遮挡测试」。模型 `claude-fable-5-thinking-high`。
> 硬规则：本轮**未跑任何测试/编译/CI**、未 commit、未切枝；只新建了本文档与一个测试源文件，
> 未改任何已有 `.rs/.ts/.tsx`（含 `lib.rs` / `streaming_anki_service.rs` / `apkg_exporter` /
> `anki_connect` / `anki_image_occlusion`——那些文件的单测归其他负责人）。

---

## 1. 产出文件

| 文件 | 性质 |
| --- | --- |
| `src-tauri/tests/occlusion_export_roundtrip.rs` | 新建 integration test（**第 1–7 轮只落盘不执行；预期第 8 轮 `cargo test --test occlusion_export_roundtrip`**） |
| `docs/dev/wave2-E-r2-05-occlusion-tests.md` | 本说明文档 |

`src-tauri/Cargo.toml` 未设 `autotests = false`（显式 `[[test]]` 条目仅用于 `harness = false`
的 e2e），因此 `tests/*.rs` 自动发现，**无需注册、无需改 Cargo.toml**。
crate 引用名照抄现有 integration tests（如 `anki_export_integration.rs`）：`deep_student_lib`。

## 2. 测试函数清单（覆盖矩阵 1–7 一一对应）

| # | 测试函数 | 覆盖点 |
| --- | --- | --- |
| 1 | `test_build_card_fields_produces_text_cloze_occlusion_field_and_tag` | `build_card_fields` 产出 `<img>` + `{{cN::label}}` Text、`extra_fields["_occlusion"]`（camelCase JSON）、`Extra`、tag `image-occlusion`；顺带钉死 `OCCLUSION_FIELD`/`OCCLUSION_TAG` 常量字面值 |
| 2 | `test_parse_occlusion_field_roundtrip_preserves_coordinates` | `build_card_fields` → `parse_occlusion_field` 回读，x/y/w/h **严格逐位相等**（fixture 坐标全部取二进制可精确表示的分数：0.125/0.25/0.5，回避 f32 容差噪声），cloze 序号与标签同锁 |
| 3 | `test_io_cloze_syntax_contains_image_occlusion_rect_with_percent_coords` | **直接调用生产函数 `format_anki_io_cloze`**：语法含 `image-occlusion:rect`，坐标为**百分数去尾零**（0.125 → `left=12.5`），值域 [0,100]，多盒无分隔拼接；另与测试内公式镜像逐字节交叉校验，并反向断言未误用归一化原值 |
| 4 | `test_export_fields_filter_excludes_underscore_protocol_fields` | 模拟 note fields（Text/Extra + `_occlusion`/`_qa_flags`/`_original_generation`）过滤后：三协议字段逐一不出现 + 泛化断言无任何 `_` 前缀键 + 用户字段不被误伤 |
| 5 | `test_legacy_card_without_occlusion_field_skips_conversion` | 旧卡（无 `_occlusion`）`parse_occlusion_field` 返回 `None` 即不走转换；坏 JSON 的 `_occlusion` 同样 `None`；全空 fields 同样 `None` |
| 6 | `test_image_ref_maps_to_media_file_name` | `vfs://…/x.png`、本地路径、Windows 路径、裸文件名四形态 → 媒体文件名；解析结果喂回 `build_card_fields` 后 Text 出现 `<img src="…">`；空/目录型引用返回 `None` 不 panic |
| 7 | `test_empty_image_ref_and_invalid_spec_do_not_panic` | 空 `image_ref`（`empty_image_ref`）、空盒列表（`empty_boxes`）、NaN/越界/零 cloze 序号混合（`box_not_finite`/`box_out_of_bounds`/`cloze_index_zero`）全部结构化拒绝、不 panic |

## 3. 依赖的 pub API（写作时已在 tip 上确认全部存在且 pub）

来自 `deep_student_lib::anki_image_occlusion`（`lib.rs:12` 已 `pub mod`）：

- `validate_spec(&OcclusionSpec, &OcclusionConfig) -> Result<ValidatedOcclusionSpec, Vec<OcclusionIssue>>`
- `build_card_fields(&ValidatedOcclusionSpec, Option<&str>, Option<&str>) -> OcclusionCardFields`
- `parse_occlusion_field(&HashMap<String, String>) -> Option<OcclusionSpec>`
- `format_anki_io_cloze(&ValidatedOcclusionSpec) -> String`
  （**本轮由 `anki_image_occlusion` 负责人并发合入工作树**，写作时已在工作树确认为 pub；
  矩阵 3 直接测它，另留公式镜像交叉校验——第 8 轮编译依赖该并发改动一并在树上）
- 常量 `OCCLUSION_FIELD`（= `"_occlusion"`）、`OCCLUSION_TAG`（= `"image-occlusion"`）
- 类型 `OcclusionSpec`、`OcclusionBox`、`OcclusionConfig`
- （`OcclusionIssue.code` 通过 `validate_spec` 的 Err 值间接消费，断言违规码字面值）

未使用但已注意到的同轮新增 pub 符号：`occlusion_image_ref_from_fields`（入库侧读
`_occlusion.imageRef`）。矩阵 6 保持用测试内镜像解析，避免对并发改动的耦合面扩大；
第 8 轮若该符号稳定合入，可考虑把矩阵 6 的读取路径也换成生产函数。

## 4. 镜像 helper（测试文件内，注明与生产实现的同步义务)

apkg/ankiconnect 转换函数非 pub 且按任务卡不得改其可见性，故按任务卡口径落测试内镜像：

| 镜像 helper | 镜像对象 | 同步义务 |
| --- | --- | --- |
| `format_anki_io_cloze_mirror` | 生产函数 `anki_image_occlusion::format_anki_io_cloze`（Anki 23.10+ IO note type Occlusion 字段公式：`{{cN::image-occlusion:rect:left=L:top=T:width=W:height=H}}`，百分数、最多 4 位小数去尾零、多盒无分隔拼接） | 生产符号**已在本轮并发合入工作树**，矩阵 3 已直接调用生产函数；镜像保留为逐字节交叉校验（公式写死在测试侧，生产侧静默改动即转红） |
| `is_internal_protocol_field_mirror` | r1-05 §5.3 议定的导出过滤谓词（`_` 前缀不得导出） | apkg/ankiconnect 落地统一谓词后语义必须等价；本测试作为协议回归锁 |
| `media_file_name_from_image_ref_mirror` | `image_ref` → 包内媒体文件名的最小解析（取最后一段 `/` 或 `\` 分量），语义对齐生产侧私有 helper `anki_image_occlusion::image_ref_basename` | 导出侧媒体收集接通后须与之兼容 |

## 5. 预期红/绿（第 8 轮才跑，本轮零执行）

**预期全绿（7/7）**，理由：全部断言只依赖 tip 上已存在的 pub API 行为（逐行静态核对过
`anki_image_occlusion.rs` 的 `validate_spec` 拒绝码、`build_card_fields` 的 Text/字段/tag
形态、`parse_occlusion_field` 的 None 语义）+ 测试内自洽的镜像 helper。

写作时已知的并发状态：工作树上 `anki_image_occlusion.rs` / `anki_connect_service.rs` /
`anki_gold_set.rs` 存在其他负责人的未提交改动（本角色未触碰）。矩阵 3 依赖其中
`anki_image_occlusion.rs` 新增的 `format_anki_io_cloze`——**第 8 轮编译前该改动必须
仍在树上/已合入**，否则矩阵 3 的 `use` 会编译失败（这是任务卡「若存在则测它」的
既定取舍，非缺陷）。

可能转红的已知情形（均为「镜像/裁决失同步」信号，非本文件缺陷）：

1. 其他负责人后续改了 `build_card_fields` 的 Text 形态（如形态裁决改为 Text 直接嵌
   `image-occlusion:rect` 序列）→ 矩阵 1/2/6 的字面断言需随裁决结果更新；
2. `format_anki_io_cloze` 公式变更（小数位数/去尾零/分隔符）→ 矩阵 3 的字面断言与
   `format_anki_io_cloze_mirror` 按生产函数为准同步；
3. 导出谓词最终形态比「`_` 前缀」更宽/更窄（如白名单制）→ 矩阵 4 泛化断言按会签结果调整。

第 8 轮运行命令：

```bash
cd src-tauri && cargo test --test occlusion_export_roundtrip
```

## 6. 边界自证

- 未改 `lib.rs`（integration test 放 `src-tauri/tests/`，自动发现）。
- 未改 `streaming_anki_service.rs` / `apkg_exporter_service.rs` / `anki_connect_service.rs` /
  `anki_image_occlusion.rs`（单测归各自负责人）。
- 未强行提升 apkg/anki_connect 转换函数可见性——矩阵 4/5 改测「字段构造 + 过滤谓词」纯逻辑，
  在测试内复述「`_` 前缀不得导出」断言并构造模拟 note fields。
- 未跑 cargo/npm/CI；未 commit；未切枝。

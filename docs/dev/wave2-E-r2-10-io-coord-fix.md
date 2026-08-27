# Wave2-E r2-10 · IO cloze 坐标对齐 Anki 官方 to-cloze.ts（0–1 归一化，禁百分数）

**背景**：Anki 官方 `to-cloze.ts` 文档示例为
`{{c1::image-occlusion:rect:top=.1:left=.23:width=.4:height=.5}}`——坐标是
**0–1 归一化小数**。此前实现输出 ×100 百分数（`left=12.5`），会让 Anki
遮罩放大 100 倍。本轮补丁把生产公式、测试镜像与全部断言统一改为 0–1，
风格选用官方示例的**前导点**（`0.125` → `.125`，去尾零，最多 4 位小数，
夹取 [0,1]）；键序维持 `left:top:width:height`，多盒无分隔符拼接（不变）。

## 逐处修改

- `src-tauri/src/anki_image_occlusion.rs`
  - 模块头「坐标约定」新增一条：IO cloze 语法同为 0–1 归一化、对齐官方
    `to-cloze.ts` 示例，**禁止再写 ×100 百分数**。
  - `format_anki_io_cloze` 文档注释：示例改为
    `{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.15}}`，
    写明 0–1 + 前导点风格选择。
  - `format_io_percent` → 重命名为 `format_io_coord`：去掉 ×100，
    夹取改为 [0,1]，保留 4 位小数去尾零，新增 `0.` 前缀 → `.` 前导点转换
    （`0` / `1` 整数值原样输出）。
  - 单测 `test_format_anki_io_cloze_percent_coordinates` → 重命名
    `test_format_anki_io_cloze_normalized_coordinates`，期望串
    `left=10…` → `left=.1…`（断言 1 处）。
  - 单测 `test_format_anki_io_cloze_rounds_to_four_decimals_and_trims_zeros`：
    期望串 `left=33.33…` → `left=.3333…`（断言 1 处）。
- `src-tauri/tests/occlusion_export_roundtrip.rs`
  - 文件头「镜像 helper 说明」第 1 条与镜像 `format_anki_io_cloze_mirror`
    文档/实现同步改为 0–1 前导点公式（`pct` 闭包 → `coord` 闭包）。
  - 矩阵 3 测试 `…with_percent_coords` → 重命名 `…with_normalized_coords`：
    期望串 `left=12.5…` → `left=.125…`（断言 1 处）；值域自证由
    「×100 后落 [0,100]」改为「原值落 [0,1]」（断言 1 处）；反向哨兵由
    `!contains("left=0.125")` 改为 `!contains("left=12.5") &&
    !contains("top=25")`（断言 1 处）。
- `src-tauri/src/apkg_exporter_service.rs`（仅委托注释与测试，公式无副本）
  - `format_io_rects` 文档注释：改述为 0–1 归一化、示例改前导点。
  - 测试 `format_io_rects_delegates_to_validated_anki_io_syntax`：期望串
    `left=10…` → `left=.1…`（断言 1 处）。
  - 测试 `occlusion_conversion_builds_cloze_text_media_and_io_extra`：
    `contains("…left=10…")` → `contains("…left=.1…")`（断言 1 处）。
- `src-tauri/src/anki_connect_service.rs`：核查无百分数公式副本
  （只经 `build_card_fields` 重建标准 Cloze Text），零修改。

**合计更新断言 7 处**（生产单测 2 + roundtrip 矩阵 3 共 3 + apkg 测试 2）。
按补丁约定未运行编译/测试（roundtrip 文件本身约定第 8 轮才执行）。

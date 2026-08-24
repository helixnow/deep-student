# Round 4 #5：AI 图像遮挡制卡首版（Image Occlusion）

> 模块：`src-tauri/src/anki_image_occlusion.rs`（纯函数层，已注册 `lib.rs`）
> 前端：`src/components/anki/utils/imageOcclusion.ts` + `ImageOcclusionOverlay.tsx`
> 状态：已实现 + 19 个 Rust 单元测试 + 11 个 vitest 测试（闭环最小路径，未接管线）

## 1. 动机与定位

图像遮挡（Image Occlusion）是 Anki 生态中医学/解剖/地理等图谱类学科的
头部制卡范式：把图上的标注区域遮住，复习时逐个揭开。Anki 23.10+ 已内置
Image Occlusion note type，AnkiHub 也有 AI 自动遮挡产品线——这是
「AI-native 制卡」明确的能力缺口。

本仓库现状：VlmFull/VlmLight 路由能让 VLM 输出 `[IMAGE_DESC: ...]`
条目式图表描述（`chatanki_executor.rs` 的 prompt 约定），但描述**没有坐标**，
最终只产出普通文本卡，图上信息的空间结构全部丢失。

首版策略（本模块）：**先把数据模型、校验、导出约定、渲染层立起来**，
坐标来源允许「启发式网格 + 前端拖拽微调」，VLM grounding 留到下一刀。
全部 API 为纯函数（无 I/O、无 LLM 调用、无管线依赖），后续 run 接线零改造成本。

## 2. 数据模型（camelCase serde 契约）

```jsonc
// OcclusionSpec —— 一张图 + 一组遮挡盒
{
  "imageRef": "vfs://images/diagram.png",   // 调用方语境的图片引用，不解引用
  "boxes": [
    { "x": 0.25, "y": 0.5, "w": 0.5, "h": 0.25, "label": "左心房", "clozeIndex": 1 }
  ]
}
```

**坐标安全约定**：模块内一律归一化 `[0,1]`（原点左上角），spec 与图片分辨率
解耦；像素换算只发生在渲染/导出边界（`to_pixel_boxes` / 前端 `toPixelRects`），
带四舍五入 + 边界收敛 + 最小 1px 三重保证，Rust 与 TS 两侧同数据测试锁定
（800×600 上 `0.25/0.5/0.5/0.25 → 200/300/400/150`；3×3 极端图上不越界不为 0）。

`clozeIndex` 为 1-based Anki cloze 序号；**允许多盒共享同一序号**
（Anki 语义：同组一起隐藏），`0` 非法。

## 3. 校验（validate_spec）

`validate_spec(&OcclusionSpec, &OcclusionConfig) -> Result<ValidatedOcclusionSpec, Vec<OcclusionIssue>>`

一次性返回全部违规（结构化 `{code, boxIndex, message}`，风格对齐
`anki_qa_lint::LintIssue`），拒绝规则：

| code | 语义 |
|------|------|
| `empty_image_ref` | 图片引用为空 |
| `empty_boxes` | 盒列表为空 |
| `too_many_boxes` | 超过 `max_boxes`（默认 12） |
| `box_out_of_bounds` | 坐标越出 `[0,1]`（含 `x+w`/`y+h` 越界、零/负宽高） |
| `box_too_small` | 宽或高 < `min_box_size`（默认 0.01，空盒/退化盒） |
| `box_not_finite` | NaN/Inf |
| `excessive_overlap` | 任意两盒 IoU > `max_pairwise_iou`（默认 0.35） |
| `cloze_index_zero` | 显式序号为 0 |

归一化行为（不拒绝）：缺 `clozeIndex` 按「已用最大序号 +1」顺序补；空标签补
`区域 N`；超长标签按字符截断（默认 48）。`ValidatedOcclusionSpec` 只能由
`validate_spec` 构造——类型系统保证未校验的 spec 无法进入导出/渲染。

## 4. 导出字段约定（与既有 APKG 导出器兼容）

首版**不引入新 note type、不改 builtin-templates.json**（评估过增量模板方案：
遮挡渲染需要 JS 读取结构化 spec 定位矩形，静态 Mustache 模板表达不了百分比
矩形层，硬塞会破坏既有 16 个 design-* 模板测试的字段约定；复用 Cloze 路径
则任何 Anki 版本可导入）。`build_card_fields` 产出：

```text
AnkiCard.text（Cloze "Text" 字段）:
  <img src="diagram.png"><br>{{c1::左心房}} {{c2::右心室}}

AnkiCard.extra_fields:
  _occlusion : 归一化 spec JSON（本应用原生遮挡渲染与再编辑的数据源）
  Extra      : 可选补充说明（Anki 揭底显示）

AnkiCard.tags 追加: image-occlusion
```

- 图片文件本体走既有 `AnkiCard.images` → `collect_media_entries` 打包路径
  （按文件名寻址），`<img src>` 只写文件名，由调用方从 `image_ref` 解析传入；
  传 `None` 时省略 `<img>`（图片走前端原生渲染的场景）。
- cloze 标签内 `}}` / `::` 会破坏 cloze 语法，`build_card_fields` 已转义
  （有测试）。`_occlusion` 是 JSON，`apkg_exporter_service` 的通用字段路径
  对 `{`/`[` 开头的值跳过 sanitize，天然兼容。
- 回读：`parse_occlusion_field(&extra_fields) -> Option<OcclusionSpec>`
  （JSON 破损返回 None，不 panic），与前端 `parseOcclusionSpec` 镜像。

**导出后的体验分层**：在 Anki 官方客户端里，这张卡是「图片 + cloze 标签列表」
的标准 Cloze 卡（可复习、信息完整）；在本应用内，渲染层读 `_occlusion`
画出真正的遮挡矩形（见 §6）。结构化数据随卡携带，后续升级为 Anki 原生
IO note type 时无损迁移。

## 5. IMAGE_DESC 启发式盒建议（零 LLM 成本桥）

`propose_boxes_from_image_desc(desc: &str, max_boxes) -> Vec<OcclusionBox>`

- 提取全部 `[IMAGE_DESC: ...]` 标记内容（无标记退化为全文）；
- 按条目边界切分（换行 / `；` `;` / `、` / `：` `:` 前缀 / `→` `->` /
  bullet 与序号前缀清洗），去重、过滤过短条目，取前 `max_boxes` 条；
- 近方形网格布局（`cols = ceil(sqrt(n))`，盒占单元格 72% 居中），
  **保证输出两两不相交、全部在界内、序号从 1 顺延——直接可过 `validate_spec`**
  （测试双向锁定）。

定位说明：这不是「猜真实坐标」，而是把 VLM 已产出的条目标签变成
**可编辑的遮挡卡草稿**——用户在前端把网格盒拖到图上真实位置即可成卡。
无图单测里绝不调 LLM。

## 6. 前端最小渲染

- `utils/imageOcclusion.ts`：`parseOcclusionSpec`（防御性解析 + 几何过滤 +
  补号补标签，与 Rust 归一化一致）/ `toPixelRects`（与 Rust 同保证）/
  `occlusionBoxPercentStyle`（百分比定位，遮挡层随图片响应式缩放）/
  `isOcclusionCard`（tag 或 `_occlusion` 命中）。已从 `utils/index.ts` 导出。
- `ImageOcclusionOverlay.tsx`：铺满图片容器的绝对定位层，按 spec 渲染遮挡
  矩形；点击揭开**同 clozeIndex 组**（Anki 语义）；支持受控
  （`revealedIndices`）/非受控/`revealAll` 三态。刻意不做：图片加载、
  拖拽编辑、复习调度。

## 7. 与 VlmFull 衔接的下一刀

当前 VlmFull 数据流：`图片 refs → VLM(prompt 要求 [IMAGE_DESC]) → 文本 →
制卡 LLM → 普通卡`。接入遮挡的最小改造（全部在管线外围，不动路由）：

1. **run 侧接线**（`chatanki_executor` 的 VlmFull 分支尾部，一个纯调用点）：
   对每个图片 ref，把 VLM 返回文本喂 `propose_boxes_from_image_desc`，
   非空则 `validate_spec` → `build_card_fields` → 组装一张
   `template_id=None`、`note_type=Cloze` 的 `AnkiCard`（`images` 填图片
   本地路径），随普通卡一起入库；校验拒绝则静默回退普通卡，违规写
   `_qa_flags` 留痕（复用 `anki_qa_lint::merge_flags` 的协议字段风格）。
2. **VLM grounding 升级**：给 VlmFull prompt 增加可选输出段
   `[OCCLUSION_BOXES: {imageRef, boxes:[...]}]`（JSON，归一化坐标），
   模型有坐标能力（Qwen-VL grounding / Gemini bbox）时直接产出真实盒；
   解析失败或校验不过 → 自动降级到启发式网格。`validate_spec` 已是两条
   来源的共同守门员，无需新代码。
3. **前端接线**：`AnkiCardPreviewPanel` / 复习面板对 `isOcclusionCard`
   命中的卡，用 `ImageOcclusionOverlay` 替换纯文本 cloze 展示；
   编辑器加矩形拖拽（写回 `_occlusion` 后重过 `parseOcclusionSpec`）。
4. **原生 IO note type 导出**（可选远期）：导出侧检测 `_occlusion` →
   生成 Anki 23.10 原生 Image Occlusion notetype 的 `Occlusion` 字段
   （`{{c1::image-occlusion:rect:left=…:top=…:width=…:height=…}}`），
   像素换算直接用 `to_pixel_boxes`。

## 8. 测试清单（30 个）

Rust（19，`cargo test --lib anki_image_occlusion`）：空盒/空引用/越界×3/
过小/NaN/重叠拒绝与贴边放行/超量/零序号/多违规聚合/补号补标签/同序号共存+
截断/IoU 数值×3/像素精确换算/贴边收敛+最小 1px+零尺寸图/导出字段+JSON
round-trip/无图+转义/破损 JSON 回读/serde camelCase 契约/启发式基础+可过
校验+两两不相交/退化全文+去重+截断+空输入/多标记合并。

vitest（11，`npx vitest run src/components/anki`）：解析契约/非法输入×5/
几何过滤/补号补标签/像素换算同数据镜像/贴边+零尺寸/百分比样式/遮挡卡判定/
组件初始遮挡/点击揭组+回调/revealAll+受控优先。

## 9. 边界与已知取舍

- 启发式网格盒的坐标**不对应图上真实位置**，价值是可编辑草稿；文档与
  函数注释都显式标注，避免误当 grounding 用。
- `excessive_overlap` 只查两两 IoU，不查「N 盒联合覆盖率」——首版
  `max_boxes=12` 下联合覆盖失控的前提是大量两两重叠，已被 IoU 规则拦截。
- `image_ref` 不解引用、不查文件存在性（纯函数边界）；媒体缺失由既有
  `collect_media_entries` 的 missing/warnings 机制兜底。

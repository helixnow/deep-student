# 图像遮挡坐标 Grounding 升级

日期：2026-08-24

## 结论

VlmFull 图像遮挡已从“仅依据 `[IMAGE_DESC]` 生成启发式网格”升级为：

`VLM 归一化坐标 → 解析与 validate_spec 校验 → 真实 box 草稿`

仅在坐标块缺失、为空、JSON 损坏或校验失败时回退原有
`propose_boxes_from_image_desc` 网格。没有引入新 note type，也没有新增真实 LLM
调用；模型调用次数与路由保持不变。

## 输出协议

`build_import_prompt` 允许 VlmFull 对适合遮挡复习的图像额外输出：

```text
[OCCLUSION_BOXES]
[{"x":0.1,"y":0.2,"w":0.3,"h":0.15,"label":"关键区域"}]
[/OCCLUSION_BOXES]
```

- `x/y/w/h` 均为 `[0,1]` 归一化坐标；
- 原点为左上角；
- 只框关键、可复习的局部区域，禁止框整页或大段无关背景；
- 没有合适区域时省略该块。

## 解析与降级

`parse_occlusion_boxes_from_vlm(text) -> Option<OcclusionSpec>` 是纯函数：

- 从完整 `[OCCLUSION_BOXES]` 块读取 `OcclusionBox` 数组；
- 容忍 Markdown JSON 围栏、块内数组前后文字、数组和对象尾随逗号；
- 使用内部占位图片引用构造 spec，并统一经过默认 `validate_spec`；
- 空盒、越界、过小、过量、非有限坐标或过度重叠均返回 `None`；
- 多块输出中前一块非法时可继续尝试后续合法块。

调用点 `append_vlmfull_occlusion_draft` 随后绑定实际直接图片 ref，并再次通过
共用 marker 构建边界校验。优先级固定为：

1. 合法 VLM 坐标；
2. `[IMAGE_DESC]` 启发式网格；
3. 两者都不可用时不生成遮挡草稿。

PDF 页面预览仍因缺少稳定逐页 `image_ref` 而不生成 marker；坐标块仍会被清理。

## 防垃圾卡

`strip_occlusion_boxes_blocks` 在坐标解析后、正文进入制卡链前删除完整协议块。
若 VLM 输出开始标记但遗漏结束标记，则从开始标记删除到文本末尾。该清理在没有
直接图片 ref 时同样执行，避免 JSON、围栏或协议标签进入普通卡正文。

内部 `[ANKI_OCCLUSION_DRAFT:...]` marker 的既有剥离和首张成功卡消费语义不变，
最终只把 `_occlusion` extra field 与 tag 合并进模型原先的普通卡；候选 Cloze
`Text`、图片媒体以及 `_occlusion` 到 APKG/AnkiConnect 的转换均未接，不会导出
为可复习的 Anki 遮挡卡。

## 测试覆盖

新增 Rust 测试覆盖：

- 合法 JSON 与真实坐标/标签保真；
- Markdown 正文夹杂、JSON 围栏和尾随逗号；
- 空块、坏 JSON、负坐标、`x+w > 1`、过小盒、过度重叠、超量盒；
- 多块输出的后续合法候选；
- 完整及未闭合协议块剥离；
- parser → 实际图片 ref → draft marker → `_occlusion` 回读；
- prompt 的可选块、归一化坐标、左上原点及“禁止整页”约束；
- `append_vlmfull_occlusion_draft` 的真实框优先、非法/空块网格回退；
- 无图片 ref 仍剥离协议，以及无 `IMAGE_DESC` 时合法真实框仍可工作。

所有测试均使用固定文本 fixture，不调用真实 LLM。

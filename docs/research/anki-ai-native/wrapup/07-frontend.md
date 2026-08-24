# Wrap-up #7：`anki_cards` 前端预览安全回归

## 结论

本轮只改前端与测试，没有修改 Rust。`_qa_flags`、`mediaReport`、空/错误/
cancelled 终态和 Image Occlusion overlay 均做了防御性收尾。

## 修复

- `_qa_flags`
  - 保持内部字段不进入卡片正文和编辑字段；
  - QA 详情改用 React 唯一 ID，避免同屏多个 `anki_cards` 块的
    `aria-controls` 指向重复元素。
- `mediaReport`
  - 允许报告在成功、错误或 cancelled 终态之后迟到补入，但不重开块，也不接受
    同一迟到 patch 夹带的状态/卡片覆盖；
  - 仅有媒体报告时不再显示无数据依据的 “AnkiConnect 检查中”。
- 空/错误/cancelled
  - `finalStatus` 做 trim 后再映射；
  - cancelled 明确压过迟到的 `completed_with_errors` 进度快照；
  - 取消原因使用 warning/status 语义，不再作为红色 error alert。
- Image Occlusion overlay
  - 渲染边界重新校验 spec，过滤非有限、退化、越界和非法 cloze index；
  - 浮点误差范围内的边界收敛到严格 `[0,1]`；
  - 与后端默认约束一致，最多渲染 12 个盒、标签最多 48 个 Unicode 字符；
  - 切换 spec 时同步隔离内部 reveal 状态，首帧不会泄漏上一张卡的答案；
  - mask/revealed 点击与键盘事件不冒泡，避免误触外层卡片翻面。

## Overlay 接线边界

当前 overlay 是安全的独立渲染层，但不能直接铺到整个模板卡面：坐标相对原图，
而模板卡面可能包含 Shadow DOM、文本和多张图片。生产接线必须先取得与
`imageRef` 对应的图片容器，再把 overlay 放入该容器；否则坐标虽安全但位置错误。

## 验证范围

相关 Vitest 覆盖：

- QA 解析/展示、跨块 ARIA ID；
- `mediaReport` 正常、迟到、错误与 cancelled 数据流；
- 空、错误、取消状态映射和视觉语义；
- overlay 非法输入、边界收敛、跨卡 reveal 隔离及事件冒泡。

云端未做交互式浏览器人工验证；UI 行为由 jsdom + Testing Library 覆盖。

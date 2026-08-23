# Round 19 落地（claude-fable-5-thinking-xhigh）

## 已修

- TranslationPopover 交换/重试 coarse 伪元素 44
- generic 块展开/复制 coarse ≥44
- NotesCrepeEditor pane 五枚工具钮 coarse min 44
- FolderPickerDialog 展开钮 coarse 44（负 margin 保缩进）
- 作文 InputPanel 轮次 prev/next/圆点 coarse ≥44
- ActiveSkillBadge / FolderContextChip 关闭 X 伪元素 44

## 核实（未删，留给 20）

- `reference-selector/` 生产零挂载，可整目录删（须清 barrel）
- `DndFileTree/` 组件死、须先迁 `TreeData` 类型
- InvalidReferenceOverlay 本轮并发上限未启动

## 仍开（Round 20+）

- ExamSheetUploader / 维护横幅 / 番茄钟 / 复习勾选 / 来源翻页 / LLM 刷新 / NotesEditorHeader / TodoQuickAdd <44
- PluginsTab 详情自绘返回（返回键已接）
- notes 孤儿目录删除

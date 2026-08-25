# Round 20 落地（claude-fable-5-thinking-xhigh）

## 已修

- 删 `reference-selector/` 整目录 + barrel；删 `InvalidReferenceOverlay`（Icon 仅被死 DndFileTree 用）
- ExamSheetUploader 确认/全选/续导 coarse `min-h-11`
- 番茄钟触屏控制/停止 40→44；维护横幅按钮 coarse `min-h-11`
- 复习勾选改按 pointer；来源翻页 coarse 44
- LLM 用量刷新 coarse 44 + aria-label；NotesEditorHeader 标签 X 伪元素 44
- TodoQuickAdd chip 移除 44；作文清空钮套 `COARSE_HIT_SM`
- PluginsTab 小屏详情隐藏自绘「返回列表」

## 仍开（Round 21+）

- BulkActionBar 优先级/删除漏 coarse；TagFilter/SearchResultList「更多」
- AgentOutputDrawer 32；MemoryView 备注编辑；题库草稿条/chips
- QuestionBankEditor 重做/解析；LearningHeatmap 重试
- DndFileTree 组件死、须先迁 TreeData

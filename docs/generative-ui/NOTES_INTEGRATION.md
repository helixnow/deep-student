# Notes 模块 × Generative UI 集成规范

> 合并 [调研 Notes 生成式集成](bc-770ae86e-b50a-58e0-be31-80efbcad0e93) 结论

## 集成 hook 点（优先级）

| 宿主 | 场景 | 块类型 |
|------|------|--------|
| `NotesContextPanel.tsx` | 学习摘要 / 知识图谱预览 | list + key-value-grid + stat-card |
| `NotesCrepeEditor.tsx`（AIDiffPanel 旁） | AI 编辑影响预览（确定性，无需模型） | stat-card + alert |
| `NotesHome.tsx` | 本周学习概览 | 复用 `LEARNING_DASHBOARD_EXAMPLE` |
| `NotesTemplatePanel.tsx` | 模板推荐 | list + action-bar |

## 写入规约（必须）

1. **禁止** generative handler 直接调用 `saveNoteContent` / 后端 write API
2. 所有写操作走 `canvas:ai-edit-request` 建议通道 + OCC（`expected_updated_at`）
3. 与 `useCanvasAIEditHandler` **单槽位**互斥——不可并行第二条 pending 建议
4. 摘要类读取用 `getFullMarkdown()` 或 DSTU，勿用窗口化截断的 `getMarkdown()`

## 预留词条

`editor.generative`（zh-CN/en-US notes.json）已定义但未接线——可作为编辑器 AI 续写模式 + GenerativeUIChrome 的 i18n 入口。

## Round 3 POC 计划

- [ ] `NotesContextPanel` 只读摘要分区（`GenerativeUIPanel` + learningHubApi）
- [ ] AIDiffPanel 顶部 deterministic 变更摘要
- [ ] generative-ui 组件 i18n 化（接入 notes/common 词条）

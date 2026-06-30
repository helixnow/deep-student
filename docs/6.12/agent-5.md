# 代理 5 —— 制卡与间隔重复

> 先读 [README.md](./README.md) 总览,遵守全局规则;状态文档:`docs/6.12/status/agent-5-status.md`。

## 1. 负责域

"理解 → 长期记忆"的固化链:Anki 服务族(对接 AnkiConnect、APKG 导出、流式批量制卡)、
间隔重复(SRS)、复习计划,以及制卡界面、模板编辑器、模板管理。

## 2. 模块清单

### 后端(src-tauri/src)
| 模块 | 路径 | 要点 |
|------|------|------|
| AnkiConnect 对接 | `anki_connect_service.rs`(~30KB) | 与本机 Anki 通信、同步 |
| APKG 导出 | `apkg_exporter_service.rs`(~57KB) | 离线卡包生成 |
| 增强制卡 | `enhanced_anki_service.rs`(~39KB) | 制卡增强逻辑 |
| 流式批量制卡 | `streaming_anki_service.rs`(~98KB) | 批量生成、断点续传、任务看板后端 |
| 间隔重复 | `spaced_repetition.rs` | SRS 算法 |
| 复习计划 | `review_plan_service.rs`(~30KB) | 复习调度 |

### 前端(src)
| 模块 | 路径 | 要点 |
|------|------|------|
| Anki 特性 | `features/anki/`、`components/anki/` | 制卡流程、任务看板 |
| 模板编辑器 | `components/RealTimeTemplateEditor/`、`MinimalTemplateEditor.tsx`(~46KB)、`EnhancedTemplateEditor.tsx`(~36KB)、`FieldTypeConfigurator.tsx` | HTML/CSS/Mustache 可视化编辑、实时预览 |
| 3D 预览 | `components/Card3DPreview.tsx`、`AnkiCardPreviewModal.tsx` | 翻转预览 |
| 模板管理 | `features/template-management/` | 模板库、批量导入 |
| CSV 导入 | `components/CsvImportDialog.tsx`、`CsvFieldMapper.tsx` | 字段映射 |
| 对话内制卡入口 | `features/chat/anki/` | 与代理 1 的边界:UI 入口归本组,对话管线归代理 1 |

## 3. 不归属本组(别改)
- 题目数据结构 → 代理 4(本组将题目转为卡片,只消费其 schema)。
- 笔记内容来源 → 代理 6。
- 对话 Pipeline 触发逻辑 → 代理 1。

## 4. 审阅重点清单
- [ ] streaming_anki_service(98KB):批量制卡的并发控制、断点续传状态机、任务取消的资源清理。
- [ ] LLM 生成卡片内容的容错:畸形输出、字段缺失、HTML 注入(卡片模板会执行 HTML/CSS)。
- [ ] 模板系统安全:Mustache 渲染的 XSS 面、用户自定义 HTML/CSS 的沙箱边界(预览 iframe?)。
- [ ] AnkiConnect:Anki 未启动/版本不兼容的错误提示、同步冲突(同名牌组/模板)处理。
- [ ] APKG 导出:媒体文件打包完整性、大批量导出内存占用、与 Anki 官方格式兼容性。
- [ ] SRS 算法正确性:间隔计算、逾期处理、时区/夏令时影响。
- [ ] 复习计划与待办/番茄钟(代理 7)的联动是否存在隐式耦合。
- [ ] 模板编辑器体验:实时预览性能(防抖)、编辑器(CodeMirror)大模板卡顿、撤销栈。
- [ ] 任务看板:进度上报准确性、失败任务重试入口。

## 5. 跨组接口
- 消费代理 4 的题目 schema:变更由代理 4 主导,本组适配。
- 制卡内容生成经代理 1 的 LLM 层:只消费。
- 卡片素材(图片等)取自代理 2 的 VFS:只读。

## 6. 验证
按 README 3.4 执行;本组重点:`cargo test anki`、`cargo test spaced_repetition`、
`cargo test review_plan`、`npm test -- anki`、`npm test -- template`。

# 代理 6 —— 内容创作工作台

> 先读 [README.md](./README.md) 总览,遵守全局规则;状态文档:`docs/6.12/status/agent-6-status.md`。

## 1. 负责域

四个"编辑器型"特性的前后端:笔记(Milkdown)、知识导图、翻译工作台、AI 作文批改。
它们交互模式相似(编辑器 + AI 辅助),统一审阅交互一致性。

## 2. 模块清单

### 笔记
| 端 | 路径 | 要点 |
|----|------|------|
| 后端 | `notes_manager.rs`(~83KB)、`notes_exporter.rs`(~115KB) | 笔记 CRUD、标签、多格式导出 |
| 前端 | `features/notes/`、`components/crepe/` | Milkdown(crepe)富文本、NotesHome/NotesHeader |

### 知识导图
| 端 | 路径 | 要点 |
|----|------|------|
| 前端 | `features/mindmap/` | React Flow(@xyflow)导图/大纲双视图、右键编辑、背诵遮挡模式、AI 生成与多轮编辑 |

### 翻译工作台
| 端 | 路径 | 要点 |
|----|------|------|
| 后端 | `src-tauri/src/translation/` | 翻译 Pipeline、领域预设 |
| 前端 | `src/translation/`、`components/translation/` | 全文/逐段双栏、同步滚动 |

### 作文批改
| 端 | 路径 | 要点 |
|----|------|------|
| 后端 | `src-tauri/src/essay_grading/` | 多场景多维度评分 |
| 前端 | `src/essay-grading/`、`components/essay-grading/`、`components/EssayGradingWorkbench.tsx`(~36KB) | 批改标注、评分展示、逐句润色对比 |

## 3. 不归属本组(别改)
- Milkdown 之外的基础 UI 组件 → 代理 7。
- 笔记的向量化入库 → 代理 2(本组保存笔记,索引由数据层负责)。
- AI 调用底层(供应商适配)→ 代理 1。
- 调研报告"自动保存为笔记"的调研端 → 代理 1(本组只管笔记接收端)。

## 4. 审阅重点清单
- [ ] notes_exporter(115KB):各导出格式(MD/HTML/PDF/DOCX?)的保真度、特殊字符/数学公式/图片转换。
- [ ] Milkdown 编辑器:大文档输入卡顿、粘贴富文本/图片的清洗(XSS)、撤销栈、与保存时序(防丢字)。
- [ ] 笔记自动保存策略:防抖间隔、冲突(同一笔记多入口打开)处理。
- [ ] 导图:大图(500+ 节点)渲染性能、AI 多轮编辑的节点 diff 正确性、导图↔大纲双向转换无损性、背诵模式遮挡逻辑。
- [ ] 翻译:长文分段策略、双栏同步滚动的映射准确性、流式翻译中断恢复、术语偏好注入。
- [ ] 作文批改:批改标注与原文偏移的对齐(高亮错位)、多轮迭代的状态管理、评分维度自定义的边界。
- [ ] 四个特性的交互一致性:快捷键、保存提示、AI 加载态、错误提示风格是否统一。
- [ ] LLM 输出畸形时(JSON 解析失败)的兜底体验。

## 5. 跨组接口
- 笔记保存后触发代理 2 的索引:只发事件,不改索引实现。
- AI 生成(导图/翻译/批改/笔记辅助)经代理 1 的 LLM 层:只消费。
- 导图/笔记内容被代理 5 制卡消费:输出结构变更需登记。

## 6. 验证
按 README 3.4 执行;本组重点:`cargo test notes`、`cargo test translation`、
`cargo test essay`、`npm test -- notes`、`npm test -- mindmap`、`npm test -- translation`。

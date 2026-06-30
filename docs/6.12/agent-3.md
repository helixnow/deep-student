# 代理 3 —— 文档解析与阅读

> 先读 [README.md](./README.md) 总览,遵守全局规则;状态文档:`docs/6.12/status/agent-3-status.md`。

## 1. 负责域

"文档 → 图像 → OCR → 结构化"整条处理链,以及直接消费这些服务的 PDF/DOCX 阅读器界面。

## 2. 模块清单

### 后端(src-tauri/src)
| 模块 | 路径 | 要点 |
|------|------|------|
| 文档解析 | `document_parser.rs`(~151KB) | PDF/DOCX/PPTX/XLSX 等全格式解析 |
| PDF OCR 服务 | `pdf_ocr_service.rs`(~58KB)、`pdfium_utils.rs`、`pdf_protocol.rs` | pdfium 渲染、OCR 调度、自定义协议 |
| OCR 适配器 | `ocr_adapters/`(6 引擎)、`deepseek_ocr_parser.rs`、`ocr_circuit_breaker.rs` | 多引擎适配、熔断 |
| 图像处理 | `page_rasterizer.rs`、`figure_extractor.rs`、`cross_page_merger.rs` | 光栅化、图表提取、跨页合并 |
| 视觉定位 | `vlm_grounding_service.rs`(~46KB) | VLM 视觉定位 |
| 多模态 | `multimodal/` | 图片/混合输入处理 |
| LLM 结构化 | `llm_structurer.rs` | 解析结果结构化 |

### 前端(src)
| 模块 | 路径 | 要点 |
|------|------|------|
| PDF/DOCX 阅读器 | `features/pdf/` | 分屏联动、双页阅读、书签标注、页码引用跳转、选区注入聊天 |
| 图像组件 | `components/ImageViewer.tsx`、`ImageCropDialog.tsx`、`ExamPageImage.tsx`、`CroppedExamCardImage.tsx`、`DocumentViewer.tsx` | 查看/裁剪 |
| 相关 hooks | `hooks/usePdfLoader.ts`、`usePdfProcessingProgress.ts` | 加载与进度 |

## 3. 不归属本组(别改)
- 向量化入库与检索 → 代理 2(本组产出解析结果,不管入库)。
- 试卷切题业务逻辑(`exam_sheet_service.rs`)→ 代理 4(它调用本组 OCR)。
- 阅读器侧边的聊天面板逻辑 → 代理 1(本组只管"选区→注入"的数据出口)。

## 4. 审阅重点清单
- [ ] document_parser(151KB 单文件):按格式分段审阅,重点是畸形文件的健壮性(panic 风险、OOM 风险)。
- [ ] 6 个 OCR 引擎适配的一致性:错误分类、超时、重试、熔断(ocr_circuit_breaker)阈值是否合理。
- [ ] OCR 失败降级链路:引擎 A 失败 → 引擎 B 的切换逻辑与用户感知。
- [ ] pdfium 内存管理:大 PDF(500+ 页)的渲染内存、句柄释放。
- [ ] 跨页合并与图表提取的正确性(截断、重复、错位)。
- [ ] pdf_protocol 自定义协议的安全性:路径校验、越权读取。
- [ ] 阅读器前端:大文档翻页性能、页面缓存策略、内存占用;选区→聊天注入的数据完整性。
- [ ] 页码引用跳转的准确性(OCR 页码 vs 渲染页码偏移)。
- [ ] DOCX/PPTX 预览(docx-preview/pptx-preview)的样式保真与 XSS 防护(DOMPurify 是否覆盖)。

## 5. 跨组接口
- 解析/OCR 输出结构 → 代理 2 入索引:结构变更双方登记同步。
- 代理 4 的试卷切题调用本组 OCR:保持调用契约稳定。
- VLM 调用经代理 1 的 LLM 管理层:只消费,不改适配实现。

## 6. 验证
按 README 3.4 执行;本组重点:`cargo test document_parser`、`cargo test ocr`、
`cargo test pdf`、`npm test -- pdf`。建议准备畸形/超大样本文件做手动冒烟。

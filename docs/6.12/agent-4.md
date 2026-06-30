# 代理 4 —— 题库与练习

> 先读 [README.md](./README.md) 总览,遵守全局规则;状态文档:`docs/6.12/status/agent-4-status.md`。

## 1. 负责域

"出题 → 练习 → 判分 → 统计"完整业务闭环:题库服务族、AI 判分、试卷切题、
练习/模拟考界面、做题历史与知识点统计。

## 2. 模块清单

### 后端(src-tauri/src)
| 模块 | 路径 | 要点 |
|------|------|------|
| 题库核心 | `question_bank_service.rs`(~76KB) | 题目 CRUD、题集管理 |
| 题目导入 | `question_import_service.rs`(~145KB) | AI 提取/生成题目、格式解析 |
| 题目导出 | `question_export_service.rs` | 多格式导出 |
| 题目同步 | `question_sync_service.rs`(~76KB) | 题库同步 |
| AI 判分 | `qbank_grading/` | 自动判分、深度解析 |
| 试卷切题 | `exam_sheet_service.rs`(~63KB) | 试卷上传→切题(调用代理 3 的 OCR) |

### 前端(src)
| 模块 | 路径 | 要点 |
|------|------|------|
| 练习特性 | `features/practice/`、`components/practice/` | 每日练习、限时练习、模拟考、做题界面 |
| 试卷上传 | `components/ExamSheetUploader.tsx`(~57KB)、`ExamCardImage.tsx` | 上传与切题预览 |
| 统计 | `components/stats/` 中题库相关、`hooks/useStatisticsData.ts`、`useQbankAiGrading.ts`、`useQuestionBankSession.ts`、`useExamSheetProgress.ts` | 知识点掌握率、历史回顾 |

## 3. 不归属本组(别改)
- OCR 引擎实现 → 代理 3(本组只消费切题结果)。
- 题目→制卡链路的制卡端 → 代理 5(题目数据结构以本组为准,变更要通知)。
- 通用图表组件 → 代理 7。

## 4. 审阅重点清单
- [ ] question_import_service(145KB):AI 提取题目的解析健壮性(LLM 输出畸形 JSON 的容错)、批量导入的事务性。
- [ ] 判分正确性:客观题判分边界(多选漏选/乱序、填空空白符/大小写)、主观题 AI 判分的提示词与失败兜底。
- [ ] 限时练习/模拟考计时:后台切换、休眠恢复后的计时准确性;提交竞态(重复提交、超时自动交卷)。
- [ ] 做题历史与统计:掌握率计算口径一致性、大数据量下的查询性能。
- [ ] 题目同步服务:冲突解决策略、幂等性。
- [ ] 试卷切题:切题框与原图坐标换算、多页试卷跨页题处理。
- [ ] 做题界面体验:键盘快捷作答、答案防误触提交、深度解析的加载状态。
- [ ] 题目富文本(LaTeX/图片)在出题、做题、解析三处渲染一致性。

## 5. 跨组接口
- 调用代理 3 的 OCR 切题:只消费,问题登记跨组。
- 题目数据结构被代理 5(制卡)消费:schema 变更必须在状态文档登记并通知。
- AI 出题/判分经代理 1 的 LLM 管理层调用:只消费。

## 6. 验证
按 README 3.4 执行;本组重点:`cargo test question`、`cargo test qbank`、
`cargo test exam_sheet`、`npm test -- practice`。

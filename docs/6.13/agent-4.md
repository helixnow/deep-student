# 代理 4（round 2）—— 题库与练习

> 先读 `docs/6.13/README.md`，再通读 `docs/6.12/status/agent-4-status.md`（33 项发现，15 bug 已修 + 总结）。

## 已完成（第一轮，勿重做）
第一轮已修 15 个 bug + 2 个测试（VLM 断点去重、选项剥离、JSON 导入事务、判分标签取末组、热力图聚合源、本地日界线、编辑漏标 modified、模拟考钳制/竞态、墙钟计时、快捷键放行、富文本统一 LatexText 等）。

## 本轮任务（按优先级）

### P1 — 死代码清理
- [ ] **#23** `components/ExamCardImage.tsx`、`CroppedExamCardImage.tsx`、`ExamPageImage.tsx`："文档25"迁移产物，全仓无 import（仅 `style-lab/scan-data.json` 扫描记录）。
  - ⚠️ 注意：`CroppedExamCardImage.tsx` 在第一轮被代理 3 的 I2 修复触碰过（说明它曾被当作活动文件审）。**删除前务必再次 grep 确认无任何 import/JSX/lazy 引用**（`tsc` 兜底），确认死后再删三件套。

### P3 — 产品取舍（只出方案，等用户拍板）
- [ ] **#6** `question_import_service.rs:run_vlm_direct_extraction`：VLM 中途失败但已存部分题时仍标会话 `completed`，用户无"缺题"提示。方案 A=改"部分成功"语义（保留可恢复）；方案 B=完成但显式提示缺题数。
- [ ] **#20** `question_sync_service.rs:batch_resolve_conflicts`：逐条失败仅 warn，全失败也返回 `Ok([])`，前端无法感知部分失败。改返回 `{resolved, failed}` 需改前后端接口。
- [ ] **#27** `QuestionInlineEditor`（出题）：纯文本输入无公式预览（四 AI 工作台里唯一）。属功能增强。

## 验证
`cargo check`；`npm run typecheck`/`lint`；`npm test -- practice` 与 `question-bank`。删组件后跑 `tsc` 确认无悬空引用。

## 备注
第一轮结论：判分/统计/同步链路经全面加固，质量高。本轮以**清理 + 产品项出方案**为主。

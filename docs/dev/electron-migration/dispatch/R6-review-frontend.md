# R6-review-frontend：前端插件化 F1 独立复核

你是独立验收人（全新上下文）。对 U1-ui-boot、U2-ui-shell、U3-ui-settings、U4-ui-content 的改造做等价性审读，依据 `docs/plugins/FRONTEND-F1.md`。

- 只读实现；只写 `src/ui-plugins/ACCEPTANCE.md` 与 `docs/dev/electron-migration/audits/R6-review-frontend.md`。各 lane 分支：`git show ds-mig/<lane>:<路径>`，或在你的工作树 `git merge` 对方分支到临时分支阅读（不要提交合并）。
- 逐 lane 核对：golden 取证提交确实早于改造提交且内容覆盖全部条目；对照测试真实比较（不是自证）；原有每个 `currentView`/条件分支在新元数据中都有等价表达（列对照表）；懒加载边界未被破坏（检查是否把页面组件静态导入了首屏模块，可用构建产物 chunk 对比）；文案键/图标/顺序一致；演示壳构建通过；社区贡献有错误隔离。
- 亲自运行规格 §1 第 3 条的全部命令并贴结果。
- 结论格式同其他复核（必须修复 / 建议 / 已核实），问题派回由 C1 协调者处理；各 lane 修复后你按编号复核勾选。
- 在某条 lane 尚未完成时，先审已提交部分，写明审读基线提交。

# F-fe ScrollArea focus 修复

## 基线与范围

- 独占工作区：`wt/W26`，开工 clean，已 `git merge --ff-only bead2d18`。
- 原始证据：根目录 `.reports/server/land-test-F-fe/{summary.json,failure-details.json}`。
- failure-details 中 87 条含 `Cannot set property focus ... which has only a getter`，集中于 `runWithoutOutsideRefocus` 初始化/销毁；W09 另确认 cloud-only-delete-conflict 的 6 条按钮缺失也是此异常使树卸载。
- 仅修改 ScrollArea 焦点临时覆盖、直接回归与获授权的过时源码契约；DOM/class、golden、全局 setup、业务测试均未改。

## 根因与修复

`active.focus = skipFocus` 在继承的 getter-only 属性下抛 TypeError。改为 `Object.defineProperty` 临时遮蔽；保存自身 descriptor，在 finally 原样恢复，原先无自身属性则删除临时属性。不可配置的自身属性不改写，仍运行库生命周期。焦点位于目标内部时仍允许库回填，保持焦点需求不变。

对照已安装 OverlayScrollbars 的 `appendElements`/cleanup：库确实在包装/解包结束时调用 focus。真实库集成测试确认实例完成销毁、外部 activeElement 保持、focus 可继续调用且没有遗留自身属性。

源码契约旧断言要求 RTL 三元表达式，但真实实现已在 RTL 返回前恢复 noContent 子规则；更新契约匹配当前分支，`scrollAreaNoContentRule.test.tsx` 已实际验证 LTR 空返回、RTL 恢复规则再返回方向。

## 验证

所有 Vitest 命令均限定 `--maxWorkers=2 --minWorkers=1`，未跑全量。

1. `npx vitest run src/components/ui/__tests__/scrollAreaRefocus.test.tsx src/components/ui/__tests__/scrollAreaRefocus.integration.test.tsx src/components/ui/__tests__/scrollAreaNoContentRule.test.tsx src/components/ui/__tests__/scrollAreaOverlayOptions.test.tsx tests/vitest/scrollbarVisualContract.test.ts --maxWorkers=2 --minWorkers=1`
   - 5 文件 / 29 条通过；随后为异常销毁新增 2 条，下批复验 refocus 共 9 条通过。
2. `npx vitest run src/components/ui/__tests__/scrollAreaRefocus.test.tsx tests/vitest/modernSidebarNavigation.test.tsx src/features/workbench/components/__tests__/AppsPanel.test.tsx tests/vitest/command-palette/commandPaletteA11yContract.test.tsx tests/vitest/command-palette/commandPaletteWorkbenchScope.test.tsx --maxWorkers=2 --minWorkers=1`
   - refocus 9、ModernSidebar 45、AppsPanel 27、commandPaletteA11y 10 全通过。
   - WorkbenchScope 首次收集被缺失的 ignored 生成文件 `src/version.ts` 阻断；按仓库脚本执行 `DEEP_STUDENT_BUILD_NUMBER=20000 npm run version:generate`（无完整历史基线，显式沿用 F-fe build number），单独重跑 WorkbenchScope 1 条通过。
3. `git diff --check` 通过。

最终定向结果：9 文件、114 条唯一用例通过。新增 getter 回归显式构造 F-fe 的只读 accessor 形态；本地共享依赖 jsdom 为 24.1.3。此结果是定向验证，不代表完整 F-fe 复跑。W09 的 8 条由其采用提交后独立回归。

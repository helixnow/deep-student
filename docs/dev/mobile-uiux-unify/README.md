# 移动端 UI/UX 统一优化

本目录记录 **cursor/mobile-uiux-unify-0888** 专属分支的方案、盘点与持续打磨进度。

父代理（云端主对话）只做文档/进度记录；页面落地与测试由子代理完成。Round 90 已收尾，PR #172 可审。

## 统一规范（验收口径）

1. **全局顶栏唯一**：所有移动页面通过 `useMobileHeader(viewId, config)` 注册到 App 级 `UnifiedMobileHeader`。禁止页面自绘第二条顶栏，禁止把后退/次级入口放到全局顶栏之外。
2. **左侧按钮**：主入口页 = 呼出侧栏（☰）；次级/子页 = 后退。不要同时在页内再放一套返回。
3. **右侧按钮**：次级页面或当前页不超过 2 个快捷动作（每个 ≥44px）。更多动作收进页内「更多」菜单。
4. **禁止桌面组件滥用于移动**：`ResizablePanel`、宽表、hover-only 操作、桌面标题栏/工具栏在窄屏上导致嵌套、溢出或不可点。
5. **可达且可回退**：每个页面必须能从抽屉、命令面板或明确入口进入，并且能回到上一页（顶栏返回、系统返回键或等价手势）。缺一即设计错误。

## 与其他并行任务的边界

本分支只改移动壳、各视图的移动 chrome、可达/回退与窄屏溢出。不碰：

- capability / mythos / 注册表（#170 #171）
- FTP tombstone / CI heap（#168 #169）
- 笔记「生成卡片」（#167）
- 命令面板 a11y / 数据治理 Debug（#166）
- 设计系统 token / 暗色阴影 / 字号缩放（#164 #165 #159）
- 工作台桌面壳（#161）
- Finder hostId 分桶（#162）
- 练习闭环（#160）

可互补：本分支消费上述 PR 已落地的 token/a11y，但不改同一文件的同一段落。

## 视图清单

见 [INVENTORY.md](./INVENTORY.md)。进度见 [PROGRESS.md](./PROGRESS.md)。

## Wave2-C（0824-wave2-mobile-uiux-a875）

上述五条规范不变，仍是 Wave2-C 的验收口径。触控机制载体调整为 `DsButton` primitive 的 coarse 能力下沉、`TouchTarget`、`coarseHit` 逃生舱，以及 ESLint `ds-components/coarse-touch-target`：`input-bar` 已提升为 `error`，全局其余范围保持 `warn`。

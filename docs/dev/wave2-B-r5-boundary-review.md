# 0824 Wave2-B 第 5 轮 — 边界审阅（审阅员-边界）

> 审阅对象：本轮工作区未提交 diff（基线 `2e1c147c`，29 个修改文件 +
> 19 个新增文件，含 6 份 r5 文档）。
> 口径：静态读码 + grep（第 8 轮前禁止编译/跑测试，遵守）；禁止 npm（遵守，
> 未执行任何 npm/包管理命令）。

## 一、越权检查（逐项结论）

| 禁区 | 检查方式 | 结论 |
|---|---|---|
| C：44px / 移动 chrome | `git diff` 全文 grep `44px/min-height: 44/coarse/mobile/touch`；PDF viewer 两文件增量单独复查 | **未越权**。唯一命中在 `DesktopContextMenu.css:1243`，为既有注释的上下文行（该 hunk 仅在其上方新增桌面命名菜单头样式，44px 段零改动） |
| E：anki / qbank / questionBankStore / cardAgent 实现 | diff 文件名 grep + `integrationManifest.ts` 全文审读 | **未越权**。diff 无任何 E 域文件；`integrationManifest.ts` 对 anki/qbank 只做**登记 + 懒加载透传**（`await import('@/features/pdf/selectionStudyActions')`，该文件本轮零改动），值导入零 E 域符号，仅 `selectionStudyActions` 的 **type** 导入（编译期擦除） |
| A：tool_loop / cache | diff 文件名 grep | **未越权**。diff 全部位于 `src/`（前端），无 `src-tauri` 触碰 |
| D：coordinator.rs | 同上 | **未越权**。零 Rust 文件改动 |
| GenUI 只读冻结 | `openResourceActionHandlers.ts` / `buildOpenResourceEntryBlock.ts` / bridge 增量全文审读 | **合规**。新增 handler 只派发既有只读导航契约（`DSTU_OPEN_NOTE` / `pdf-ref:open`），零 save/create/dstu 写 API；目标 id/页码强校验（白名单形状 + 长度 + 页码上限），非法反解为 null 不注册。`integrationManifest.ts` 头注亦明示 GenUI 不进能力表 |
| finder 未合桶 | diff 文件名 grep `finder` | **合规**。`finderStore.ts` 及分桶调用点零触碰；handoff 走独立 descriptor（`handoffDescriptor.ts` 头注、r5-handoff 文档 §1 均明示「不合并 Finder bucket」） |
| 快照未塞草稿 | `snapshot.ts` 零 diff；新增持久化键逐一核对 | **合规**。`snapshot.ts` / `pickShellFields` 未动。新键均独立于 `desktop.workbenchSnapshot`：`desktop.workbenchHandoff`（handoff descriptor）、`desktop.workbenchDesktopName`（桌面命名，store 头注明示刻意不进快照）。App.tsx 交接 launch 的 `innerRoute` 以瞬态 payload 透传，不落快照 |

其余改动（Notes 搜索浮层/局部图谱、PDF 批注面板、crepe `pdfRef` 插件、
桌面命名、i18n 键）均在 B 组可写清单内；`pdfRef` 插件复核为纯只读导航
（点击 `pdfref://` 链接 → 派发既有 `pdf-ref:open`，零写路径）。

## 二、handoff / Agent 接线核验

### 已核验为通的

- **consume 已调用**：`App.tsx` false→true effect 调用
  `consumeHandoffDescriptor()`（模块内先删再判 + 15min 新鲜度），
  prevRef 短路防重复交接，移动平台双重护栏，registerAll 动态引入
  时序护栏 + `workbenchBus.isEnabled()` 复查——与 r5-handoff 文档 §6 一致。
- **openPdfPage 签名正确**：`workbenchBus.openPdfPage(req: OpenPdfPageRequest)`
  ＝ `{ typeId: PdfPageActivationTypeId; resourceId: string; page: number;
  fallbackLaunch?: boolean }`；App.tsx 调用点
  `{ typeId, resourceId: instanceKey, page }` 逐字段吻合，typeId 先经
  `PDF_PAGE_ACTIVATION_TYPE_IDS` 白名单收窄再断言。委托链
  `activateDetailed('gotoPage')` → `pdfFocusAck` 为既有通道，
  `fallbackLaunch`（`ActivateRequest.fallbackLaunch?: LaunchRequest`，
  types.ts:528）形状吻合。
- **openNoteAnchor 签名正确**：委托 `activateDetailed('note','scrollToHeading')`，
  payload `{ heading, level? }` 与工作区注册表既有 action 吻合。
- **integrationManifest 薄执行器**：四个入口均为纯透传/懒加载，符号
  （`openChatSession`、`registerAll`、`makeCardsFromSelection`、
  `sendSelectionToQuestionGeneration`）经 grep 确认真实存在。

### 发现的确定性断裂（已打最小补丁）

**`handoffWorkbenchToLegacyShell` 零调用方**：handoff-1 建好了采集/落盘/
导航对齐（`legacyNavigationMap.ts`），handoff-2 建好了消费侧（App.tsx），
但落盘侧的调用点在 `workbenchMode.ts` / `WorkbenchSettingsSection.tsx`
辖区，两卡都不可写，r5-handoff 文档 §5/§6-① 已如实记账「无调用方」。
后果：descriptor **永远不会被写入**，App.tsx 的 consume 恒得 null，
Workbench→经典壳方向完全无交接（用户落回无关旧视图），经典壳→Workbench
仅剩 currentView 兜底——本轮 P3 handoff 的 round-trip 主通道整体死路，
属任务卡口径的「接线断裂」。

**最小补丁**（2 文件，各 +1 import +1 调用，禁区零触碰）：

1. `src/features/settings/components/workbenchMode.ts`
   `persistWorkbenchModeEnabled(false)`：save_setting 成功后、
   `setEnabled(false)` / 派发 `WORKBENCH_MODE_CHANGED` 之前调用
   `handoffWorkbenchToLegacyShell()`——覆盖侧边栏快捷开关、品牌菜单
   「退出学习桌面」、`WorkbenchModeSwitchRow` 三个入口。
2. `src/features/settings/components/WorkbenchSettingsSection.tsx`
   `handleModeChange(false)`：同一插入点（persist ok 之后、
   `setEnabled(false)` 之前），覆盖设置页总开关。

插入点依据 `legacyNavigationMap.ts` 头注契约：「停用事务返回 ok 之后、
workbenchActive 翻 false / 卸载 LazyWorkbenchDesktop 之前」——此时
windowStore 焦点窗与单实例工作区注册表仍完整（`deactivationTransaction`
为纯预检不关窗，已核）；且置于 persist 成功之后，save 失败时不会写
descriptor 也不会预先导航经典壳视图。调用包 try/catch：交接是尽力而为
的增强，绝不阻塞停用。两处 `console.warn` 依赖的 `getErrorMessage`
均为文件内既有 import。

体积/循环依赖核验：`legacyNavigationMap` 已被 App.tsx 静态引入
（`installLegacyNavigationFallback`），从 settings 模块引用不新增首屏
chunk；`legacyNavigationMap` → `handoffDescriptor` → windowStore /
resourceWorkspaceRegistry 依赖链不回指 settings，无环。

刻意不接的（维持 r5 裁决，非断裂）：app-exit / breakpoint 路径不交接
（退出无壳可交接、断点自 r2 起不换壳）；经典壳侧不消费 innerRoute
（双消费方优先序未裁决，consume 一次即清不可两侧共用，见 r5-handoff §6-②）。

## 三、遗留（移交，非本卡修）

- innerRoute 提供者注册表仍空（r5 裁决「只建通道不接线」）：descriptor
  现阶段实际只含 appType+resourceId，`page:<n>`/`tab:<id>` 供给待各应用
  在自身可写清单内注册。
- `handoffWorkbenchToLegacyShell` 的落盘→导航现已接通，但运行时行为
  仍未经执行验证（第 8 轮前禁编译/测试），测试要点见 r5-handoff §4。

## 四、验证口径声明

静态读码 + grep,未编译、未跑测试、未使用 npm。补丁涉及文件的符号引用
（`handoffWorkbenchToLegacyShell` / `getErrorMessage` /
`closeBrowserForDisabledGate`）逐一 grep 确认存在且可达。

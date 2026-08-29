# 0824 Wave2-C R1 扫描台账 · 05 设置页族 + 数据治理（移动）

- 扫描员：设置与数据治理移动（claude-fable-5-thinking-high，只静态审阅）
- 规范依据：docs/dev/mobile-uiux-unify/README.md 五条（①全局顶栏唯一 ②左侧按钮语义 ③右侧≤2且≥44px ④禁桌面组件滥用 ⑤可达且可回退）
- 仓库只读；未运行任何构建/测试。不变量 13–15（WebDAV decode_path / S3 normalize_endpoint / FTP 白名单）未触碰，且本轮扫描确认所列文件均未涉及这三处后端逻辑（SyncTab 仅做展示层错误分类，见 SyncTab.tsx:109-116 注释「不改引擎」）。

---

## 一、逐页五条核验表

结论符号：✓ 合规 / △ 有瑕疵（见问题清单）/ ✗ 违规。

| 文件 | ①顶栏唯一 | ②左侧语义 | ③右侧≤2/44px | ④禁桌面组件 | ⑤可达可回退 |
|---|---|---|---|---|---|
| Settings.tsx（移动壳） | ✓（自绘 sheet header + `hidden` 注册，见备注 A） | ✓ | ✓（右侧恒 ≤1） | ✓ | ✓ |
| GeneralTab.tsx | ✓（无自绘顶栏） | n/a（内容页） | n/a | ✓（快速助手移动端整块隐藏 :91） | ✓ |
| AppearanceTab.tsx | ✓ | n/a | n/a | ✓（桌面开关按 isMobilePlatform 隐藏 :423,:435） | ✓ |
| EngineSettingsSection.tsx | ✓ | n/a | n/a | ✓ | ✓ |
| MemorySettingsSection.tsx | ✓ | n/a | n/a | ✓ | ✓ |
| PdfSettingsSection.tsx | ✓ | n/a | n/a | ✓（SwitchRow 整行可点 + coarse min-h-11 :74） | ✓ |
| SyncSettingsSection.tsx | ✓（卡片式，无自绘顶栏） | n/a | n/a | ✓ | ✓ |
| WorkbenchSettingsSection.tsx | ✓ | n/a | n/a | △（:742 快捷键折叠按钮触屏 <44px） | ✓ |
| McpEditorSection.tsx（嵌入编辑器） | ✓（标题由 sheet header 承载） | ✓（返回=dismissRightPanel） | △（保存入口位置不统一，见备注 B） | ✓ | ✓（底部 footer 保存/取消 min-h-11 :1661-1664, :1818-1821） |
| McpToolsSection.tsx（chrome only） | ✓ | n/a | ✓（页内卡片动作非顶栏） | ✓（hover 隐藏动作已做 coarse 常显 + pointer-events 防误触 :433-438，机制正确） | ✓ |
| VendorDetailPanel.tsx | ✓ | n/a | ✓ | ✓（hover 动作 max-md/coarse 常显 :519；移动端行内二次确认删除替代全局弹窗 :552-565） | ✓ |
| data-governance/SyncTab.tsx | ✓ | n/a | n/a | △（宽表横滑，见问题 3） | ✓ |
| data-governance/BackupTab.tsx | ✓ | n/a | n/a | △✗ 倾向（6 列宽表 + 每行 4 图标动作，见问题 3） | ✓ |
| data-governance/AuditTab.tsx | ✓ | n/a | n/a | △（宽表横滑；过滤器 <44px，见问题 4） | ✓ |
| DataGovernanceDashboard.tsx | ✓（TabsList 页内二级导航，非顶栏） | n/a | ✓（8 个 TabsTrigger 均 min-h-11 :1815-1849，横滑收纳 :1811-1813） | ✓ | ✓ |
| DataImportExport.tsx | ✓（见备注 C） | ✓（showBackArrow=独立视图时 :283） | ✓（右侧仅 1 个导出 :285-297） | ✓（桌面 HeaderTemplate 在小屏/embedded 不渲染 :1324） | ✓（onBack→chat-v2，App.tsx:2466） |

### 备注 A：Settings 移动壳的「双顶栏」判定

移动端 Settings 整页是全屏 Sheet，自绘 `settings-mobile-sheet-header`（Settings.tsx:1982-2023），同时以

```703:705:src/features/settings/components/Settings.tsx
  useMobileHeader('settings', {
    hidden: isSmallScreen || !isActive,
  }, [isSmallScreen, isActive]);
```

把全局 UnifiedMobileHeader 隐藏（`hidden` 是 MobileHeaderContext.tsx:20 的一等字段，UnifiedMobileHeader.tsx:57 消费）。**屏上任意时刻只有一条顶栏**，属规范①允许的机制化例外（App 级注册 + hidden，而非无注册自绘）。回退链完备：

- 供应商详情 → 供应商列表 → 分区内容 → 分区列表 → 关 Sheet（handleMobileSettingsBack :542-569 + handleSheetBack :1951-1957）；
- Android 返回键注册在 overlay 档并 gate isActive（:586-599），右滑面板手势滑回与返回键共用 dismissRightPanel 清理（:496-540）。

### 备注 B：右滑面板保存入口不对称

sheet header 右侧动作只为 `vendorConfig` / `modelEditor` 提供顶栏保存（Settings.tsx:670-698，44px `!h-11 !w-11`）；`mcpTool` / `mcpPolicy` 的保存在面板底部 footer（McpEditorSection.tsx:1661-1664, :1818-1821）。两条路径都可达、都 ≥44px，不算违规，但同为「右滑编辑面板」交互不一致。

### 备注 C：data-governance 移动页与注册情况

- 数据治理**没有独立 viewId**，是 Settings 的 `data-governance` 分区（Settings.tsx:1623-1627 渲染 DataGovernanceDashboard）。入口：设置分区列表、GeneralTab「前往数据治理」按钮（GeneralTab.tsx:806-816，setPendingSettingsTab + SETTINGS_NAVIGATE_TAB 双保险）、命令面板/外部路由（App.tsx:1129, :1204, :2776-2778）。程序化直达时 `setMobileNavView('content')` 跳过分区列表（Settings.tsx:978, :993），回退走通用分区链。规范⑤满足。
- `data-management` 独立视图 = DataImportExport（App.tsx:2464-2473, :2835），`useMobileHeader('data-management', …, !embedded)`（DataImportExport.tsx:280-298）——embedded 挂在 Settings 统计分区时禁用注册，避免覆盖独立实例顶栏配置，机制正确。
- UnifiedMobileHeader 写者盘点（settings 域）：`settings`（hidden）、`data-management` 两个 viewId，无第二写者、无未注册自绘顶栏。

---

## 二、问题清单（file:line）

按规范条目分组；均为静态判读，未运行验证。

### ① 双顶栏 / 顶栏注册

未发现违规。Settings sheet 自绘 header 属 hidden 机制例外（备注 A）；DataImportExport 桌面 HeaderTemplate 已按 `!embedded && !isSmallScreen` gate（src/components/DataImportExport.tsx:1324）。

### ③ 右侧动作 / 44px 触控

1. **WorkbenchSettingsSection.tsx:742** — 快捷键清单折叠按钮 `py-1 text-xs`，无 coarse 44px 兜底；同文件 :965 的同类折叠按钮有 `[@media(pointer:coarse)]:min-h-11`，属散点遗漏。
2. **data-governance/AuditTab.tsx:149-178** — 两个过滤器 AppSelect（操作类型/状态）`size="sm"` 无 coarse 高度覆盖；同页 :180 的刷新按钮反而有。仓库内 AppSelect 需逐处加 `[@media(pointer:coarse)]:!h-11`（GeneralTab.tsx:519、MemorySettingsSection.tsx:276 等均手工加了），说明 AppSelect 基座缺中央触控目标契约。

### ④ 桌面组件滥用（宽表 / hover-only / ResizablePanel）

3. **宽表**（rule 4 的「宽表」项，当前以横向滚动缓解，未做窄屏卡片化）：
   - **data-governance/BackupTab.tsx:923-1103** — 6 列表格（min-w 合计 ≥510px：:926-931）+ 每行 4 个 `h-7 w-7` 图标动作（:1014, :1025, :1039, :1073，已带 `max-md:min-h-11` 放大）。移动端必横滑且「操作」列在最右、初始视口外——最重的一处。
   - **data-governance/SyncTab.tsx:290-366** — 4 列表格横滑（列窄，可接受下限）。
   - **data-governance/AuditTab.tsx:186-237** — 5 列表格横滑。
   - （同目录顺带记录：OverviewTab.tsx:354-357 同款 min-w 列。）
   三处外层均是 `CustomScrollArea orientation="horizontal"`，可达性成立，但违背「移动端禁宽表」的精神：状态/操作类信息在窄屏应折叠为卡片行。
4. **hover-only**：未发现真 hover-only 不可点。抽查均已带 coarse 常显：McpToolsSection.tsx:433-438（且补 `pointer-events-none` 防不可见误触，机制样板）、VendorDetailPanel.tsx:519、VendorSidebar.tsx:201、OcrEngineCard.tsx:321、DimensionManagement.tsx:622。EngineSettingsSection.tsx:377-555 与 VendorDetailPanel.tsx:781 是 `opacity-60 hover:opacity-100`（常显淡化，非隐藏），合规。
5. **ResizablePanel**：设置域零使用（仅 OpenSourceAcknowledgementsSection.tsx:32 的致谢文案字符串）。
6. **VendorDetailPanel.tsx:541** — 测试连接按钮 `max-md:hidden`：窄屏刻意收进编辑器底部入口（注释 :517-518 已说明），记录为有意裁剪、非缺陷。

### ⑤ 不可回退

未发现。全部页面/面板有返回路径（备注 A/C）；MobileSlidingLayout 在 Settings sheet 内 `enableGesture={false}`（Settings.tsx:2061, :2080），回退依赖 header 返回键 + Android 返回键，链路完整。

### 散点 44px（专项统计）

`min-h-11|min-w-11|h-11|w-11|44px` 在 `src/features/settings/components/**` 命中 **51 个文件、约 500+ 处**，重灾区：McpToolsSection.tsx 77 处、ShadApiEditModal.tsx 35 处、McpEditorSection.tsx 24 处、DimensionManagement.tsx 24 处、EngineSettingsSection.tsx 21 处、BackupTab.tsx 20 处、GeneralTab.tsx 18 处。

**根因**：DsButton 基座契约其实已中央化——`buttonPrimitiveContract.ts:64-84` 所有 size 在 `<lg` 断点默认 `h-[var(--touch-target-size)]`（=44px），`lg:` 才收敛为桌面高度。散点产生于调用侧用 `!h-7` / `h-8` 强行压扁按钮（如 McpToolsSection.tsx:445-467 `!h-7 !w-7`、SyncTab.tsx:269 `h-8`），击穿中央契约后再补一条 `[@media(pointer:coarse)]:!min-h-11` 拉回——每个按钮两次手工覆盖，纯负熵。

---

## 三、机制化建议（不落地，仅记录）

1. **停止「压扁再拉回」**：设置域按钮删除 `!h-7`/`h-8` + `[@media(pointer:coarse)]:!min-h-11` 成对覆盖，紧凑观感改由 DsButton 增加 `density="compact"`（仅收缩 `lg:` 桌面高度，不触碰 `<lg` 的 `--touch-target-size`）。一次改基座（buttonPrimitiveContract.ts），可清掉设置域 ~500 处散点的大部分。
2. **AppSelect / Input 纳入触控契约**：与建议 1 同构，把 `--touch-target-size` 下沉到 AppSelect trigger 与 shad/Input 的基础类（`<lg` 默认 44px、`lg:` 收敛），消除 AuditTab.tsx:149-178 这类「忘加即违规」的负担；WorkbenchSettingsSection.tsx:742 这类裸 `<button>` 建议换 DsButton variant="ghost"。
3. **数据治理宽表 → 响应式行卡**：为 SyncTab/BackupTab/AuditTab/OverviewTab 建一个共享 `ResponsiveDataList`（≥md 渲染 shad Table，<md 渲染卡片行：主字段 + Badge + 动作收进行内「更多」菜单）。优先 BackupTab（6 列 + 4 动作最重）。注意仅动展示层，禁触 WebDAV/S3/FTP 相关逻辑（不变量 13–15）。
4. **右滑面板保存入口统一**：把 `mcpTool`/`mcpPolicy` 也接入 `settingsHeaderRightActions`（Settings.tsx:670-698 的 switch 补两个 case，模仿 modelEditor 的 `form.requestSubmit()` 模式），或反向统一为底部 footer；二选一，避免同类面板两套心智。
5. **AuditTab 过滤器补顶**：短期最小修 = :149-178 两个 AppSelect 补 `[@media(pointer:coarse)]:!h-11`（若建议 2 落地则免）。

---

## 四、结论

设置页族整体是本仓移动规范的**正面样板**：hidden 注册消除双顶栏、四级回退链 + overlay 档 Android 返回、hover 动作全部带 coarse 常显与 pointer-events 防误触、弹窗按契约改右滑面板/行内确认。实质问题集中在**数据治理三张宽表**（rule 4，横滑缓解但未卡片化）与**散点 44px 反模式**（中央契约已存在却被调用侧击穿），另有 2 处孤立的 <44px 触控目标（WorkbenchSettingsSection.tsx:742、AuditTab.tsx:149-178）。无双顶栏、无右侧超 2、无不可回退页面。

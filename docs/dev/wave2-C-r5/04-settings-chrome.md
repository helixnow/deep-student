# 0824 Wave2-C R5 · 04 设置/数据治理 chrome 修复

- 执行员：settings-chrome（claude-fable-5-thinking-high）
- 工作目录：/tmp/0824-wave2-c-r5-settings-chrome，基线 cf8eb9e8
- 依据：docs/dev/wave2-C-r1/05-settings-governance.md（问题 1/2、建议 2/3/5）
- 未 git commit（按指令）；未运行任何测试。验证仅静态：tsc --noEmit + eslint。

---

## 一、改动清单

### 1. WorkbenchSettingsSection.tsx — 折叠钮换 DsButton（问题 1）

- **:737-754** 快捷键清单折叠钮：裸 `<button className="… py-1 text-xs"`（触屏 <44px）→ `DsButton variant="ghost" size="sm"`，触控高度走 buttonPrimitiveContract（`<lg` 44px、`lg:` 收敛、coarse min-h 保底），零手工覆盖。`aria-expanded` / `aria-controls` 原样保留，`className="justify-start gap-1.5 px-1 font-normal"` 仅调布局观感（twMerge 覆盖，无 `!`）。
- **:958-976** 浏览器高级选项折叠钮：同款裸 `<button>`（原带手工 `[@media(pointer:coarse)]:min-h-11`）同步换 DsButton，删除手工 coarse 覆盖。台账只点名 :742，此处是同文件同模式的顺带清理；disabled 态由 DsButton 内建（原 `disabled:pointer-events-none disabled:opacity-50` 手写类删除）。

### 2. data-governance/AuditTab.tsx — 过滤器触控高走体系（问题 2 + 建议 5）

核验发现：台账 R1 指出的「两个 AppSelect size="sm" 无 coarse 覆盖」在基线已被中央修复——AppSelect 基座 sizeClasses（AppSelect.tsx:163-168）现已内建 coarse 44px。因此本轮**不在调用侧加任何 min-h**（任务红线：禁止 `!min-h-11`），改为清掉本文件全部「压扁再拉回」散点：

- **:138** 重试按钮：删除冗余 `[@media(pointer:coarse)]:!min-h-11`（DsButton sm 契约已保底）。
- **:180** 刷新按钮：`className="h-8 w-8 p-0 … max-md:min-h-11 … !min-h-11 !min-w-11"`（1 次压扁 + 4 次拉回）→ `size="icon"`。桌面视觉不变（`--button-icon-size` = 2rem = 原 h-8 w-8），触屏 44×44 由契约保证。
- **:257 附近** 加载更多按钮：删除 `h-8 max-md:min-h-11 [@media(pointer:coarse)]:!min-h-11` 整条 className，回归 size="sm" 契约（桌面 30px vs 原 32px，视觉差 2px）。
- **:147** 过滤器行加一句注释注明触控高度契约来源，防止后人回填散点。

结果：AuditTab 现在是 0 条 `ds-components/coarse-touch-target` lint warning（原 5 处）。

### 3. ShadApiEditModal.tsx — 键盘避让迁到全局单例

- **:50** `import { useKeyboardInset } from '../hooks/useKeyboardInset'` → `from '@/hooks/useKeyboardHeight'`。
- **:166-169** `useKeyboardInset(mobilePanelMode)` → 无参 `useKeyboardInset()`；是否消费仍由原有的 `mobilePanelMode && keyboardInset > 0` 门控（:2176），行为不变处新增注释说明语义。
- **删除 src/features/settings/hooks/useKeyboardInset.ts**（42 行）。全仓 grep 确认它只有 ShadApiEditModal 一个消费者，hooks/index.ts 未导出它，tests 无引用。

语义收益（不只是搬家）：旧本地 hook 用 `window.innerHeight - vv.height` 简单估算，桌面窗口缩放会误判、Android adjustResize 下会双重抬升；全局单例（useKeyboardHeight.ts）按平台正确区分——Android adjustResize 布局视口已随键盘收缩时 inset≈0，iOS overlay 键盘返回被遮挡高度，且仅移动端启用、宽度变化重置基线。与 InputBarUI / TodoMainPanel 共用同一份 visualViewport 监听（原来两套监听并存）。

### 4. data-governance/BackupTab.tsx — 宽表卡片化（复用现有模式，非新框架）

复用 **DimensionManagement.tsx:543/:810 已有的「`hidden md:block` 表格 + `md:hidden` 卡片列表」响应式模式**，仅动展示层：

- **:469-486** `handleRestoreClick`：恢复入口的前置校验（增量/不可恢复备份拦截）从表格行内联 onClick 提为函数，表格与卡片共用——纯搬移，判断逻辑逐字符不变。
- **:489-563** `renderBackupTypeBadge` / `renderVerificationBadge`：类型徽标与验证状态徽标从表格单元格提为组件内渲染函数（JSX 逐字符搬移），表格（:1027/:1036）与卡片（:1127/:1134）共用，避免双份维护。
- **:1003** 原 6 列宽表整体包进 `hidden md:block`（表格本身零改动，含其原有 coarse 覆盖，供 iPad ≥md 粗指针继续生效）。
- **:1119-1201** 新增 `md:hidden` 卡片列表：每张卡 = 时间 + 类型徽标 / 大小 + 库数 + 验证徽标 / 动作行（验证、导出、恢复 + 右对齐删除）。四个动作按钮 `DsButton size="icon"` 走契约（`<md` 视口必 `<lg`，天然 44×44），**零手工 min-h/覆盖类**；删除钮保留 destructive 着色。空态/加载态与表格文案一致。
- 交互回调与表格逐一相同（onVerifyBackup / setActionType('export'|'delete') / handleRestoreClick），确认对话框、任务进度等逻辑层未动。

## 二、不变量核验（13-15）

未触碰 WebDAV decode_path / S3 normalize_endpoint / FTP 白名单：本轮 5 个文件改动全部在 `src/features/settings/**` 展示层 + 删除一个前端 hook；`git diff` 中无任何 sync/backup 引擎、Rust、API 层文件。BackupTab 的 onClick 全部沿用既有 props 回调，未新增任何后端调用。

## 三、验证（仅静态，按指令未运行测试）

- `npm ci` + `npx tsc --noEmit`：**本轮 5 个文件零类型错误**。全仓唯一报错文件是 `src/components/ui/TouchTarget.tsx`（见下 P0，基线自带，与本轮无关：`git status` 确认该文件未被本轮触碰）。
- `npx eslint <4 个改动文件>`：**0 error**；warning 由基线 58 → 53（净 -5，全部为本轮清掉的 coarse 散点），无新增。
- 未运行 vitest / playwright / 构建。

## 四、欠账与移交

1. **P0（非本轮范围，基线已坏）：TouchTarget.tsx:19 注释把整个文件截断。** 注释文字 `h-*/w-*` 中的 `*/` 提前终止了 :5 起的块注释，:19 之后全部被当作代码解析 → `tsc` 25+ 个语法错误，esbuild/vite 构建同样会炸。引入自基线内 commit 752b592c（R3「sink coarse 44px defaults」）。修复是把注释改成 `h-* / w-*` 之类一处小改，但该文件不在本轮允许清单（且疑似 R3 触控专线持有），**未修，请协调人立刻派单**。
2. **SyncTab（4 列）/ AuditTab（5 列）/ OverviewTab 宽表未卡片化**：任务只授权 BackupTab（最重的 6 列 + 4 动作）；其余三张维持横滑（可达性成立）。后续可照抄本轮 BackupTab 的「包 `hidden md:block` + `md:hidden` 卡片」手法，或等台账建议 3 的共享 `ResponsiveDataList`。
3. **BackupTab 桌面表格内残留的 `max-md:min-h-11 …` 覆盖类**（:1042 等 4 处）：表格现在 `<md` 不渲染，这些类成为死代码但对 iPad（≥md 粗指针）仍有 `[@media(pointer:coarse)]` 部分在生效，故未拆——正确做法是等这些行内 icon 钮统一换 `size="icon"`（同 AuditTab :180 手法），属台账建议 1 的批量清理。
4. **AppSelect 基座的 coarse 覆盖用的是 `!h-11` 而非 `min-h-[var(--touch-target-size)]`**（AppSelect.tsx:165-166，lint 规则也在报）：中央化方向对、写法欠账，改它影响全仓 AppSelect，不在本轮清单。
5. ShadApiEditModal 其余 ~35 处 coarse 散点、BackupTab 配置区散点：未动（任务只授权键盘 hook 迁移/卡片化），归台账建议 1 的 `density="compact"` 基座方案。

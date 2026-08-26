model=gpt-5.6-sol-xhigh-fast

# 20 — Composer F×G 与 DataGovernanceDashboard A×B×G 叠加静态审计

- 审计方式：只读检查当前工作树、既有归并记录与契约测试；未执行 Git/GitHub 操作，未改产品代码，未运行会写缓存或产物的测试。
- 审计问题：
  1. InputBar 保留 F 的 Composer* 拆分后，G 的移动端热区是否落到拆分后的所有者文件，而不是把旧单体实现搬回 `InputBarUI.tsx`；
  2. `DataGovernanceDashboard` 是否同时保留 A 的 `tabs_nav_label`、B 的 E2EE ZIP 密码链和 G 的 44px 页签热区。

## 一、InputBar：F 拆分仍是结构真相，G 没有借热区修复复活单体

### 1. 活跃入口不是 legacy `InputBar`

- `src/features/chat/components/ChatContainer.tsx:23,327-331` 导入并渲染 `InputBarV2`。
- `src/features/chat/components/InputBar.tsx:4-5` 明确标为 `@deprecated Legacy`，并要求新功能只改 InputBarV2 侧。
- `src/features/chat/components/input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts:31-35` 同时锁定活跃表面必须含 `<InputBarV2`、不得渲染 legacy `<InputBar>`。

因此，legacy 文件中即使仍有兼容样式，也不代表旧输入栏重新成为生产入口。

### 2. F 的职责拆分仍在

`InputBarUI.tsx` 当前是编排壳，不是把拆出的渲染实现重新内联：

- `InputBarUI.tsx:54-69` 导入 `ComposerTextarea`、`ComposerToolbar`、`AttachmentPanelBody` 及拆分 helper；
- `InputBarUI.tsx:116-118` 明示 IME/textarea、工具栏、水位环和附件模式 helper 已迁出；
- `InputBarUI.tsx:2110-2126` 只组装 `AttachmentPanelBody` 的 props，移动端内联与桌面 overlay 分别在 `:2142`、`:2567` 复用同一面板体；
- `InputBarUI.tsx:2442-2466` 渲染 `ComposerTextarea`；
- `InputBarUI.tsx:2482-2547` 渲染 `ComposerToolbar`。

拆分文件的所有权也清楚：

- `ComposerTextarea.tsx:1-11,82-124,127-318` 持有 textarea、ghost、IME 合成态、Enter/队列键盘路由和 coarse 指针 16px 输入字号；
- `ComposerToolbar.tsx:1-8,113-243,519-930` 持有加号菜单挂载、水位环、推理/模型控件、发送与停止按钮；
- `AttachmentPanelBody.tsx:1-6,131-395` 持有桌面/移动共用的附件面板头、列表、重试/移除与注入模式控件；
- `ComposerPlusMenu.tsx:1-9,225-227,261-659` 持有加号触发器及移动端单层 44px 菜单行。

最强的负向证据在
`InputBarUI.mobileSplitContract.source.test.ts:24-29`：测试要求
`InputBarUI.tsx` 不得再出现 `function ContextWindowUsageRing`，而
`ComposerToolbar.tsx` 必须拥有它。当前源码满足该约束。

### 3. G 热区的实际归属

`docs/0824-MERGE-PLAN.md:496-501` 记录的裁决是：G 在壳层原位保留 5 个提示按钮热区，其余热区手工重放进 F 拆分文件，不复活整文件单体。当前源码逐项吻合。

#### 3.1 合法留在编排壳的 5 处

`InputBarUI.tsx` 中 `[@media(pointer:coarse)]:!h-11` 实测恰为 5 处：

- 长粘贴“转为附件”与“忽略”：`:2325`、`:2333`；
- 制卡、音视频、思维导图提示关闭：`:2355`、`:2377`、`:2397`。

这些节点本来就是壳层持有的跨附件编排提示，不属于已拆走的 toolbar/attachment body；保留它们不是单体复活。契约测试在
`InputBarUI.mobileSplitContract.source.test.ts:54-56` 要求至少 5 处，防止后续丢失。

#### 3.2 工具栏热区落在 `ComposerToolbar` / `ComposerPlusMenu`

- 通用 36px 图标按钮通过透明伪元素扩区：
  `ComposerToolbar.tsx:51-61` 的 `coarseHitAreaClass` 使用 `after:-inset-1`；
  28px/更窄控件使用 `:55-57` 的 `after:-inset-2/-inset-2.5`。
- 水位环由 `ComposerToolbar.tsx:113-243` 持有；实际控件在 `:203-212`，
  `h-8 w-7` 配 `after:-inset-2`，coarse 命中区达到至少 44px。
- 发送按钮尺寸常量在 `ComposerToolbar.tsx:66-67`：
  coarse 指针强制 `!h-11 !w-11`；消费点在 `:897-911`。
- 停止按钮在 `ComposerToolbar.tsx:868-890`，`:876` 同时按移动断点和
  coarse 指针强制 44×44px。
- 推理/运行时模型触发器在 `ComposerToolbar.tsx:609-641,824-840` 使用拆分文件内的扩区常量；模型搜索框在 `:727-736` 使用 coarse `!h-11 !text-base`，同时避免 iOS 对小字号输入框自动缩放。
- 加号触发器本体在 `ComposerPlusMenu.tsx:275-291`，`:284` 强制 coarse
  `!min-h-11 !min-w-11`；移动菜单行统一由 `:225-227`
  `min-h-[44px]` 提供。

发送按钮契约也已经改读拆分所有者：
`tests/vitest/chatV2SendButtonContract.test.ts:6-8,23-56` 从
`ComposerToolbar.tsx` 取证，并在 `:35-38` 锁定 44px coarse 尺寸，而不是继续要求 `InputBarUI.tsx` 内联发送按钮。

#### 3.3 附件热区落在 `AttachmentPanelBody`

- 移动端头部：添加按钮 `AttachmentPanelBody.tsx:143-150` 为
  `!h-11 !min-w-11`；更多与关闭按钮 `:151-203` 均为 `!h-11 !w-11`；
  更多菜单行 `:165-189` 为 `min-h-[44px]`。
- 桌面视觉密度保持不变，仅 coarse 指针扩高：添加、资源库、相机、清空、关闭在
  `AttachmentPanelBody.tsx:212-238` 使用 `!min-h-11`。
- 附件行的重试与移除在 `AttachmentPanelBody.tsx:365-377` 使用同一 coarse
  44px 下限。
- 当前该文件的 `[@media(pointer:coarse)]:!min-h-11` 共 7 处；
  `InputBarUI.mobileSplitContract.source.test.ts:49-52` 明确要求移动按钮
  `!h-11 !min-w-11` 且 coarse 规则至少 7 处。
- `tests/vitest/chatV2ComposerPanelTokensContract.test.ts:18-21,54-67`
  同样直接审计 `AttachmentPanelBody.tsx`，证明面板测试所有权已随 F 拆分迁移。

### 4. InputBar 判定

**PASS。** G 热区不是通过把工具栏、水位环、发送/停止按钮或附件面板重新粘回
`InputBarUI.tsx` 实现，而是落在 `ComposerToolbar.tsx`、
`ComposerPlusMenu.tsx`、`AttachmentPanelBody.tsx` 等拆分所有者中。
`InputBarUI.tsx` 仅保留 5 处与自身提示条职责一致的 coarse 热区。

## 二、DataGovernanceDashboard：A `tabs_nav_label` + B E2EE ZIP + G 44px 同时在位

### 1. A：页签组名与逐页签可访问名称

- `DataGovernanceDashboard.tsx:1804-1811` 的 `TabsList` 使用
  `aria-label={t('data:governance.tabs_nav_label')}`。
- `DataGovernanceDashboard.tsx:1812-1847` 源码共有 8 个 `TabsTrigger`
  （7 个常驻页签 + 1 个 DEV-only debug 页签），每个都有独立本地化
  `aria-label`；小于 640px 时文字虽由 `hidden sm:inline` 隐藏，读屏名称仍保留。
- `src/locales/zh-CN/data.json:815` 与 `src/locales/en-US/data.json:815`
  均定义 `tabs_nav_label`。
- Debug 入口仍由 `DataGovernanceDashboard.tsx:102,637,641-644,1840-1847`
  限制在开发构建，外部深链不能把生产面板切到不存在的 debug 页。

### 2. B：E2EE ZIP 密码不是死 UI，而是三条调用链贯通

#### 2.1 新建备份并导出

- `BackupTab.tsx:340-360` 保存并按 Unicode 码点校验可选密码，最小 8 字符；
  `:411-431` 将其写入 `encryptionPassword`。
- `DataGovernanceDashboard.tsx:1094-1104` 接收该字段，`:1127-1136`
  将 `options.encryptionPassword` 传给 `DataGovernanceApi.backupAndExportZip`，
  `:1872-1883` 把 handler 接回 `BackupTab`。
- `src/api/dataGovernance.ts:719-740` 再以 `encryptionPassword` 送入 Tauri IPC。

#### 2.2 已有备份单项导出

- `BackupTab.tsx:363-376` 在确认后调用
  `onExportZip(selectedBackup, compressionLevel, encryptionPassword)`。
- `DataGovernanceDashboard.tsx:1170-1203` 接收第三参，并作为
  `DataGovernanceApi.exportZip` 第五参传递。
- `src/api/dataGovernance.ts:765-780` 将字段映射为 IPC 的
  `encryptionPassword`。

#### 2.3 加密 ZIP 导入

- `BackupTab.tsx:434-440,1125-1178` 先显示密码对话框，确认后调用
  `onImportZip(importPassword || undefined)`，不会点击导入即直接执行。
- `DataGovernanceDashboard.tsx:1220-1265` 接收密码，并调用
  `DataGovernanceApi.importZip(zipPath, undefined, password)`。
- `src/api/dataGovernance.ts:797-808` 将其作为 IPC `password` 发送。

这条链最终有真实密码加密语义，不只是字段透传：

- `src-tauri/src/data_governance/backup/zip_export.rs:14-18,43-58`
  定义 `portable_secrets.dsbk`，使用 Argon2id 派生密钥与 AES-256-GCM
  分块加密；
- 同文件 `:184-265` 将原始 manifest 与本地密钥/审计等敏感文件封装后加密，
  `:1393-1454` 在导入时要求同一密码并解封；
- `src-tauri/src/data_governance/commands_zip.rs:520-545,1857-1978`
  把密码接到导出/导入器，并以 `validate_for_slot_restore` 决定导入物能否整槽恢复；
- `zip_export.rs:467-487` 对密码字段 `skip_serializing`，Debug 只输出
  `<redacted>`。

严格说，这里的“E2EE ZIP”是产品定义的“加密全保真 ZIP”：敏感材料和原始
manifest 被密码加密密封，外层非敏感归档内容不等于全部密文。当前 UI 文案与后端
实现对此没有发现矛盾。

### 3. G：8 个页签全部保留 44px 触控目标

- `DataGovernanceDashboard.tsx:1808-1811` 的页签列表本身为 `min-h-11`，
  并允许横向滚动，窄屏不强行压缩页签。
- `DataGovernanceDashboard.tsx:1812-1847` 的 8 个 `TabsTrigger` 每个都同时含：
  - 移动布局基线 `min-h-11 min-w-11`；
  - coarse 指针兜底 `!min-h-11 !min-w-11`；
  - `shrink-0`，避免横向空间不足时把 44px 命中区压小。

源码计数结果为 8 个 trigger、8 个逐项 aria-label、8 个移动 44px 基线、8 个
coarse 44px 兜底，四组数量完全对齐。

### 4. A/B/G 防回退契约

`tests/vitest/data-governance/DataGovernanceDashboard.abg.source.test.ts:10-50`
在同一文件中锁定三方共存：

- `:11-25` 要求 8 个 trigger 全有 aria-label，并保留 DEV-only debug 门；
- `:27-38` 要求 `backupAndExportZip` 继续接收并传递 `encryptionPassword`；
- `:40-50` 逐 trigger 检查移动与 coarse 44px，同时再次检查
  `tabs_nav_label` 和密码参数，避免只修 G 却覆盖 A/B。

该源码契约对 B 的主“一步备份并导出”链覆盖最直接；另外
`tests/vitest/data-governance/BackupTab.zip-password.test.tsx:1-12,91-292`
覆盖空密码、短密码、Unicode 码点、单项导出和导入对话框，
`tests/vitest/data-governance/dataGovernance.api-contract.test.ts:1255-1397`
覆盖三组 API 参数映射。本轮只核对测试源码，没有重新执行。

### 5. DataGovernanceDashboard 判定

**PASS。** A 的页签组/逐页签本地化可访问名称、B 的三条 E2EE ZIP 密码调用链、
G 的 8×44px 页签目标在同一终态中共存；未发现 G 覆盖 A 的 aria，或 A/G 合并时
丢失 B 的密码参数。

## 风险与是否需要产品修复

1. 【低，无需产品修复】`InputBarUI.tsx` 仍然较大，但现有体量主要来自附件上传、
   状态轮询与壳层编排；关键渲染所有权和负向源码契约均未回流。是否继续拆业务逻辑
   属后续重构议题，不是本轮发现的回退。
2. 【低，无需产品修复】44px 结论来自 Tailwind 类与源码契约，未在本轮做真机
   hit-testing；伪元素扩区还需依赖正常 CSS 构建与层叠环境。当前没有静态缺口。
3. 【低，无需产品修复】A/B/G 主契约是源码字符串测试，不替代 VoiceOver/TalkBack、
   iOS 缩放和真实加密包跨设备恢复测试；但旁侧组件/API/Rust 契约已形成多层覆盖。

## 结论

**总判定：PASS。** InputBar 保持 F 的 Composer* 拆分：G 热区按职责落在
`ComposerToolbar`、`ComposerPlusMenu`、`AttachmentPanelBody` 等拆分文件，
没有为修 44px 而复活旧单体；壳层仅保留 5 个本职提示按钮热区。
`DataGovernanceDashboard` 同时保留 A `tabs_nav_label` 与 8 个逐项 aria-label、
B E2EE ZIP 导出/导入密码全链、G 8 个 44px 页签目标，并由 A+B+G 共存契约锁定。
无需产品修复。**本轮不改代码**。

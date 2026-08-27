# 0824 跨主题合成质量审查

## 结论

审查对象为 `origin/cursor/0824-cde6 @ 2d41ea8b`，对照 `v0.9.44`。本次只看合成后的产品交叉面，不复述 PR/提交吸收表。

**总判定：WARN，不应作为“无缝合成、无条件 PASS”验收。**

0824 不是简单把四组功能并排放进仓库：Composer 拆分确实承接了移动端布局，Chat 的持久制卡与只读预览边界明确，恢复也已从 v0.9.44 的“写完才发现不能切槽”收紧为候选槽验证后再发布。这些是有效的整体化改造。

但仍有四条真实接缝：

1. **设置里的“测试连接”会先改写当前生效的云配置与凭据，再测试；失败不回滚。** 配置与凭据又是两次独立提交，存在“旧 endpoint + 新密码”及“未验证配置已成为同步 SSOT”两种半事务状态。
2. **自动同步的持久化与生命周期没有统一。** 开关能跨重启恢复，但调度器只在两个同步设置组件挂载时启动；用户重启后不打开设置，已开启的自动同步不会计时。
3. **Chat 公开的 `enableQaPass=false` 与 Anki 落库实现相反。** 0824 新增的 schema 承诺“不留 QA 痕迹”，后端却在删掉旧 flag 后无条件重新写入确定性 `_qa_flags`。
4. **VFS 对“迁移历史已记账、物理 schema 稀疏”的修复只补普通表，没有补 init 索引、FTS 和视图；恢复候选槽最终会被 verifier 拒绝。** 这是安全的 fail-closed，不会覆盖当前槽，但并未完成“旧/损坏备份可恢复”的闭环。

分面判断：

- **Chat × Anki：WARN。** 主链归属清楚，新增 QA 开关语义有确定性缺口。
- **设置 × 云同步：FAIL。** 后端 SSOT/安全存储方向正确，但配置发布事务与调度器生命周期存在产品级断点。
- **Composer × 移动端：PASS（静态）。** 拆分、布局、键盘、安全区、返回键和热区在同一所有权体系内，没有互相削弱。
- **VFS × 恢复：WARN。** 正常完整备份路径显著强于 v0.9.44；稀疏 schema 修复及畸形 `props` 的语义校验仍有边界。

本结论来自源码与既有契约测试的静态复核；未把“测试文件存在”表述成真机、真实云供应商或灾难恢复演练已经通过。

## 一、Chat × Anki

### 合成得好的部分

#### 1. 持久制卡与展示预览没有混成两套写入口

当前产品有两种视觉上相近的闪卡块，但职责边界是清楚的：

- `buildFlashcardPreviewIntent` 明确声明只读，持久化归 `anki_cards` 管线；它只构造 `flashcard-preview` block（`src/features/generative-ui/utils/buildFlashcardPreviewIntent.ts:1-36`）。
- `FlashcardPreviewBlock` 只渲染正反面、牌组和标签，没有按钮、handler 或持久化调用（`src/features/generative-ui/components/FlashcardPreviewBlock.tsx:7-55`）。
- 真正的 Chat 制卡走 `anki_cards`：后端在生成时先做 QA/critic 相关处理并写入卡库，前端块负责展示、编辑、导出与 AnkiConnect 状态，而不是让 GenUI 任意 block 获得写权限。

这不是“该统一却没统一”。GenUI 是不可信展示协议，`anki_cards` 是带 QA、审计和卡库副作用的业务协议；把两者强行合成一个可写 block 反而会放宽边界。

#### 2. Chat 流水线不会在最终保存时吃掉异步制卡块

`anki_cards` 可能在主 Chat pipeline 之外异步创建。最终持久化前会读取已有 `anki_cards`，按原 `block_index` 合并回消息并避免同 ID 重复；对应处理在
`src-tauri/src/chat_v2/pipeline/persistence.rs:440-549` 和 `:979-1209`。

这条接缝处理得比“前端临时显示成功”更完整：刷新后块仍在，且不会统一被追加到消息尾部。`anki_cards` 的持久化所有权与 Chat 最终消息保存已经显式协调。

#### 3. v0.9.44 的旧卡片数据没有被新增 QA 字段卡死

0824 对 `tags_json`、`images_json`、`extra_fields_json` 采用可空读取并安全解析，迁移只把 NULL/空串规范为 `[]`/`{}`，不改写已有 `_qa_flags`、`_occlusion`。因此新 Chat/Anki 展示并不要求 v0.9.44 卡片天然带 0824 元数据。

#### 4. critic 与图像遮挡没有暗中扩大默认副作用

- `enableCriticPass` 默认关闭，只有显式开启才在生成成功后调用 critic；失败降级为保留原卡，不阻断制卡。
- 图像遮挡只补 `_occlusion` 和识别 tag，不覆盖模型生成的 front/back/text（`src-tauri/src/streaming_anki_service.rs:1929-1942`）。

这两项保持“新增能力不削弱旧制卡完成率”的方向。

### 确定性接缝：QA 开关只控制了前半段

Chat 对模型公开的两个工具 schema 都写明：

> `enableQaPass=false` 仅在用户明确不要 QA 留痕时使用。

证据在 `src/features/chat/skills/builtin/index.ts:283-292,374-383`。但实际落库顺序是：

1. `qa_pass_enabled=false` 时删除字段规则已经写入的 `_qa_flags`
   （`src-tauri/src/streaming_anki_service.rs:1904-1907`）；
2. 随后无条件运行单卡 lint 和文档级重复检测；
3. 无条件调用 `merge_flags` 把 `_qa_flags` 写回
   （同文件 `:1944-1968`）。

所以关闭开关后，卡仍会在 Chat `anki_cards` 块里出现 QA 摘要，也会把 flag 写进卡库。它不是单纯文案瑕疵，而是 Chat 工具契约、Anki 存储和 UI 呈现三层同时可见的语义冲突。

该问题是 **0824 新增**：v0.9.44 没有 `enableQaPass`、`enable_qa_pass` 或 `_qa_flags` 协议，不能归为旧欠账。

建议二选一并锁成跨层契约：

- 若产品语义是“不留痕”，则让全部 `lint_card`、文档重复检测和 `merge_flags` 受开关控制；
- 若产品始终要求确定性 lint，则把参数改成“只关闭字段规则 QA”之类的精确名称，不能继续对 Chat 声称“不留 QA 痕迹”。

### 本面结论

Chat 与 Anki 的大结构是统一的：展示预览保持只读，持久卡走专用管线，异步块不会被 Chat 最终保存覆盖。唯一明确回退不是结构重复，而是新增 QA 开关没有贯穿到最终落库；因此判 WARN。

## 二、设置 × 云同步

### 合成得好的部分

#### 1. 非敏感配置已有后端 SSOT，localStorage 被降为缓存

`resolveCloudStorageConfig` 先读后端：

- 后端已配置时，以后端 DTO 覆盖本地安全缓存；
- 后端明确未配置且迁移标记已存在时，删除本地旧值，禁止 stale cache 复活配置；
- 只在首次迁移时从 localStorage 导入，并按“凭据先写安全存储、非敏感配置后发布”的顺序迁移。

证据在 `src/utils/cloudStorageApi.ts:453-506`。

后端命令收到前端 config 后也不信任 IPC 中的 provider、endpoint、root 和不安全传输授权，而是从数据库 SSOT 重建，再从安全存储补凭据（`src-tauri/src/secure_store.rs:2284-2308`）。自动/手动同步因此最终共享同一后端权威配置，而不是各自相信页面状态。

#### 2. secret 不再在常规 IPC 中往返

前端常规加载返回空密码占位，后端只返回“是否已配置”状态；真正同步前由后端 hydrate。云密码最短 8 个 Unicode 码点、E2EE marker 校验和明文防降级也都在后端。

相对 v0.9.44，旧云端 DSBK 备份没有 `.encryption-marker` 的升级场景已被专门承接：首次设置密码时先试解已有备份，成功后才登记 v2 verifier；错误密码不会抢先固化成新基准。

#### 3. 同步、备份、恢复共享后端互斥与远端租约

带进度同步在读取配置后使用 `BACKUP_GLOBAL_LIMITER.try_acquire_owned()`，与备份、恢复、ZIP 导入导出互斥；拿锁成功后才发 preparing，避免第二入口产生幽灵进度（`src-tauri/src/data_governance/commands_sync.rs:2803-2817`）。远端 target lease 又覆盖 manifest、文件、记录及 cursor 写窗口（`:2846-2869`）。

这说明多个设置入口虽然都能触发同步，最终不是靠各页面按钮禁用来保证一致性。

### 高风险接缝一：“测试连接”实际先发布，再测试

`CloudStorageSection.doTestConnection` 的顺序是：

1. `saveCredentials` 写入全局云凭据；
2. `saveCloudConfigSsot` 把草稿发布为当前后端 SSOT；
3. 最后才 `checkConnection`；
4. 连接失败只显示错误，不恢复旧配置或旧凭据。

证据为 `src/features/settings/components/CloudStorageSection.tsx:518-595`。

因此按钮名表达的是只读验证，行为却是“保存并切换当前同步目标，再验证”。只要步骤 1、2 成功，即使步骤 3 失败，手动同步、Chat 数据治理工具和下一轮自动同步都会读取这份失败配置。若用户原本有一套可用配置，单纯试填另一个服务就会替换它。

这与“后端 SSOT”本身不冲突，问题在于 **SSOT 的发布时点错误**：权威配置在验证通过前就被替换。

### 高风险接缝二：配置与凭据是两次独立提交

正常保存也先 `saveCredentials`，再 `saveCloudConfigSsot`
（`CloudStorageSection.tsx:411-476`）。安全存储采用“非空字段覆盖、空字段保留”的全局记录，不按 endpoint 或 root 版本化
（`src-tauri/src/secure_store.rs:2055-2076`）。

于是第二步失败时会留下：

- 后端仍是旧 provider/endpoint/root；
- 安全存储已经是新密码或新 secret；
- 下一次后端 hydrate 会组合“旧配置 + 新凭据”。

例如用户同时更换 WebDAV endpoint 和密码，密码成功写入、endpoint 因校验失败未发布，原本可用的旧 endpoint 会立即拿新密码连接。代码注释只防住了“配置已发布、凭据没写成”，没有防住反方向的半事务。

`cloud_config_ssot_clear` 也先删数据库配置、后删凭据（`src-tauri/src/cloud_config_commands.rs:595-611`）；后者失败会显式报 partial，不是静默成功，但同样证明两份状态没有原子提交/回滚。

更进一步，云配置 mutation 不参与 `BACKUP_GLOBAL_LIMITER`。自动同步若恰好在两次提交之间启动，后端 SSOT 与安全凭据可能来自不同一版。窗口虽短，源码没有锁或版本号把它关闭。

建议把“编辑草稿、测试、发布”变成明确状态机：

1. 测试命令使用一次性草稿配置和一次性凭据，在后端内完成连接验证，不修改 active SSOT；
2. 测试成功后，以单个后端命令提交配置版本与凭据，失败时保持旧 active generation；
3. 若安全存储与 SQLite 无法做跨介质事务，至少使用 staged generation + active pointer，或保存旧 secret 并在配置发布失败时可靠回滚；
4. 配置发布与同步启动共用 generation/锁，禁止同步读取混合代际。

### 高风险接缝三：自动同步“已启用”不等于“已调度”

持久化层本身做得正确：旧/损坏值逐字段净化，`enabled`、档位、上次结果跨重启，连续失败次数不持久化（`src/stores/syncStatusStore.ts:326-477`）。

但 hydration 只恢复状态，不调用 `setEnabled`。真正创建 timer 的入口只有：

- 用户当次切换开关时，`setEnabled(true)` 调 `scheduler.start()`（`:448-454`）；
- `SyncSettingsSection` 挂载（`src/features/settings/components/SyncSettingsSection.tsx:122-125`）；
- Data Governance 的 `SyncTab` 挂载（`src/features/settings/components/data-governance/SyncTab.tsx:168-174`）。

`ensureAutoSyncSchedulerStarted` 的源码注释甚至把语义限定为“任一同步设置面加载后开始计时”（`src/stores/syncStatusStore.ts:504-512`）。App 壳层只在启动时调用了键盘追踪（`src/App.tsx:1571`），没有启动 auto-sync。

确定结果是：用户在 0824 打开自动同步，退出应用，重启后若一直停留在学习/Chat 页面而不打开同步设置，store 显示的持久开关为 true，但没有 timer。名称“自动同步”与实际“打开设置后自动同步”不一致。

这条缝也削弱恢复闭环：恢复激活会轮换 device ID、清消费 cursor，并要求后续同步发布新设备 manifest；如果用户依赖已开启的自动同步，重启后仍不会发生，直到进入设置或手动同步。

修复应把调度器所有权上移到 App/数据治理服务层：等待 Zustand hydration 完成后，在应用启动时幂等启动；设置页只编辑状态和展示结果，不负责服务生命周期。

### 本面结论

0824 已统一“谁是权威”和“secret 在哪里”，但没有统一“何时发布一版配置”和“谁负责常驻调度”。安全边界强，事务与生命周期弱；这会直接改变同步目标或让自动同步失效，因此本面判 FAIL。

## 三、Composer × 移动端

### 1. v0.9.44 单体被真实拆分，移动修复没有把它粘回去

v0.9.44 的 `InputBarUI.tsx` 约 3919 行，且没有
`ComposerToolbar`、`ComposerTextarea`、`AttachmentPanelBody`。0824 当前壳约 2661 行，新增的职责所有者包括：

- textarea、IME、Enter/队列路由：`ComposerTextarea.tsx`；
- 模型/推理、水位环、发送/停止：`ComposerToolbar.tsx`；
- 桌面/移动共用附件内容：`AttachmentPanelBody.tsx`；
- 加号入口及移动单层菜单：`ComposerPlusMenu.tsx`；
- attachment mode、配置和发送可用性 helper。

移动端热区也落在这些新所有者内，而不是重新内联回壳：

- 发送/停止和模型控件在 `ComposerToolbar`；
- 加号与移动菜单行在 `ComposerPlusMenu`；
- 添加、更多、关闭、重试、移除在 `AttachmentPanelBody`；
- `InputBarUI` 只保留长粘贴、制卡、音视频、思维导图等壳层提示按钮。

这是本次四个交叉面里“结构目标”和“移动修复”配合最好的一处。

### 2. 布局判断与设备能力是有意分开的，不是漂移的双轨

`InputBarUI` 明确规定：

- `isMobile` 由 `MobileLayoutContext`/宽度驱动，只决定内联面板、底部布局、tooltip 等布局行为；
- `isMobileEnv` 由 `(pointer: coarse)` 驱动，只决定拍照等设备能力。

证据在 `src/features/chat/components/input-bar/InputBarUI.tsx:319-327,807-808`。移动端使用 `ComposerInlinePanel`，桌面才渲染 portal overlay（同文件 `:2133-2181,2555-2649`）。这避免了窄桌面窗口被当成“有相机的手机”，也避免宽屏触控设备失去能力入口。

### 3. 键盘、安全区、面板与消息列表使用同一链路

- App 启动时调用 `ensureKeyboardTracking`，在键盘出现前建立 visualViewport 基线（`src/hooks/useKeyboardHeight.ts:115-143`）。
- Android adjustResize 下 `keyboardInset≈0`，iOS overlay 下计算被遮挡高度，避免 Android 双重抬升（同文件 `:169-176`）。
- Composer 只在移动布局且焦点位于自身 textarea、面板搜索框或 portal 菜单输入框时应用 inset（`InputBarUI.tsx:1060-1086`）。
- 底部间距用 `max(safe-area, keyboardInset)`，不是相加后悬空（`:1157-1168`）。
- `ComposerInlinePanel` 直接消费全局 `--keyboard-inset` 限制高度，Android/iOS 两种模式有明确分支语义（`ComposerInlinePanel.tsx:40-94`）。

这些实现形成一条链，而不是 Composer 自己再维护一套 visualViewport 状态。

### 4. Android back 与移动面板状态已接通

任一组合面板打开时，移动 Composer 以 overlay 优先级注册返回键，先关闭面板并消费事件（`InputBarUI.tsx:1422-1432`）；切离 Chat 时也主动关闭 portal 面板（`:1434-1441`）。因此返回键不会直接退页面，也不会让桌面 portal 残留到另一个保活视图。

### 保留边界

本次结论是静态 PASS，不等于以下项目已经真机证明：

- iOS 地址栏/第三方键盘的 visualViewport 组合；
- Android 厂商 WebView 的 adjustResize 行为；
- 伪元素扩展的 44px 命中区在最终 CSS 层叠下的真实 hit-test；
- VoiceOver/TalkBack 下内联面板展开、焦点顺序和返回键。

源码所有权、CSS token 和契约测试均未发现交叉回退，但这些仍需要真机交互验证。

### 本面结论

Composer 拆分没有被移动端补丁削弱；移动能力反而被放进拆分后的正确所有者，布局/能力、overlay/inline、Android/iOS 键盘模式也有明确 SSOT。判静态 PASS。

## 四、VFS × 恢复

### 合成得好的部分

#### 1. 相对 v0.9.44，整槽恢复已经从“晚失败”改成“写前拒绝”

v0.9.44 在 `DataSpaceManager` 缺失时回退到硬编码 `slotB`，清槽并写完数据库后才因无法登记切槽失败，可能留下无人管理的半恢复槽（v0.9.44
`commands_restore.rs:628-642,1079-1084`）。

0824 当前在磁盘预算、清槽和任何数据库写入之前要求 A/B manager；缺失时返回稳定错误并保持当前数据不动（`src-tauri/src/data_governance/commands_restore.rs:24-29,644-648`）。

恢复候选还必须依次通过：

- 完整快照/coverage、资产策略和 manifest 验证；
- 文件 SHA-256 与数据库 `PRAGMA integrity_check`；
- 磁盘预算；
- 恢复后的 VFS 派生索引收敛；
- 对候选槽执行完整 migration + verifier；
- 同步基线重建；
- 持久激活 marker、维护屏障和 A/B pending cutover。

候选迁移失败发生在发布切槽状态之前（`commands_restore.rs:987-995`）。这里的 fail-closed 是实质安全边界，不依赖前端确认框。

#### 2. 可重建 Lance 索引没有被误当成必须完整携带的用户数据

若 manifest 没有完整 `databases/lance/vfs` component，恢复会删除目标 Lance 目录，清空 segment/orphan 账本，把资源和 index unit 状态重置为待重建；恢复文件结束后再清一次，防止 legacy/partial 文件在中途被复制回来
（`src-tauri/src/data_governance/backup/mod.rs:2256-2518`）。

这使 VFS 数据库与派生向量索引的恢复策略一致：用户数据必须完整，派生物可以明确丢弃并重建，不能把半套索引暴露给新槽。

#### 3. 恢复后同步身份不是沿用备份设备

候选槽会先把各业务表 `sync_version` 对齐 `local_version`，随后清空 `__change_log`、冲突和 alias，避免“恢复即把旧快照当新修改重新覆盖云端”
（`commands_restore.rs:997-1069`；`sync/mod.rs:4072-4159`）。

新槽启动并完成迁移后才：

- 持久化 old/new device ID；
- 记录 device rotation；
- 清消费 cursor、legacy processed key、tombstone watermark；
- 更新设备 ID；
- 提交并解除恢复维护租约。

证据在 `commands_restore.rs:84-155` 与 `sync/state.rs:477-517`。这比只清业务 change log 更完整，也把恢复和云同步的设备代际接了起来。

### 关键接缝：稀疏 VFS 只补“表”，没有补完整 init 契约

`pre_repair_vfs_schema` 遇到已有 `resources` 的旧库时会先调用
`apply_vfs_init_missing_tables`，再回放 change-log 触发器，解决缺少
`questions/review_plans/folders` 时的 `no such table`（`coordinator.rs:2275-2289`）。

但 helper 的边界被明确写成：

> 只建缺失表，不重放已有表上的索引。

实现只从 V20260130 SQL 提取 `CREATE TABLE IF NOT EXISTS`，并明确跳过 virtual table
（`coordinator.rs:2378-2469`；测试 `:5777-5791`）。

这与最终 schema verifier 的契约不闭合：

- V20260130 migration definition 要求普通表、关键索引和 smoke queries 全部存在
  （`src-tauri/src/data_governance/migration/vfs.rs:56-64`）；
- 关键索引包括 `idx_folders_parent`、`idx_questions_exam_id`、
  `idx_review_plans_exam_id` 等（`:182-223`）；
- smoke queries 要求 `questions_fts` 与 `trash_view` 可查询（`:171-180`）；
- verifier 会验证所有版本不高于已记录 current version 的 migration
  （`coordinator.rs:4057-4074`）。

现有回归只直接调用 `pre_repair_vfs_schema`，断言 `questions` 与 `__change_log` 出现，没有跑完整 coordinator，也没有断言上述索引、FTS、视图和最终 verifier
（`coordinator.rs:5794-5853`）。

因此在“V20260130 已记账，但物理库只剩 resources/notes”这类稀疏状态中，当前代码能越过第一处 `no such table`，随后仍会在最终验证阶段 fail-closed。对在线升级而言表现为启动迁移失败；对恢复而言表现为候选槽无法激活。当前槽不会被破坏，但用户的备份恢复目标没有完成。

需限定风险范围：这不是已证明的标准 v0.9.44 完整库升级失败。v0.9.44 release fixture 的 VFS head 为 20260808，正常库应已具备 init 对象；该问题针对更旧、曾中断、被裁剪或已损坏却保留迁移 history 的稀疏库。但恢复功能恰恰应处理这类非理想输入，不能用正常 fixture 覆盖掉该边界。

修复闭环应包含：

1. 构造“V20260130 已记录、仅 resources/notes 在位”的真实数据库；
2. 执行完整 migration coordinator，而不是只测 pre-repair helper；
3. 安全重建 init 的缺失关键索引、`questions_fts`、对应触发器和 `trash_view`；
4. 断言最终 verifier、候选槽 migration 及恢复激活前检查全部通过；
5. 对不能重建的对象保留 fail-closed，不能仅补 history 绕过 verifier。

### 次级接缝：恢复验证保证 SQLite 完整，不保证 `notes.props` 语义有效

0824 新增 `notes.props` 的写路径很严格：只收对象，限制数量、键和值，空对象规范为 SQL NULL
（`src-tauri/src/vfs/repos/note_repo.rs:398-482,1884-1905`）。同步也明确采用整对象 row-level LWW，不做危险的深合并。

但读取端对缺列、NULL、坏 JSON、非对象和空对象统一回退为 `None`，且 `props` 解析失败没有像 tags 那样记录 warning
（`note_repo.rs:2164-2194`）。所以若恢复包或外部同步数据中已经存在畸形 props：

- ZIP hash 和 `PRAGMA integrity_check` 可以全部通过；
- schema verifier 只确认列存在；
- 恢复可成功激活；
- 用户随后看到“无属性”，而不是明确的数据损坏提示。

这不是正常应用写入路径会主动制造的问题，也不应上升为整槽恢复阻断；但从“恢复后数据语义可见”看，当前选择是静默容错而非告警。至少应在候选验证或读侧记录可定位告警，并明确产品政策：隐藏坏值、隔离坏行，还是阻断恢复。

### 本面结论

恢复发布协议、同步身份轮换和 Lance 派生索引处理已经形成完整安全链，显著强于 v0.9.44。主要缺口是稀疏 VFS repair 与 verifier 的对象集合不一致；它安全地拒绝切槽，却不能兑现恢复可用性。判 WARN。

## 五、从产品整体看：哪里已经统一，哪里仍是两套真相

### 已经统一

1. **Anki 持久化真相**：可写卡走 `anki_cards`/卡库管线，GenUI flashcard 只展示。
2. **Composer 布局真相**：宽度决定布局，pointer 能力只决定设备功能；移动端是 inline，桌面是 overlay。
3. **云配置读取真相**：数据库保存非敏感 active config，安全存储保存 secret，后端 hydrate，不信任 IPC 草稿。
4. **恢复发布真相**：候选槽先迁移验证，成功后才登记切槽；同步与备份/恢复共享后端互斥。
5. **VFS 派生向量索引真相**：完整携带或明确清空重建，不接受半套 Lance 状态。

### 仍未统一

1. **云设置的一次用户操作不是一个配置 generation**：secret 与 config 分两次写，“测试”还提前发布。
2. **自动同步的状态所有者与生命周期所有者分离**：store 说 enabled，timer 仍可能不存在。
3. **Chat QA 的公开契约与 Anki 最终落库分离**：同一 boolean 在前半段和后半段含义不同。
4. **VFS migration history 与物理 schema 的修复集合分离**：普通表能补，init 索引/FTS/视图不能补，最终仍由 verifier 拒绝。
5. **恢复的字节/SQLite 完整性与业务 JSON 语义分离**：`notes.props` 坏值可被静默隐藏。

这些问题有共同模式：各主题内部都做了防线，但跨主题发布时缺少“同一代状态”的概念。云配置需要 generation，恢复已有 snapshot epoch，Chat/Anki 需要一个贯穿 schema 到落库的 QA policy，VFS repair 需要与 verifier 共用同一份 expected-object 契约。

## 六、建议处置顺序

1. **优先修复设置 × 云同步事务边界**：让测试连接真正只测试；引入 staged/active generation，防止旧配置与新 secret 混配；配置 mutation 与同步读取建立版本或锁。
2. **把 auto-sync 启动上移到 App/后台服务**：hydration 完成后启动，不依赖设置页挂载；增加“重启后不打开设置仍会排程”的测试。
3. **统一 `enableQaPass` 的最终语义**：实现或 schema 二选一，增加从 Chat tool 参数到落库 `_qa_flags` 再到块摘要的端到端断言。
4. **补 VFS 稀疏库完整迁移/恢复回归**：测试必须进入最终 verifier，并覆盖 init 索引、FTS、触发器与视图。
5. **将 `notes.props` 畸形值从静默缺失提升为可诊断状态**：至少告警和计数，避免恢复成功后用户无法区分“原本为空”和“数据不可解析”。
6. **Composer × 移动端保持现结构，只补真机证据**：不需要因移动端继续改造而把职责搬回 `InputBarUI`。

最终判断：0824 的合成不是失控拼接，关键安全方向大体正确；但设置/云同步的 active state 发布、auto-sync 生命周期、QA policy 贯穿和 VFS 稀疏恢复仍有可复现或可直接推导的接缝。修复前适合标记为 **有条件可用，不适合宣称整体无缝**。

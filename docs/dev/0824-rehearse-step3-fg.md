# 0824 第六轮预演：F × G（step 3）

## 范围

- 最终基线：`origin/cursor/0824-cde6` @ `4f05d2272217e91a899ed6261356eea1acafc438`
- 建分支时的基线：`af3e39d818cf557e4f1434dd909442b4aae6d490`
- F：`origin/cursor/0824-theme-subapp-cde6` @ `575fee7f475a83de5c0edd3dd378015495fb22ad`
- G：`origin/cursor/0824-theme-mobile-cde6` @ `4ab24435bb998f7d24fed9e80e39746a4f44edb3`
- D：已由 `origin/cursor/0824-cde6` 的 `a81856649b7116b808cca584c563952f7322a845`
  合入，Generative UI 只读闪卡裁决为 `cdfc9d632` + `65274b98b`
- 热区参考：F × G rehearsal `ec8a2524`
- 预演分支：`cursor/0824-rehearse-step3-fg-cde6`
- F 合并提交：`7d7064cb54ebcddeda22f8d14f67c74a8793ef51`
- G 合并提交：`2a6ffedb50707b2b26a805fd05e66af597daffdb`
- cloud-sync 0824 刷新合并：`078b82db1b132ee84856999a3fc4b84d0458ca02`
- D-integrated 0824 刷新合并：`2016f748b99a13618f17fb76365822d17a2729ee`

本轮只提交并推送预演分支，未改动或推送 `main` / `cursor/0824-cde6`。

## 合并顺序与原则

1. 从最新 0824 建立预演分支。
2. 完整 merge 最新 F，以 F 的子应用拆分、finder 宿主隔离、InputBar 拆分和
   workbench 新结构为主体。
3. 再 merge 最新 G，按 `ec8a2524` 的「F 主体 + G 热区」规则，把移动端返回键、
   coarse pointer 触控区、窄屏固定布局和可见性守卫重放到 F 的新组件边界。
4. G 已删除的 legacy notes 实现继续删除，不因 modify/delete 冲突而复活。
5. 执行期间 0824 先合入 cloud-sync 并推进到 `8b70b2d7`，随后又合入 D 并推进到
   `4f05d227`；两次都将 0824 的推进量反向 merge 到预演分支，只解决预演分支上的
   冲突，不改写 0824。

G 热区回放复用了 `ec8a2524` 文档和已验证 F × G 树的逐文件取舍，而不是整文件采用
G 的旧结构。重点覆盖 InputBar、Learning Hub/finder、PDF/EPUB、Todo、Anki、
flashcards、settings、workbench CSS 和通用响应式组件。

## 主要冲突取舍

- `InputBarUI.tsx`：保留 F 的 `ComposerToolbar` / `AttachmentPanelBody` 拆分，
  G 的移动触控增量落到拆分后的实际承载组件。
- Learning Hub：保留 F 的每宿主独立 finder store、active-host 全局导航和新 sidebar；
  不恢复 0824 旧的 `page/page-mobile` 共桶协议。
- `Resizable.tsx`：同时保留可拖模式的比例持久化和 G 的 `fixed` 小屏固定分栏；
  coarse pointer 拖拽命中区一并保留。
- `McpToolsSection.tsx`：保留 F 主体，同时恢复 G 的两个小屏分支守卫，避免响应式 JSX
  分支在热点回放中被拼接坏。
- `VendorSidebar.tsx`：保留 0824 的 `dnd-kit` 迁移和统一传感器，叠加 G 的触控样式；
  清除旧 `hello-pangea` 行渲染器残留，选择供应商继续支持移动端进入详情。
- qbank tools：保留 F 的 schema/逻辑，只对齐 F × G 已验证的描述契约。
- workbench：保留 F 的新窗口、finder、桌面和壳层能力，并在新结构上保留 G 的
  44px 热区、窄屏布局和 Android 返回键行为。

legacy notes 删除集合保持删除，包括 `DndFileTree/**`、旧 PreviewPanel/preview
实现、`reference-selector/**`、`NoteTagsEditor`、旧 Notes header/home/sidebar/tabs
以及 `workspaceShared.tsx`；当前 workbench notes 实现和其新增能力不受影响。

## 合并后静默契约修复

- `5e766540`：补回 `VerticalResizable.fixed` 协议，并移除
  `useChatPageEvents` 已废弃的 `loadUngroupedCount` 依赖。
- `5b38002a`：按已验证 F × G 树重放 48 个热点文件，恢复 F 主体上的 G 增量并对齐
  qbank 描述契约。
- `c1285a4e`：恢复 MCP action menu 与 preset selector 的小屏分支守卫。
- `4b118599`：清除导航上下文中旧 finder API 残留；恢复 `dnd-kit` vendor row 的
  选择回调并删除旧 DnD 渲染器。
- `1b289aa7`：删除被 F 新测试完整替代、且仍断言旧共桶语义的
  `finderStoreHostBuckets.test.ts`。保留的新测试锁定每个 host 独立分桶和
  active-host 导航协议。
- `078b82db`：合入执行期间新增的 0824 cloud-sync 基线。两个冲突均组合双方契约：
  `CloudStorageSection` 保留最新的清配置确认与失败重试，并给新增操作补 G 的 44px
  触控热区；`RecordConflictsPanel` 保留 cloud-only DELETE 可执行 keep-local 的新语义，
  同时保留窄屏/coarse pointer 44px 热区。

## 第八轮复查：刷新到已含 D 的 0824

旧 tip `f0efdfea` 仍可作为 F × G 裁决来源，但不能再当作当前 0824 的无冲突最终树：
它以 D 合入前的 `8b70b2d7` 为基线。机械重放
`git merge-tree --write-tree 4f05d227 f0efdfea` 得到 7 个文本冲突。现已把
`4f05d227` merge 回本预演分支，形成代码合并点 `2016f748`。

D 与 G 的直接文件重叠共 9 个：

- 作文/错题制卡：`EssayGradingWorkbench`、`ReviewQuestionsView`、`GradingMain`、
  `ResultPanel`。保留 F 的完整作文状态机与 G 的窄屏/44px 热区；共享制卡入口采用
  D 的非阻塞 `cardAgent.startGeneration`，不退回旧 `generateCards`。
- Anki 聊天块：`src/features/chat/anki/index.tsx`、`ankiCardsBlock.tsx`、
  `ChatAnkiProgressCompact.tsx`。保留 D 的 QA/critic、媒体报告和图片遮挡展示，
  同时保留 G 的触控热区。
- Notes：`NotesCrepeEditor.tsx`、`NotesEditorToolbar.tsx`。保留 F/D 的笔记制卡入口，
  同时保留 G 的移动端触控规则；legacy notes 删除集合仍不复活。

与整条 F × G 预演相比，D 共触及 29 个文件；7 个文本冲突的裁决如下：

- 三个作文 UI 文件采用 F/G 版，因为它们已包含 #160 的制卡入口，并额外保留 F 的
  撤销/保存笔记状态机和 G 的 44px/返回键增量；D 在这些文件的增量是同一制卡入口。
- `generateCardsFromText.ts`、其测试和 `selectionCardGeneration.ts` 采用 D 的
  `startGeneration` 协议；Anki 用户指南合并双方新增说明。
- 其余 Anki/Notes 重叠文件自动合并后抽查：D 的 QA/media/occlusion 与只读闪卡边界、
  F/G 的移动热区同时在位。Generative UI 的独立保存 handler/提取器及
  `save_to_library` locale 死键保持删除，入库仍只走 `anki_cards`。

关键回归复核：

- Finder compact 溢出触发器仍为 40px 视觉 + `after:-inset-1` 扩展命中区；
  `EnhancedPdfViewer` 的四个移动侧栏 tab 均保留 `!min-h-11`。
- #160/#161 的 F 集成提交仍均为分支祖先：错题/作文转卡、手动建卡与 `.apkg` 导入、
  题库进度持久化，以及关窗拦截、快捷键可发现、`ImmersiveHint`、空桌面 tour 解耦均在位。
- `DndFileTree/**`、旧 PreviewPanel/preview、`reference-selector/**`、
  `NoteTagsEditor`、`workspaceShared.tsx` 等 legacy notes 文件继续不存在。
- `npm run typecheck` 通过；`npm run build` 通过（19803 modules，仅既存 chunk 告警）；
  D/F/G 重叠与 #161 契约测试 7 files / 82 tests 全绿。

## 门禁结果

- `npm run typecheck`：通过。
- `npm run build`：通过。prebuild 内的版本生成、许可证检查和二次 typecheck
  全部通过；Vite 转换 19801 个模块。输出仅有既存的循环 chunk、重复静态/动态导入
  和大 chunk 警告。
- `rustup run stable cargo check --manifest-path src-tauri/Cargo.toml`：通过，
  25 个 warning、0 error。环境默认 Cargo 1.83 不支持锁定依赖所需的
  edition 2024，因此使用已安装的 stable Cargo/Rust 1.98。
- 热点契约测试：通过（8 files / 58 tests），覆盖 qbank tools、finder host buckets、
  MCP permission/bypass、CloudStorage UI 和 cloud-only conflict contracts。

门禁运行后工作区无生成物或未提交改动。

# 学习资源 / 笔记 / 划词保存改造质量评审

对照范围：`v0.9.44` → `origin/cursor/0824-cde6 @ 2d41ea8b`。本评审只看学习资源阅读、笔记编辑与划词保存之间的真实接缝，不重复 Finder 通用能力盘点。

## 结论

总体判定为 **WARN：核心架构明显变好，但“保存到哪里、关闭前是否真的落盘、并发阅读是否互相覆盖”还没有统一成可靠契约。**

本轮有效改造不是表面换壳：

- Learning Hub 面板改为按稳定 `resourceId` 取资源，并丢弃过期异步结果（`src/features/learning-hub/apps/UnifiedAppPanel.tsx:194-245`）。
- 笔记正文已具备 OCC、外部更新脏态保护、在途保存队列、维护模式写入阻断和大文档窗口化；这部分是本块质量最高的实现（`NoteContentView.tsx:68-79,302-424,457-660`；`NotesCrepeEditor.tsx:626-845`）。
- 聊天与 PDF 的通用“保存为笔记”已经共享目录选择、成功后打开笔记和移动端全屏子屏；不可用的保存入口不会做灰色假按钮（`src/shared/selection/SelectionToolbar.tsx:288-317,386-397`；`src/shared/notes/useSaveAsNoteFlow.tsx:58-138`）。
- 阅读进度控制器做了单实例内串行写、字段白名单和切换资源时的快照隔离，修复方向正确（`previewPersistence.ts:114-169,231-350`）。

但最终态仍有四项 P1：书签可被另一个阅读实例的进度写回覆盖；Learning Hub 关笔记标签没有等待或确认保存；共享保存会把“移动失败、实际落根目录”报告成成功；PDF 同一选区同时存在两套笔记动作且新共享动作保存了错误的来源标题。再叠加标签参数在真实后端被丢弃、标签页持久化缓存回滚等缺口，当前不适合宣称“学习资料到笔记已完整闭环”。

## 主要缺陷与风险

### P1 — 阅读进度写入会携带旧书签，跨窗口可覆盖用户新书签

`previewPersistence` 解决了单个控制器内部的乱序，却没有解决同一资源的多个控制器并发：

1. 控制器创建时快照 `readingProgress/bookmarks`，之后 `mergeBase()` 总会把快照或本控制器最后值带入 payload（`src/features/learning-hub/apps/views/previewPersistence.ts:136-151`）。
2. 单纯翻页触发 `persistProgress` 时，payload 因此可能同时包含旧的完整 `bookmarks` 数组（`:186-193`）。
3. 后端对 textbook/file 的 `bookmarks` 都是整数组覆盖，且只有 `highlights` 分支要求 `expected_updated_at`；进度与书签分支没有 OCC（`src-tauri/src/dstu/handlers.rs:3561-3622,3740-3775`）。

可复现的交错是：窗口 A、B 都以空书签打开；A 新增书签并落盘；B 随后只翻一页，但把创建时的空书签随进度一起写回，A 的书签被清空。当前测试只证明“同一个 controller 的后写不恢复自己的旧快照”，没有两个 controller 交错用例（`previewPersistence.test.ts:39-177`）。

这不是普通 last-write-wins 的阅读页码问题，而是用户显式创建的书签被无关的翻页动作删除。修复应先让进度写只携带 `readingProgress`；书签写入则需要版本条件或 add/update/delete 操作协议，不能继续依赖整数组无条件覆盖。

### P1 — Learning Hub 关闭笔记标签不是 fail-closed，失败后没有草稿恢复入口

笔记编辑器本身会在卸载时尝试 flush，但 Learning Hub 的标签关闭链没有等待它：

- `closeTab` 直接从数组删除标签（`src/features/learning-hub/LearningHubPage.tsx:279-290`）。
- `TabPanelContainer` 没有接收或转发 `onSaveStateChange`，也不查询 dirty registry（`src/features/learning-hub/apps/TabPanelContainer.tsx:32-42,91-102`）。
- 编辑器卸载清理只是 fire-and-forget 调用 `flushNoteDraftRef.current()?.catch(() => {})`（`src/features/notes/NotesCrepeEditor.tsx:994-1013`）。

正常磁盘下这通常能补写成功，但如果保存冲突、维护模式、磁盘失败，标签已经消失，编辑器内的失败条和用户草稿也随实例一起不可达；应用紧接着退出时更没有完成保证。与之相对，Workbench Notes 已通过 `canClose` 在确认宿主异常时也保留窗口和编辑内容（`src/features/workbench/apps/notes/register.ts:13-22,39-43`）。同一个编辑器在两个宿主下形成了不同的数据安全等级。

现有 `contentDirtyRegistry` 已提供 `isContentDirty`、保存 handler 和失败不放行关闭的语义（`src/features/workbench/apps/content/contentDirtyRegistry.ts:46-101`），Learning Hub 应复用它：关闭单标签、关闭其他、关闭右侧、LRU 淘汰以及页面离开都必须走同一异步 close gate。

### P1 — “保存到所选目录”是两步非原子操作，失败却仍显示无条件成功

共享保存先调用 `notesDstuAdapter.createNote` 在根目录建笔记，再调用 `folderApi.moveItem`。移动失败只写 `console.warn`，返回值仍是 `{ ok: true }`，随后弹成功 toast（`src/shared/notes/saveTextAsNote.ts:68-93,99-127`）。对应测试还把该行为固定为成功（`src/shared/notes/__tests__/saveTextAsNote.test.ts:115-125`）。

“优先保住正文”是合理降级，但“用户选了目录 A，实际落在根目录，界面仍说保存成功”不是完整成功。用户最可能在目标目录寻找刚保存的摘录，结果会表现为内容丢失。

更关键的是，这个两步模型没有必要：后端 `dstu_create` 已能从 `metadata.folderId` 解析目标目录，并直接调用 `create_note_in_folder`（`src-tauri/src/dstu/handlers.rs:721-752,785-808`）。应把 `folderId` 纳入 `createNote` 的真实创建参数，一次提交资源与目录关系；若仍需兼容回退，结果类型必须区分“保存到目标目录”和“已保存但落在根目录”，toast 明示实际位置。

### P1 — PDF 同一选区出现两套“笔记”语义，共享入口还把资源 ID 当标题

当前 PDF 选区会同时出现：

- 高亮菜单里的“做笔记”：标题取摘录前 30 字，正文包含文档名和页码，但直接写根目录（`TextbookContentView.tsx:526-544`；`FileContentView.tsx:277-297`）。
- 共享工具条里的“保存为笔记”：可选目录并可立即打开，但只把 `documentTitle` 引用行加到正文，不携带页码（`src/features/pdf/components/PdfSelectionActions.tsx:99-103`）。

这两条不是分布在不同产品角落，而是被有意放在同一选区的上下两条工具栏（`EnhancedPdfViewer.tsx:3275-3287,3317-3321,3356-3360`）。名称无法让用户预判“一个落根且带页码，一个选目录但没有页码”。

共享入口的来源信息还有确定性错误：`EnhancedPdfViewer` 传给 `PdfSelectionActions` 的不是已有 `fileName`，而是 `resourcePath` 最后一段（`:3277-3282`）；上层传入的是 `node.path`（`TextbookContentView.tsx:838-853`；`FileContentView.tsx:733-749`），通常是 `note_/tb_/file_` 一类资源路径。共享保存又把该引用行放在正文第一行，标题推导会去掉 `>` 后直接使用这段 ID（`saveTextAsNote.ts:40-54`）。结果是同一 PDF 的多条摘录可能得到相同、不可读的资源 ID 标题，并且失去页码定位。

应只保留一个面向用户的摘录保存动作，统一传递显示标题、页码 locator、摘录文本和目标目录。高亮颜色操作可以保留独立菜单，但“做笔记/保存为笔记”不应各自维护一套落库语义。

### P2 — 笔记创建接口接受 tags，真实落库却固定为空数组

共享保存的请求模型公开 `tags`，`notesDstuAdapter.createNote` 也把它放进 `metadata`（`src/shared/notes/saveTextAsNote.ts:24-33,77-81`；`src/dstu/adapters/notesDstuAdapter.ts:189-201`）。但后端 note 创建分支将 `VfsCreateNoteParams.tags` 固定成 `vec![]`（`src-tauri/src/dstu/handlers.rs:800-806`）。

因此调用方和单元测试都可以观察到“标签参数已传递”，数据库中的新笔记仍没有标签。Quick Assistant 直写时携带的来源标签也受同一问题影响（`src/quick-assistant/service.ts:227-236`）。

这项后端行为未必是 0824 新引入，但 0824 新共享 API 继续把 tags 声明成有效能力，扩大了错误契约。应在后端校验并持久化 tags，补一条跨适配器/命令边界的集成测试；在修复前则应移除虚假的可选参数。

### P2 — Learning Hub 标签页持久化有两个状态回滚点

标签页持久化是本轮新增的连续性能力，但实现还不稳：

1. `persistedTabsCache` 只在首次读取时赋值，`savePersistedTabs` 写 localStorage 时不更新缓存（`src/features/learning-hub/LearningHubPage.tsx:122-159`）。页面在同一 renderer 中卸载再挂载时会从旧缓存恢复，并由挂载后的 effect 把旧状态重新覆盖回 localStorage。
2. 恢复校验使用旧的 `tab.dstuPath`（`:199-229`），而真正面板加载已经明确改为稳定 `resourceId`，因为 `dstuPath` 可能是人类可读路径且会过期（`UnifiedAppPanel.tsx:204-245`）。资源只是移动或重命名时，恢复逻辑会把仍存在的标签当失效标签删除。

此外，持久化解析只校验 `tabId/resourceId/dstuPath` 三个字符串，没有校验 `type/title/openedAt`（`LearningHubPage.tsx:134-145`）；损坏值会进入类型分发和 LRU 排序。应移除模块级陈旧缓存或让写入同步缓存，恢复时按 `resourceId` 重取节点并刷新 path/title，仅在稳定 ID 确认不存在时删除标签，同时对完整 `OpenTab` 做版本化白名单解析。

## 改造质量评价

### 做得好的地方

1. **笔记正文并发策略是明确的。** OCC token 先于正文读取，避免“新 token + 旧正文”配对；外部更新在 dirty/saving 时不推进保存基线；真实内容冲突保留“恢复我的版本”动作。这些约束有对应的竞态测试，不是注释式安全。
2. **保存队列覆盖了难处理的切换时序。** 在途旧版本完成后会继续排空最新草稿，切换笔记后仍绑定原笔记的保存回调；测试覆盖卸载、切换、回退到旧内容和旧请求失败后新请求成功（`tests/vitest/notes/NotesCrepeEditor.saveQueue.test.tsx:136-314`）。
3. **学习资源导入对部分失败较诚实。** Markdown 批量导入保留成功项并汇总失败文件，浏览器 File 分支有并发上限；成功后打开真实导入节点，而不是只显示完成动画（`LearningHubSidebar.tsx:900-1045,1391-1579`）。
4. **共享划词层的宿主边界清楚。** 保存按钮只有宿主提供真实回调时才出现；PDF 选择器使用内联结果面板和移动端目录子屏，减少了 portal、裁剪和返回键冲突。

### 质量不足的共同模式

本块的薄弱点不是缺少 helper，而是 helper 只解决了单实例成功路径：

- `previewPersistence` 有本地串行链，没有资源级并发协议；
- `NotesCrepeEditor` 有卸载 flush，宿主关闭动作却不等待结果；
- `saveTextAsNote` 有 Result，Result 却不能表达“目录移动失败的部分成功”；
- 标签页有持久化缓存，却没有稳定 ID 恢复和缓存一致性；
- `tags` 在前端类型和 mock 测试中存在，真实命令边界没有兑现。

现有测试也反映了这一点：笔记正文竞态测试较强；共享保存、阅读持久化和标签恢复主要在 mock 单元层验证局部行为，甚至把“移动失败仍无条件成功”固化成预期。后续测试重点不应再增加同层 happy path，而应覆盖两个窗口、真实命令边界、卸载失败和 remount。

## 相对 v0.9.44 的归因

- 0824 的净改善成立：统一 Notes Workspace、Learning Hub 多标签、PDF 划词能力、阅读进度控制器和共享目录选择保存都属于新增或实质改造；笔记正文 OCC/保存队列也显著提高了并发安全。
- Quick Assistant 直落根目录是 v0.9.44 已有路径，本轮没有新造；但共享文件头把它列作“改造前入口”，最终却未迁移，说明“统一保存入口”的改造目标没有完全兑现（`saveTextAsNote.ts:1-12` 对照 `quick-assistant/service.ts:227-236`）。
- 教材/文件阅读的直接摘录笔记与作文批改直存路径在本区间加入。它们各自能保存内容，但与后来新增的共享选目录流程叠加后形成当前分裂，不能简单归为历史债。
- tags 后端丢弃是否早于本轮不影响当前裁决：不应把存量缺陷算成 0824 新回归，但新 API 和新入口继续承诺该字段，属于本轮未做端到端收口。

## 优化顺序

1. 先修书签写入协议：进度 payload 不带书签，书签使用 CAS 或增量操作，并补两个阅读实例交错测试。
2. 给 Learning Hub 所有关闭/淘汰入口接入 dirty/save registry；保存失败必须保留标签和草稿。
3. 把“创建笔记 + 目标目录 + tags”收敛为一次后端提交；部分成功必须在 Result 和 UI 中可见。
4. 合并 PDF 两套笔记动作，传真实文档标题与页码 locator，统一目录、正文模板和打开动作。
5. 重写标签恢复为稳定 ID 重绑定，删除陈旧模块缓存，补“移动后重启”“同进程 remount”“损坏 payload”测试。

最终评价：0824 已把学习资源、阅读器和笔记编辑器连成了可用主链，尤其正文并发保存质量较高；但外围的书签、标签关闭、目录落点和 PDF 摘录仍各自维护局部真相。当前更准确的发布口径是 **“主链可用，数据落点与多实例边界有条件通过”**，不是全量收口。

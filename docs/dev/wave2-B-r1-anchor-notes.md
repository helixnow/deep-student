# 0824 Wave2-B 第 1 轮锚定 — notes 与「保存为笔记」保存链

- 角色：锚定员（只读产品代码，只写本文档）。
- 基线：`/workspace` @ `061b4815`（当前 HEAD `82e016b7` 为其上的会话分支空启动提交，产品代码与 `061b4815` 一致）。
- 对照评审：`docs/0824-quality-review/learning-notes.md`（P1「两步非原子」、P1「关标签不等待」、P2「tags 丢弃」、P1「PDF 双入口」）。
- 本轮只锚定证据与插入点，不改任何产品代码；`handlers.rs`/`coordinator.rs` 留给第 3 轮。

---

## 1. 保存链时序图（前端 → adapter → dstu_create → folder move）

以共享流程（聊天消息 / PDF 划词「保存为笔记」）为主链：

```
用户点「保存为笔记」
  │
  ├─ MessageItem.tsx:767 / PdfSelectionActions.tsx:67,99-103
  │    useSaveAsNoteFlow.start(request) → 打开 FolderPickerDialog
  │
  ▼ 用户选定目录（folderId | null）
useSaveAsNoteFlow.tsx:76-88  handleConfirm
  │  void saveTextAsNoteAndNotify({ content, title, tags, folderId }, { openSource })
  ▼
saveTextAsNote.ts:130-137  saveTextAsNoteAndNotify
  ▼
saveTextAsNote.ts:71-97  saveTextAsNote
  │
  │ 【第 1 步：创建，永远落根目录】
  ├─ :80  notesDstuAdapter.createNote(title, content, input.tags ?? [])
  │     ▼
  │   notesDstuAdapter.ts:189-206  createNote
  │     │  dstu.create('/', { type:'note', name, content, metadata:{ tags } })
  │     │  ← 注意：metadata 只有 tags，没有 folderId
  │     ▼
  │   dstu/api.ts:328-337  invoke('dstu_create', { path:'/', options })
  │     ▼
  │   handlers.rs  dstu_create
  │     ├─ :725-735  从 metadata.folderId 解析目录 → 本链恒为 None（前端没传）
  │     ├─ :737-749  从 path 解析目录 → path='/' 恒为 None
  │     ├─ :752      folder_id = None（根目录）
  │     └─ :800-808  VfsNoteRepo::create_note_in_folder(
  │                     VfsCreateNoteParams{ title, content, tags: vec![] },  ← tags 被硬编码丢弃
  │                     folder_id=None)
  │           ▼
  │        note_repo.rs:2220-2241  create_note_in_folder_with_conn
  │           BEGIN IMMEDIATE → 建资源+notes 行+folder_items(folder_id=None) → COMMIT
  │           （单事务，后端本身是原子的；非原子发生在前端第 2 步）
  │
  │ 【第 2 步：移动，可失败】
  ├─ :86-91  if (input.folderId) folderApi.moveItem('note', noteId, folderId)
  │     ▼
  │   folderApi.ts:269-302  invoke('dstu_folder_move_item', { itemType, itemId, newFolderId })
  │     ▼
  │   folder_handlers.rs:588-624  dstu_folder_move_item
  │       → VfsFolderRepo::move_item_to_folder（更新 folder_items 归属）
  │
  ▼
saveTextAsNote.ts:93  return { ok: true, noteId, title }   ← 无论第 2 步成败
  ▼
saveTextAsNote.ts:99-127  notifySaveTextAsNoteResult → 成功 toast + 「打开笔记」动作
```

关键结论：**目录信息从未进入 `dstu_create`**。`createNote` 的签名（notesDstuAdapter.ts:189-193）没有 folderId 参数；而后端 `dstu_create` 本来就支持 `metadata.folderId`（handlers.rs:725-735），且同文件的 `importMarkdownContent` 已经在用这条单次提交路径（notesDstuAdapter.ts:283-288，`metadata: folderId ? { folderId } : undefined`）。两步模型是前端自造的。

---

## 2. 「两步非原子 + 移动失败仍 ok:true」现码证据

1. **两步结构**：`saveTextAsNote.ts:80`（创建）与 `:86-91`（移动）是两次独立 IPC；两次调用之间进程崩溃 / 应用退出，笔记留在根目录且无任何记录。
2. **移动失败被吞**：

```86:93:src/shared/notes/saveTextAsNote.ts
    if (input.folderId) {
      const moved = await folderApi.moveItem('note', noteId, input.folderId);
      if (!moved.ok) {
        console.warn('[saveTextAsNote] note created but move to folder failed:', moved.error.message);
      }
    }

    return { ok: true, noteId, title };
```

3. **设计注释承认该取舍**（`saveTextAsNote.ts:65-70`：「目录移动失败不算整体失败」），但 Result 类型（`:35-37`）只有 ok/error 两态，无法表达「已保存但落在根目录」。
4. **成功 toast 无条件**：`notifySaveTextAsNoteResult`（`saveTextAsNote.ts:104-126`）只看 `result.ok`，移动失败时用户看到「已保存」+「打开笔记」，但去目标目录找不到笔记。
5. **测试把该行为固化为预期**：

```115:125:src/shared/notes/__tests__/saveTextAsNote.test.ts
  it('still reports success when only the folder move fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    moveItem.mockResolvedValue(err('目录不存在'));

    const result = await saveTextAsNote({ content: '正文', folderId: 'folder-x' });

    // 笔记已经写进去了，吞掉它比落在根目录更糟
    expect(result).toEqual({ ok: true, noteId: 'note-1', title: '正文' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
```

6. **后端反证（单次提交可行）**：`note_repo.rs:2220-2241` 的 `create_note_in_folder_with_conn` 用 `BEGIN IMMEDIATE` 把「建笔记 + folder_items 归属」包进同一事务，`:2251-2258` 还先校验目标目录存在。目录不存在时整个创建回滚返回 NotFound——一次提交天然消除「移动失败」这个状态。

---

## 3. tags：前端承诺 vs 后端 `vec![]` 证据

前端逐层传递：

- `SaveTextAsNoteInput.tags`（`saveTextAsNote.ts:31-32`）→ `createNote(title, content, input.tags ?? [])`（`:80`）。
- `useSaveAsNoteFlow` 的 `SaveAsNoteRequest.tags`（`useSaveAsNoteFlow.tsx:29-30`）→ `handleConfirm` 透传（`:81-82`）。
- 适配器把 tags 放进 metadata：

```196:201:src/dstu/adapters/notesDstuAdapter.ts
    const result = await dstu.create(path, {
      type: 'note',
      name: title,
      content,
      metadata: { tags },
    });
```

后端丢弃：

```800:808:src-tauri/src/dstu/handlers.rs
            match VfsNoteRepo::create_note_in_folder(
                &vfs_db,
                VfsCreateNoteParams {
                    title: note_title,
                    content: content.clone(),
                    tags: vec![],
                },
                folder_id.as_deref(),
            ) {
```

`dstu_create` 的 note 分支从不读取 `metadata.get("tags")`，直接硬编码 `vec![]`。而仓储层完全支持 tags：`create_note_with_conn` 会 `validate_tags`（`note_repo.rs:507-509`）并持久化。所以修复只是 handler 一处解析问题，不需要动 repo。

受影响的真实调用方：

- 共享流程（上文）——`tags` 参数目前是死代码。
- Quick Assistant：`src/quick-assistant/service.ts:233` 传 `metadata: { tags: [tt('service.tag')], source: 'quick-assistant' }`，来源标签同样落空。
- Textbook/File 直存入口传 `metadata: { tags: [] }`（`TextbookContentView.tsx:537`、`FileContentView.tsx:289`），恰好与后端行为一致，无观测差异。
- 单测断言的是 mock 适配器收到 tags（`saveTextAsNote.test.ts:100`），命令边界从未被验证——这就是评审说的「mock 层承诺」。

---

## 4. 四个直存入口 vs 共享流程差异表

| 维度 | ① Textbook 划词「做笔记」<br>`TextbookContentView.tsx:526-547` | ② File 划词「做笔记」<br>`FileContentView.tsx:277-297` | ③ 作文批改「存为笔记」<br>`EssayGradingWorkbench.tsx:1477-1512` | ④ Quick Assistant<br>`service.ts:227-237` | 共享流程（对照）<br>`useSaveAsNoteFlow` + `saveTextAsNote` |
|---|---|---|---|---|---|
| 调用方式 | `dstu.create('/')` 直调（:530） | `dstu.create('/')` 直调（:282） | `notesDstuAdapter.createNote(title, content)`（:1502） | `dstu.create('/')` 直调（:229） | `createNote` + `folderApi.moveItem` 两步 |
| 目录选择 | 无，恒根目录 | 无，恒根目录 | 无，恒根目录 | 无，恒根目录 | 有（FolderPickerDialog），但移动可静默失败 |
| 标题 | 摘录前 30 字（:528-529） | 摘录前 30 字（:280-281） | 会话标题/输入前 20 字 + 轮次（:1487-1494） | `compactTitle(source, …)`（:228） | `deriveNoteTitle` 首行去 MD 标记截 50 字（saveTextAsNote.ts:42-55） |
| 正文来源信息 | 引用块 + 「文档名 + 页码」来源行（:533-536） | 同左（:285-288） | 题目/原文/批改结果三段（:1495-1501） | 来源 + 回答两段模板（:232） | 仅 PDF 侧加 `> documentTitle` 引用行，**无页码**（PdfSelectionActions.tsx:99-103）；且 documentTitle 实为 `resourcePath` 末段（评审 P1，EnhancedPdfViewer :3277-3282） |
| tags | `{ tags: [] }`（:537） | `{ tags: [] }`（:289） | 不传（默认 `[]`） | `{ tags: ['快捷助手'], source: … }`（:233，被后端丢弃） | 类型上支持，实际被后端丢弃 |
| 成功反馈 | toast，无打开动作（:540） | toast，无打开动作（:292） | toast，无打开动作（:1504） | 返回 noteId，由调用方处理（:236） | toast + 「打开笔记」动作（saveTextAsNote.ts:115-126） |
| 失败反馈 | error toast（:542） | error toast（:294） | error toast（:1506-1510） | throw（:235） | error toast；**但移动失败仍算成功** |

分裂焦点：①② 与共享流程被有意放在**同一 PDF 选区的两层工具栏**（评审 :59，EnhancedPdfViewer.tsx:3275-3360），一个带页码落根目录、一个可选目录但没页码且标题可能是资源 ID。③④ 是独立产品面，收敛优先级低于 ①②，但同样应改走单次提交接口。

---

## 5. NotesCrepeEditor 卸载 flush 与 Learning Hub closeTab 的接缝

编辑器侧（尽力而为的兜底链）：

- 卸载 cleanup 是 fire-and-forget：

```994:1013:src/features/notes/NotesCrepeEditor.tsx
  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      cancelDebounce();
      // ... 清定时器、清编辑器引用 ...
      flushNoteDraftRef.current()?.catch(() => {});
    };
  }, []);
```

- `flushNoteDraft`（:800-811）→ `queueSave`（:773-798，按 noteId 去重入队）→ `runPendingSave`（:687-771，单飞共享 promise 排空队列；注释 :703-705 明确说明卸载期入队的草稿会被在途保存继续 await）。
- `executeSave`（:627-678）在 DSTU 模式下从 `dstuSaveByNoteRef`（:613-617 注册）取回原笔记的保存回调，即 `NoteContentView.handleSave`（NoteContentView.tsx:459-660，:918-921 处作为 `onSave` 传入），后者带 OCC（:552-554 `expectedUpdatedAtMs`）、维护模式拦截（:464-473 抛 isNonRetryable）、冲突处理（:560-648 抛 isNoteConflict）。
- 失败路径：冲突/不可重试直接放弃（:717-724）；普通失败指数退避重试 5 次（:727-747，最长约 1+2+4+8+16=31 秒）后放弃。组件已卸载时 `isUnmountedRef` 只抑制 setState 与 UI（:721,:739,:764），promise 无人 await、无人展示结果。

宿主侧（不等待、不确认）：

- `closeTab` 同步删数组，无任何 dirty 查询或 await：

```279:291:src/features/learning-hub/LearningHubPage.tsx
  const closeTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.tabId === tabId);
      if (idx === -1) return prev;
      const next = prev.filter(t => t.tabId !== tabId);
      // 激活相邻 tab（避开分屏 tab）
      setActiveTabId(currentId => {
        if (currentId !== tabId) return currentId;
        return pickNextActiveTab([next[idx], next[idx - 1]], next);
      });
      return next;
    });
  }, [pickNextActiveTab]);
```

- 批量关闭同构：`closeOtherTabs`（LearningHubPage.tsx:303 起）同样直接过滤数组。
- `TabPanelContainer` 的 props 面（:32-42）只有 `onClose/onTitleChange`，没有保存状态通道；面板渲染（:91-103）也不查 dirty。
- 额外的静默卸载入口：LRU 保活上限 `MAX_KEEPALIVE_TABS = 5`（TabPanelContainer.tsx:26），超限 tab 直接卸载（:139-144 计算保活集合，:180-183 过滤渲染）——用户没点关闭，编辑器也会走同一条 fire-and-forget flush。

对照组（同一编辑器在 Workbench 下是 fail-closed 的）：

- `canCloseNotesWorkspace`（`src/features/workbench/apps/notes/register.ts:13-23`）：有未保存修改先弹确认，确认宿主异常时返回 false 保留窗口；注册于 `:39` `canClose`。
- 基础设施已存在且语义完整：`contentDirtyRegistry.ts` 的 `isContentDirty`（:47-60，checker 抛错按 dirty 处理）与 `saveContentNow`（:93-103，任一失败不放行关闭）。

接缝总结：**数据安全等级由宿主决定**。Learning Hub 的所有关闭/淘汰路径（单关、关其他、LRU）都绕过了编辑器唯一的失败可见面（编辑器内的 saveError 条随实例一起销毁），保存冲突/维护模式/磁盘失败时草稿不可恢复。

---

## 6. 第 3 轮实现员插入点表

| # | 目标 | 文件与锚点（现码行号） | 改法要点 | 依赖/顺序 |
|---|---|---|---|---|
| 1 | handlers 一次提交 folderId + tags | `src-tauri/src/dstu/handlers.rs:800-806`（note 分支 `tags: vec![]`）；folderId 解析已就绪于 `:725-752` | 从 `metadata.get("tags")` 解析 `Vec<String>`（非法形状返回 INVALID_ARGUMENT，复用 `note_repo.rs:507-509` 的 `validate_tags` 语义）替换 `vec![]`。folder_id 已传入 `create_note_in_folder`，事务原子性由 `note_repo.rs:2220-2241` 现成保证，repo 层零改动 | 先行项；本会话第 3 轮唯一 handlers 改动，不碰书签分支（:3561-3775 只读记录）与 coordinator.rs |
| 2 | adapter 暴露 folderId | `src/dstu/adapters/notesDstuAdapter.ts:189-206` `createNote` | 增加 `folderId?: string \| null` 参数，metadata 组装 `{ tags, ...(folderId ? { folderId } : {}) }`；范式抄同文件 `importMarkdownContent`（:283-288） | 依赖 #1（否则 folderId 生效但 tags 仍丢） |
| 3 | saveTextAsNote 删两步 | `src/shared/notes/saveTextAsNote.ts:79-93`（创建+移动）；`:35-37`（Result 类型）；`:65-70`（旧取舍注释） | `createNote(title, content, tags, input.folderId)` 单次提交，删除 `folderApi.moveItem` 分支；目录不存在时后端整体失败（note_repo.rs:2251-2258），Result 不再需要「部分成功」态——若保留回退移动，则必须扩展 Result 表达「已保存但落根目录」并让 toast 明示实际落点（:99-127） | 依赖 #2 |
| 4 | 更新固化旧行为的测试 | `src/shared/notes/__tests__/saveTextAsNote.test.ts:110-125`（`skips the move`、`still reports success when only the folder move fails`）；`:100-102`（断言 createNote/moveItem 调用形状） | 改为断言 folderId 进入 createNote 调用、目录失败时整体失败；补一条跨命令边界（真实 `dstu_create`）的 tags 持久化集成测试 | 与 #3 同 PR |
| 5 | 入口收敛：PDF 双动作合一 | `TextbookContentView.tsx:526-547`、`FileContentView.tsx:277-297`（直存）；`PdfSelectionActions.tsx:99-103`（共享入口拼正文）；EnhancedPdfViewer.tsx:3275-3287,3317-3321,3356-3360（同选区两套动作）、:3277-3282（resourcePath 当标题传入） | 高亮菜单「做笔记」改走共享流程；共享流程入参补真实 `node.name` 与页码 locator（模板复用 `buildSelectionNoteContent` 的来源行），删除直存 `dstu.create` 分支 | 依赖 #3；标题错误（资源 ID 当 documentTitle）在此一并修 |
| 6 | 入口收敛：作文批改 & Quick Assistant | `EssayGradingWorkbench.tsx:1502`（`createNote(title, content)`）；`quick-assistant/service.ts:229-234`（`dstu.create('/')` 直调） | 至少改为携带 tags 的新 `createNote` 签名；是否接目录选择由产品决定（Quick Assistant 直落根是 v0.9.44 存量，评审 :106 已归因），但 `saveTextAsNote.ts:1-12` 文件头宣称的「统一入口」应与现实对齐 | 依赖 #2；低风险独立提交 |
| 7 | Learning Hub 关闭链接入 dirty/save gate | `LearningHubPage.tsx:279-291`（closeTab）、:303 起（closeOtherTabs 等批量）；`TabPanelContainer.tsx:32-42`（props 无保存通道）、:26,:139-144,:180-183（LRU 淘汰）；复用 `contentDirtyRegistry.ts:47-60,93-103`；对照 `workbench/apps/notes/register.ts:13-23` | 所有关闭/淘汰入口先 `isContentDirty` → `saveContentNow`，失败保留标签与草稿（fail-closed）；NoteContentView 需向 registry 注册 checker/save handler（其 handleSave `NoteContentView.tsx:459-660` 可直接作为 save handler） | 可与 #1-4 并行；属评审 P1-2，改动面在 Learning Hub 前端 |

风险提示（给第 3 轮）：

- #1 解析 tags 时注意 `metadata` 里 tags 可能是 `null`/非数组（Quick Assistant 与直存入口传的形状各异），INVALID_ARGUMENT 与「忽略降级」二选一要写明。
- #3 删除 moveItem 后，`folderApi.moveItem` 内的缓存失效与 `emitDstuFolderChange('item-moved')`（folderApi.ts:282-294）不再触发；单次提交路径需确认 `dstu_create` 返回后前端有等价的目录树刷新事件（`importMarkdownContent` 既有路径可作行为参照）。
- #7 LRU 淘汰（非用户动作）不宜弹确认框；对淘汰路径应改为「dirty 则豁免淘汰或先 await saveContentNow」，与用户主动关闭区分。

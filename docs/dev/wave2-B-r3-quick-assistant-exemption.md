# Wave2-B 第 3 轮:Quick Assistant「存为笔记」书面豁免

> 角色:入口收敛-2。裁决对象:`src/quick-assistant/service.ts` 的 `saveAsNote`(改动前 :227-236,`dstu.create('/')` 直落根目录)。
> 对照物:`src/shared/notes/saveTextAsNote.ts` 头注宣称的统一入口(目录选择 + 「打开笔记」toast + 标题推导)。
> 底稿:`wave2-B-r1-anchor-notes.md` §5 四直存入口差异表(第 ④ 列)与 §6 插入点表 #6。

## 裁决

**豁免:判定为独立产品语义,不迁入共享 saveTextAsNote 流程。** 依据本轮任务卡口径:「系统级剪贴快速落笔记、不应弹目录」成立,不硬改体验。

## 证据链(行号为本轮工作区实况)

### 1. 运行环境:轻量独立窗,共享流程的两大支柱均无宿主

- `src/main.tsx:364-366`:`window=quick-assistant` 查询参数分流,与番茄钟置顶小窗同列 `IS_LIGHTWEIGHT_WINDOW`;`main.tsx:434-437` 只 render `QuickAssistantWindow`,**刻意跳过完整 App 与全部重量级初始化**(`main.tsx:361` 注释自述)。
- 支柱一(目录选择):`useSaveAsNoteFlow.tsx:20` 静态引入 learning-hub 的 `FolderPickerDialog`。迁移即把 finder 目录树整链(folderApi、Dialog 栈、断点 hook)拖进轻量窗,违背该窗的体积/启动契约。
- 支柱二(结果反馈):`saveTextAsNote.ts:100-127` 的 `notifySaveTextAsNoteResult` 依赖 `showGlobalNotification`(UnifiedNotification 宿主只挂在 main 窗 App 树);「打开笔记」动作走 `window.dispatchEvent(DSTU_OPEN_NOTE)`(`saveTextAsNote.ts:61-63`),而该事件仅有两个消费方——`WorkbenchEventBridge.tsx:213-215` 与 `useChatPageEvents.ts:70-72`——**均只存在于 main 窗**。在 quick 窗派发等于对空气广播。
- Quick Assistant 的跨窗打开已有专用桥:`quick-assistant/window.ts:44-54` `openQuickAssistantTarget` 经 `emitTo('main', …)` + 聚焦 main 窗 + 隐藏自身。这是与 DSTU_OPEN_NOTE 并行的既有契约,不应为一个 toast 动作再造第三条通道。

### 2. 产品语义:一击即存的捕获流,目录选择是负资产

- `QuickAssistantWindow.tsx:505-515`:「笔记/错题/卡片/待办」四个保存键并列同构,全部一击直存 + 本窗内 `notify` 轻提示;错题(`bulkImportProblemCards`)、卡片(`ankiApiAdapter`)、待办(`ensureInbox` 收件箱)同样不问落点。单独给「笔记」弹全屏目录树,在四键族内制造行为分裂,且打断全局快捷键唤起的秒级捕获流。
- `service.ts` 落库形态有自己的结构:`compactTitle` 取材料前 32 字、正文分「原文 / 解答」两节、`metadata: { tags, source: 'quick-assistant' }`。其中 **metadata.source 是 `dstu.create` 直调才有的能力**,`saveTextAsNote` 的 `notesDstuAdapter.createNote(title, content, tags)` 签名不承载,迁移反而丢信息。
- 评审底稿已有归因:anchor-notes §6 #6 明言「Quick Assistant 直落根是 v0.9.44 存量,是否接目录选择由产品决定」——即第 1 轮锚定时就未将其定性为漏迁。

## 为什么不是「漏迁」

`saveTextAsNote.ts:4` 头注把「快捷助手」列进改造前旧入口清单,单看会读成未完成的迁移。但该头注同段声明的统一三件事(目录选择 / 打开笔记 toast / 标题推导)在 quick 窗**一件都没有可运行的宿主**(见证据 1);且 quick 侧连底层 API 都不同(`dstu.create` 带 metadata,而非 `notesDstuAdapter.createNote`)。语义与实现双重独立,故定性为豁免而非漏迁。

**遗留移交**:`saveTextAsNote.ts` 头注中「快捷助手」字样与本裁决不一致,该文件在本角色禁改区(本轮由收口员持有),建议其将头注旧入口清单改为「聊天消息、聊天划词」并附本文档索引,消除后来者误读。

## 本轮实际改动(quick-assistant 侧)

- `service.ts` `saveAsNote` 上方新增 8 行头注,说明豁免理由并指回本文档。**函数体零改动**,体验不变。

## 未验证声明

全部结论为静态读码 + grep 证据,未跑 npm/vitest/编译(第 8 轮前禁止);「showGlobalNotification 在 quick 窗无宿主渲染」为挂载树静态推演,未真机确认。

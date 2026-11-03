# Task4 — 手写编辑器与可恢复草稿

Repo /home/xutao/deepstudent/deep-student featurebranch. Read first requirements. Scope `src/features/ink/{InkEditor,InkPageView,InkToolbar}.tsx`, `drafts.ts`,`editorSession.ts`,`useInkDocument.ts`、相应unit/CT在tests/ct/ink-editor、locale en-US/zh-CN ink.json与i18n.ts最小namespace注册、report。别动api/types/renderer/Office/Rust。主agent测试，子agentNO tests/build/install/agents/commits。

## Current contracts

types.ts稳定manifest/page/object。renderer.ts renderInkPage(canvas,pageRef,page,{background?,crop?,scale?,max_pixels?})同一renderer已7真实Canvas测试通过；geometry/input已10unit通过。`api.ts`由另agent写，functions `createInk(request)`, `getInk({document_id})`, `getInkPage({document_id,page_id})`, `saveInkPage({document_id,expected_revision,operation_id,page})`, `copyInk(request)`, `InkApiError`。统一invoke `{request}`，snake_case，返回manifest/page。不复制存储逻辑。追加页/改名接口尚待后端，组件可通过可选 onAppendPage/onRename 回调暂接待集成，但最终必须连API；不能把空按钮当实现。

## FIRST gate

先写成功状态测试+最小组件/hook/journal接口scaffold，不先生产功能。3项起步：加载指定manifest/page→canvas可实际书写一笔并保存可重开；保存冲突保留草稿/提示不丢笔；隐藏/unmount/remount恢复持久draft。STOP NEEDS_RED_VERIFICATION。mock only Tauri transport boundaries with真实manifest/page及内存CAS服务，不mockrenderer；真实CT像素和pointer输入，fixture纯自建。IDB可用浏览器真实存储，unit fake storage通过接口注入但不assert mockcalls替代行为。

## 产品行为

- `InkEditor({documentId,className?,initialPageId?,onAskAi?,onExport?})` 资源宿主嵌入，不新顶层view。独立ErrorBoundary；加载/错/恢复提示/保存状态中英i18n。
- 一份sharedrenderer。当前笔overlay+完成页canvas分层，采样存在refs不逐点ReactsetState；PointerEvents/coalesced。压感笔/荧光笔、整笔橡皮（geometryobjectHitTest），颜色/宽度、undo/redo、zoom/pan、页导航、A4空白/ruling（新建在资源入口）、追加页/改名接统一API。shape/text显示AI对象无需另写编辑器。
- touch默认平移不画误笔；显式允许手指书写切换。pen捕获pointer，笔期间忽略touch；pointercancel/up结束一次有效笔，取最后样本，坐标clamp页内。手掌误触真机单列，不能声称浏览器验证足够。
- 仅当前页和最多1邻页加载，Canvas max16M，DPR控制输出尺寸，CSS逻辑尺寸保持geometry。页切换先finish+flush，不丢草稿。
- 每笔完成先await持久draft（原生IndexedDB，无新依赖；不要用容量不足localStorage存8MiB页），再save CAS；journal包含document/page/base_revision/page数据/sequence。写入失败不假称saved；保存失败retry；冲突保留本地draft，提供reload remote与另存副本/保留草稿入口，绝不自动回滚人类笔。
- 串行页保存，避免同document不同页并发rev乱序。回复到达若用户又写新笔不删新draft（sequence/CAS）；忽略过期load但不丢数据。
- `editorSession.ts`应用级注册dirty/flush，用于工具协调：`flushInkEditor(documentId):Promise<...>`；无法flush返回EDITOR_BUSY。严格docID，多个编辑器冲突不静默覆盖。注册生命周期能在卸载前finish+persist，但不可依赖unmount异步唯一保障；visibility/pagehide钩子复用现有events/eventregistry（不裸window.addEventListener）。
- “问AI”finish→flush→callback(documentId,pageId,revision)，不直接调用模型；export同version。AI事件刷新仅无dirty时reload，否则先协调。
- DsButton/Input/AppSelect/Tooltip等现有组件、cn fromutils、语义theme/UI颜色，画布纸白/笔色为文档内容可固定，不用TSX硬编码UI颜色。详读 docs/frontend/components.md/patterns.md 相关节，不用原生button/select、不扩deprecatedScrollArea。

First handoff minimaltests<=20toolcalls，无需先建所有UI后再tests。后续验收覆盖undoredo/橡皮/压感fallback/手指与pan/失败重试/切页卸载恢复/active stroke/canvas预算/实际像素。报告tasks/task-4-report.md selectors和API依赖，不宣称未跑测试通过。

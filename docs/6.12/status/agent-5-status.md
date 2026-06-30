# 代理 5 状态文档 —— 制卡与间隔重复

## 任务目标
全面审阅"理解 → 长期记忆"固化链:Anki 服务族(AnkiConnect 对接、APKG 导出、增强制卡、流式批量制卡)、
间隔重复(SRS)算法、复习计划,以及前端制卡流程、任务看板、模板编辑器/管理、CSV 导入、3D 预览。
识别 bug/性能/安全/体验问题,在职责域内实施低风险优化(高风险方案登记待用户确认),全程维护本文档。

## 当前状态
T1-T13 全部完成。审阅 23 项发现(F1-F23,1 项撤销),实施 11 项优化(O1-O11,其中 O6-O11 为用户批准的高风险项)。
验证全部通过:
- cargo check:exit 0(2026-06-13 00:31,Finished dev profile;全库 100 条警告与改动前持平,均为其他域既有警告)
- npm run typecheck(tsc --noEmit):exit 0(覆盖 O4/O5 复验与 F16 删除、F19/F20 前端改动)
- vitest TaskController:4/4 通过(含 cancel 改接新命令断言)
- 二轮复查:anki_database 与 database 为同一 Arc 别名(lib.rs:1847)、cancel 与 pause/resume 同句柄一致、
  ControlTaskOutput.tasks 可选字段、调度协程对"状态被删"路径不复活幽灵条目、无任何残留对已删文件的引用
本组工作收尾,等待用户验收。F21/F22/F3/F5/F7/F9/F11/F13/F14 为低优先级登记项,未动。
最后更新:2026-06-13 00:45

## 职责域文件清单(审阅范围)
后端:
- `src-tauri/src/streaming_anki_service.rs`(98KB)
- `src-tauri/src/apkg_exporter_service.rs`(57KB)
- `src-tauri/src/enhanced_anki_service.rs`(39KB)
- `src-tauri/src/anki_connect_service.rs`(30KB)
- `src-tauri/src/review_plan_service.rs`(30KB)
- `src-tauri/src/spaced_repetition.rs`(16KB)

前端:
- `src/components/anki/**`(30 文件:panels、cardforge 引擎、TaskDashboardPage、services、utils)
- `src/features/anki/ankiCompletionNotifier.ts`
- `src/features/chat/anki/index.tsx`(19KB,UI 入口归本组,对话管线归代理 1)
- `src/components/RealTimeTemplateEditor/`(index.tsx + template.worker.ts + css)
- `src/components/MinimalTemplateEditor.tsx`(46KB)、`EnhancedTemplateEditor.tsx`(36KB)
- `src/components/FieldTypeConfigurator.tsx`、`Card3DPreview.tsx`、`AnkiCardPreviewModal.tsx`
- `src/components/CsvImportDialog.tsx`(30KB)、`CsvFieldMapper.tsx`
- `src/features/template-management/`

## TODO 计划
- [x] T1 streaming_anki_service.rs + enhanced_anki_service.rs:并发控制、断点续传状态机、取消清理(2026-06-12,发现 F1-F5)
- [x] T2 LLM 生成卡片容错:后端解析容错已审(T1);前端所有模板渲染路径走沙箱(T3),看板/聊天卡片列表以 React 文本节点渲染不解析 HTML(T9/T11),CardAgent 对后端事件做卡片结构校验(T10);无注入面(2026-06-13)
- [x] T3 模板系统安全:全部域内预览(模板编辑/管理/选择器/3D/弹窗/聊天内渲染)统一走 HtmlSandboxPreview=DOMPurify 消毒+iframe sandbox(allow-scripts 无 same-origin,不透明源)+严格 CSP+CSS 消毒;全域无 dangerouslySetInnerHTML 直插;结论:安全架构健全(2026-06-12,发现 F15-F17)
- [x] T4 anki_connect_service.rs:错误提示、同名冲突、canAddNotes 去重(2026-06-12,发现 F6/F7,修复 O1)
- [x] T5 apkg_exporter_service.rs:媒体完整性、内存、格式兼容(2026-06-12,发现 F9-F12,修复 O2/O3)
- [x] T6 spaced_repetition.rs:SM-2 正确、失败保留 EF 符合原始规范、本地时区一致、fuzz 防洪峰;无问题(2026-06-12)
- [x] T7 review_plan_service.rs + review_plan_repo 抽查:事务正确、时区用 Local 与 todo 约定一致、与番茄钟无隐式耦合(仅日期语义约定);无问题(2026-06-12)
- [x] T8 模板编辑器:MinimalTemplateEditor(唯一在用编辑器)实时预览原先每按键同步跑 Mustache 管线+iframe srcDoc 整页重载,已实施 O4 防抖 300ms+memo;CodeMirror 撤销栈用默认配置正常;另发现 RealTime/Enhanced 两编辑器是死代码(F16)(2026-06-12)
- [x] T9 任务看板 TaskDashboardPage(1394行)+ streamEventHandler:整体质量高(智能轮询+视图可见性门控、内联删除确认、allSettled 批量重试、导出双击锁);发现 F19(Cancelled 计入失败但重试不覆盖)、streamEventHandler 整库无消费者(并入 F16);卡片内容以 React 文本节点渲染,无注入面(T2 同步关闭)(2026-06-13)
- [x] T10 cardforge 引擎:CardAgent(收集器先订阅后调用防竞态、事件按 document_id 隔离、工具调用入参校验,质量良好);发现 F20(cancel=删除会话,破坏性语义)、F21(收集器 5 分钟超时对大文档不足)、F22(SegmentEngine.hardSplit 对英文按字符计 0 token,与 estimateTokens 词级估算不一致,仅影响前端预估);TaskController/chatV2Adapter 一致;CardEngine/useCardForge/panels 无运行时消费者(并入 F16)(2026-06-13)
- [x] T11 CSV 导入(事件监听清理、exam_id 会话隔离、取消语义明确告知,无问题)+ 3D 预览(发现 F23 全量 iframe 挂载,已修 O5)+ 对话制卡入口 chat/anki(导出/同步报告语义清晰,部分成功/全重复区分到位,无问题)+ AnkiCardPreviewModal(走沙箱,无问题)(2026-06-13)
- [x] T12 域内修复实施 + 验证:O1-O11 全部实施;cargo check exit 0、tsc --noEmit exit 0、TaskController vitest 4/4(2026-06-13)
- [x] T13 汇总:见下方"最终汇总"(2026-06-13)

## 审阅发现
| # | 文件/位置 | 类型 | 严重度 | 描述 | 处理 |
|---|-----------|------|--------|------|------|
| F1 | streaming_anki_service.rs:2193-2212 | 坏味道 | 低 | `pause_streaming`/`resume_streaming` 及整个 `pause_senders`/`pause_rx` 软暂停机制是死代码：全仓库无调用方（文档级暂停实际走 `cancel_streaming` 硬取消）。pause_rx 分支(L808-810)永不触发 | 已修复(O6,用户批准) |
| F2 | streaming_anki_service.rs:953-1000 | bug | 低 | 流结束后的残留缓冲只尝试整体解析一次；若 buffer 中积累了多张带分隔符的完整卡（仅软暂停路径可触发，当前为死代码），会整体解析失败变成一张错误卡。配合 F1 一起处理 | 已修复(O6,软暂停路径移除后唯一触发面消失) |
| F3 | streaming_anki_service.rs:324 / 2161 | 坏味道 | 低 | 以错误消息字符串(`CANCELLED_BY_USER`、包含"超时/截断")做控制流分支，脆弱 | 建议（重构成枚举属中风险，登记不动） |
| F4 | enhanced_anki_service.rs:385-503 | bug(竞态) | 中 | 暂停→快速恢复竞态：`pause` 立即置 `running=false`，但旧调度协程要到下一个任务完成才观察到 `paused` 退出；若在此窗口内 `resume`（置 paused=false 并 spawn 新调度协程），旧协程不会退出，新旧两个调度协程并发处理同一批 Pending 任务→重复 LLM 调用（卡片靠 DB 唯一索引去重，但浪费 token 且进度事件混乱） | 已修复(O7,调度代际 epoch,用户批准) |
| F5 | enhanced_anki_service.rs:259-260 | 坏味道 | 低 | 用 sleep(20ms) 缩小"取消信号注册前就被取消"的竞态窗口，兜底靠 handle.abort()；能用但非确定性 | 建议（保持现状，兜底已覆盖） |
| F6 | anki_connect_service.rs:356-357 | 性能 | 中 | `get_model_field_names` 每次调用都先跑完整 `check_anki_connect_availability`（TCP探测+GET+POST version 三连）；`add_notes_to_anki_detailed` 入口已检查过一次，循环内每个模型又重复检查，N 模板同步多付 N×3 次网络探测 | 已修复（见优化 O1） |
| F7 | anki_connect_service.rs:159-268 | 体验 | 低 | 可用性检查的超时提示文案写"5秒"，实际 POST 超时 15 秒；且 println! 大量输出诊断（全文件用 println! 而非 tracing） | 建议（文案随 O1 顺带核对；println→tracing 改动面大，登记） |
| F8 | cmd/anki_connect.rs:521-528 vs enhanced_anki_service.rs:715-729 | 体验/不一致 | 中 | 同为 APKG 导出取模板：`export_cards_as_apkg_with_template` 模板缺失直接报错中断导出；`export_apkg_for_selection` 则 warn 后回退默认模板继续。卡片引用已删除模板时前者让整批导出失败 | 已修复(O8,统一警告+回退,用户批准) |
| F9 | apkg_exporter_service.rs:552 | 坏味道 | 低 | note_id 用 `now秒*1000+序号` 生成,同秒多次导出产生相同 id;因 guid 唯一且 Anki 导入会处理冲突,实际无害 | 建议(不动) |
| F10 | apkg_exporter_service.rs:556-567/660-671 | 体验/隐私 | 中 | >4 字段模板导出时用 warn! 打印模板字段、extra_fields 键、每个字段值(截断50字符),卡片内容刷进 warn 日志 | 已修复(O2,降级 debug!) |
| F11 | apkg_exporter_service.rs:1165-1190 vs 539-700 | 不一致 | 低 | 多模板导出 insert_note 字段映射比单模板路径简化:text 不回退 extra_fields、无 ALIAS_MAP。正常生成链路下 card.text 已被填充,影响有限 | 建议(登记,统一需较大重构) |
| F12 | apkg_exporter_service.rs:1237-1268 | bug | 中 | 多模板导出:media 清单先编号、zip 写入时读文件失败被静默跳过(`if let Ok`),导致清单引用悬空条目,Anki 导入报媒体缺失 | 已修复(O3,先读后编号,失败 warn 且不进清单) |
| F13 | apkg_exporter_service.rs:517-526 | 兼容 | 低 | csum 用原始 sort_field 算 SHA1 前4字节;Anki 官方对首字段先 strip HTML 再算。仅影响 Anki 端重复检测精度,不影响导入 | 建议(不动,改动有回归风险) |
| F14 | apkg_exporter_service.rs:889-963 | 性能 | 低 | 导出时整库 fs::read 进内存+每个媒体文件整读;桌面端数千卡片规模可接受 | 建议(不动) |
| F15 | src/components/previews/htmlSandboxPolicy.ts | 安全(正面结论) | — | 模板预览安全体系核验通过:DOMPurify 白名单消毒(禁 script/iframe/事件属性)+CSS 消毒(禁 @import/javascript: 等)+iframe sandbox="allow-scripts"(无 allow-same-origin→不透明源,拿不到宿主 cookie/storage)+CSP default-src 'none';域内全部 7 个预览入口均经此通道,无 dangerouslySetInnerHTML 直插 | 无需处理 |
| F16 | 域内死代码清单 | 死代码 | 中 | 全仓库无任何运行时消费者:① RealTimeTemplateEditor/(整目录含 worker)② EnhancedTemplateEditor.tsx + .debug.tsx(与①合计约 95KB;唯一在用编辑器是 MinimalTemplateEditor)③ anki/services/streamEventHandler.ts(仅被自身 index 再导出)④ anki/panels/ 三面板(DocumentUploadPanel/MaterialQueuePanel/ExportPanel,仅被 anki/index.ts 再导出,无人 import 该入口)⑤ cardforge CardEngine.ts(导出未消费)+ TaskController.examples.ts(13KB 示例文件)⑥ useCardForge(导出+测试,无生产消费者)。聊天制卡实际链路:AnkiPanelHost→ChatV2AnkiAdapter→cardAgent/taskController | 已修复(O11,17 文件全删+index 修复,用户批准) |
| F17 | MinimalTemplateEditor.tsx(原 614/725 行) | 性能 | 中 | 实时预览无防抖:每次按键同步执行 renderCardPreview(i18n returnObjects+约15趟正则+Mustache.render)+previewDataJson 双重 JSON.parse+iframe srcDoc 变化触发整页重新导航(解析/执行/布局+可见闪烁) | 已修复(O4) |
| F18 | (撤销)RealTimeTemplateEditor handleCancelRequest 未 await unifiedConfirm | 误报 | — | 复核:unifiedConfirm 是同步函数(返回 boolean 的双击确认模式,8s 窗口),不存在未 await 问题;且该文件本身是死代码(F16) | 撤销 |
| F19 | TaskDashboardPage retryFailed vs database/mod.rs:5574 | 体验/不一致 | 低 | 看板会话统计把 Cancelled 任务计入 failed_tasks(SQL IN ('Failed','Truncated','Cancelled')),会话被标为"失败"组;但"重试失败"只筛 Failed/Truncated——仅含 Cancelled 的会话点重试得到"没有卡住的任务",与徽标矛盾。Cancelled 是否应重试/是否应计为失败需产品决策 | 已修复(O10,重试覆盖 Cancelled,用户批准) |
| F20 | cardforge controlTask('cancel') / TaskController.cancel → delete_document_session | 体验(破坏性语义) | 中 | 聊天工具 anki_control_task 的 cancel 动作实际执行"删除整个文档会话"(后端级联删任务+已生成卡片)。LLM 或用户说"取消"会连已生成的卡一起清掉,而非仅停止生成。建议引入仅停止不删除的真取消,或在工具描述中明示破坏性 | 已修复(O9,新增非破坏性取消命令,用户批准) |
| F21 | CardAgent.createCardCollector 超时 300_000ms | bug(边界) | 低 | 整个文档生成共用 5 分钟超时;大文档多分段×LLM 调用容易超过,超时后 generateCards 以部分卡片"成功"返回,后端仍在继续生成,聊天块卡片数与最终库内数量不一致(看板可看到全量)。建议超时按"距上次事件的空闲时间"计或按段数放大 | 建议(登记,改动需测大文档场景) |
| F22 | SegmentEngine.hardSplit/estimateCharTokens | bug(估算) | 低 | hardSplit 逐字符累计 token 时 ASCII 字母返回 0(设计上由词级估算覆盖,但 hardSplit 不做词级),英文文档几乎不产生分割点→analyzeContent 对英文长文低估分段数。实际切分在后端,不影响真实生成 | 建议(登记;该引擎仅用于预估) |
| F23 | Card3DPreview.tsx | 性能 | 中 | 3D 预览对全部卡片急切挂载正反两个沙箱 iframe(N 卡=2N iframe,各自完整文档+脚本),距离>4 的卡片仅 visibility:hidden 仍全量渲染;聊天内大批量制卡(50+)时内存/CPU 开销大 | 已修复(O5,窗口化 ±4) |

## 已实施的优化
| # | 改动文件 | 改动说明 | 验证结果 |
|---|----------|----------|----------|
| O1 | src-tauri/src/anki_connect_service.rs | 移除 `get_model_field_names` 内冗余的 `check_anki_connect_availability`(唯一调用方入口已检查),并补充函数文档;修正超时文案"5秒"与实际不符 | cargo check exit 0(2026-06-13) |
| O2 | src-tauri/src/apkg_exporter_service.rs | 多字段模板导出的调试日志 warn!→debug!(共3处),避免卡片内容刷爆 warn 日志;iPad 诊断 println!→debug! | cargo check exit 0(2026-06-13) |
| O3 | src-tauri/src/apkg_exporter_service.rs | `export_multi_template_apkg` 媒体打包改为"先读取成功再编号进清单",修复清单悬空引用;读失败 warn 并跳过 | cargo check exit 0(2026-06-13) |
| O4 | src/components/MinimalTemplateEditor.tsx | 预览渲染防抖:formData/previewDataJson 经 useDebounce(300ms)+useMemo 后再喂 renderCardPreview 与 IframePreview,消除每按键的同步 Mustache 管线与 iframe 整页重载;顺带删除 handleSubmit 内未使用的 parsedPreviewData 死变量(避免遮蔽组件级同名 memo) | tsc --noEmit 通过(2026-06-12) |
| O5 | src/components/Card3DPreview.tsx | 3D 预览窗口化渲染:仅对距当前卡 ±4(与 getCardTransform 可见窗口一致)的卡片挂载正/反面沙箱 iframe,远处卡片跳过模板渲染与 iframe 实例化;50 卡场景 iframe 数 100→≤18 | tsc exit 0(2026-06-13 复验) |
| O6 | src-tauri/src/streaming_anki_service.rs | (F1+F2,用户批准)移除软暂停死代码:`pause_senders` 字段及初始化、`pause_tx/pause_rx` 通道、`stream_cards_from_ai` 的 pause_rx 参数与循环内 borrow 检查、公开方法 `pause_streaming`/`resume_streaming` 整体删除;F2 残留缓冲多卡场景的唯一触发面随之消失 | cargo check exit 0(2026-06-13) |
| O7 | src-tauri/src/enhanced_anki_service.rs | (F4,用户批准)引入调度代际:`DocumentRunState` 增加 `epoch:u64`;启动/恢复调度时 epoch+1 并由该调度协程持有,暂停/取消/删除会话时 epoch+1 使旧协程失效;`process_all_tasks_async` 在任务前检查、流间检查、统一重试、收尾清理/完成事件四处均校验代际,旧协程不再清理新协程的状态;顺带把 current_task_id 记录从 entry().or_default() 改为 get_mut,避免会话删除后复活幽灵状态;测试构造补 `..Default::default()` | cargo check exit 0(2026-06-13) |
| O8 | src-tauri/src/cmd/anki_connect.rs | (F8,用户批准)`export_cards_as_apkg_with_template` 取模板失败从直接报错中断改为 log::warn + 回退默认 Basic 模板继续导出,与 `export_apkg_for_selection` 行为一致 | cargo check exit 0(2026-06-13) |
| O9 | 后端:enhanced_anki_service.rs + cmd/enhanced_anki.rs + lib.rs + chat_v2/tools/chatanki_executor.rs;前端:cardforge/engines/{CardAgent,TaskController}.ts + features/chat/skills/builtin/index.ts + tests/vitest/anki/cardforge/TaskController.test.ts | (F20,用户批准)新增非破坏性取消:服务层 `cancel_document_processing`(epoch 失效调度+断流+Pending/Processing/Streaming/Paused→Cancelled+发完成事件,保留已生成卡片);注册同名 Tauri 命令;chatanki_executor 的 cancel 分支改调该服务(原手工实现只改 DB 状态、调度协程仍会继续跑剩余任务——顺带修复);前端 CardAgent.controlTask('cancel') 与 TaskController.cancel 改接新命令;chatanki_control 工具描述注明"cancel 仅停止生成,已生成的卡片会保留";更新单测 | cargo check exit 0 + vitest 4/4(2026-06-13) |
| O10 | src/components/anki/TaskDashboardPage.tsx + src-tauri/src/enhanced_anki_service.rs(trigger_task_processing) | (F19,用户批准)看板"重试失败"筛选条件补 Cancelled,与会话统计 failed_tasks 口径(Failed/Truncated/Cancelled)一致;后端 trigger_task_processing 状态校验同步放行 Cancelled | cargo check exit 0 + tsc exit 0(2026-06-13) |
| O11 | 删除 17 个死代码文件 + 修复 3 个 index | (F16,用户批准)删除:RealTimeTemplateEditor/ 整目录(index.tsx+template.worker.ts+css)、EnhancedTemplateEditor.tsx+.debug.tsx、anki/services/(streamEventHandler.ts+index.ts)、anki/panels/ 整目录(3 面板+index.ts)、anki/hooks/index.ts、cardforge/hooks/(useCardForge.ts+测试+index.ts)、cardforge/engines/CardEngine.ts+TaskController.examples.ts,合计约 165KB;修复再导出:anki/index.ts(去 services/hooks/panels 段)、cardforge/index.ts(去 CardEngine/useCardForge 导出与 Hook 文档示例)、cardforge/engines/index.ts(去 CardEngine 段);残留引用仅 style-lab/scan-data.json(静态扫描快照数据)与一条 CSS 注释,均为惰性数据 | tsc exit 0 + vitest 4/4(2026-06-13) |

## 最终汇总
- 审阅覆盖:T1-T11 共 11 个审阅单元,后端 6 服务 + 前端编辑器/看板/cardforge/CSV/3D/对话入口全部过完。
- 发现:23 项(F1-F23),其中 1 项误报撤销(F18)、1 项正面结论(F15 模板安全体系健全)。
- 已修复:11 项优化(O1-O11),覆盖 F1/F2/F4/F6/F8/F10/F12/F16/F17/F19/F20/F23 共 12 个发现;
  O6-O11 为用户批准的高风险项,O9 顺带修复 chatanki_executor cancel 不停调度的隐性 bug。
- 登记未动(低优先级建议):F3(错误字符串控制流)、F5(sleep 20ms 竞态窗口)、F7(println→tracing)、
  F9(note_id 同秒碰撞,无害)、F11(多模板字段映射简化)、F13(csum 不 strip HTML)、F14(媒体整读内存)、
  F21(收集器 5 分钟固定超时,建议改空闲超时)、F22(SegmentEngine 英文 token 估算偏低,仅影响预估)。
- 验证:cargo check exit 0、tsc --noEmit exit 0、TaskController vitest 4/4;
  期间的 cargo 失败均为环境问题(磁盘满/坏工件/多代理锁竞争),最终在干净队列下通过。
- 共享文件改动:lib.rs(+1 行命令注册)、builtin skills index(工具描述 1 句)、chatanki_executor(cancel 分支),均已登记 S1-S3。

## 跨组问题(发现但不属于本组职责域)
| # | 涉及文件 | 问题描述 | 建议归属代理 |
|---|----------|----------|--------------|

## 共享文件改动登记
| # | 文件 | 改动段落/函数 | 原因 |
|---|------|---------------|------|
| S1 | src-tauri/src/lib.rs | invoke_handler 列表中 `pause_document_processing` 与 `resume_document_processing` 之间插入一行 `crate::commands::cancel_document_processing` | O9(F20)新命令注册,仅本域段落 |
| S2 | src/features/chat/skills/builtin/index.ts | `builtin-chatanki_control` 工具 description 一处:补"cancel 仅停止生成,已生成的卡片会保留" | O9(F20)让 LLM 知晓 cancel 的非破坏性语义 |
| S3 | src-tauri/src/chat_v2/tools/chatanki_executor.rs | 仅 `chatanki_control` 的 "cancel" 分支:手工断流+改状态 → 调用 `enhanced.cancel_document_processing`(该文件主体归代理 1 的对话管线,本处只动制卡工具分支) | O9(F20)统一取消语义;原实现只改 DB 状态,调度协程仍会继续跑剩余任务 |

## 接力须知
- 本会话为首次会话,feed_id=F-A7LZT(mcp-feedback-enhanced 轮询/反馈用)。
- 审阅顺序按 TODO 编号推进;每完成一个单元立即更新本文档。
- 验证命令:前端 `npm run typecheck` / `npm run lint` / `npm test -- anki|template`;
  后端在 `src-tauri/` 下 `cargo check` / `cargo clippy -- -D warnings` / `cargo test anki|spaced_repetition|review_plan`。
- 纪律:不动域外文件;共享文件(commands.rs/lib.rs/models.rs/App.tsx/locales)只改本域段落并登记;
  不引入新依赖;未经用户要求不 git commit/push。

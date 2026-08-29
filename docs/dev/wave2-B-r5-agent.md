# Wave2-B 第 5 轮 · Agent 结合-1:跨应用结合点能力表 + workbenchBus 薄封装

- **身份**:0824 Wave2-B 第 5 轮「Agent 结合-1」。
- **执行口径**:禁止 npm/vitest/编译全程遵守(第 8 轮前禁令);未 commit/push(父代理统一处置);测试文件为**用例文本,未执行**。
- **对照输入**:`wave2-B-r1-notes-gap.md` §1.6/§3、`wave2-B-r1-pdf-gap.md` §五、台账 §4.6-2(孤儿库函数裁决)与 §4.7-2(本轮派遣)。

## 一、改动清单

| 文件 | 性质 | 内容 |
|---|---|---|
| `src/features/workbench/agent/integrationManifest.ts` | **新增(能力表)** | 声明式登记 4 个跨应用 Agent 结合点的唯一合法入口(`AGENT_INTEGRATIONS` + `getAgentIntegration`)+ 每结合点一个薄执行器(纯透传,零业务逻辑) |
| `src/features/workbench/core/workbenchBus.ts` | 小改(授权范围内) | 新增两个薄封装 `openNoteAnchor` / `openPdfPage` 及配套类型(`OpenNoteAnchorRequest` / `OpenPdfPageRequest`)、常量 `PDF_PAGE_ACTIVATION_TYPE_IDS`、私有 `invalidArgsResult`;**既有方法与接口冻结签名零触碰** |
| `src/features/workbench/agent/AgentBridge.tsx` | 头注更新 | 指认同目录能力表;传输层(listen→emit、≤5Hz 节流)与挂载逻辑**零改动** |
| `src/features/workbench/agent/__tests__/integrationManifest.test.ts` | 测试文本(未执行) | 表不变量、薄封装参数校验/禁用态、源码级懒加载与禁改区闩 |
| `docs/dev/wave2-B-r5-agent.md` | 本文档 | — |

## 二、能力表四结合点(与调研文档的对应)

| id | 入口 | 复用的既有链路 | 调研锚 |
|---|---|---|---|
| `open_note_anchor` | `workbenchBus.openNoteAnchor` | `activateDetailed('note','scrollToHeading')` → `workspaceRegistry.activateWorkspaceResource` → `editor.scrollToHeading`(ack/幂等/NOT_READY 均既有) | notes-gap §1.6 A3、§3「新动作走既有 activation,不开新全局事件」 |
| `open_pdf_page` | `workbenchBus.openPdfPage` | `activateDetailed(typeId,'gotoPage',{page})` → `pdfFocusAck.requestPdfPageFocus`(pdf-ref:focus + viewer ack + 超时 + stale 防双跳);typeId 白名单 `textbook/file/file-preview` 与三处 register 一致 | pdf-gap §5.1「已有能力,不需要新建跳页通道,只补 manifest 描述」 |
| `generate_cards_from_excerpt` | `cardAgent.startGeneration`(经 `selectionStudyActions.makeCardsFromSelection` **懒加载**透传) | E 域唯一合法入口(后端 `start_enhanced_document_processing`,与 chatanki 共用);启动即返回 documentId,任务台跟踪 | pdf-gap §5.2-3、notes-gap §1.6 A6 |
| `generate_questions_from_excerpt` | `selectionStudyActions.sendSelectionToQuestionGeneration`(PREFILL_CHAT_INPUT → 聊天 Agent qbank-tools,**懒加载**透传) | autoSend=false 用户把关;明确**不走** `import_question_bank_stream`(抽取流对散文材料得空结果) | pdf-gap §5.2-3、文件头 2026-08 调研结论 |

薄封装语义要点:

- 两个导航封装都是**纯接线**——参数校验(INVALID_ARGS 早退)后委托 `activateDetailed`,缺省带 `fallbackLaunch(reason:'api')` 自动开窗,可用 `fallbackLaunch:false` 关闭;禁用态沿用 `WORKBENCH_DISABLED` 回执,不新增错误码体系。
- `openNoteAnchor` 要求 heading 必填:「无锚点仅打开笔记」既有 `launch`/`openResource` 已覆盖,薄封装不重复造第二个打开入口。
- `openPdfPage` 页码口径与 `file-preview` 的 `parsePage` 一致(有限数、≥1、向下取整)。

## 三、孤儿库函数裁决(台账 4.6-2)

**裁决:复用,不死码化。** `sendSelectionToQuestionGeneration` / `buildQuestionGenerationPrompt` / `makeCardsFromSelection` / `MIN_SELECTION_LENGTH_FOR_QUESTIONS` 自本轮起由能力表登记为 `generate_questions_from_excerpt` / `generate_cards_from_excerpt` 的唯一合法入口(消费方 = 后续轮次的 StageManager app_command / 领域 driver 接线),`pdf:selection.questionPrompt*` / `selectionEmpty` / `selectionTooShort` 等键随之保留,**不进死键清单**。

**记账(移交,不越权)**:台账 4.7-2 要求「若复用,detail 须按 `sendSelectionToChatInput` 同款并入 page/sourceName」。核对现码:`sendSelectionToChatInput` 已并入(`selectionStudyActions.ts:54-59`);`sendSelectionToQuestionGeneration` 的 PREFILL detail 仍只有 `{content, autoSend}`(`:125`),来源信息现经 `buildQuestionGenerationPrompt` 进入 prompt 文本,不丢失但非结构化。补字段改动落在 `src/features/pdf/selectionStudyActions.ts`,**不在本角色可写清单**,移交 PDF 域写手(一行级:detail 交叉类型并入 `page/sourceName`,与 `sendSelectionToChatInput` 同款)。

## 四、边界遵守自查

- **streaming_anki / qbank 服务层**:零 import、零触碰;制卡只经 E 域 `cardAgent.startGeneration` 既有入口透传,不新增 tauri command,不碰判分/管线/CriticSummary(测试文本含反向闩)。
- **GenUI**:不可写,不在能力表(notes-gap §1.6 A2 只读冻结,与 18 不变量第 8 条一致)。
- **tool_loop / StageManager 管道**:未改;AgentBridge 仅头注。能力表本轮**只登记 + 透传**,不接入请求路由——接线属后续轮次。
- **懒加载不被抵消**(pdf-gap §1.5 教训):manifest 对 `selectionStudyActions` 只有 `import type`(编译期擦除)+ 动态 `import()`,cardforge / 聊天服务不进 workbench agent 常驻 chunk;测试文本含正反向闩。
- **接口冻结**:`workbenchBus` 只新增方法/导出,未动任何既有签名(types.ts P0 契约未触碰)。
- **本轮派遣中的 `requestWakePrefetch` 接线**(台账 4.7-2 前半)落在 `core/agentRuntime.ts`,不在「AgentBridge + 同目录 manifest + workbenchBus 薄封装」授权面内,归本轮其他角色/后续轮,此处仅记账不实施。

## 五、已验证 / 未验证

**已验证(静态)**:三处 register 的 `gotoPage`/`scrollToHeading` 处理与白名单逐一核对(`apps/content/register.ts` textbook/file、`apps/preview/register.tsx` file-preview、`apps/notes/workspaceRegistry.ts` note);`fallbackLaunch.reason` 取值与全仓 17 处既有调用同款(`'api'`);`makeCardsFromSelection` → `generateCardsFromSelection` → `cardAgent.startGeneration` 链路逐级读码确认;类型导入形状(`SelectionCardInput`/`SelectionQuestionResult`/`SelectionSourceInfo` 均为具名导出)核对。

**未验证(如实声明)**:未跑 tsc/vitest/构建——薄封装运行时行为、测试文本红绿、chunk 切分效果均待第 8 轮实测;能力表消费方(StageManager/driver 按 id 查表)本轮未接线,表的「防漂移」效力当前仅靠一致性测试文本约束。

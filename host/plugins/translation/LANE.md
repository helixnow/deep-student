# L02-llm-manager：LLM 管理与翻译

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L02-llm-manager（LLM 管理与翻译） |
| 目录 | `host/plugins/translation/`（同 lane 另有 `host/plugins/llm/`，文件划分见 `scripts/electron-migration/lib/lanes.mjs` 的 DIR_SPLIT） |
| Rust 范围（lanes.md） | dstu-llm 的 llm_manager、dstu-tutor、translation-core、src/translation，以及 translation 和 settings_models 工具 |
| 主要提供 | **`llm@1`（H16 里程碑）**、`translation@1` |
| 主要消费 | L01、F3、F4 |
| 特别注意 | 吸收现有 `src/plugins/translation` 及其三方对照；模型配置冻结、llm_usage、路由、单次流式 |
| 规模（本目录） | 6317 行 · 20 个文件 · 6 个命令（前端调用 2） · 42 个测试 |
| 规模（整条 lane，inventory） | 56347 行 · 70 个文件 · 26 个命令（前端 13） · 709 个测试 |
| 契约 | [`contracts/ipc/L02-llm-manager.json`](../../../contracts/ipc/L02-llm-manager.json) |
| 服务草稿 | [`contracts/services/DRAFT-L02-llm-manager.md`](../../../contracts/services/DRAFT-L02-llm-manager.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-llm/src/llm_manager/translation_prompts.rs` | 3 | 0 |  |
| `src-tauri/crates/dstu-translation-core/examples/replay.rs` | 141 | 0 |  |
| `src-tauri/crates/dstu-translation-core/src/engine.rs` | 218 | 0 |  |
| `src-tauri/crates/dstu-translation-core/src/lib.rs` | 14 | 0 |  |
| `src-tauri/crates/dstu-translation-core/src/policy.rs` | 270 | 0 |  |
| `src-tauri/crates/dstu-translation-core/src/prompts.rs` | 162 | 0 |  |
| `src-tauri/crates/dstu-translation-core/src/wire.rs` | 76 | 0 |  |
| `src-tauri/crates/dstu-tutor/src/translation/candidates.rs` | 357 | 0 |  |
| `src-tauri/crates/dstu-tutor/src/translation/chat_popover.rs` | 377 | 1 |  |
| `src-tauri/crates/dstu-tutor/src/translation/events.rs` | 159 | 0 |  |
| `src-tauri/crates/dstu-tutor/src/translation/mod.rs` | 94 | 0 |  |
| `src-tauri/crates/dstu-tutor/src/translation/pipeline.rs` | 1210 | 14 |  |
| `src-tauri/crates/dstu-tutor/src/translation/types.rs` | 163 | 0 |  |
| `src-tauri/src/chat_v2/tools/translation_executor.rs` | 2113 | 20 |  |
| `src-tauri/src/cmd/translation.rs` | 155 | 2 | 1 |
| `src-tauri/src/translation/candidates.rs` | 40 | 0 | 2 |
| `src-tauri/src/translation/chat_popover.rs` | 34 | 0 | 2 |
| `src-tauri/src/translation/mod.rs` | 43 | 0 | 1 |
| `src-tauri/tests/c1_cross_lang_consistency.rs` | 86 | 5 |  |
| `src-tauri/tests/translation_executor_e2e.rs` | 602 | 0 |  |

### 命令（6）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `cancel_translation_candidates` | `src/translation/candidates.rs:33` | async | none | — | (sessionId: string) → boolean ! AppError |
| `ocr_extract_text` | `src/cmd/translation.rs:90` | async | app | src/utils/testApi.ts:142 | (imagePath?: string \| null, imageBase64?: string \| null) → string ! AppError |
| `stream_chat_translation_aligned` | `src/translation/chat_popover.rs:16` | async | none | — | (request: ChatTranslationRequest) → null ! AppError |
| `stream_chat_translation_plain` | `src/translation/chat_popover.rs:26` | async | none | — | (request: ChatTranslationRequest) → null ! AppError |
| `translate_text_candidates` | `src/translation/candidates.rs:21` | async | none | — | (request: TranslationRequest, numCandidates?: integer(u32) \| null) → TranslationCandidatesResponse ! AppError |
| `translate_text_stream` | `src/translation/mod.rs:35` | async | app | src/translation/useTranslationStream.ts:399 | (request: TranslationRequest) → TranslationResponse \| null ! AppError |

### 发出的事件（7）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `event` | 动态（表达式） | crates/dstu-tutor/src/translation/candidates.rs:69 (emit)<br>crates/dstu-tutor/src/translation/chat_popover.rs:199 (emit) |
| `Self::event_name(session_id)` | 动态（表达式） | crates/dstu-tutor/src/translation/events.rs:56 (emit)<br>crates/dstu-tutor/src/translation/events.rs:98 (emit)<br>crates/dstu-tutor/src/translation/events.rs:120 (emit)<br>crates/dstu-tutor/src/translation/events.rs:143 (emit)<br>crates/dstu-tutor/src/translation/events.rs:154 (emit) |
| `stats.event(chunk, lang, info)` | 动态（表达式） | crates/dstu-translation-core/src/engine.rs:157 (emit) |
| `stats.event(segment.separator.clone(), None, info)` | 动态（表达式） | crates/dstu-translation-core/src/engine.rs:188 (emit) |
| `TranslationEvent::Cancelled` | 动态（表达式） | crates/dstu-translation-core/src/engine.rs:117 (emit)<br>crates/dstu-translation-core/src/engine.rs:163 (emit) |
| `TranslationEvent::Complete { id: request.session_id.clone(), translated_text: text.clone(), created_at: created_at.clone(), detected_lang: detected, }` | 动态（表达式） | crates/dstu-translation-core/src/engine.rs:204 (emit) |
| `TranslationEvent::Error { message: f.message.clone(), code: f.code.clone(), retriable: f.retriable, }` | 动态（表达式） | crates/dstu-translation-core/src/engine.rs:70 (emit) |

### 契约中的事件（3，`contracts/ipc/L02-llm-manager.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `chat_translation_{}` | 是 | ChatTranslationEvent | crates/dstu-tutor/src/translation/chat_popover.rs:228 (other)<br>crates/dstu-tutor/src/translation/chat_popover.rs:243 (other)<br>crates/dstu-tutor/src/translation/chat_popover.rs:275 (other)<br>crates/dstu-tutor/src/translation/chat_popover.rs:292 (other)<br>crates/dstu-tutor/src/translation/chat_popover.rs:302 (other)<br>crates/dstu-tutor/src/translation/chat_popover.rs:310 (other)<br>crates/dstu-tutor/src/translation/chat_popover.rs:317 (other)<br>crates/dstu-tutor/src/translation/chat_popover.rs:332 (other) |
| `translation_candidates_{}` | 是 | TranslationCandidatesEvent | crates/dstu-tutor/src/translation/candidates.rs:69 (emit) |
| `translation_stream_{}` | 是 | TranslationEvent \| TranslationStreamCancelled \| TranslationStreamComplete \| TranslationStreamData \| TranslationStreamError | crates/dstu-tutor/src/translation/events.rs:56 (emit)<br>crates/dstu-tutor/src/translation/events.rs:98 (emit)<br>crates/dstu-tutor/src/translation/events.rs:120 (emit)<br>crates/dstu-tutor/src/translation/events.rs:143 (emit)<br>crates/dstu-tutor/src/translation/events.rs:154 (emit) |
<!-- END GENERATED:lane -->

## 备注

### 2026-11-05 OCR 命令最高优先级交付核验

`69fbbb8ee`（并发写者）已提供llmOcrPages/llmFileOcr并注册ocr_extract_text；本会话测试提交6029c2ac3、70278cd4e验证原两个decode_payload断言、临时清理、已有文件保留、单次probe、dedicated过滤/取消、真实F7大图Triangle/JPEG85。20261104154626-f3d816：5 passed，exit0，无Errors。两条TESTMAP已指向生产入口向量，当前40 ported/2 pending；不把这些证据扩成整lane或D5/C签收。

同树并发已两次上报C1/架构师，原始prompt/页面OCR实现保留其提交，不整批还原。3db0b4737自检曾仅boundaries两项失败，后续37acfe34c已按同lane真实入口测试加准确导入注释；当前普通boundaries为0，strict仅剩四条既有vfs违规。随后按Rust补两处文件IO Display及公开命令反例：20261104161000-bb0d5c红例exit1；修复后20261104162840-ba6ff1六项全过exit0，随后按§5提交并自检。U2预留repository/translations.ts始终未修改。

### R1 v2 反馈处理（2026-11-04）

- R1-TR-01/02 候选已修：使用L01同一有状态provider adapter与F4 SSE；请求建立阶段重试，读取失败不重试；取消订阅贯穿退避/读取，并释放reader/socket。
- R1-TR-05/06 候选已修：生产入口注入 `llmHttp.fetch`，沿用代理/重定向/客户端超时；预算用performance.now；事件投递失败按Rust warn后继续，恢复候选与popover start info。
- 证据：`20261104115934-cb2200` typecheck exit0；`20261104115934-4efe36` 两目录83文件/904测试全通过，exit0，无Errors。真实L01/L02/translation组合、真实配置读取与HTTP请求在llm/tests/unified_stream.test.ts与codex_streaming_integration.test.ts；公开翻译命令反例在tests/commands.test.ts。
- 保留Rust语义歧义：raw `[DONE]` 提前短路；普通finish_reason或DeepSeek length后EOF不自动完成。详细分支/原测试修正依据见SPEC，等待R1复验。
- 尚未闭合：TR-03需要L11 metadata同连接所有者方法；TR-04需要F7图片编码与F4严格base64公共接口及完整file OCR组合；TR-07缺L04/L03实际中央dispatcher接口。注册顺序原测试恢复pending，当前39 ported/3 pending，未删除断言。

## v2 排雷清单

### C2 固定编号与窄单元交接

冻结报告0119143715c0bab2d8f698b7c1d58651358e85be，源码基线2ee9a9cbe：

- X6-SW-0092/0093/0094 → R1-TR-03，分别为repository/translations.ts旧84 resources INSERT、149 translations INSERT、218 translations UPDATE；三个duplicate-repository info仍并入同根问题。
- X6-UD-0086 → R1-TR-03，旧107行rowToTranslation的断言随owner仓储迁移处理。
- X6-PR-0119 → R1-TR-04，decodeBase64ImagePayload/file OCR原pending。
- X6-LP-0260 → R1-TR-06 commands日志分支；0261 → R1-TR-03/06 repo/executor日志分支；0262 → 原X6-LP-translation-LANE-1汇总线索。

C1 13:02调度核验：`repository/translations.ts`没有本轮WIP，也没有本轮修复提交；最后涉及文件的提交714d4c8c2。已告C1：U2获架构师授权后可仅接X6-SW-0092～0094独立存储单元，本lane避开该文件；授权前不假定已移交，不放开整个translation目录。D1精确接口需求见本节末尾，owner裁定按037376b1e / X6-OWN-C2-20261104。

### C1/U2 调用点对齐：R1-TR-03 / X6-SW-0092～0094

已按U2只读方案4eb41c761修改本lane调用点：`TranslationToolContext.vfsTranslations`逐调用携带真实owner；persist helpers首参接owner；save实际传入同一连接，不再import本地repository副本，没有全局binder。L11错误经VfsRepositoryError.data.resourceType映射，缺Folder保原FOLDER_NOT_FOUND/原hint/retryable=false；metadata失败保Rust1416 warn及已成功保存/缓存消费顺序。tool output中owner省略的Option恢复null，owner实体本身不被改写。

`20261104135047-1f6b90`：两文件23 tests passed，exit0，无Errors；测试经公开translation.toolExecutor.save/execute→真实L11 create/get→真实SQLite，验证缺owner不借连接、缺Folder无写且释放缓存claim、metadata失败warn而保存成功、同一executor跨两个Host按调用使用各自deviceId/连接。metadata成功写入目前仍使用明确的外部端口夹具（待L11），不能据此签收真实metadata owner。原保存测试断言保留并增强retryable=false，单行TESTMAP恢复pending（现38/4）；中央save caller仍缺，R1-TR-03/07保持开放。

本轮没有修改U2预留的repository/translations.ts；该文件在本lane生产路径已无import，是否删除/改为owner薄委托由获授权的U2独立单元处理。metadata接口名与U2方案统一请求updateTranslationMetadata(conn,id,metadata)，旧persistTranslationMetadataWithConn请求视为同一业务接缝，非两套接口需求。

补齐运行证据：typecheck `20261104135047-f5897e` exit0；Electron SQLite `20261104135621-1355db` 同两文件23 passed、exit0，无Errors。测试明确只把未发布metadata方法作为外部端口夹具，不拿夹具签收L11生产写入。

C1候选基线`2ee9a9cbe`；当前核验`29f0fb473`；读取X6报告tip=`f5822bce6`。旧行号只作索引，完整JSON见 `git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。同根finding复用R1编号，不另起重复修复；info/计数不直接判失败。

| 既有finding / X6旧索引 | 当前SHA核验与Rust证据 | 修复状态 / owner接口请求 |
|---|---|---|
| R1-TR-03 · SW repository/translations.ts:84 resources INSERT；:149 translations INSERT；:218 translations UPDATE | 三处仍实际存在；另:84 resources、:191 folder_items、:149 translations三个duplicate-repository info是同一复制仓储问题。Rust经VfsTranslationRepo create_translation[_in_folder]_with_conn（translation_repo.rs:380–460,1088–1122）；metadata原位于translation_executor.rs:1293–1311 | 未修，不承认D1例外；L11已有createTranslationInFolder(conn,params,folderId)→VfsTranslation，还需persistTranslationMetadataWithConn(conn,id,metadata)→void/原错误。保持同连接、create/缓存消费/metadata尽力保存的原顺序；不改SQL拼写/挪repo逃检测 |
| R1-TR-03 · UD repository/translations.ts:107 | rowToTranslation仍把content JSON断言为对象；非法对象/可选字符串语义应由L11 owner返回VfsTranslation负责；Rust translation_repo row decoder | 随上行删复制decoder/写SQL；不新造第二套本地row校验作为终态 |
| R1-TR-04 · PR tests/transport.test.ts:1 decodeBase64ImagePayload | 仍只有ocr_extract.ts这个未注册file-OCR入口调用；两条decode_payload原测试保持pending；Rust src/cmd/translation.rs:44–127 | F4请求公开decodeBase64Standard(text)→bytes，保base64 0.22错误；F7请求Triangle缩放+JPEG85编码（尺寸/格式/容差证据）。文件OCR编排属于本lane待做，不把全部自有代码算外部阻塞 |
| R1-TR-06 · LP src/commands.ts:1 | emitEvent已按Translation/TranslationCandidates/ChatTranslation分别warn后继续，start info已恢复；chat_popover.rs:198–220、candidates.rs:67–70,113、events.rs:56–57 | 053498e16修复+公开命令投递故障测试；原4 warn的其他位置仍需逐项核，不凭此关闭整个文件计数 |
| R1-TR-03/06 · LP repository/translations.ts:1 | 报告把executor 5 warn归集到repo；原source为src/chat_v2/tools/translation_executor.rs，不应只往repo补日志 | 在owner迁移/真实tool执行单元逐日志核验，pending |
| X6-LP-translation-LANE-1 · plugin warn计数 | 报告总计13/2是旧基线与宽映射，当前已有日志；无逐位置失败证据 | info人工线索，不能按数量判失败或补无意义日志 |

补充已存在R1-TR-07：registers_before_general_catch_all已恢复pending；L07公开register/all是roster，不等于L04/L03中央get_executor分发。请求实际dispatcher接缝后再验证真实注册顺序。此项不因X6索引额外整表重标；AP计数候选本插件本次无新增。qbank四类表及practice_attempts归L14的裁定不涉及本插件以上三表，不将旧报告误用为L11全表所有权。

LP原位置索引：chat_popover.rs warn200/299/324/339；translation_executor.rs warn764/927/1398/1416/1534。其中200投递失败已由053498e16处理；其余须在候选/partial保存/metadata/通知等实际分支逐条核，不以新增日志数量验收。

给L11的精确D1请求：已有 `createTranslationInFolder(conn, {title?,source,translated,srcLang,tgtLang,engine?,model?}, folderId:string|null):VfsTranslation` 应直接消费；补 `persistTranslationMetadataWithConn(conn:SqlExecutor, id:string, metadata:JsonValue):void`，内部保留 `UPDATE translations SET metadata_json = ?1 WHERE id = ?2` 及参数顺序，0行返回 `translation row {id} not found for metadata update`，SQL/连接失败保留原Display（translation_executor.rs:1293–1311）。创建的事务先完成，再消费缓存引用，最后metadata尽力保存；不得把最后一步扩成新的跨步骤原子事务或静默省略。

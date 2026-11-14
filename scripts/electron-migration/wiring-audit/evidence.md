# X4 接线审计原始证据

<!-- Generated: node scripts/electron-migration/wiring-audit/audit.mjs --markdown -->

只导入入口读取 meta，不执行 apply；以下是静态证据，不是全应用运行成功证明。缺服务诊断为候选，包含 Rust 原有的正常不可用分支。

```json
{
  "plugins": 36,
  "services": 94,
  "unconsumed": 44,
  "islands": 25,
  "bypassed": 3,
  "wiringIslands": 28,
  "commandSurfaces": 10,
  "missing": 9,
  "missingHardInject": 0,
  "cycles": 0,
  "loadErrors": 0,
  "profileOmissions": 0
}
```

## 插件入口 / meta

| id / lane | 入口 | profile | provides | inject | commands |
|---|---|---|---|---|---|
| dstu.shell / F2-shell | electron/index.ts | true | startupGate, systemNotification |  | 23 |
| dstu.plugins / F1-kernel | host/kernel/plugins.ts | true | plugins | settings | 11 |
| dstu.platform.diagnostics / F4-security | host/platform/diagnostics/index.ts | true | diagnostics, backgroundTasks | storage | 9 |
| dstu.platform.cloud-config / F4-security | host/platform/errors/index.ts | true |  | cloudConfig | 4 |
| dstu.platform.log / F4-security | host/platform/log/index.ts | true | log | paths | 14 |
| dstu.native / F7-native | host/platform/native/index.ts | true | nativeCompression, nativeHeic, nativeImage, nativeOfficeText, nativeProtobuf, nativeTokenizer, nativePdfium, nativeFsrs, nativeRegex, nativeStarlark, nativeAudio |  | 0 |
| dstu.platform.paths / F4-platform | host/platform/paths/index.ts | true | paths |  | 0 |
| dstu.platform.secrets / F4-security | host/platform/secrets/index.ts | true | secrets | paths, log | 11 |
| dstu.platform.settings / F4-platform | host/platform/settings/index.ts | true | settings | storage, secrets | 0 |
| dstu.platform.storage / F3-storage | host/platform/storage/index.ts | true | storage, dataSpace, featureFlags, injectionBudget, noteAssets | secrets, paths, log | 33 |
| dstu.agent-orchestration / L06-agent-orchestration | host/plugins/agent-orchestration/index.ts | true | agentAutomation, agentSubagent | settings, storage | 17 |
| dstu.agent-skills / L07-agent-skills-ptc | host/plugins/agent-skills/index.ts | true | agentSkills, agentTools | paths, settings, storage | 22 |
| dstu.agent-workspace / L05-agent-workspace | host/plugins/agent-workspace/index.ts | true | agentApproval, agentWorkspace, agentWorkspaceTools, agentVfsResolver, agentCompletionOutbox, runtimeRoots | settings, storage | 12 |
| dstu.anki / L16-anki | host/plugins/anki/index.ts | true | anki | paths, storage | 61 |
| dstu.backup / L21-backup-governance | host/plugins/backup/index.ts | true | backup, governance, cloudConfig | storage, settings, secrets | 33 |
| dstu.browser / L19-mcp-browser | host/plugins/browser/index.ts | true | webSearch, browser, browserToolPolicy, webpageToolPolicy | settings, storage, log, featureFlags | 39 |
| dstu.chat-pipeline / L03-chat-pipeline | host/plugins/chat-pipeline/index.ts | true | chatPipeline | nativeTokenizer, chatSession, settings, storage, vfsRepo, agentVfsResolver | 0 |
| dstu.chat / L04-chat-session | host/plugins/chat/index.ts | true | chatState, chatSession | storage, vfs | 87 |
| dstu.chatanki / L24-chatanki | host/plugins/chatanki/index.ts | true | chatankiTools | settings, review, llm, anki | 0 |
| dstu.integration / L22-app-commands | host/plugins/integration/index.ts | true | appCommandState |  | 0 |
| dstu.llm-providers / L01-llm-providers | host/plugins/llm-providers/index.ts | true | llmAdapters, llmOcr, llmMultimodal, llmCodexAuth | settings | 5 |
| dstu.llm / L02-llm-manager | host/plugins/llm/index.ts | true | llm, essayGrading, llmStreaming, llmAdapterInfos, llmEmbeddingModels, llmOcrModels, llmRag, llmOcrRegions, llmOcrHedge, llmQuestionParsing, llmModel2Messages, llmProviderRequests, llmStreamEvents, llmAnkiRouting | settings, secrets, vfsDatabase, vfsRepo, llmAdapters, nativeTokenizer, nativeImage | 20 |
| dstu.mcp / L19-mcp-browser | host/plugins/mcp/index.ts | true | mcp | settings, secrets, llm, webSearch, log | 23 |
| dstu.media / L18-media-docs | host/plugins/media/index.ts | true | media, docs, ocr, examSheetSession | settings | 57 |
| dstu.memory / L17-memory-research | host/plugins/memory/index.ts | true | memory, insight, masteryProfileSink | storage, settings, notes, vfsRepo | 34 |
| dstu.notes / L10-notes | host/plugins/notes/index.ts | true | notes | storage, vfsRepo | 81 |
| dstu.qbank / L14-qbank | host/plugins/qbank/index.ts | true | qbank | storage, paths | 73 |
| dstu.review / L15-review-analytics | host/plugins/review/index.ts | true | mastery, review | storage | 69 |
| dstu.sync-providers / L23-sync-providers | host/plugins/sync-providers/index.ts | true | syncProvider | secrets, backup, paths | 14 |
| dstu.sync-support / L20-sync | host/plugins/sync-support/index.ts | true | syncSupport | storage, notes | 0 |
| dstu.sync / L20-sync | host/plugins/sync/index.ts | true | sync | storage, paths, notes, backup, syncProvider, secrets, vfsDatabase, syncSupport, nativeCompression, vfsRepo | 16 |
| dstu.translation / L02-llm-manager | host/plugins/translation/index.ts | true | translation | llm | 5 |
| dstu.vfs-handlers / L13-vfs-api | host/plugins/vfs-handlers/index.ts | true | vfsHooks | vfsDatabase, vfsRepo, notes, vfsIndex, retrieval, settings, docs | 157 |
| dstu.vfs-index / L12-vfs-index | host/plugins/vfs-index/index.ts | true | lanceEngine, retrieval, vfsIndex, vfsUnitBuilder, vfsIndexMaintenance | storage | 3 |
| dstu.vfs-repos / L11-vfs-repos | host/plugins/vfs-repos/index.ts | true | vfsRepo, vfsMaintenance, vfsWorker | storage, paths | 0 |
| dstu.vfs / L13-vfs-api | host/plugins/vfs/index.ts | true | vfsDatabase, vfs, dstu | storage | 34 |

## 服务依赖图（消费者 → 服务 → 提供方）

| 服务 | 提供方 | 生产消费者（含 get / 子 inject） | 无外部消费者的分类 |
|---|---|---|---|
| agentApproval | dstu.agent-workspace | dstu.chat (host/plugins/chat/index.ts:95, child-inject)<br>dstu.chat (host/plugins/chat/index.ts:96, property) | — |
| agentAutomation | dstu.agent-orchestration | dstu.chat (host/plugins/chat/index.ts:101, child-inject)<br>dstu.chat (host/plugins/chat/index.ts:102, property) | — |
| agentCompletionOutbox | dstu.agent-workspace | — | island: See wiring task W03 |
| agentSkills | dstu.agent-skills | — | command-surface: host/plugins/agent-skills/index.ts:208-259: skill_* commands call the same SkillsService instance |
| agentSubagent | dstu.agent-orchestration | dstu.chat (host/plugins/chat/index.ts:133, child-inject)<br>dstu.chat (host/plugins/chat/index.ts:134, property) | — |
| agentTools | dstu.agent-skills | dstu.backup (host/plugins/backup/index.ts:195, get)<br>dstu.backup (host/plugins/backup/index.ts:197, child-inject)<br>dstu.backup (host/plugins/backup/index.ts:197, get)<br>dstu.browser (host/plugins/browser/index.ts:170, child-inject)<br>dstu.browser (host/plugins/browser/index.ts:172, get)<br>dstu.chatanki (host/plugins/chatanki/index.ts:484, lookup-wrapper)<br>dstu.notes (host/plugins/notes/index.ts:155, get)<br>dstu.notes (host/plugins/notes/index.ts:157, child-inject)<br>dstu.notes (host/plugins/notes/index.ts:157, get) | — |
| agentVfsResolver | dstu.agent-workspace | dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:177, property)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:378, inject) | — |
| agentWorkspace | dstu.agent-workspace | dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:505, get)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/src/super-inbox-drain.ts:216, lookup-wrapper)<br>dstu.backup (host/plugins/backup/src/operations.ts:296, get)<br>dstu.chat (host/plugins/chat/index.ts:118, child-inject)<br>dstu.chat (host/plugins/chat/index.ts:119, property) | — |
| agentWorkspaceTools | dstu.agent-workspace | — | island: See wiring task W02 |
| anki | dstu.anki | dstu.chatanki (host/plugins/chatanki/index.ts:330, lookup-wrapper)<br>dstu.chatanki (host/plugins/chatanki/index.ts:476, inject) | — |
| appCommandState | dstu.integration | dstu.platform.storage (host/platform/storage/index.ts:179, get)<br>dstu.platform.storage (host/platform/storage/index.ts:202, get) | — |
| backgroundTasks | dstu.platform.diagnostics | dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:141, get) | — |
| backup | dstu.backup | dstu.sync-providers (host/plugins/sync-providers/index.ts:115, property)<br>dstu.sync-providers (host/plugins/sync-providers/index.ts:128, property)<br>dstu.sync-providers (host/plugins/sync-providers/index.ts:102, inject)<br>dstu.sync (host/plugins/sync/index.ts:73, inject) | — |
| browser | dstu.browser | — | command-surface: host/plugins/browser/index.ts:92-135: browser_* commands call browserService |
| browserToolPolicy | dstu.browser | — | island: browser/index.ts:94 exposes the singleton from src/tool-executor.ts:192-208; browser commands call browserService, not this policy; agent roster/policy invocation remains unwired (W02) |
| chatPipeline | dstu.chat-pipeline | dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:122, get)<br>dstu.chat (host/plugins/chat/index.ts:89, child-inject)<br>dstu.chat (host/plugins/chat/index.ts:90, property) | — |
| chatSession | dstu.chat | dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:122, get)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:503, get)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/src/super-inbox-drain.ts:215, lookup-wrapper)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:149, property)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:163, property)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:179, property)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:180, property)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:183, property)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:185, property)<br>dstu.chatanki (host/plugins/chatanki/index.ts:333, lookup-wrapper)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:378, inject) | — |
| chatState | dstu.chat | dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:256, get)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:514, get)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/src/super-inbox-drain.ts:192, get) | — |
| chatankiTools | dstu.chatanki | — | island: See wiring task W02/W04 |
| cloudConfig | dstu.backup | dstu.platform.cloud-config (host/platform/errors/cloud-config-commands.ts:11, property)<br>dstu.platform.cloud-config (host/platform/errors/cloud-config-commands.ts:12, property)<br>dstu.platform.cloud-config (host/platform/errors/cloud-config-commands.ts:13, property)<br>dstu.platform.cloud-config (host/platform/errors/cloud-config-commands.ts:19, property)<br>dstu.platform.cloud-config (host/platform/errors/index.ts:0, inject) | — |
| dataSpace | dstu.platform.storage | dstu.backup (host/plugins/backup/src/restore-commands.ts:131, get) | — |
| diagnostics | dstu.platform.diagnostics | — | command-surface: host/platform/diagnostics/index.ts:23-31: package-manager commands call service |
| docs | dstu.media | dstu.agent-workspace (host/plugins/agent-workspace/index.ts:66, get)<br>dstu.qbank (host/plugins/qbank/index.ts:667, get)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:267, property)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:198, inject) | — |
| dstu | dstu.vfs | — | command-surface: host/plugins/vfs/index.ts:98-99: dstu_parse_path uses the same parseDstuPath function |
| essayGrading | dstu.llm | dstu.review (host/plugins/review/src/essay-grading-commands.ts:22, get) | — |
| examSheetSession | dstu.media | — | needs-review: New unconsumed service: inspect command/remote surfaces before calling it an island |
| featureFlags | dstu.platform.storage | dstu.browser (host/plugins/browser/index.ts:108, property)<br>dstu.browser (host/plugins/browser/index.ts:418, property)<br>dstu.notes (host/plugins/notes/index.ts:115, get)<br>dstu.browser (host/plugins/browser/index.ts:83, inject) | — |
| governance | dstu.backup | — | command-surface: host/plugins/backup/index.ts:107-108,117-130: data_governance_* commands |
| injectionBudget | dstu.platform.storage | — | bypassed: host/plugins/llm/index.ts:15-18,205: independent InjectionBudgetManager instead of F3 service |
| insight | dstu.memory | dstu.review (host/plugins/review/src/insight-commands.ts:18, get) | — |
| lanceEngine | dstu.vfs-index | — | local-implementation: host/plugins/vfs-index/index.ts:65-67,160-175: same local engine feeds VFS stores |
| llm | dstu.llm | dstu.chat (host/plugins/chat/index.ts:124, child-inject)<br>dstu.chat (host/plugins/chat/index.ts:125, property)<br>dstu.chatanki (host/plugins/chatanki/index.ts:332, lookup-wrapper)<br>dstu.mcp (host/plugins/mcp/index.ts:186, property)<br>dstu.mcp (host/plugins/mcp/index.ts:195, property)<br>dstu.media (host/plugins/media/index.ts:155, get)<br>dstu.qbank (host/plugins/qbank/index.ts:81, get)<br>dstu.qbank (host/plugins/qbank/index.ts:397, get)<br>dstu.qbank (host/plugins/qbank/index.ts:571, get)<br>dstu.qbank (host/plugins/qbank/index.ts:581, get)<br>dstu.translation (host/plugins/translation/index.ts:22, property)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:207, child-inject)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:208, property)<br>dstu.vfs-index (host/plugins/vfs-index/src/runtime-adapter.ts:47, optional-get)<br>dstu.vfs-index (host/plugins/vfs-index/src/runtime-adapter.ts:142, optional-get)<br>dstu.chatanki (host/plugins/chatanki/index.ts:476, inject)<br>dstu.mcp (host/plugins/mcp/index.ts:78, inject)<br>dstu.translation (host/plugins/translation/index.ts:18, inject) | — |
| llmAdapterInfos | dstu.llm | — | island: host/plugins/llm/index.ts:100 exposes registry.ts:115 listAdapterInfos; anki/src/model-adapters.ts:28 still gets llm.adapter-infos@1 instead of this service (W15) |
| llmAdapters | dstu.llm-providers | dstu.llm (host/plugins/llm/index.ts:93, property)<br>dstu.llm (host/plugins/llm/index.ts:97, property)<br>dstu.llm (host/plugins/llm/index.ts:104, property)<br>dstu.llm (host/plugins/llm/index.ts:107, property)<br>dstu.llm (host/plugins/llm/index.ts:112, property)<br>dstu.llm (host/plugins/llm/index.ts:80, inject) | — |
| llmAnkiRouting | dstu.llm | — | island: llm/index.ts:99 exposes anki_routing_service.ts:12-30; Anki generation still waits on generation-port.ts:39,56 rather than this role resolver (W04/W05) |
| llmCodexAuth | dstu.llm-providers | — | command-surface: llm-providers/index.ts:63-92,101-123 shares the same manager between the provided auth service and real OAuth commands; request preparation/refresh consumers remain separate |
| llmEmbeddingModels | dstu.llm | — | island: host/plugins/llm/index.ts:101 creates the settings/model resolver; vfs-index/src/runtime-adapter.ts:141-168 still resolves assignments itself and waits for embedding@1 (W06) |
| llmModel2Messages | dstu.llm | — | island: host/plugins/llm/index.ts:96 exports buildModel2Messages as build; model2_messages.ts:54 is the implementation, with no production model2 request call into this service (W01/W05) |
| llmMultimodal | dstu.llm-providers | — | island: See wiring task W06 |
| llmOcr | dstu.llm-providers | — | island: See wiring task W06 |
| llmOcrHedge | dstu.llm | — | island: host/plugins/llm/index.ts:104 provides prepareCandidates/runPrepared; ocr_hedge_service.ts:68,102,138 has the real conditional chain, but no production request driver (W06) |
| llmOcrModels | dstu.llm | — | island: host/plugins/llm/index.ts:102-106 passes the same models to hedge/regions; their conditional calls exist at ocr_hedge_service.ts:87 and ocr_regions_service.ts:28, but neither outer request entry is wired (W06) |
| llmOcrRegions | dstu.llm | — | island: host/plugins/llm/index.ts:105-106 provides parse; ocr_regions_service.ts:27-80 performs dimensions/adapter parsing only if called, with no command/consumer request edge (W06) |
| llmProviderRequests | dstu.llm | — | island: host/plugins/llm/index.ts:97 exposes provider_requests_service.ts:11 prepareModel2; shared preparePlainProviderRequest has other callers but this role-specific wrapper is not consumed (W01/W05) |
| llmQuestionParsing | dstu.llm | — | island: host/plugins/llm/index.ts:95 creates parse/parseStreaming; question_parsing_service.ts:77-98 drives real streaming when called, but no qbank command consumes the provided instance (W05) |
| llmRag | dstu.llm | — | rust-unwired-candidate: rag_service.ts:17 translateText mirrors Rust rag_extension.rs:896 translate_text (definition without a caller); active translation_executor.rs:1028 uses run_translation, not this helper. No new production activation; adjudication remains separate |
| llmStreamEvents | dstu.llm | — | island: llm/index.ts:98 exposes model2_stream_events.ts:136 createStreamEventsService; the outer model2 stream driver has not connected it (W01/W05) |
| llmStreaming | dstu.llm | — | island: host/plugins/llm/index.ts:93-95,104 passes streaming to parsing/hedge; their singleShotCompletion sites at question_parsing_service.ts:79,85 and ocr_hedge_service.ts:138 are conditional on currently unwired outer requests (W05/W06) |
| log | dstu.platform.log | dstu.platform.secrets (host/platform/secrets/index.ts:103, property)<br>dstu.platform.storage (host/platform/storage/index.ts:69, property)<br>dstu.browser (host/plugins/browser/index.ts:86, property)<br>dstu.browser (host/plugins/browser/index.ts:127, property)<br>dstu.browser (host/plugins/browser/index.ts:138, property)<br>dstu.browser (host/plugins/browser/index.ts:148, property)<br>dstu.browser (host/plugins/browser/index.ts:164, property)<br>dstu.llm (host/plugins/llm/index.ts:82, get)<br>dstu.mcp (host/plugins/mcp/index.ts:59, property)<br>dstu.mcp (host/plugins/mcp/index.ts:82, property)<br>dstu.mcp (host/plugins/mcp/index.ts:86, property)<br>dstu.mcp (host/plugins/mcp/index.ts:107, property)<br>dstu.mcp (host/plugins/mcp/index.ts:125, property)<br>dstu.mcp (host/plugins/mcp/index.ts:139, property)<br>dstu.mcp (host/plugins/mcp/index.ts:210, property)<br>dstu.memory (host/plugins/memory/index.ts:109, property)<br>dstu.memory (host/plugins/memory/src/quick-assistant.ts:358, property)<br>dstu.memory (host/plugins/memory/src/service.ts:121, property)<br>dstu.memory (host/plugins/memory/src/service.ts:391, property)<br>dstu.memory (host/plugins/memory/src/service.ts:452, property)<br>dstu.memory (host/plugins/memory/src/service.ts:454, property)<br>dstu.translation (host/plugins/translation/index.ts:20, get)<br>dstu.platform.secrets (host/platform/secrets/index.ts:101, inject)<br>dstu.platform.storage (host/platform/storage/index.ts:67, inject)<br>dstu.browser (host/plugins/browser/index.ts:83, inject)<br>dstu.mcp (host/plugins/mcp/index.ts:78, inject) | — |
| mastery | dstu.review | dstu.qbank (host/plugins/qbank/index.ts:76, get)<br>dstu.qbank (host/plugins/qbank/index.ts:90, get)<br>dstu.qbank (host/plugins/qbank/index.ts:124, get)<br>dstu.sync (host/plugins/sync/index.ts:83, property)<br>dstu.sync (host/plugins/sync/index.ts:84, property) | — |
| masteryProfileSink | dstu.memory | dstu.review (host/plugins/review/src/mastery.ts:145, get) | — |
| mcp | dstu.mcp | — | local-implementation: host/plugins/mcp/index.ts:24-46,67-82 calls initializeGlobalClient in backend mode and dispose on the same provided instance; registry.callTool still needs the external dispatcher |
| media | dstu.media | — | command-surface: host/plugins/media/index.ts:126-187: TTS/media commands; PDF gaps are separate findings |
| memory | dstu.memory | — | command-surface: host/plugins/memory/index.ts:90-245: memory_* commands call service; maintenance gaps remain |
| nativeAudio | dstu.native | dstu.media (host/plugins/media/index.ts:403, get) | — |
| nativeCompression | dstu.native | dstu.sync (host/plugins/sync/index.ts:92, property)<br>dstu.sync (host/plugins/sync/index.ts:95, property)<br>dstu.sync (host/plugins/sync/index.ts:98, property)<br>dstu.sync (host/plugins/sync/index.ts:101, property)<br>dstu.sync (host/plugins/sync/index.ts:73, inject) | — |
| nativeFsrs | dstu.native | — | bypassed: host/plugins/review/src/fsrs-scheduler.ts:11,106-111: direct native module import, no Cordis substitution |
| nativeHeic | dstu.native | — | not-approved: D5/D9 (docs/dev/electron-migration/decisions.md:129,152) prohibit backend HEIC expansion: Rust desktop returns its validation error. Do not install libheif-js or wire a new successful backend |
| nativeImage | dstu.native | dstu.llm (host/plugins/llm/index.ts:105, property)<br>dstu.media (host/plugins/media/index.ts:292, get)<br>dstu.llm (host/plugins/llm/index.ts:80, inject) | — |
| nativeOfficeText | dstu.native | — | island: See wiring task W08 |
| nativePdfium | dstu.native | — | island: See wiring task W07 |
| nativeProtobuf | dstu.native | — | bypassed: host/plugins/media/src/bilibili-grpc.ts:6,24-65: local protobuf/gzip implementation instead of F7 service |
| nativeRegex | dstu.native | dstu.agent-workspace (host/plugins/agent-workspace/index.ts:94, get)<br>dstu.chatanki (host/plugins/chatanki/index.ts:335, lookup-wrapper)<br>dstu.notes (host/plugins/notes/index.ts:110, get)<br>dstu.notes (host/plugins/notes/index.ts:496, get) | — |
| nativeStarlark | dstu.native | dstu.agent-skills (host/plugins/agent-skills/index.ts:230, get) | — |
| nativeTokenizer | dstu.native | dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:143, property)<br>dstu.llm (host/plugins/llm/index.ts:319, property)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:378, inject)<br>dstu.llm (host/plugins/llm/index.ts:80, inject) | — |
| noteAssets | dstu.platform.storage | — | island: See wiring task W17 |
| notes | dstu.notes | dstu.media (host/plugins/media/index.ts:390, get)<br>dstu.memory (host/plugins/memory/src/service.ts:110, context-helper)<br>dstu.sync (host/plugins/sync/index.ts:78, property)<br>dstu.sync-support (host/plugins/sync-support/index.ts:51, property)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:283, property)<br>dstu.vfs-repos (host/plugins/vfs-repos/index.ts:111, get)<br>dstu.memory (host/plugins/memory/index.ts:67, inject)<br>dstu.sync-support (host/plugins/sync-support/index.ts:46, inject)<br>dstu.sync (host/plugins/sync/index.ts:73, inject)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:198, inject) | — |
| ocr | dstu.media | dstu.vfs-index (host/plugins/vfs-index/src/runtime-adapter.ts:49, optional-get) | — |
| paths | dstu.platform.paths | dstu.platform.log (host/platform/log/index.ts:121, property)<br>dstu.platform.secrets (host/platform/secrets/index.ts:103, property)<br>dstu.platform.storage (host/platform/storage/index.ts:346, property)<br>dstu.platform.storage (host/platform/storage/index.ts:359, property)<br>dstu.agent-skills (host/plugins/agent-skills/index.ts:207, property)<br>dstu.agent-skills (host/plugins/agent-skills/index.ts:209, property)<br>dstu.anki (host/plugins/anki/src/plugin.ts:169, property)<br>dstu.anki (host/plugins/anki/src/plugin.ts:181, property)<br>dstu.anki (host/plugins/anki/src/plugin.ts:230, property)<br>dstu.anki (host/plugins/anki/src/plugin.ts:235, property)<br>dstu.backup (host/plugins/backup/src/restore-commands.ts:135, get)<br>dstu.media (host/plugins/media/index.ts:250, property)<br>dstu.media (host/plugins/media/index.ts:304, property)<br>dstu.qbank (host/plugins/qbank/index.ts:123, property)<br>dstu.qbank (host/plugins/qbank/index.ts:639, property)<br>dstu.qbank (host/plugins/qbank/index.ts:649, property)<br>dstu.sync (host/plugins/sync/index.ts:82, property)<br>dstu.sync (host/plugins/sync/index.ts:116, property)<br>dstu.sync (host/plugins/sync/index.ts:122, property)<br>dstu.sync (host/plugins/sync/index.ts:123, property)<br>dstu.sync (host/plugins/sync/index.ts:124, property)<br>dstu.sync-providers (host/plugins/sync-providers/index.ts:173, property)<br>dstu.sync-providers (host/plugins/sync-providers/index.ts:301, property)<br>dstu.vfs-repos (host/plugins/vfs-repos/index.ts:134, property)<br>dstu.platform.log (host/platform/log/index.ts:119, inject)<br>dstu.platform.secrets (host/platform/secrets/index.ts:101, inject)<br>dstu.platform.storage (host/platform/storage/index.ts:67, inject)<br>dstu.agent-skills (host/plugins/agent-skills/index.ts:205, inject)<br>dstu.anki (host/plugins/anki/index.ts:78, inject)<br>dstu.qbank (host/plugins/qbank/index.ts:290, inject)<br>dstu.sync-providers (host/plugins/sync-providers/index.ts:102, inject)<br>dstu.sync (host/plugins/sync/index.ts:73, inject)<br>dstu.vfs-repos (host/plugins/vfs-repos/index.ts:128, inject) | — |
| plugins | dstu.plugins | — | command-surface: host/kernel/plugins.ts:80-118: plugin_* commands call manager |
| qbank | dstu.qbank | dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:269, child-inject)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:270, property) | — |
| retrieval | dstu.vfs-index | dstu.memory (host/plugins/memory/src/search-store.ts:89, context-helper)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:362, property)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:198, inject) | — |
| review | dstu.review | dstu.chatanki (host/plugins/chatanki/index.ts:331, lookup-wrapper)<br>dstu.chatanki (host/plugins/chatanki/index.ts:476, inject) | — |
| runtimeRoots | dstu.agent-workspace | dstu.browser (host/plugins/browser/index.ts:137, get) | — |
| secrets | dstu.platform.secrets | dstu.platform.settings (host/platform/settings/index.ts:221, property)<br>dstu.platform.settings (host/platform/settings/index.ts:224, property)<br>dstu.platform.storage (host/platform/storage/index.ts:71, property)<br>dstu.backup (host/plugins/backup/index.ts:42, property)<br>dstu.backup (host/plugins/backup/index.ts:164, property)<br>dstu.backup (host/plugins/backup/index.ts:202, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:542, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:559, property)<br>dstu.backup (host/plugins/backup/src/crypto-restore.ts:148, property)<br>dstu.backup (host/plugins/backup/src/crypto-restore.ts:155, property)<br>dstu.backup (host/plugins/backup/src/crypto-restore.ts:203, property)<br>dstu.backup (host/plugins/backup/src/crypto-restore.ts:219, property)<br>dstu.backup (host/plugins/backup/src/crypto-restore.ts:335, property)<br>dstu.backup (host/plugins/backup/src/crypto-restore.ts:337, property)<br>dstu.backup (host/plugins/backup/src/sync-ports.ts:94, property)<br>dstu.backup (host/plugins/backup/src/zip-commands.ts:91, property)<br>dstu.backup (host/plugins/backup/src/zip.ts:254, property)<br>dstu.backup (host/plugins/backup/src/zip.ts:290, property)<br>dstu.backup (host/plugins/backup/src/zip.ts:602, property)<br>dstu.backup (host/plugins/backup/src/zip.ts:687, property)<br>dstu.llm (host/plugins/llm/index.ts:89, property)<br>dstu.llm (host/plugins/llm/index.ts:90, property)<br>dstu.mcp (host/plugins/mcp/index.ts:204, property)<br>dstu.media (host/plugins/media/index.ts:157, get)<br>dstu.sync-providers (host/plugins/sync-providers/index.ts:107, property)<br>dstu.platform.settings (host/platform/settings/index.ts:216, inject)<br>dstu.platform.storage (host/platform/storage/index.ts:67, inject)<br>dstu.backup (host/plugins/backup/index.ts:157, inject)<br>dstu.llm (host/plugins/llm/index.ts:80, inject)<br>dstu.mcp (host/plugins/mcp/index.ts:78, inject)<br>dstu.sync-providers (host/plugins/sync-providers/index.ts:102, inject)<br>dstu.sync (host/plugins/sync/index.ts:73, inject) | — |
| settings | dstu.platform.settings | dstu.plugins (host/kernel/plugins.ts:62, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:148, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:158, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:223, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:272, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:338, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:448, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:452, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:501, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:515, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:541, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:550, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:570, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:582, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:583, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:584, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/src/super-inbox-drain.ts:218, lookup-wrapper)<br>dstu.agent-skills (host/plugins/agent-skills/index.ts:211, property)<br>dstu.agent-skills (host/plugins/agent-skills/index.ts:214, property)<br>dstu.agent-workspace (host/plugins/agent-workspace/index.ts:101, property)<br>dstu.backup (host/plugins/backup/index.ts:41, property)<br>dstu.backup (host/plugins/backup/index.ts:163, property)<br>dstu.backup (host/plugins/backup/src/sync-ports.ts:93, property)<br>dstu.browser (host/plugins/browser/index.ts:93, property)<br>dstu.browser (host/plugins/browser/index.ts:103, property)<br>dstu.browser (host/plugins/browser/index.ts:104, property)<br>dstu.browser (host/plugins/browser/index.ts:122, property)<br>dstu.browser (host/plugins/browser/index.ts:135, property)<br>dstu.browser (host/plugins/browser/index.ts:348, property)<br>dstu.browser (host/plugins/browser/index.ts:355, property)<br>dstu.browser (host/plugins/browser/index.ts:360, property)<br>dstu.browser (host/plugins/browser/index.ts:365, property)<br>dstu.browser (host/plugins/browser/index.ts:370, property)<br>dstu.browser (host/plugins/browser/index.ts:376, property)<br>dstu.browser (host/plugins/browser/index.ts:381, property)<br>dstu.browser (host/plugins/browser/index.ts:382, property)<br>dstu.browser (host/plugins/browser/index.ts:383, property)<br>dstu.browser (host/plugins/browser/index.ts:388, property)<br>dstu.browser (host/plugins/browser/index.ts:398, property)<br>dstu.browser (host/plugins/browser/index.ts:432, property)<br>dstu.browser (host/plugins/browser/index.ts:443, property)<br>dstu.browser (host/plugins/browser/index.ts:453, property)<br>dstu.chat (host/plugins/chat/index.ts:139, get)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:147, property)<br>dstu.chatanki (host/plugins/chatanki/index.ts:336, get)<br>dstu.llm (host/plugins/llm/index.ts:86, property)<br>dstu.llm (host/plugins/llm/index.ts:88, property)<br>dstu.llm (host/plugins/llm/index.ts:101, property)<br>dstu.llm (host/plugins/llm/index.ts:102, property)<br>dstu.llm (host/plugins/llm/index.ts:215, property)<br>dstu.llm (host/plugins/llm/index.ts:239, property)<br>dstu.llm (host/plugins/llm/index.ts:375, property)<br>dstu.llm-providers (host/plugins/llm-providers/index.ts:64, property)<br>dstu.mcp (host/plugins/mcp/index.ts:50, property)<br>dstu.mcp (host/plugins/mcp/index.ts:58, property)<br>dstu.mcp (host/plugins/mcp/index.ts:92, property)<br>dstu.mcp (host/plugins/mcp/index.ts:106, property)<br>dstu.mcp (host/plugins/mcp/index.ts:110, property)<br>dstu.mcp (host/plugins/mcp/index.ts:114, property)<br>dstu.mcp (host/plugins/mcp/index.ts:119, property)<br>dstu.mcp (host/plugins/mcp/index.ts:123, property)<br>dstu.mcp (host/plugins/mcp/index.ts:134, property)<br>dstu.mcp (host/plugins/mcp/index.ts:143, property)<br>dstu.mcp (host/plugins/mcp/index.ts:163, property)<br>dstu.media (host/plugins/media/index.ts:168, property)<br>dstu.media (host/plugins/media/index.ts:174, property)<br>dstu.media (host/plugins/media/index.ts:178, property)<br>dstu.media (host/plugins/media/index.ts:188, property)<br>dstu.media (host/plugins/media/index.ts:192, property)<br>dstu.media (host/plugins/media/index.ts:201, property)<br>dstu.media (host/plugins/media/index.ts:205, property)<br>dstu.media (host/plugins/media/index.ts:210, property)<br>dstu.media (host/plugins/media/index.ts:216, property)<br>dstu.media (host/plugins/media/index.ts:223, property)<br>dstu.media (host/plugins/media/index.ts:421, property)<br>dstu.media (host/plugins/media/index.ts:932, property)<br>dstu.memory (host/plugins/memory/src/quick-assistant.ts:355, property)<br>dstu.notes (host/plugins/notes/index.ts:114, get)<br>dstu.notes (host/plugins/notes/src/command-utils.ts:29, get)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:353, property)<br>dstu.plugins (host/kernel/plugins.ts:57, inject)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:95, inject)<br>dstu.agent-skills (host/plugins/agent-skills/index.ts:205, inject)<br>dstu.agent-workspace (host/plugins/agent-workspace/index.ts:59, inject)<br>dstu.backup (host/plugins/backup/index.ts:157, inject)<br>dstu.browser (host/plugins/browser/index.ts:83, inject)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:378, inject)<br>dstu.chatanki (host/plugins/chatanki/index.ts:476, inject)<br>dstu.llm-providers (host/plugins/llm-providers/index.ts:38, inject)<br>dstu.llm (host/plugins/llm/index.ts:80, inject)<br>dstu.mcp (host/plugins/mcp/index.ts:78, inject)<br>dstu.media (host/plugins/media/index.ts:149, inject)<br>dstu.memory (host/plugins/memory/index.ts:67, inject)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:198, inject) | — |
| startupGate | dstu.shell | — | island: electron/index.ts:35-36 provides the gate; no completion mark/finalizer registration is connected. Profile inclusion is fixed; D2 startup completion still needs F3/F2 wiring (W21) |
| storage | dstu.platform.storage | dstu.platform.diagnostics (host/platform/diagnostics/database-commands.ts:40, property)<br>dstu.platform.diagnostics (host/platform/diagnostics/database-commands.ts:47, property)<br>dstu.platform.diagnostics (host/platform/diagnostics/database-commands.ts:56, property)<br>dstu.platform.diagnostics (host/platform/diagnostics/database-commands.ts:62, property)<br>dstu.platform.settings (host/platform/settings/index.ts:220, property)<br>dstu.platform.settings (host/platform/settings/index.ts:224, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:98, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:288, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:317, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:359, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:508, property)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/src/super-inbox-drain.ts:213, lookup-wrapper)<br>dstu.agent-skills (host/plugins/agent-skills/index.ts:218, property)<br>dstu.agent-workspace (host/plugins/agent-workspace/index.ts:79, property)<br>dstu.agent-workspace (host/plugins/agent-workspace/index.ts:81, property)<br>dstu.agent-workspace (host/plugins/agent-workspace/index.ts:83, property)<br>dstu.agent-workspace (host/plugins/agent-workspace/index.ts:84, property)<br>dstu.agent-workspace (host/plugins/agent-workspace/index.ts:86, property)<br>dstu.anki (host/plugins/anki/src/plugin.ts:167, property)<br>dstu.anki (host/plugins/anki/src/plugin.ts:179, property)<br>dstu.anki (host/plugins/anki/src/plugin.ts:180, property)<br>dstu.backup (host/plugins/backup/index.ts:72, property)<br>dstu.backup (host/plugins/backup/index.ts:198, property)<br>dstu.backup (host/plugins/backup/src/backup-commands.ts:53, property)<br>dstu.backup (host/plugins/backup/src/backup-commands.ts:116, property)<br>dstu.backup (host/plugins/backup/src/backup-commands.ts:117, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:136, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:144, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:146, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:147, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:151, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:156, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:252, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:265, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:318, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:510, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:514, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:667, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:673, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:674, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:683, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:686, property)<br>dstu.backup (host/plugins/backup/src/backup-manager.ts:693, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:49, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:54, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:65, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:124, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:180, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:339, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:362, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:394, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:453, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:457, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:528, property)<br>dstu.backup (host/plugins/backup/src/governance.ts:546, property)<br>dstu.backup (host/plugins/backup/src/operations.ts:292, property)<br>dstu.backup (host/plugins/backup/src/restore-commands.ts:139, get)<br>dstu.backup (host/plugins/backup/src/restore-commands.ts:376, property)<br>dstu.backup (host/plugins/backup/src/restore-commands.ts:383, property)<br>dstu.backup (host/plugins/backup/src/sync-ports.ts:111, property)<br>dstu.browser (host/plugins/browser/index.ts:119, property)<br>dstu.browser (host/plugins/browser/index.ts:120, property)<br>dstu.chat (host/plugins/chat/index.ts:84, property)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:275, property)<br>dstu.media (host/plugins/media/index.ts:259, property)<br>dstu.media (host/plugins/media/index.ts:463, property)<br>dstu.media (host/plugins/media/index.ts:920, property)<br>dstu.memory (host/plugins/memory/index.ts:85, property)<br>dstu.memory (host/plugins/memory/src/service.ts:99, property)<br>dstu.memory (host/plugins/memory/src/service.ts:119, property)<br>dstu.memory (host/plugins/memory/src/service.ts:368, property)<br>dstu.memory (host/plugins/memory/src/service.ts:369, property)<br>dstu.notes (host/plugins/notes/index.ts:94, property)<br>dstu.notes (host/plugins/notes/index.ts:129, property)<br>dstu.notes (host/plugins/notes/index.ts:282, property)<br>dstu.notes (host/plugins/notes/index.ts:286, property)<br>dstu.notes (host/plugins/notes/index.ts:290, property)<br>dstu.notes (host/plugins/notes/index.ts:298, property)<br>dstu.notes (host/plugins/notes/index.ts:504, property)<br>dstu.notes (host/plugins/notes/index.ts:508, property)<br>dstu.notes (host/plugins/notes/index.ts:512, property)<br>dstu.notes (host/plugins/notes/index.ts:516, property)<br>dstu.notes (host/plugins/notes/index.ts:520, property)<br>dstu.notes (host/plugins/notes/index.ts:524, property)<br>dstu.notes (host/plugins/notes/index.ts:528, property)<br>dstu.notes (host/plugins/notes/index.ts:533, property)<br>dstu.notes (host/plugins/notes/index.ts:536, property)<br>dstu.notes (host/plugins/notes/index.ts:560, property)<br>dstu.notes (host/plugins/notes/index.ts:564, property)<br>dstu.notes (host/plugins/notes/index.ts:579, property)<br>dstu.notes (host/plugins/notes/index.ts:613, property)<br>dstu.notes (host/plugins/notes/index.ts:614, property)<br>dstu.notes (host/plugins/notes/index.ts:633, property)<br>dstu.qbank (host/plugins/qbank/index.ts:75, property)<br>dstu.qbank (host/plugins/qbank/index.ts:89, property)<br>dstu.qbank (host/plugins/qbank/index.ts:92, property)<br>dstu.qbank (host/plugins/qbank/index.ts:122, property)<br>dstu.qbank (host/plugins/qbank/index.ts:129, property)<br>dstu.qbank (host/plugins/qbank/index.ts:133, property)<br>dstu.qbank (host/plugins/qbank/index.ts:137, property)<br>dstu.qbank (host/plugins/qbank/index.ts:141, property)<br>dstu.qbank (host/plugins/qbank/index.ts:145, property)<br>dstu.qbank (host/plugins/qbank/index.ts:158, property)<br>dstu.qbank (host/plugins/qbank/index.ts:297, property)<br>dstu.qbank (host/plugins/qbank/index.ts:305, property)<br>dstu.qbank (host/plugins/qbank/index.ts:311, property)<br>dstu.qbank (host/plugins/qbank/index.ts:319, property)<br>dstu.qbank (host/plugins/qbank/index.ts:563, property)<br>dstu.qbank (host/plugins/qbank/index.ts:622, property)<br>dstu.qbank (host/plugins/qbank/index.ts:626, property)<br>dstu.qbank (host/plugins/qbank/index.ts:627, property)<br>dstu.review (host/plugins/review/index.ts:19, property)<br>dstu.review (host/plugins/review/src/commands.ts:26, property)<br>dstu.review (host/plugins/review/src/mastery.ts:32, property)<br>dstu.review (host/plugins/review/src/review-plan-commands.ts:17, property)<br>dstu.review (host/plugins/review/src/study-time.ts:36, property)<br>dstu.review (host/plugins/review/src/study-time.ts:44, property)<br>dstu.sync (host/plugins/sync/index.ts:82, property)<br>dstu.sync (host/plugins/sync/index.ts:113, property)<br>dstu.sync (host/plugins/sync/index.ts:114, property)<br>dstu.sync (host/plugins/sync/index.ts:115, property)<br>dstu.sync (host/plugins/sync/index.ts:116, property)<br>dstu.sync (host/plugins/sync/index.ts:117, property)<br>dstu.sync (host/plugins/sync/index.ts:118, property)<br>dstu.sync (host/plugins/sync/index.ts:119, property)<br>dstu.sync (host/plugins/sync/index.ts:120, property)<br>dstu.sync (host/plugins/sync/index.ts:122, property)<br>dstu.sync (host/plugins/sync/index.ts:123, property)<br>dstu.sync (host/plugins/sync/index.ts:124, property)<br>dstu.sync-support (host/plugins/sync-support/index.ts:48, property)<br>dstu.vfs (host/plugins/vfs/index.ts:89, property)<br>dstu.vfs-index (host/plugins/vfs-index/index.ts:47, property)<br>dstu.vfs-index (host/plugins/vfs-index/index.ts:89, property)<br>dstu.vfs-index (host/plugins/vfs-index/index.ts:123, property)<br>dstu.vfs-index (host/plugins/vfs-index/index.ts:158, property)<br>dstu.vfs-index (host/plugins/vfs-index/index.ts:200, property)<br>dstu.vfs-repos (host/plugins/vfs-repos/index.ts:138, property)<br>dstu.vfs-repos (host/plugins/vfs-repos/src/maintenance-service.ts:67, property)<br>dstu.vfs-repos (host/plugins/vfs-repos/src/maintenance-service.ts:73, property)<br>dstu.platform.diagnostics (host/platform/diagnostics/index.ts:14, inject)<br>dstu.platform.settings (host/platform/settings/index.ts:216, inject)<br>dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:95, inject)<br>dstu.agent-skills (host/plugins/agent-skills/index.ts:205, inject)<br>dstu.agent-workspace (host/plugins/agent-workspace/index.ts:59, inject)<br>dstu.anki (host/plugins/anki/index.ts:78, inject)<br>dstu.backup (host/plugins/backup/index.ts:157, inject)<br>dstu.browser (host/plugins/browser/index.ts:83, inject)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:378, inject)<br>dstu.chat (host/plugins/chat/index.ts:75, inject)<br>dstu.memory (host/plugins/memory/index.ts:67, inject)<br>dstu.notes (host/plugins/notes/index.ts:92, inject)<br>dstu.qbank (host/plugins/qbank/index.ts:290, inject)<br>dstu.review (host/plugins/review/index.ts:86, inject)<br>dstu.sync-support (host/plugins/sync-support/index.ts:46, inject)<br>dstu.sync (host/plugins/sync/index.ts:73, inject)<br>dstu.vfs-index (host/plugins/vfs-index/index.ts:60, inject)<br>dstu.vfs-repos (host/plugins/vfs-repos/index.ts:128, inject)<br>dstu.vfs (host/plugins/vfs/index.ts:87, inject) | — |
| sync | dstu.sync | — | needs-review: New unconsumed service: inspect command/remote surfaces before calling it an island |
| syncProvider | dstu.sync-providers | dstu.backup (host/plugins/backup/index.ts:203, get)<br>dstu.sync (host/plugins/sync/index.ts:73, inject) | — |
| syncSupport | dstu.sync-support | dstu.backup (host/plugins/backup/src/restore-commands.ts:182, get)<br>dstu.sync (host/plugins/sync/index.ts:89, property)<br>dstu.sync (host/plugins/sync/index.ts:92, property)<br>dstu.sync (host/plugins/sync/index.ts:95, property)<br>dstu.sync (host/plugins/sync/index.ts:98, property)<br>dstu.sync (host/plugins/sync/index.ts:101, property)<br>dstu.sync (host/plugins/sync/index.ts:106, property)<br>dstu.sync (host/plugins/sync/index.ts:73, inject) | — |
| systemNotification | dstu.shell | dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:130, get) | — |
| translation | dstu.translation | — | command-surface: host/plugins/translation/index.ts:22-52: five commands and the exposed service share commands |
| vfs | dstu.vfs | dstu.agent-workspace (host/plugins/agent-workspace/index.ts:64, get)<br>dstu.chat (host/plugins/chat/index.ts:106, property)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:256, get)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:259, get)<br>dstu.chat (host/plugins/chat/index.ts:75, inject) | — |
| vfsDatabase | dstu.vfs | dstu.browser (host/plugins/browser/index.ts:141, get)<br>dstu.llm (host/plugins/llm/index.ts:117, property)<br>dstu.media (host/plugins/media/index.ts:242, get)<br>dstu.media (host/plugins/media/index.ts:266, get)<br>dstu.media (host/plugins/media/index.ts:451, get)<br>dstu.media (host/plugins/media/index.ts:464, get)<br>dstu.media (host/plugins/media/index.ts:513, get)<br>dstu.media (host/plugins/media/src/service.ts:47, get)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:200, property)<br>dstu.vfs-repos (host/plugins/vfs-repos/src/maintenance-service.ts:65, get)<br>dstu.vfs-repos (host/plugins/vfs-repos/src/maintenance-service.ts:71, get)<br>dstu.llm (host/plugins/llm/index.ts:80, inject)<br>dstu.sync (host/plugins/sync/index.ts:73, inject)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:198, inject) | — |
| vfsHooks | dstu.vfs-handlers | — | island: See wiring task W11 |
| vfsIndex | dstu.vfs-index | dstu.browser (host/plugins/browser/index.ts:157, get)<br>dstu.browser (host/plugins/browser/index.ts:159, get)<br>dstu.media (host/plugins/media/index.ts:364, get)<br>dstu.media (host/plugins/media/index.ts:440, get)<br>dstu.media (host/plugins/media/index.ts:628, get)<br>dstu.media (host/plugins/media/index.ts:757, get)<br>dstu.media (host/plugins/media/index.ts:808, get)<br>dstu.memory (host/plugins/memory/src/search-store.ts:153, context-helper)<br>dstu.memory (host/plugins/memory/src/service.ts:380, get)<br>dstu.memory (host/plugins/memory/src/service.ts:462, context-helper)<br>dstu.memory (host/plugins/memory/src/write-store.ts:149, context-helper)<br>dstu.qbank (host/plugins/qbank/index.ts:67, get)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:302, property)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:198, inject) | — |
| vfsIndexMaintenance | dstu.vfs-index | — | island: vfs-index/index.ts:179-190 shares unitIndex with the used unit builder/background sync; unit-sync-service.ts:114,140 maintenance methods are not reached by handlers, which still call deps.maintenance at index-admin.ts:74,110 (W09) |
| vfsMaintenance | dstu.vfs-repos | dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:202, child-inject)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:203, property) | — |
| vfsRepo | dstu.vfs-repos | dstu.agent-orchestration (host/plugins/agent-orchestration/index.ts:289, get)<br>dstu.agent-workspace (host/plugins/agent-workspace/index.ts:65, get)<br>dstu.browser (host/plugins/browser/index.ts:155, get)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:176, property)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:257, get)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:260, get)<br>dstu.llm (host/plugins/llm/index.ts:117, property)<br>dstu.media (host/plugins/media/index.ts:285, get)<br>dstu.memory (host/plugins/memory/index.ts:77, context-helper)<br>dstu.memory (host/plugins/memory/src/service.ts:112, context-helper)<br>dstu.notes (host/plugins/notes/index.ts:100, get)<br>dstu.qbank (host/plugins/qbank/index.ts:66, get)<br>dstu.qbank (host/plugins/qbank/index.ts:83, get)<br>dstu.qbank (host/plugins/qbank/index.ts:306, get)<br>dstu.review (host/plugins/review/src/review-plan-commands.ts:14, get)<br>dstu.sync (host/plugins/sync/index.ts:76, property)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:211, property)<br>dstu.vfs-index (host/plugins/vfs-index/index.ts:182, optional-get)<br>dstu.vfs-index (host/plugins/vfs-index/src/runtime-adapter.ts:212, optional-get)<br>dstu.vfs-index (host/plugins/vfs-index/src/runtime-adapter.ts:230, optional-get)<br>dstu.chat-pipeline (host/plugins/chat-pipeline/index.ts:378, inject)<br>dstu.llm (host/plugins/llm/index.ts:80, inject)<br>dstu.memory (host/plugins/memory/index.ts:67, inject)<br>dstu.notes (host/plugins/notes/index.ts:92, inject)<br>dstu.sync (host/plugins/sync/index.ts:73, inject)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:198, inject) | — |
| vfsUnitBuilder | dstu.vfs-index | dstu.browser (host/plugins/browser/index.ts:156, get)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:310, child-inject)<br>dstu.vfs-handlers (host/plugins/vfs-handlers/index.ts:311, property) | — |
| vfsWorker | dstu.vfs-repos | — | island: vfs-repos/index.ts:138-139 constructs and disposes the lazy worker; a disposal hook alone does not invoke owner worker operations (W09) |
| webSearch | dstu.browser | dstu.mcp (host/plugins/mcp/index.ts:90, property)<br>dstu.mcp (host/plugins/mcp/index.ts:78, inject) | — |
| webpageToolPolicy | dstu.browser | — | island: browser/index.ts:95 exposes indexWebpageToolPolicy from src/index-webpage.ts:217-225; no VFS persistence/executor method consumes it (W02) |

## 悬空名字（不以测试桥接补齐）

### ankiGeneration@1

- host/plugins/anki/src/generation-port.ts:39 · L16-anki · get: `ctx.get(ANKI_GENERATION_SERVICE)`
- host/plugins/anki/src/generation-port.ts:56 · L16-anki · get: `ctx.get(ANKI_GENERATION_SERVICE)`

### browserSurface

- host/plugins/browser/index.ts:115 · L19-mcp-browser · get: `ctx.get('browserSurface')`

### chat.send@1

- host/plugins/agent-orchestration/index.ts:486 · L06-agent-orchestration · child-inject: `ctx.inject([SEND_MESSAGE_PIPELINE_SERVICE], linked => { const pipeline = linked.get(SEND_MESSAGE_PIPELINE_SERVICE) as SendMessagePipeline; // 注册挂在 linked fiber 上：provider 消失时随注入作用域撤销， // 重新发布后可再次注册（不会留下指向旧管线的命令）。 linked.commands.register<Commands['chat_v2_super_deliver_inbox']['args'], Commands['chat_v2_super_deliver_inbox']['result']>( 'chat_v2_su`
- host/plugins/agent-orchestration/index.ts:487 · L06-agent-orchestration · get: `linked.get(SEND_MESSAGE_PIPELINE_SERVICE)`
- host/plugins/agent-orchestration/index.ts:593 · L06-agent-orchestration · get: `ctx.get(SEND_MESSAGE_PIPELINE_SERVICE)`
- host/plugins/agent-orchestration/src/super-inbox-drain.ts:220 · L06-agent-orchestration · lookup-wrapper: `requireService<SendMessagePipeline>(ctx, SEND_MESSAGE_PIPELINE_SERVICE)`

### embedding@1

- host/plugins/vfs-index/src/runtime-adapter.ts:48 · L12-vfs-index · optional-get: `optionalService<EmbeddingCapability>(ctx, 'embedding@1')`
- host/plugins/vfs-index/src/runtime-adapter.ts:143 · L12-vfs-index · optional-get: `optionalService<EmbeddingCapability>(ctx, 'embedding@1')`

### llm.adapter-infos@1

- host/plugins/anki/src/model-adapters.ts:28 · L16-anki · get: `ctx.get('llm.adapter-infos@1')`

### pdf@1

- host/plugins/vfs-index/index.ts:168 · L12-vfs-index · optional-get: `optionalService<PdfStageRuntime>(ctx, 'pdf@1')`

### reviewPlan

- host/plugins/qbank/index.ts:94 · L14-qbank · get: `ctx.get('reviewPlan')`

### storageStartupSync

- host/platform/storage/index.ts:72 · F3-storage · get: `ctx.get('storageStartupSync')`

### vector

- host/plugins/vfs-handlers/index.ts:314 · L13-vfs-api · child-inject: `ctx.inject(['vector'], scoped => { indexDeps.vectorAvailable = scoped.vector !== undefined; scoped.effect(() => () => { indexDeps.vectorAvailable = false; }); })`
- host/plugins/vfs-handlers/index.ts:315 · L13-vfs-api · property: `scoped.vector`
- host/plugins/vfs-index/index.ts:66 · L12-vfs-index · optional-get: `optionalService<VectorService>(ctx, 'vector')`

## 硬 inject 环

无。ctx.inject 子回调不参与顶层启动环。

## 服务不可用/待接线诊断候选（逐位置；reachable 为入口导入可达）

| lane | 位置 | 可达 | 原文 |
|---|---|---|---|
| F1-kernel | host/kernel/extensions.ts:84 | true | `[extensions] installers not published yet: ${missing.join(', ')}` |
| F1-kernel | host/kernel/profile.ts:202 | false | `platform core services unavailable: ${missing.map(name => `"${name}"`).join(', ')}` |
| F1-kernel | host/kernel/runtime.ts:227 | false | `service "${service}" does not expose "${method}" to UI (declare it in meta.remote)` |
| F1-kernel | host/kernel/runtime.ts:399 | false | `plugin "${entry.id}" did not start: ${missing.length ? `required services not available: ${missing.map((n) => `"${n}"`).join(', ')}` : `fiber state ${String(fiber.state)}`}` |
| F1-kernel | host/kernel/runtime.ts:399 | false | `required services not available: ${missing.map((n) => `"${n}"`).join(', ')}` |
| F4-security | host/platform/errors/api.ts:77 | true | `${service} API key is not configured` |
| F4-security | host/platform/errors/api.ts:84 | true | 'SERVICE_UNAVAILABLE' |
| F4-security | host/platform/secrets/api.ts:58 | true | 'SECURE_STORE_UNAVAILABLE' |
| F4-security | host/platform/secrets/api.ts:59 | true | 'SECURE_STORE_UNAVAILABLE' |
| F4-security | host/platform/secrets/api.ts:97 | true | 'KeychainUnavailable' |
| F4-security | host/platform/secrets/commands.ts:38 | true | 'DECRYPTOR_INTEGRATION_UNAVAILABLE' |
| F4-security | host/platform/secrets/secret-prompt.ts:40 | true | 'DECRYPTOR_INTEGRATION_UNAVAILABLE' |
| F4-security | host/platform/secrets/secret-prompt.ts:43 | true | 'DECRYPTOR_INTEGRATION_UNAVAILABLE' |
| F4-security | host/platform/secrets/secure-store.ts:138 | true | 'KeychainUnavailable' |
| F4-security | host/platform/secrets/secure-store.ts:420 | true | 'KeychainUnavailable' |
| F4-security | host/platform/secrets/secure-store.ts:426 | true | 'KeychainUnavailable' |
| F4-security | host/platform/secrets/secure-store.ts:715 | true | 'KeychainUnavailable' |
| F4-security | host/platform/secrets/secure-store.ts:736 | true | 'KeychainUnavailable' |
| F3-storage | host/platform/storage/index.ts:73 | true | 'L20 storageStartupSync 服务尚未就绪' |
| F3-storage | host/platform/storage/index.ts:203 | true | '应用命令状态服务尚未就绪' |
| F1-kernel | host/platform/util/index.ts:231 | true | 'Unavailable For Legal Reasons' |
| F1-kernel | host/platform/util/index.ts:235 | true | 'Service Unavailable' |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:280 | true | 'Automation agent turn requires the headless pipeline (chatSession.runHeadlessTurn / chatPipeline.runHeadlessTurn), which is not published.' |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:334 | true | `[AutomationScheduler] scheduler startup deferred (database unavailable): ${errorMessage(error)}` |
| L06-agent-orchestration | host/plugins/agent-orchestration/repository/automation-todo.ts:56 | true | '[AutomationScheduler] VFS todo repository is not available; automation todo cannot be created' |
| L06-agent-orchestration | host/plugins/agent-orchestration/src/automation-runtime.ts:227 | true | 'Skipped by catch-up policy after the app was unavailable' |
| L06-agent-orchestration | host/plugins/agent-orchestration/src/subagent-args.ts:49 | true | `Profile skills are unavailable in the current runtime: [${missing.join(', ')}]. Refusing to create a worker that would silently ignore them.` |
| L06-agent-orchestration | host/plugins/agent-orchestration/src/super-inbox-drain.ts:184 | true | `Service "${name}" is not published; chat_v2_super_deliver_inbox cannot deliver the inbox without it.` |
| L06-agent-orchestration | host/plugins/agent-orchestration/src/super-inbox-drain.ts:194 | true | `${KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE} (service "chatState" is not published)` |
| L06-agent-orchestration | host/plugins/agent-orchestration/src/super-inbox-drain.ts:394 | true | '"agentWorkspace" does not expose getTaskManager(); L05 must publish the subagent task repository ' |
| L06-agent-orchestration | host/plugins/agent-orchestration/src/super-session-exec.ts:133 | true | 'Failed to list worker tasks: task manager is not available in the workspace coordinator' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/skill-market.ts:417 | true | `Community marketplace scan artifact directory is unavailable: ${(error as Error).message}` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/skill-market.ts:422 | true | `Community marketplace scan artifact is unavailable: ${(error as Error).message}` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:188 | true | 'connector operation ledger is unavailable (chat_v2 database not attached)' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:362 | true | `capability_unavailable: connector '${providerId}' is not configured` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:367 | true | `capability_unavailable: '${providerId}' does not provide '${capabilityName}'` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:372 | true | `capability_unavailable: '${providerId}' lacks OAuth scopes or an MCP tool mapping ` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:541 | true | 'capability_unavailable' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:546 | true | 'Main database not available' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:741 | true | `capability_unavailable: ${errorText(error)}` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:749 | true | `capability_unavailable: action '${preview.action}' is not mapped for ` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:754 | true | 'capability_unavailable: mapped MCP tool is empty' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:898 | true | `capability_unavailable: ${errorText(error)}` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:908 | true | 'capability_unavailable: action mapping was removed' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:916 | true | 'capability_unavailable: webhook connector is missing its webhook config' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:919 | true | 'Main database not available' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:923 | true | 'connector provider is not ready: webhook provider transport is not configured' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/connector-executor.ts:972 | true | 'connector provider commit failed: tool registry is unavailable' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/llm-usage-executor.ts:245 | true | 'unavailable' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/object-pages.ts:93 | true | `managed root '${locator.rootId}' is unavailable: ${ioMessage(error)}` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/object-pages.ts:194 | true | `managed root '${locator.rootId}' is unavailable: ${ioMessage(error)}` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/object-pages.ts:199 | true | `managed root '${locator.rootId}' is unavailable: ${ioMessage(error)}` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/object-pages.ts:208 | true | `parent directory is unavailable: ${ioMessage(error)}` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/object-pages.ts:219 | true | `object '${locator.relativePath}' is unavailable: ${ioMessage(error)}` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/object-pages.ts:225 | true | `object '${locator.relativePath}' is unavailable: ${ioMessage(error)}` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/ptc-runtime.ts:497 | true | 'no artifacts root in this context; materialized objects are unavailable' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/ptc-runtime.ts:572 | true | 'no artifacts root in this context; object writes are unavailable' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/skill-workshop-executor.ts:893 | true | `[SkillWorkshopExecutor] main_db unavailable; provenance for '${skillId}' written only ` |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/workbench-executor.ts:76 | true | 'WORKBENCH_UNAVAILABLE' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/workbench-executor.ts:103 | true | 'WORKBENCH_UNAVAILABLE' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/workbench-executor.ts:111 | true | 'APP_AGENT_UNAVAILABLE' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/workbench-executor.ts:116 | true | 'ACTION_UNAVAILABLE' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/workbench-executor.ts:239 | true | 'WORKBENCH_UNAVAILABLE' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/workbench-executor.ts:370 | true | 'WORKBENCH_UNAVAILABLE' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/workbench-executor.ts:375 | true | 'WORKBENCH_UNAVAILABLE' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/tools/workbench-executor.ts:382 | true | 'WORKBENCH_UNAVAILABLE' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/workers/zip-pool.ts:135 | true | 'zip worker pool unavailable' |
| L07-agent-skills-ptc | host/plugins/agent-skills/src/zip.ts:207 | true | 'Zip read error: unsupported Zip archive: The file length is not available in the local header' |
| L05-agent-workspace | host/plugins/agent-workspace/index.ts:67 | true | 'VFS resolver requires vfs, vfsRepo and docs services' |
| L05-agent-workspace | host/plugins/agent-workspace/index.ts:194 | true | 'Workspace root is not configured' |
| L05-agent-workspace | host/plugins/agent-workspace/src/approval-scope/env.ts:421 | true | 'unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/approval-scope/env.ts:421 | true | 'unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/runtime-roots.ts:362 | true | 'Workspace root is not configured. Ask the user to select a workspace directory in Settings > 工具权限, or use root_id=artifacts / temp instead.' |
| L05-agent-workspace | host/plugins/agent-workspace/src/runtime-roots.ts:376 | true | `Unsupported runtime root '${id}'. It is not available for the current loaded skills.` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/code-navigation.ts:133 | true | 'Code navigation does not expose hidden or sensitive paths' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/lsp-navigation.ts:448 | true | 'Language server stdin is unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/lsp-navigation.ts:449 | true | 'Language server stdout is unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-authority.ts:106 | true | 'unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-authority.ts:107 | true | 'unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-execute/context.ts:102 | true | 'Chat V2 database is unavailable for shell authority lookup' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-execute.ts:289 | true | 'workspace snapshots were unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-preflight.ts:224 | true | `Trusted Windows PowerShell executable is unavailable: ${powershell}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-preflight.ts:258 | true | `macOS Seatbelt launcher is unavailable: ${ioMessage(error)}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-preflight.ts:303 | true | `/bin/sh is unavailable: ${ioMessage(error)}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-preflight.ts:513 | true | `local shell sandbox is unavailable: ${capability.reason}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox-windows.ts:416 | true | `Trusted Windows PowerShell executable is unavailable: ${powershell}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:101 | true | 'unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:101 | true | 'unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:337 | true | `macOS Seatbelt launcher is unavailable: ${messageOf(error)}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:344 | true | `Local shell sandbox is unavailable; refusing unsandboxed execution: ${capability.reason}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:480 | true | `Local shell sandbox is unavailable; refusing unsandboxed execution: ${messageOf(error)}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:520 | true | 'Local shell sandbox is unavailable; refusing unsandboxed execution' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:524 | true | 'Local shell sandbox is unavailable; refusing unsandboxed execution' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:529 | true | 'unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:530 | true | 'unavailable' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:608 | true | `Local shell sandbox is unavailable; refusing unsandboxed execution: ${capability.reason}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:632 | true | `Local shell sandbox is unavailable; refusing unsandboxed execution: ${capability.reason}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:730 | true | `/bin/sh is unavailable: ${messageOf(error)}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:780 | true | `Full Access shell backend is unavailable: ${capability.reason}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/shell-sandbox.ts:789 | true | `Full Access shell backend is unavailable: ${capability.reason}` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/workspace-executor.ts:155 | true | `Profile skills are unavailable in the current runtime: [${missing.join(', ')}]. ` |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/workspace-executor.ts:286 | true | 'chat_v2_db not available for creating agent session' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/workspace-executor.ts:400 | true | 'runWorkspaceAgentBackend is not configured for worker runtime' |
| L05-agent-workspace | host/plugins/agent-workspace/src/tools/workspace-fs.ts:196 | true | 'Hidden files and common credential/secret paths are not available to workspace tools' |
| L16-anki | host/plugins/anki/src/apkg-import-types.ts:47 | true | 'media_dir_unavailable' |
| L16-anki | host/plugins/anki/src/plugin-handlers-generation.ts:47 | true | 'Anki 生成服务不可用：L02 尚未发布 generateAnkiCardsFromDocument（服务名 ankiGeneration@1）' |
| L16-anki | host/plugins/anki/src/plugin-handlers-generation.ts:203 | true | 'Anki 生成服务不可用：L02 尚未发布 processTaskAndGenerateCardsStream（服务名 ankiGeneration@1）' |
| L21-backup-governance | host/plugins/backup/src/cloud-config.ts:35 | true | 'E_CLOUD_CREDENTIALS_UNAVAILABLE' |
| L21-backup-governance | host/plugins/backup/src/cloud-config.ts:118 | true | `cloud credentials are unavailable or incomplete: ${detail}` |
| L21-backup-governance | host/plugins/backup/src/cloud-config.ts:499 | true | 'cloud sync is not configured in the backend SSOT' |
| L21-backup-governance | host/plugins/backup/src/cloud-config.ts:654 | true | 'SECURE_STORE_UNAVAILABLE' |
| L21-backup-governance | host/plugins/backup/src/cloud-config.ts:867 | true | `cloud credentials are unavailable or incomplete: 发布被拒绝：${providerName(config)} 凭据在草稿与已发布记录中均为空，发布后的 generation 将指向空凭据` |
| L21-backup-governance | host/plugins/backup/src/governance-tool.ts:101 | true | 'Cloud sync is not configured in the backend SSOT.' |
| L21-backup-governance | host/plugins/backup/src/governance-tool.ts:114 | true | 'CLOUD_CONFIG_UNAVAILABLE' |
| L21-backup-governance | host/plugins/backup/src/governance-tool.ts:119 | true | 'credentials_unavailable' |
| L21-backup-governance | host/plugins/backup/src/governance-tool.ts:121 | true | 'CLOUD_CREDENTIALS_UNAVAILABLE' |
| L21-backup-governance | host/plugins/backup/src/manifest.ts:21 | true | 'E_BACKUP_ATOMIC_RESTORE_UNAVAILABLE' |
| L21-backup-governance | host/plugins/backup/src/restore-commands.ts:70 | true | `[${ATOMIC_RESTORE_UNAVAILABLE_CODE}] A/B 数据空间管理器不可用，已在写入任何恢复数据前中止；当前数据未改动` |
| L21-backup-governance | host/plugins/backup/src/restore-commands.ts:188 | true | '待接线：syncSupport.state.recordDeviceRotation（L20 尚未提供）' |
| L19-mcp-browser | host/plugins/browser/index.ts:149 | true | `[IndexWebpageToolExecutor] VFS connection unavailable: ${error instanceof Error ? error.message : String(error)}` |
| L19-mcp-browser | host/plugins/browser/src/browser-bridge.js:527 | false | 'DataTransfer is unavailable in this WebView' |
| L19-mcp-browser | host/plugins/browser/src/browser-service.ts:280 | true | `window ${BROWSER_CONTENT_LABEL} is unavailable` |
| L19-mcp-browser | host/plugins/browser/src/browser-service.ts:681 | true | '[browser] failed to resolve download artifact root: artifacts root unavailable' |
| L19-mcp-browser | host/plugins/browser/src/browser-tool-executor.ts:259 | true | 'BROWSER_SERVICE_UNAVAILABLE' |
| L19-mcp-browser | host/plugins/browser/src/browser-tool-executor.ts:457 | true | 'BROWSER_FILE_UNAVAILABLE' |
| L19-mcp-browser | host/plugins/browser/src/browser-tool-executor.ts:673 | true | 'PLATFORM_API_UNAVAILABLE' |
| L19-mcp-browser | host/plugins/browser/src/command-result.ts:27 | true | `Data space unavailable: ${error.message}` |
| L19-mcp-browser | host/plugins/browser/src/index-webpage-executor.ts:127 | true | 'DEPENDENCY_UNAVAILABLE' |
| L19-mcp-browser | host/plugins/browser/src/index-webpage-executor.ts:166 | true | 'DEPENDENCY_UNAVAILABLE' |
| L19-mcp-browser | host/plugins/browser/src/index-webpage-executor.ts:167 | true | `${what} is unavailable.` |
| L19-mcp-browser | host/plugins/browser/src/index-webpage-executor.ts:363 | true | 'DEPENDENCY_UNAVAILABLE' |
| L19-mcp-browser | host/plugins/browser/src/index-webpage-executor.ts:364 | true | 'VfsIndexService.get_status_summary is not published yet (L12).' |
| L19-mcp-browser | host/plugins/browser/src/index-webpage.ts:181 | true | 'DNS resolution failed: DNS resolution is unavailable' |
| L19-mcp-browser | host/plugins/browser/src/window-policy.ts:96 | true | 'DNS resolution is unavailable' |
| L04-chat-session | host/plugins/chat/index.ts:140 | true | 'Settings service is unavailable' |
| L04-chat-session | host/plugins/chat/src/approval.ts:26 | true | 'ApprovalManager is not available' |
| L04-chat-session | host/plugins/chat/src/deletion.ts:60 | true | 'agentSubagent.onSessionRemoved is unavailable' |
| L04-chat-session | host/plugins/chat/src/group-actions.ts:56 | true | `defaultRuntimeRootId '${trimmed}' is not resolvable on this device: runtime root service is unavailable` |
| L04-chat-session | host/plugins/chat/src/group-actions.ts:168 | true | 'VFS database is unavailable' |
| L04-chat-session | host/plugins/chat/src/ocr.ts:36 | true | 'LLM OCR adapter/raw prompt service is unavailable' |
| L04-chat-session | host/plugins/chat/src/plan-gate.ts:23 | true | 'PlanGateManager is not available' |
| L04-chat-session | host/plugins/chat/src/session-actions.ts:412 | true | 'ApprovalManager is not available' |
| L04-chat-session | host/plugins/chat/src/state.ts:5 | true | 'AgentKillSwitch gate: ChatV2State is unavailable, admission denied (fail-closed).' |
| L04-chat-session | host/plugins/chat/src/workspace-actions.ts:34 | true | 'WorkspaceCoordinator is not available' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/execution-snapshot.ts:51 | true | 'unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/finalizer.ts:227 | true | 'unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/finalizer.ts:228 | true | 'check_unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/finalizer.ts:241 | true | 'artifact locator unavailable (no app handle / main database); cannot verify declared artifacts' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/finalizer.ts:276 | true | 'check_unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/finalizer.ts:299 | true | 'check_unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/finalizer.ts:415 | true | 'check_unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/finalizer.ts:436 | true | 'unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/local-shell-contract.ts:15 | true | 'unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/local-shell-contract.ts:16 | true | 'unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/model-selection.ts:115 | true | `Explicit persona model '${modelId}' is unavailable; refusing to fall back to another model` |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/parallel-exec.ts:19 | true | 'workbench_unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/parallel-exec.ts:22 | true | 'temporarily unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/parallel-exec.ts:23 | true | 'service unavailable' |
| L03-chat-pipeline | host/plugins/chat-pipeline/src/parallel-exec.ts:29 | true | 'temporarily unavailable' |
| L24-chatanki | host/plugins/chatanki/index.ts:185 | true | 'settings store does not expose get/getSetting' |
| L24-chatanki | host/plugins/chatanki/index.ts:190 | true | 'settings store does not expose save/saveSetting' |
| L24-chatanki | host/plugins/chatanki/src/apkg-executor.ts:84 | true | 'Chat database not available for APKG resource ownership check' |
| L24-chatanki | host/plugins/chatanki/src/apkg-executor.ts:96 | true | 'Anki database not available' |
| L24-chatanki | host/plugins/chatanki/src/apkg-executor.ts:104 | true | 'VFS database not available' |
| L24-chatanki | host/plugins/chatanki/src/apkg-import.ts:37 | true | `APKG resource is not available in the current chat session: ${errorText(caught)}` |
| L24-chatanki | host/plugins/chatanki/src/apkg-import.ts:43 | true | `APKG resource is not available in the current chat session: ${resourceId}` |
| L24-chatanki | host/plugins/chatanki/src/chatanki-executor.ts:266 | true | 'the LLM manager is present but does not expose it' |
| L24-chatanki | host/plugins/chatanki/src/chatanki-executor.ts:307 | true | 'Database not available' |
| L24-chatanki | host/plugins/chatanki/src/chatanki-executor.ts:382 | true | 'Anki database not available' |
| L24-chatanki | host/plugins/chatanki/src/chatanki-executor.ts:424 | true | 'JSON export service unavailable' |
| L24-chatanki | host/plugins/chatanki/src/chatanki-executor.ts:460 | true | 'blocks.ankiCards.errors.databaseUnavailable' |
| L24-chatanki | host/plugins/chatanki/src/chatanki-executor.ts:483 | true | 'AnkiConnect service unavailable' |
| L24-chatanki | host/plugins/chatanki/src/errors.ts:11 | true | 'AnkiConnect is unavailable; ask the user to open Anki with the AnkiConnect add-on enabled, then retry' |
| L24-chatanki | host/plugins/chatanki/src/errors.ts:15 | true | 'the card database is currently unavailable; wait and retry later instead of repeating immediately' |
| L24-chatanki | host/plugins/chatanki/src/errors.ts:25 | true | 'the template database is currently unavailable; retry later' |
| L24-chatanki | host/plugins/chatanki/src/fsrs-settings-executor.ts:89 | true | 'FSRS_DB_UNAVAILABLE' |
| L24-chatanki | host/plugins/chatanki/src/fsrs-settings-executor.ts:111 | true | 'FSRS_CONFIG_UNAVAILABLE' |
| L24-chatanki | host/plugins/chatanki/src/fsrs-settings-executor.ts:118 | true | 'FSRS_STATS_UNAVAILABLE' |
| L24-chatanki | host/plugins/chatanki/src/fsrs-settings-executor.ts:119 | true | '读取闪卡今日额度统计失败: review 服务未发布 getReviewStatistics(days)' |
| L24-chatanki | host/plugins/chatanki/src/fsrs-settings-executor.ts:126 | true | 'FSRS_STATS_UNAVAILABLE' |
| L24-chatanki | host/plugins/chatanki/src/get-cards-executor.ts:76 | true | 'blocks.ankiCards.errors.databaseUnavailable' |
| L24-chatanki | host/plugins/chatanki/src/mutation-executor.ts:32 | true | 'blocks.ankiCards.errors.databaseUnavailable' |
| L24-chatanki | host/plugins/chatanki/src/mutation-executor.ts:53 | true | 'settings store does not expose get/getSetting' |
| L24-chatanki | host/plugins/chatanki/src/mutation-executor.ts:58 | true | 'settings store does not expose save/saveSetting' |
| L24-chatanki | host/plugins/chatanki/src/mutation-executor.ts:96 | true | '[ChatAnkiToolExecutor] preference deletion denominator unavailable: document ownership changed' |
| L24-chatanki | host/plugins/chatanki/src/mutation-executor.ts:101 | true | `[ChatAnkiToolExecutor] preference deletion denominator unavailable: ${errorText(caught)}` |
| L24-chatanki | host/plugins/chatanki/src/mutation-executor.ts:116 | true | ' F4 settings or L16 anki_preference_memory service is not available' |
| L24-chatanki | host/plugins/chatanki/src/mutation-executor.ts:140 | true | ' F4 settings or L16 anki_preference_memory service is not available' |
| L24-chatanki | host/plugins/chatanki/src/retemplate-executor.ts:35 | true | 'blocks.ankiCards.errors.databaseUnavailable' |
| L24-chatanki | host/plugins/chatanki/src/retemplate-executor.ts:36 | true | 'blocks.ankiCards.errors.templateDatabaseUnavailable' |
| L24-chatanki | host/plugins/chatanki/src/retemplate-executor.ts:226 | true | 'LLM manager not available for fill_missing_llm' |
| L24-chatanki | host/plugins/chatanki/src/review-executor.ts:32 | true | 'blocks.ankiCards.errors.databaseUnavailable' |
| L24-chatanki | host/plugins/chatanki/src/status-executor.ts:73 | true | 'Anki database not available' |
| L24-chatanki | host/plugins/chatanki/src/transform-executor.ts:139 | true | 'sandbox_unavailable' |
| L24-chatanki | host/plugins/chatanki/src/transform-executor.ts:143 | true | 'script_sandbox_unavailable' |
| L24-chatanki | host/plugins/chatanki/src/transform-executor.ts:145 | true | 'Script mode requires the desktop hard sandbox (macOS Seatbelt / Linux bubblewrap / Windows AppContainer) and is unavailable on this platform (e.g. mobile). Use transform.ops instead.' |
| L24-chatanki | host/plugins/chatanki/src/transform-executor.ts:147 | true | 'interpreter_unavailable' |
| L24-chatanki | host/plugins/chatanki/src/transform-executor.ts:151 | true | 'interpreter_unavailable' |
| L24-chatanki | host/plugins/chatanki/src/transform-executor.ts:211 | true | 'script_environment_unavailable' |
| L24-chatanki | host/plugins/chatanki/src/transform-executor.ts:282 | true | 'blocks.ankiCards.errors.databaseUnavailable' |
| L24-chatanki | host/plugins/chatanki/src/transform-executor.ts:447 | true | 'sandbox_unavailable' |
| L24-chatanki | host/plugins/chatanki/src/transform-executor.ts:534 | true | 'blocks.ankiCards.errors.databaseUnavailable' |
| L24-chatanki | host/plugins/chatanki/src/transform-script.ts:1042 | true | 'sandbox_unavailable' |
| L24-chatanki | host/plugins/chatanki/src/transform-script.ts:1049 | true | 'interpreter_unavailable' |
| L02-llm-manager | host/plugins/llm/src/connection_test.ts:655 | true | 'Codex OAuth 连接测试依赖 L01 尚未发布的 llmAdapters 认证服务' |
| L02-llm-manager | host/plugins/llm/src/data/model_capability_registry.ts:3 | true | "持续维护模型能力、参数形态和适配注意事项，用于修正 chat-v2 适配器与模型能力推断实现。2026-08-23 增补：新增 claude-haiku-4-5、gemini-3.1-flash-lite、gemini-3.5-flash-lite、MiniMax-M2（均核验官方文档并附 source_url/verified_at）；2026-08-24 补齐官方 claude-opus-5。claude-haiku-5 因官方未发布对应模型 ID 暂不收录。2026-09-12 核验：DeepSeek V4.1 Flash（deepseek-flash）原生多模态；旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 路由到该模型。官 |
| L02-llm-manager | host/plugins/llm/src/data/model_capability_registry.ts:3 | true | "截至 2026-08-23，Anthropic 官方模型总览未发布 claude-haiku-5 的模型 ID，Haiku 产线最新官方型号即 4.5；前端 claude-haiku-5 规则暂无官方 registry 对应。" |
| L02-llm-manager | host/plugins/llm/src/settings_models_executor.ts:29 | false | 'DEPENDENCY_UNAVAILABLE' |
| L02-llm-manager | host/plugins/llm/src/settings_models_executor.ts:29 | false | 'The settings database is unavailable.' |
| L02-llm-manager | host/plugins/llm/src/settings_models_executor.ts:34 | false | 'DEPENDENCY_UNAVAILABLE' |
| L02-llm-manager | host/plugins/llm/src/settings_models_executor.ts:34 | false | 'The model manager is unavailable.' |
| L02-llm-manager | host/plugins/llm/src/tools.ts:81 | false | 'or any information not available in local knowledge base. Use this when users ' |
| L01-llm-providers | host/plugins/llm-providers/src/ocr/system.ts:32 | true | 'System OCR is not available on this platform. Supported: macOS 10.15+, Windows 10+. ' |
| L01-llm-providers | host/plugins/llm-providers/src/openai-codex/error.ts:29 | true | 'Codex credentials are not available' |
| L01-llm-providers | host/plugins/llm-providers/src/openai-codex/manager-values.ts:91 | true | 'temporarily_unavailable' |
| L19-mcp-browser | host/plugins/mcp/index.ts:36 | true | 'LLMManager 未发布 clearMcpToolCache/preheatMcpTools，无法执行 MCP 工具缓存清理/预热' |
| L19-mcp-browser | host/plugins/mcp/src/web-search-core.ts:43 | true | 'Unavailable For Legal Reasons' |
| L19-mcp-browser | host/plugins/mcp/src/web-search-core.ts:44 | true | 'Service Unavailable' |
| L18-media-docs | host/plugins/media/index.ts:268 | true | 'VFS database not configured' |
| L18-media-docs | host/plugins/media/index.ts:287 | true | 'VFS repository service not configured' |
| L18-media-docs | host/plugins/media/index.ts:392 | true | 'Notes service not configured' |
| L18-media-docs | host/plugins/media/index.ts:515 | true | 'VFS database not configured' |
| L18-media-docs | host/plugins/media/src/asr.ts:120 | true | 'provider-unavailable' |
| L18-media-docs | host/plugins/media/src/asr.ts:158 | true | 'provider-unavailable' |
| L18-media-docs | host/plugins/media/src/asr.ts:219 | true | 'provider-unavailable' |
| L18-media-docs | host/plugins/media/src/asr.ts:310 | true | 'model-unavailable' |
| L18-media-docs | host/plugins/media/src/bilibili-bridge-hub.ts:161 | true | 'unavailable' |
| L18-media-docs | host/plugins/media/src/bilibili-bridge-server.ts:403 | true | 'Unavailable' |
| L18-media-docs | host/plugins/media/src/bilibili-links.ts:14 | true | 'bilibili-video-unavailable' |
| L18-media-docs | host/plugins/media/src/bilibili-stream.ts:657 | true | 'bilibili-video-unavailable' |
| L18-media-docs | host/plugins/media/src/media-executor.ts:62 | true | 'APP_STATE_UNAVAILABLE' |
| L18-media-docs | host/plugins/media/src/office-fidelity.ts:195 | true | 'DECRYPTOR_INTEGRATION_UNAVAILABLE' |
| L18-media-docs | host/plugins/media/src/service.ts:48 | true | 'VFS database not configured' |
| L18-media-docs | host/plugins/media/src/service.ts:253 | true | 'PDF 功能不可用：未找到 pdfium 库。PDF OCR 会话需要 F7 nativePdfium' |
| L18-media-docs | host/plugins/media/src/service.ts:256 | true | 'PDF 功能不可用：未找到 pdfium 库。PDF OCR 页面处理需要 F7 nativePdfium' |
| L18-media-docs | host/plugins/media/src/service.ts:259 | true | 'PDF 功能不可用：未找到 pdfium 库。PDF OCR 需要 F7 nativePdfium' |
| L18-media-docs | host/plugins/media/src/service.ts:262 | true | 'PDF 功能不可用：未找到 pdfium 库。后端 PDF OCR 需要 F7 nativePdfium' |
| L18-media-docs | host/plugins/media/src/vfs-blob-path.ts:36 | true | 'VFS database not configured' |
| L18-media-docs | host/plugins/media/src/voice-input.ts:137 | true | 'provider-unavailable' |
| L17-memory-research | host/plugins/memory/index.ts:79 | true | 'vfsRepo service is not available' |
| L17-memory-research | host/plugins/memory/repository/learning.ts:31 | false | 'SOURCE_UNAVAILABLE' |
| L17-memory-research | host/plugins/memory/repository/learning.ts:32 | false | 'chat.tools.learning.source_unavailable' |
| L17-memory-research | host/plugins/memory/repository/learning.ts:93 | false | `Learning activity source ${source} is unavailable: ${error instanceof Error ? error.message : String(error)}` |
| L17-memory-research | host/plugins/memory/repository/learning.ts:158 | false | 'VFS learning activity is unavailable.' |
| L17-memory-research | host/plugins/memory/src/search-store.ts:55 | true | '[Memory] Query rewrite skipped: L02 LLM completion API is not published, using the original query' |
| L17-memory-research | host/plugins/memory/src/search-store.ts:90 | true | 'retrieval is not available' |
| L17-memory-research | host/plugins/memory/src/search-store.ts:155 | true | `[Memory] vfsIndex is not available; immediate index for ${resourceId} skipped` |
| L17-memory-research | host/plugins/memory/src/service.ts:114 | true | 'notes service is not available' |
| L17-memory-research | host/plugins/memory/src/service.ts:115 | true | 'vfsRepo service is not available' |
| L17-memory-research | host/plugins/memory/src/service.ts:382 | true | `[Memory] vfsIndex is not available; immediate index for ${resourceId} skipped` |
| L17-memory-research | host/plugins/memory/src/service.ts:425 | true | '[Memory] Post-write category refresh skipped: L02 LLM completion API is not published' |
| L17-memory-research | host/plugins/memory/src/service.ts:434 | true | '[Memory] Post-write promotion pass skipped: L02 LLM completion API is not published' |
| L17-memory-research | host/plugins/memory/src/service.ts:436 | true | '[Memory] Post-write semantic dedup skipped: L02 LLM completion API is not published' |
| L17-memory-research | host/plugins/memory/src/write-store.ts:151 | true | '[Memory] vfsIndex is not available; deleted note index cleanup skipped' |
| L10-notes | host/plugins/notes/repository/notes.ts:27 | true | 'VFS database not configured' |
| L10-notes | host/plugins/notes/repository/resource-deps.ts:33 | true | 'VFS repository service vfsRepo is not available' |
| L10-notes | host/plugins/notes/src/canvas-tool.ts:902 | true | 'WORKBENCH_UNAVAILABLE' |
| L10-notes | host/plugins/notes/src/command-utils.ts:31 | true | 'Settings service unavailable' |
| L10-notes | host/plugins/notes/src/notes-import-tool.ts:142 | true | 'Notes database not available' |
| L10-notes | host/plugins/notes/src/user-todo-tool.ts:621 | true | 'VFS database not available' |
| L14-qbank | host/plugins/qbank/src/grading-service.ts:77 | true | 'AI 评判服务不可用：L02 llm 尚未发布流式补全接口' |
| L14-qbank | host/plugins/qbank/src/llm-grader.ts:82 | true | 'AI 批改服务不可用：L02 llm 尚未发布 gradePracticeSnapshot 接口' |
| L14-qbank | host/plugins/qbank/src/paper-export-bridge.ts:56 | true | `Paper export surface unavailable: ${error instanceof Error ? error.message : String(error)}` |
| L14-qbank | host/plugins/qbank/src/question-service.ts:313 | true | `[qbank] daily progress unavailable for ${examId}: ${errorMessage(error)}` |
| L15-review-analytics | host/plugins/review/src/mastery.ts:57 | true | 'mastery concept_key unavailable for question' |
| L15-review-analytics | host/plugins/review/src/mastery.ts:63 | true | 'mastery concept_key unavailable for question' |
| L15-review-analytics | host/plugins/review/src/mastery.ts:99 | true | 'mastery concept_key unavailable for question' |
| L15-review-analytics | host/plugins/review/src/review-plan-commands.ts:15 | true | 'vfsRepo service is not available' |
| L15-review-analytics | host/plugins/review/src/review.ts:560 | true | 'undo_snapshot_unavailable' |
| L20-sync | host/plugins/sync/repository/apply-record.ts:417 | true | 'note history service unavailable (L10 note_format_repo)' |
| L20-sync | host/plugins/sync/repository/apply-record.ts:456 | true | 'note history service unavailable (note_relation_repo)' |
| L20-sync | host/plugins/sync/repository/note-history.ts:444 | true | 'note history service unavailable (L10 note_format_repo)' |
| L20-sync | host/plugins/sync/repository/pomodoro-counts.ts:19 | true | 'Database error: vfsRepo.pomodoros sync batch owner is unavailable' |
| L20-sync | host/plugins/sync/src/run-sync.ts:26 | false | 'Cloud storage is not configured. Save a cloud config in Settings first.' |
| L23-sync-providers | host/plugins/sync-providers/src/config.ts:12 | true | 'FTP/FTPS storage is not available on Android.' |
| L23-sync-providers | host/plugins/sync-providers/src/delta_restore.ts:490 | true | '当前 host/plugins/backup/api.ts 尚未发布；拒绝恢复（fail-closed）' |
| L23-sync-providers | host/plugins/sync-providers/src/delta_upload.ts:603 | true | '当前 host/plugins/backup/api.ts 尚未发布；拒绝发布（fail-closed）' |
| L23-sync-providers | host/plugins/sync-providers/src/sync_manager.ts:701 | true | '已回滚本次上传、未发布任何版本。请重试上传以重新校验加密密码。' |
| L20-sync | host/plugins/sync-support/src/note-history.ts:202 | true | '待接线：notes.format.blocks' |
| L20-sync | host/plugins/sync-support/src/note-history.ts:220 | true | 'note history service unavailable (L10 notes)' |
| L20-sync | host/plugins/sync-support/src/note-history.ts:313 | true | 'note history service unavailable (L10 notes)' |
| L20-sync | host/plugins/sync-support/src/note-history.ts:376 | true | 'note history service unavailable (L10 notes)' |
| L20-sync | host/plugins/sync-support/src/note-history.ts:412 | true | 'note history service unavailable (L10 notes)' |
| L20-sync | host/plugins/sync-support/src/note-history.ts:455 | true | 'note history service unavailable (L10 notes)' |
| L20-sync | host/plugins/sync-support/src/note-history.ts:482 | true | 'note history service unavailable (L10 notes)' |
| L02-llm-manager | host/plugins/translation/index.ts:54 | true | 'OCR 未在 TypeScript 宿主中实现' |
| L02-llm-manager | host/plugins/translation/src/tool_executor.ts:903 | true | 'DEPENDENCY_UNAVAILABLE' |
| L02-llm-manager | host/plugins/translation/src/tool_executor.ts:904 | true | 'Translation model is not available.' |
| L02-llm-manager | host/plugins/translation/src/tool_executor.ts:1074 | true | 'DEPENDENCY_UNAVAILABLE' |
| L02-llm-manager | host/plugins/translation/src/tool_executor.ts:1075 | true | 'VFS database is not available.' |
| L13-vfs-api | host/plugins/vfs/src/error.ts:54 | true | `MAINTENANCE_MODE: ${v.component} is temporarily unavailable` |
| L13-vfs-api | host/plugins/vfs-handlers/repository/refs.ts:698 | true | `[REQUIRED_QUESTION_IMAGE_UNAVAILABLE: ${JSON.stringify(image['id'] ?? null)}]` |
| L13-vfs-api | host/plugins/vfs-handlers/src/attachments.ts:31 | true | 'L11 vfsAttachments 服务未发布' |
| L13-vfs-api | host/plugins/vfs-handlers/src/index-admin.ts:79 | true | 'vfsUnitBuilder 未发布 syncResourceUnits' |
| L13-vfs-api | host/plugins/vfs-handlers/src/index-admin.ts:99 | true | 'vfsIndex.multimodal 未发布 processPendingBatch' |
| L13-vfs-api | host/plugins/vfs-handlers/src/maintenance-needs.ts:39 | true | '待接线：vfsMaintenance（L11/L12 表所有者的写操作接口）' |
| L13-vfs-api | host/plugins/vfs-handlers/src/mindmaps.ts:23 | true | 'L11 vfsMindmaps 服务未发布' |
| L13-vfs-api | host/plugins/vfs-handlers/src/refs.ts:83 | true | 'docs@1 未发布 extractTextFromBase64' |
| L13-vfs-api | host/plugins/vfs-handlers/src/refs.ts:211 | true | 'qbank 未发布 contextForRefs' |
| L13-vfs-api | host/plugins/vfs-handlers/src/search.ts:74 | true | 'vfs.index@1 未发布 fullSearch' |
| L13-vfs-api | host/plugins/vfs-handlers/src/todo.ts:699 | true | 'LLMManager.call_model2_raw_prompt is unavailable: llm@1 does not expose it' |
| L12-vfs-index | host/plugins/vfs-index/index.ts:183 | true | 'L11 vfsRepo service is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/full-indexing.ts:388 | true | 'L11 vfsRepo questions service is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/full-indexing.ts:501 | true | 'L11 vfsRepo questions service is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/multimodal-service.ts:147 | true | 'L11 vfsRepo service is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/multimodal-service.ts:251 | true | 'L02 multimodal embedding service is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/multimodal-service.ts:262 | true | 'L02 multimodal embedding service is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/pdf-service.ts:220 | true | 'PDF stage runtime (F7 pdfium/image codec) is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/retrieval-planner.ts:91 | true | 'unavailable' |
| L12-vfs-index | host/plugins/vfs-index/src/retrieval-service.ts:383 | true | 'query_derivation:image_semantics_unavailable' |
| L12-vfs-index | host/plugins/vfs-index/src/retrieval-service.ts:475 | true | 'Lance vector store is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/retrieval-service.ts:490 | true | 'Lance vector store is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/retrieval-service.ts:505 | true | 'Lance vector store is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/retrieval-service.ts:655 | true | 'OCR returned no visible text; non-text image semantics remain unavailable' |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:80 | true | 'embedding@1 service is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:86 | true | 'embedding@1 service does not expose multimodal embedding' |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:92 | true | 'ocr service does not expose image observation' |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:98 | true | 'ocr service does not expose free-text OCR' |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:147 | true | 'L02 llm@1 service is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:166 | true | 'embedding@1 service is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:241 | true | 'Lance table statistics are unavailable' |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:247 | true | 'Lance optimization is unavailable' |
| L12-vfs-index | host/plugins/vfs-index/src/search-service.ts:186 | true | 'Lance engine service is not available' |
| L12-vfs-index | host/plugins/vfs-index/src/search-service.ts:191 | true | 'Lance engine service is not available' |
| L11-vfs-repos | host/plugins/vfs-repos/index.ts:112 | true | 'notes service is not available: folder cascade on notes requires the notes plugin' |
| L11-vfs-repos | host/plugins/vfs-repos/repository/attachments.ts:739 | true | 'PDF processing adapter not wired (pdfium/document parser unavailable in Host)' |
| L11-vfs-repos | host/plugins/vfs-repos/repository/folders.ts:644 | true | `Folder cascade for item type '${key}' requires a repository adapter that is not wired` |
| L11-vfs-repos | host/plugins/vfs-repos/src/worker-service.ts:128 | true | 'vfs worker is not available' |

## Context 来源的条件/默认值分支（含无诊断的静默降级；候选而非逐条缺陷）

| lane | 位置 | 可达 | 分支 |
|---|---|---|---|
| F1-kernel | host/kernel/runtime.ts:231 | false | if (typeof fn !== 'function') throw new CommandError(AppError.validation(`service "${service}" has no method "${method}"`)); |
| F1-kernel | host/kernel/runtime.ts:234 | false | if (valueProblem) { const message = `[dstu-host] ${HOST_CALL_COMMAND} ${service}.${method} returned a value that is not plain JSON: ${valueProblem}`; this.ctx.logger('host').error(message); throw new CommandError(AppError.internal(message)); } |
| F1-kernel | host/kernel/runtime.ts:399 | false | missing.length ? `required services not available: ${missing.map((n) => `"${n}"`).join(', ')}` : `fiber state ${String(fiber.state)}` |
| F4-security | host/platform/log/commands.ts:32 | true | if (!await log.debugLogs.flushPending()) throw new CommandError(AppError.file_system('等待调试日志写入超时，请稍后重试')); |
| F4-security | host/platform/log/commands.ts:56 | true | if (info.isFile()) files.push({ path: `${directory}/${name}`, time: info.mtimeMs }); |
| F4-security | host/platform/log/commands.ts:69 | true | if (rel === '..' \|\| rel.startsWith(`..${sep}`) \|\| isAbsolute(rel)) throw new CommandError(AppError.validation('非法的文件路径访问')); |
| F4-security | host/platform/log/commands.ts:86 | true | chars.length > cap ? '…[truncated]' : '' |
| F4-security | host/platform/log/commands.ts:92 | true | if (typeof clean === 'string') return text(clean, 8000); |
| F4-security | host/platform/log/commands.ts:93 | true | if (Array.isArray(clean)) return clean.slice(0, 20).map(child => json(child, depth + 1)); |
| F4-security | host/platform/log/commands.ts:94 | true | if (clean !== null && typeof clean === 'object') return Object.fromEntries(Object.entries(clean).slice(0, 40).map(([key, child]) => [key, json(child, depth + 1)])); |
| F4-security | host/platform/log/diagnostics.ts:70 | true | if (!await log.debugLogs.flushPending()) throw new Error('等待详细请求日志写入超时，请稍后重试'); |
| F4-security | host/platform/log/diagnostics.ts:114 | true | ctx.app.platform === 'darwin' ? 'macos' : ctx.app.platform === 'win32' ? 'windows' : 'linux' |
| F4-security | host/platform/log/diagnostics.ts:114 | true | ctx.app.platform === 'win32' ? 'windows' : 'linux' |
| F4-platform | host/platform/settings/backup-commands.ts:86 | false | if (await ensureWritable(primary)) return primary; |
| F4-platform | host/platform/settings/backup-commands.ts:91 | false | if (await ensureWritable(fallback)) return fallback; |
| F4-platform | host/platform/settings/backup-commands.ts:93 | false | if (!(await ensureWritable(temp))) ctx.logger.warn(`⚠️ [文件系统] 无法获取稳定的持久目录，临时使用 ${temp}`); |
| F4-platform | host/platform/settings/backup-commands.ts:124 | false | if (selected === null \|\| selected === undefined) return null; |
| F4-platform | host/platform/settings/index.ts:221 | true | if (secure === null \|\| secure.dir !== dir) secure = { dir, store: ctx.secrets.openStore(dir) }; |
| F3-storage | host/platform/storage/index.ts:73 | true | if (!sync) throw new Error('L20 storageStartupSync 服务尚未就绪'); |
| F3-storage | host/platform/storage/index.ts:108 | true | if (!startup.status().recovery_required) await storage.impl.migrations.runAll(); |
| F3-storage | host/platform/storage/index.ts:110 | true | if (!startup.initialized) throw new CommandError(AppError.internal('数据空间管理器未初始化')); |
| F3-storage | host/platform/storage/index.ts:175 | true | if (!startup.initialized) throw new CommandError(AppError.internal('数据空间管理器未初始化')); |
| F3-storage | host/platform/storage/index.ts:185 | true | appState?.activeDatabase ?? 'production' |
| F3-storage | host/platform/storage/index.ts:203 | true | if (state === undefined) throw new CommandError(AppError.internal('应用命令状态服务尚未就绪')); |
| F3-storage | host/platform/storage/index.ts:212 | true | if (!fs.existsSync(testPath)) { try { openTestDatabase(testPath).close(); } catch (error) { throw new CommandError(AppError.file_system(`初始化测试数据库失败: ${errorText(error)}`)); } storageLog('dstu_storage::test_mode', 'info', `[测试模式] 已创建测试数据库: ${JSON.stringify(testPath)}`); } else { storageLog('dstu_storage::test_mode', 'info', `[测试模式] 使用现有测试数据库: ${JSON |
| F3-storage | host/platform/storage/index.ts:228 | true | if (fs.existsSync(testPath)) { try { fs.unlinkSync(testPath); } catch (error) { throw new CommandError(AppError.file_system(`删除测试数据库文件失败: ${errorText(error)}`)); } deletedFiles.push(testPath); } |
| F3-storage | host/platform/storage/index.ts:235 | true | if (!fs.existsSync(extra)) continue; |
| F3-storage | host/platform/storage/index.ts:243 | true | if (appState.activeDatabase === 'test') switchMistakesDatabase(testPath); |
| F3-storage | host/platform/storage/index.ts:258 | true | if (!fs.existsSync(testPath)) { try { openTestDatabase(testPath).close(); } catch (error) { throw new CommandError(AppError.file_system(`初始化测试数据库失败: ${errorText(error)}`)); } } |
| F3-storage | host/platform/storage/index.ts:319 | true | status.recovery_required ? null : storage.impl.componentHealth |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:150 | true | notification === undefined ? {} : { notification } |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:258 | true | if (state === undefined) { throw automationCommandError(AppError.validation(KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE)); } |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:277 | true | if (runner === null) { // 依赖未发布：调度层把该错误落为 spawn_error（不伪装成功）。 // agentSubagent 的同名能力在没有 runner 时不会发布（见下）。 throw new Error('Automation agent turn requires the headless pipeline (chatSession.runHeadlessTurn / chatPipeline.runHeadlessTurn), which is not published.'); } |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:293 | true | if (!todoDelivered) return { delivered: [] }; |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:297 | true | marked ? ['todo'] : [] |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:344 | true | if (recovered > 0) ctx.logger.info(`[AutomationScheduler] recovered ${recovered} stale automation runs`); |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:364 | true | if (typeof finalizerHost.registerFinalizer === 'function') { try { finalizerHost.registerFinalizer('l06.automationSchedulerStartup', initializeScheduler); } catch (error) { ctx.logger.warn(`[AutomationScheduler] startup finalizer registration failed: ${errorMessage(error)}`); initializeScheduler(); } } else { initializeScheduler(); } |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:391 | true | if (background === undefined) { void runTick(); return; } |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:397 | true | if (spawned === null) { ctx.logger.warn('[AutomationScheduler] tick rejected: background tasks are shutting down'); ticking = false; } |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:504 | true | if (chat === undefined) throw new Error('ChatV2Database 未初始化'); |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:506 | true | if (workspace === undefined) throw new Error('WorkspaceCoordinator 未初始化'); |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:514 | true | (ctx.get('chatState') as SuperSessionDeps['streams'] \| undefined) ?? null |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:541 | true | if (!readEnabled(ctx.settings)) return superSessionDisabledState(); |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:550 | true | if (!readEnabled(ctx.settings)) return superSessionDisabledState(); |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:594 | true | if (pipeline === undefined) return undefined; |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:599 | true | if (runner === null) return undefined; |
| L06-agent-orchestration | host/plugins/agent-orchestration/index.ts:604 | true | if (runner === null) return undefined; |
| L06-agent-orchestration | host/plugins/agent-orchestration/src/super-inbox-drain.ts:182 | true | if (service === undefined) { throw new Error( `Service "${name}" is not published; chat_v2_super_deliver_inbox cannot deliver the inbox without it.`, ); } |
| L06-agent-orchestration | host/plugins/agent-orchestration/src/super-inbox-drain.ts:193 | true | if (service === undefined) { throw new Error(`${KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE} (service "chatState" is not published)`); } |
| L07-agent-skills-ptc | host/plugins/agent-skills/index.ts:231 | true | if (service === undefined) throw new Error('ptc_run requires the nativeStarlark service'); |
| L05-agent-workspace | host/plugins/agent-workspace/index.ts:67 | true | if (!vfs \|\| !vfsRepo \|\| !docs) throw new Error('VFS resolver requires vfs, vfsRepo and docs services'); |
| L05-agent-workspace | host/plugins/agent-workspace/index.ts:95 | true | if (!regex) throw new Error('Code navigation requires nativeRegex service'); |
| L05-agent-workspace | host/plugins/agent-workspace/index.ts:120 | true | if (!fs.existsSync(root.path)) throw new Error('No artifacts exist for this session yet'); |
| L05-agent-workspace | host/plugins/agent-workspace/index.ts:154 | true | if (retained.length === records.length) throw new Error('Authorized runtime root not found'); |
| L05-agent-workspace | host/plugins/agent-workspace/index.ts:178 | true | if (!fs.existsSync(root.path)) throw new Error('No artifacts exist for this session yet'); |
| L05-agent-workspace | host/plugins/agent-workspace/index.ts:194 | true | if (!root.configured) throw new Error('Workspace root is not configured'); |
| L05-agent-workspace | host/plugins/agent-workspace/index.ts:195 | true | if (root.access !== 'read_write') throw new Error('Workspace root is read-only'); |
| L16-anki | host/plugins/anki/src/generation-port.ts:42 | true | if (service === undefined) return null; |
| L16-anki | host/plugins/anki/src/generation-port.ts:43 | true | if ( typeof service.generateAnkiCardsFromDocument !== 'function' \|\| typeof service.processTaskAndGenerateCardsStream !== 'function' ) { return null; } |
| L16-anki | host/plugins/anki/src/generation-port.ts:59 | true | if (service === undefined) return null; |
| L16-anki | host/plugins/anki/src/generation-port.ts:60 | true | if (typeof service.generateAnkiCardsFromDocument !== 'function') return null; |
| L16-anki | host/plugins/anki/src/plugin.ts:263 | true | if (loaded !== null) { templateConfig = loaded.config; fullTemplate = loaded.full; } |
| L21-backup-governance | host/plugins/backup/index.ts:196 | true | if (existingAgentTools !== undefined) registerGovernanceTools(existingAgentTools); |
| L21-backup-governance | host/plugins/backup/index.ts:203 | true | (ctx.reflect.get('syncProvider') as SyncProviderService \| undefined) ?? null |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:60 | true | if (!existsSync(root)) return []; |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:74 | true | if (!existsSync(root)) throw new Error(backupDirMissingError()); |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:76 | true | if (existsSync(target)) ensureExistingPathWithinBackupDir(target, root); |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:91 | true | if (!existsSync(root)) throw new Error(backupDirMissingError()); |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:93 | true | manifest.assets?.total_size ?? 0 |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:118 | true | slot === 'slotA' ? 'slotB' : 'slotA' |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:125 | true | if (!existsSync(root)) throw new Error(backupDirMissingError()); |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:158 | true | if (!existsSync(root)) { throw new Error('备份目录不存在。请前往「设置 > 数据治理 > 备份」检查备份目录配置'); } |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:175 | true | manifest.assets?.total_files ?? 0 |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:189 | true | if (!existsSync(root)) { throw new Error(`[${BACKUP_DIR_MISSING_CODE}] 备份目录不存在，无法执行自动验证。请前往「设置 > 数据治理 > 备份」检查备份目录配置`); } |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:269 | true | if (!existsSync(root)) mkdirSync(root, { recursive: true }); |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:334 | true | verification.isValid ? null : '备份完成但校验失败，请在审计页查看详情并重新执行备份。' |
| L21-backup-governance | host/plugins/backup/src/backup-commands.ts:480 | true | verification.isValid ? null : '分层备份完成但校验失败，请在审计页查看详情并重新执行备份。' |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:153 | true | if (!hasRefineryHistory(db)) return 0; |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:191 | true | if (masterStat?.isSymbolicLink()) throw new Error('应用主密钥路径不是普通文件，拒绝跟随符号链接备份'); |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:192 | true | if (masterStat && !masterStat.isFile()) throw new Error('应用主密钥路径不是普通文件，拒绝跟随符号链接备份'); |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:194 | true | if (secureStat?.isSymbolicLink()) throw new Error('应用安全存储路径不是普通目录，拒绝跟随符号链接备份'); |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:195 | true | if (secureStat && !secureStat.isDirectory()) throw new Error('应用安全存储路径不是普通目录，拒绝跟随符号链接备份'); |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:196 | true | if (!masterStat && !secureStat) { manifest.key_policy = 'not_present'; updateCoverage(manifest, 'crypto', 'absent', []); return; } |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:203 | true | if (masterStat) { const dest = join(cryptoDest, '.master_key'); copyStrict(masterKey, dest); validateMasterKey(dest); } |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:208 | true | if (secureStat) { const secureDest = join(cryptoDest, '.secure'); mkdirSync(secureDest, { recursive: true }); let count = 0; for (const name of readdirSync(secureDir)) { const path = join(secureDir, name); const metadata = lstatSync(path); if (metadata.isSymbolicLink()) throw new Error(`安全存储包含符号链接，拒绝备份: ${path}`); if (!metadata.isFile()) continue;  |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:215 | true | if (metadata.isSymbolicLink()) throw new Error(`安全存储包含符号链接，拒绝备份: ${path}`); |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:216 | true | if (!metadata.isFile()) continue; |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:253 | true | if (!existsSync(source)) { updateCoverage(manifest, 'audit', 'absent', []); return; } |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:267 | true | if (!stat) { updateCoverage(manifest, 'workspaces-root', 'absent', []); return; } |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:268 | true | if (stat.isSymbolicLink() \|\| !stat.isDirectory()) throw new Error(`工作区数据库根必须是普通目录: ${srcDir}`); |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:275 | true | if (metadata.isSymbolicLink() \|\| !metadata.isFile()) throw new Error(`工作区数据库必须是普通文件: ${src}`); |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:513 | true | if (result !== 'ok') databaseErrors.push(`数据库完整性检查失败 ${file.path}: 完整性检查失败: ${String(result)}`); |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:564 | true | if (value === null) databaseErrors.push(`加密材料验证失败: 加密凭据验证时消失: ${relative}`); |
| L21-backup-governance | host/plugins/backup/src/backup-manager.ts:691 | true | if (result !== 'ok') throw new Error(`恢复后完整性检查失败: ${result}`); |
| L21-backup-governance | host/plugins/backup/src/crypto-restore.ts:204 | true | if (!publication) throw new Error('密钥发布服务不可用，目标密钥保持不变'); |
| L21-backup-governance | host/plugins/backup/src/crypto-restore.ts:220 | true | if (!publication) throw new Error('密钥发布服务不可用，目标密钥保持不变'); |
| L21-backup-governance | host/plugins/backup/src/crypto-restore.ts:323 | true | if (copied < 28) { throw new Error(`备份加密凭据格式过短，目标密钥保持不变: ${stagedFile}`); } |
| L21-backup-governance | host/plugins/backup/src/crypto-restore.ts:343 | true | if (backupSubdir !== preRestoreRoot) { try { snapshotCurrentCryptoKeys(ctx.app.dataDir, preRestoreRoot); } catch (error) { throw new Error(`当前密钥快照失败，已中止恢复且目标密钥保持不变: ${ioMessage(error)}`); } } |
| L21-backup-governance | host/plugins/backup/src/crypto-restore.ts:350 | true | if (existsSync(journalPath)) { throw new Error('检测到未决的密钥发布 journal，请先重启应用完成恢复后重试'); } |
| L21-backup-governance | host/plugins/backup/src/crypto-restore.ts:386 | true | if (hasMaster && hadOldMaster) { renameSync(targetMaster, rollbackMaster); state.movedMaster = true; } |
| L21-backup-governance | host/plugins/backup/src/crypto-restore.ts:387 | true | if (hasSecure && hadOldSecure) { renameSync(targetSecure, rollbackSecure); state.movedSecure = true; } |
| L21-backup-governance | host/plugins/backup/src/crypto-restore.ts:410 | true | if (lstatSync(entry).isFile()) restrictPermissions(entry, false); |
| L21-backup-governance | host/plugins/backup/src/governance.ts:399 | true | health?.snapshot ?? null |
| L21-backup-governance | host/plugins/backup/src/governance.ts:400 | true | health?.issues ?? [] |
| L21-backup-governance | host/plugins/backup/src/operations.ts:297 | true | if (candidate !== undefined && typeof candidate.enterMaintenanceMode === 'function') { workspace = candidate; try { await workspace.enterMaintenanceMode(); workspaceEntered = true; } catch (error) { throw new Error(`工作区进入备份快照屏障失败: ${messageOf(error)}`); } } |
| L21-backup-governance | host/plugins/backup/src/restore-commands.ts:131 | true | (ctx.reflect.get('dataSpace') as DataSpaceService \| undefined) ?? null |
| L21-backup-governance | host/plugins/backup/src/restore-commands.ts:135 | true | (ctx.reflect.get('paths') as PlatformPathsService \| undefined) ?? null |
| L21-backup-governance | host/plugins/backup/src/restore-commands.ts:139 | true | (ctx.reflect.get('storage') as StorageService \| undefined) ?? null |
| L21-backup-governance | host/plugins/backup/src/restore-commands.ts:187 | true | if (typeof rotate !== 'function' \|\| syncState === undefined) { throw new Error('待接线：syncSupport.state.recordDeviceRotation（L20 尚未提供）'); } |
| L21-backup-governance | host/plugins/backup/src/restore-commands.ts:312 | true | if (!existsSync(root)) { job.fail('备份目录不存在'); return; } |
| L21-backup-governance | host/plugins/backup/src/restore-commands.ts:335 | true | if (!verification.isValid) { const errors = [...verification.databaseErrors, ...verification.assetErrors.map(error => `${error.path}: ${error.message}`)]; job.fail(`备份完整性验证失败: ${errors.join('; ')}`); return; } |
| L21-backup-governance | host/plugins/backup/src/restore-commands.ts:356 | true | if (!existsSync(backupSubdir)) { job.fail(`备份目录不存在: ${backupSubdir}`); return; } |
| L21-backup-governance | host/plugins/backup/src/restore-commands.ts:366 | true | if (!existsSync(filePath)) { job.fail(`备份文件不存在: ${file.path}`); return; } |
| L21-backup-governance | host/plugins/backup/src/zip-commands.ts:213 | true | if (!existsSync(source)) { const message = `备份不存在: ${backupId}`; this.governance.trySaveAuditLog(failAuditLog(withAuditDetails(newAuditLog({ type: 'Backup', backup_type: 'Full', file_count: 0, total_size: 0, }, `zip_export/${backupId}`), { job_id: job.job_id, backup_id: backupId, subtype: 'zip_export' }), message)); job.fail(message); return; } |
| L21-backup-governance | host/plugins/backup/src/zip-commands.ts:246 | true | result.totalSize === 0 ? 0 : 1 - result.compressedSize / result.totalSize |
| L21-backup-governance | host/plugins/backup/src/zip-commands.ts:359 | true | if (existsSync(targetDir) && !(resumable && isResuming)) { job.fail(`备份已存在: ${targetId}`); return; } |
| L21-backup-governance | host/plugins/backup/src/zip-commands.ts:422 | true | if (!resumable && existsSync(targetDir)) { try { rmSync(targetDir, { recursive: true, force: true }); } catch (cleanupError) { this.ctx.logger('backup').warn(`清理失败的导入目录时出错: ${ioMessage(cleanupError)}`); } } |
| L21-backup-governance | host/plugins/backup/src/zip-commands.ts:478 | true | if (!existsSync(root)) mkdirSync(root, { recursive: true }); |
| L21-backup-governance | host/plugins/backup/src/zip-commands.ts:552 | true | result.totalSize === 0 ? 0 : 1 - result.compressedSize / result.totalSize |
| L19-mcp-browser | host/plugins/browser/index.ts:115 | true | ctx.get('browserSurface') ?? new ShellBrowserSurface(ctx.shell, platform) |
| L19-mcp-browser | host/plugins/browser/index.ts:137 | true | ctx.get('runtimeRoots') ?? null |
| L19-mcp-browser | host/plugins/browser/index.ts:145 | true | if (database === undefined) return null; |
| L19-mcp-browser | host/plugins/browser/index.ts:154 | true | vfsDatabase()?.blobsDir() ?? null |
| L19-mcp-browser | host/plugins/browser/index.ts:155 | true | (ctx.get('vfsRepo') as VfsReposService \| undefined) ?? null |
| L19-mcp-browser | host/plugins/browser/index.ts:156 | true | (ctx.get('vfsUnitBuilder') as UnitBuilderService \| undefined) ?? null |
| L19-mcp-browser | host/plugins/browser/index.ts:157 | true | (ctx.get('vfsIndex') as VfsIndexService \| undefined)?.indexing ?? null |
| L19-mcp-browser | host/plugins/browser/index.ts:161 | true | typeof index?.getStatusSummary === 'function' ? index.getStatusSummary() : null |
| L19-mcp-browser | host/plugins/browser/index.ts:173 | true | if (tools === undefined \|\| typeof tools.registerToolExecutors !== 'function') return; |
| L19-mcp-browser | host/plugins/browser/index.ts:184 | true | if (state === null) throw new CommandError(`NOT_FOUND: session ${sessionId}`); |
| L19-mcp-browser | host/plugins/browser/index.ts:230 | true | state === null ? null : stateResult(state, browserService.getHistoryEntries(state.id), platform) |
| L19-mcp-browser | host/plugins/browser/index.ts:237 | true | if (active === null \|\| active.id !== sessionId) throw new CommandError(`NOT_FOUND: session ${sessionId}`); |
| L19-mcp-browser | host/plugins/browser/index.ts:249 | true | if (active === null) throw new CommandError('NOT_FOUND: no active browser session'); |
| L19-mcp-browser | host/plugins/browser/index.ts:389 | true | raw === null ? null : parseProviderStrategies(raw) |
| L19-mcp-browser | host/plugins/browser/index.ts:391 | true | parsed ?? defaultProviderStrategies() |
| L19-mcp-browser | host/plugins/browser/index.ts:434 | true | if (result.ok) return { ok: true, message: `${engine}搜索引擎连接正常`, response_time: responseTime, test_query: 'AI artificial intelligence' }; |
| L19-mcp-browser | host/plugins/browser/index.ts:449 | true | result.ok ? { success: true, usage: result.usage } : { success: false, detail: result } |
| L19-mcp-browser | host/plugins/browser/index.ts:466 | true | if (!hasConfig) { results[engineId] = { name: engineName, status: 'not_configured', message: '缺少API密钥或端点配置', elapsed_ms: 0 }; continue; } |
| L19-mcp-browser | host/plugins/browser/index.ts:475 | true | if (result.ok) { results[engineId] = { name: engineName, status: 'success', message: '连接成功', elapsed_ms: elapsed, results_count: result.citations?.length ?? 0, }; } else { const error = typeof result.error === 'string' ? result.error : '未知错误'; results[engineId] = { name: engineName, status: 'failed', message: error, elapsed_ms: elapsed }; } |
| L19-mcp-browser | host/plugins/browser/index.ts:478 | true | result.citations?.length ?? 0 |
| L19-mcp-browser | host/plugins/browser/index.ts:481 | true | typeof result.error === 'string' ? result.error : '未知错误' |
| L04-chat-session | host/plugins/chat/index.ts:126 | true | if (typeof manager.getOcrAdapter === 'function' && typeof manager.callOcrModelRawPrompt === 'function') { ocr = { getOcrAdapter: manager.getOcrAdapter.bind(manager), callOcrModelRawPrompt: manager.callOcrModelRawPrompt.bind(manager) }; } |
| L04-chat-session | host/plugins/chat/index.ts:140 | true | if (service === undefined) throw new ChatV2Error('Database', 'Settings service is unavailable'); |
| L03-chat-pipeline | host/plugins/chat-pipeline/index.ts:256 | true | this.ctx.get('vfs')?.database ?? null |
| L03-chat-pipeline | host/plugins/chat-pipeline/index.ts:257 | true | this.ctx.get('vfsRepo')?.blobs ?? null |
| L03-chat-pipeline | host/plugins/chat-pipeline/index.ts:259 | true | this.ctx.get('vfs')?.database ?? null |
| L03-chat-pipeline | host/plugins/chat-pipeline/index.ts:260 | true | this.ctx.get('vfsRepo')?.blobs ?? null |
| L24-chatanki | host/plugins/chatanki/index.ts:350 | true | settings !== undefined ? adaptSettings(settings) : null |
| L24-chatanki | host/plugins/chatanki/index.ts:466 | true | if (service !== undefined) return service; |
| L24-chatanki | host/plugins/chatanki/index.ts:481 | true | if (existing !== undefined) service.registerWith(existing); |
| L02-llm-manager | host/plugins/llm/index.ts:83 | true | logService?.logger('dstu_llm::llm_manager') ?? ctx.logger |
| L02-llm-manager | host/plugins/llm/index.ts:241 | true | raw === null ? defaultBudgetConfig() : (JSON.parse(raw) as ReturnType<typeof defaultBudgetConfig>) |
| L02-llm-manager | host/plugins/llm/index.ts:329 | true | if (!isGoVendor) throw new CommandError(AppError.validation('该供应商不是 OpenCode Go')); |
| L02-llm-manager | host/plugins/llm/index.ts:330 | true | vendor.isBuiltin ? vendor.apiKey.trim() : (await store.decryptApiKeyIfNeeded(vendor.apiKey)).trim() |
| L02-llm-manager | host/plugins/llm/index.ts:336 | true | if (key === undefined) throw new CommandError(AppError.validation('请先填写 OpenCode Go 的 API Key')); |
| L19-mcp-browser | host/plugins/mcp/index.ts:125 | true | ctx.log?.logger?.('dstu_mcp::mcp::stdio_proxy') ?? ctx.log?.logger?.('dstu_mcp') |
| L19-mcp-browser | host/plugins/mcp/index.ts:139 | true | ctx.log?.logger?.('dstu_mcp::mcp::stdio_proxy') ?? ctx.log?.logger?.('dstu_mcp') |
| L18-media-docs | host/plugins/media/index.ts:155 | true | (ctx.get('llm') as LLMManager \| undefined) ?? null |
| L18-media-docs | host/plugins/media/index.ts:158 | true | if (service === undefined) throw new CommandError('B 站账号存储不可用'); |
| L18-media-docs | host/plugins/media/index.ts:174 | true | ctx.settings.get('ocr.engine_type') ?? 'paddle_ocr_vl' |
| L18-media-docs | host/plugins/media/index.ts:267 | true | if (database === undefined) { throw new CommandError(new MediaError('Database', 'VFS database not configured').toPayloadString()); } |
| L18-media-docs | host/plugins/media/index.ts:286 | true | if (repo === undefined) { throw new CommandError(AppError.configuration('VFS repository service not configured')); } |
| L18-media-docs | host/plugins/media/index.ts:293 | true | if (service === undefined) { throw new CommandError(AppError.configuration( '媒体图片服务未提供：需要 F7 nativeImage')); } |
| L18-media-docs | host/plugins/media/index.ts:366 | true | if (pdf?.isRunning(info.fileId) === true) pdf.cancelMedia(info.fileId); |
| L18-media-docs | host/plugins/media/index.ts:372 | true | if (vfsIndex !== undefined && info.resourceId !== null) { void vfsIndex.indexing.indexResource(info.resourceId).catch((error: unknown) => { log.warn('[media::commands] failed to schedule indexing for %s: %s', info.fileId, error instanceof Error ? error.message : String(error)); }); } |
| L18-media-docs | host/plugins/media/index.ts:379 | true | pdf?.isRunning(info.fileId) ?? false |
| L18-media-docs | host/plugins/media/index.ts:391 | true | if (notesService === undefined) { throw new CommandError(AppError.configuration('Notes service not configured')); } |
| L18-media-docs | host/plugins/media/index.ts:404 | true | if (service === undefined) { throw new CommandError(AppError.configuration( '媒体解码服务未提供：需要 F7 nativeAudio')); } |
| L18-media-docs | host/plugins/media/index.ts:452 | true | if (database === undefined) return []; |
| L18-media-docs | host/plugins/media/index.ts:465 | true | database === undefined ? new Map() : questionTallies(database.getConnSafe(), ids) |
| L18-media-docs | host/plugins/media/index.ts:514 | true | if (database === undefined) { throw new CommandError(AppError.configuration('VFS database not configured')); } |
| L18-media-docs | host/plugins/media/index.ts:534 | true | if (newSha256 !== textbook.sha256) { throw new CommandError(AppError.validation( '所选文件与原文件内容不一致，请选择同一个文件')); } |
| L18-media-docs | host/plugins/media/index.ts:585 | true | session?.cookie ?? null |
| L18-media-docs | host/plugins/media/index.ts:707 | true | defaultTrack?.lan ?? null |
| L18-media-docs | host/plugins/media/index.ts:711 | true | found.lookup.subtitleError?.message ?? null |
| L18-media-docs | host/plugins/media/index.ts:733 | true | if (existing !== null) { const info = loadMediaFile(database.getConnSafe(), existing); const view = transcriptViewOf(database, repos, info, pdf); if (view.segments.length > 0) { return { fileId: info.fileId, name: info.fileName, created: false, segments: view.segments.length, lan: lan ?? '', lanDoc: '', ai: false, }; } } |
| L18-media-docs | host/plugins/media/index.ts:736 | true | if (view.segments.length > 0) { return { fileId: info.fileId, name: info.fileName, created: false, segments: view.segments.length, lan: lan ?? '', lanDoc: '', ai: false, }; } |
| L18-media-docs | host/plugins/media/index.ts:788 | true | if (isLinkItem(info)) { const own = readLinkDescriptor( database.getConnSafe(), repos.files, database.blobsDir(), info); if (own.bvid !== found.lookup.video.bvid \|\| own.page !== found.lookup.page.page) { throw new MediaError('Bilibili', '链接条目只能重新获取它自己的字幕；要导入别的视频，请用「B 站链接」新建条目', 'bilibili-invalid-link'); } } |
| L18-media-docs | host/plugins/media/index.ts:791 | true | if (own.bvid !== found.lookup.video.bvid \|\| own.page !== found.lookup.page.page) { throw new MediaError('Bilibili', '链接条目只能重新获取它自己的字幕；要导入别的视频，请用「B 站链接」新建条目', 'bilibili-invalid-link'); } |
| L18-media-docs | host/plugins/media/index.ts:803 | true | if (pdf?.isRunning(info.fileId) === true) pdf.cancelMedia(info.fileId); |
| L18-media-docs | host/plugins/media/index.ts:850 | true | if (!isLinkItem(info)) { throw new MediaError('InvalidInput', `不是 B 站链接条目: ${info.fileName}`); } |
| L18-media-docs | host/plugins/media/src/service.ts:48 | true | if (database === undefined) throw new Error('VFS database not configured'); |
| L17-memory-research | host/plugins/memory/index.ts:79 | true | if (repos === undefined) throw new Error('vfsRepo service is not available'); |
| L17-memory-research | host/plugins/memory/index.ts:112 | true | mode === 'append' ? service.appendById(args.noteId, args.title, args.content) : service.updateById(args.noteId, args.title, args.content) |
| L17-memory-research | host/plugins/memory/src/search-store.ts:90 | true | if (retrieval === undefined) throw new Error('retrieval is not available'); |
| L17-memory-research | host/plugins/memory/src/search-store.ts:97 | true | response.result.hits[0]?.rrfScore ?? 0 |
| L17-memory-research | host/plugins/memory/src/search-store.ts:111 | true | Number.isFinite(fused.rrfScore) && Number.isFinite(bestRrf) && bestRrf > 0 ? Math.min(1, Math.max(0, fused.rrfScore / bestRrf)) : 0 |
| L17-memory-research | host/plugins/memory/src/search-store.ts:154 | true | if (index === undefined) { this.host.warn(`[Memory] vfsIndex is not available; immediate index for ${resourceId} skipped`); return; } |
| L17-memory-research | host/plugins/memory/src/service.ts:114 | true | if (notes === undefined) throw new Error('notes service is not available'); |
| L17-memory-research | host/plugins/memory/src/service.ts:115 | true | if (repos === undefined) throw new Error('vfsRepo service is not available'); |
| L17-memory-research | host/plugins/memory/src/service.ts:381 | true | if (index === undefined) { this.warn(`[Memory] vfsIndex is not available; immediate index for ${resourceId} skipped`); return; } |
| L17-memory-research | host/plugins/memory/src/service.ts:463 | true | if (index !== undefined) { try { await index.indexing.deleteResourceIndex(resourceId); } catch (error) { this.warn(`[MemoryEvolution] Failed to delete vector chunks for ${resourceId}: ${errorText(error)}`); } } |
| L17-memory-research | host/plugins/memory/src/write-store.ts:150 | true | if (index === undefined) { this.host.warn('[Memory] vfsIndex is not available; deleted note index cleanup skipped'); } else { try { await index.indexing.deleteResourceIndex(note.resourceId); } catch (error) { this.host.warn(`[Memory] Failed to delete lance index for ${note.resourceId} (will rely on disabled state): ${errorText(error)}`); } } |
| L10-notes | host/plugins/notes/index.ts:156 | true | if (installedAgentTools !== undefined) registerAgentTools(installedAgentTools); |
| L10-notes | host/plugins/notes/index.ts:411 | true | if (result.active_lease !== null) ctx.backendEvents.emit('notes:lease-changed', result.active_lease); |
| L10-notes | host/plugins/notes/src/command-utils.ts:30 | true | if (service === undefined) { throw new CommandError(AppError.configuration('Settings service unavailable')); } |
| L14-qbank | host/plugins/qbank/index.ts:82 | true | if (llm === undefined) throw new QbankServiceError(AppError.configuration('LLM 服务未提供')); |
| L14-qbank | host/plugins/qbank/index.ts:84 | true | if (vfsRepo === undefined) { throw new QbankServiceError(AppError.configuration('VFS 仓库服务未提供')); } |
| L14-qbank | host/plugins/qbank/index.ts:312 | true | record === null ? null : taskView(record) |
| L14-qbank | host/plugins/qbank/index.ts:565 | true | if (record === null) return null; |
| L14-qbank | host/plugins/qbank/index.ts:566 | true | if (!isTerminal(record.status)) markCancelled(db, taskId); |
| L14-qbank | host/plugins/qbank/index.ts:572 | true | if (llm === undefined) throw new QbankServiceError(AppError.configuration('LLM 服务未提供')); |
| L14-qbank | host/plugins/qbank/index.ts:668 | true | if (docs === undefined) throw new QbankServiceError(AppError.configuration('文档解析服务未提供')); |
| L15-review-analytics | host/plugins/review/src/commands.ts:95 | true | ctx.mastery.getState(concept)?.score ?? null |
| L15-review-analytics | host/plugins/review/src/commands.ts:187 | true | if (ctx.mastery.revertFsrsRatingForLog(pending.logId) !== null) { confirmMasterySynced(ctx, svc, pending.logId, 'fsrs_rate'); } |
| L15-review-analytics | host/plugins/review/src/commands.ts:309 | true | if (ctx.mastery.revertFsrsRatingForLog(expectedLogId) !== null) { confirmMasterySynced(ctx, svc, expectedLogId, 'fsrs_undo'); } |
| L15-review-analytics | host/plugins/review/src/essay-grading-commands.ts:23 | true | if (service === undefined) throw appError('Database', 'VFS 数据库未初始化'); |
| L15-review-analytics | host/plugins/review/src/insight-commands.ts:19 | true | if (service === undefined) throw appError('Database', 'VFS 数据库未初始化'); |
| L15-review-analytics | host/plugins/review/src/mastery.ts:149 | true | if (sink) { database(() => sink.upsertWeakPointFromMastery(this._db(), state.conceptKey, { score: state.score, total: state.total, wrongCount: state.wrongCount, recentWrongSummary: summary, })); this.ctx.logger('review').debug( '[Mastery] upserted weak_point source=mastery concept=%s', state.conceptKey, ); } |
| L15-review-analytics | host/plugins/review/src/mastery.ts:158 | true | if (sink) { database(() => sink.removeWeakPointFromMastery(this._db(), state.conceptKey)); this.ctx.logger('review').debug( '[Mastery] removed/recovered weak_point concept=%s score=%s', state.conceptKey, state.score.toFixed(3), ); } |
| L15-review-analytics | host/plugins/review/src/review-plan-commands.ts:15 | true | if (repos === undefined) throw new Error('vfsRepo service is not available'); |
| L23-sync-providers | host/plugins/sync-providers/index.ts:205 | true | data === null ? null : Array.from(data) |
| L02-llm-manager | host/plugins/translation/index.ts:21 | true | logService?.logger('dstu_translation') ?? ctx.logger |
| L13-vfs-api | host/plugins/vfs-handlers/index.ts:307 | true | typeof (indexService.multimodal as unknown as Partial<indexAdmin.MultimodalBatchService>).processPendingBatch === 'function' ? indexService.multimodal as unknown as indexAdmin.MultimodalBatchService : undefined |
| L12-vfs-index | host/plugins/vfs-index/index.ts:107 | true | if (lanceEnabled) { try { store = createChatStore(ctx, lanceEngine); } catch { store = null; } } |
| L12-vfs-index | host/plugins/vfs-index/index.ts:133 | true | if (!lanceEnabled) { // `lance_vector_store.rs` feature-disabled stub returns 0. logger.debug('[LanceVectorStore] optimize_chat_tables skipped: lance feature disabled'); return null; } |
| L12-vfs-index | host/plugins/vfs-index/index.ts:162 | true | lanceEnabled ? new VfsLanceStore(vfsDb, { basePath: resolveVfsLanceBase(vfsDb.path), adapter: lanceEngine, logger, }) : new VfsLanceDisabled() |
| L12-vfs-index | host/plugins/vfs-index/index.ts:174 | true | pdfRuntime !== undefined ? { runtime: pdfRuntime } : {} |
| L12-vfs-index | host/plugins/vfs-index/index.ts:183 | true | if (repos === undefined) throw new Error('L11 vfsRepo service is not available'); |
| L12-vfs-index | host/plugins/vfs-index/index.ts:199 | true | lanceEnabled ? { legacyKb: LegacyKbStore.create(ctx.storage.database('mistakes'), lanceEngine, logger) } : {} |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:53 | true | if (llm === undefined) return []; |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:71 | true | if (ocr?.getStructuredOcrCandidates === undefined) return []; |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:75 | true | if (ocr?.getFreeTextOcrCandidates === undefined) return []; |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:79 | true | if (embedding === undefined) { throw new Error('embedding@1 service is not available'); } |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:85 | true | if (embedding?.callMultimodalEmbeddingApi === undefined) { throw new Error('embedding@1 service does not expose multimodal embedding'); } |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:91 | true | if (ocr?.observeImage === undefined) { throw new Error('ocr service does not expose image observation'); } |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:97 | true | if (ocr?.ocrImage === undefined) { throw new Error('ocr service does not expose free-text OCR'); } |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:146 | true | if (llm === undefined) { throw new Error('L02 llm@1 service is not available'); } |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:151 | true | if (id === null \|\| id === undefined) { throw new Error('未配置默认嵌入维度'); } |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:156 | true | if (config === undefined) { throw new Error('默认文本嵌入配置已禁用或能力协议不匹配'); } |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:159 | true | if (!config.enabled \|\| !config.isEmbedding) { throw new Error('默认文本嵌入配置已禁用或能力协议不匹配'); } |
| L12-vfs-index | host/plugins/vfs-index/src/runtime-adapter.ts:165 | true | if (embedding === undefined) { throw new Error('embedding@1 service is not available'); } |
| L11-vfs-repos | host/plugins/vfs-repos/index.ts:112 | true | if (notes === undefined) throw new Error('notes service is not available: folder cascade on notes requires the notes plugin'); |
| L11-vfs-repos | host/plugins/vfs-repos/src/maintenance-service.ts:66 | true | if (database !== undefined) return database.getConnSafe(); |
| L11-vfs-repos | host/plugins/vfs-repos/src/maintenance-service.ts:72 | true | if (database !== undefined) return database.blobsDir(); |

## 测试桥接/替身（提供正式服务或正式路径获取的名字）

| 名字 | 测试位置 | 提供声明/调用 |
|---|---|---|
| settings | host/kernel/tests/plugins.test.ts:508 | settings |
| storage | host/platform/diagnostics/tests/devtools.test.ts:10 | storage: { database: () => ({}) } |
| storage | host/platform/diagnostics/tests/devtools.test.ts:32 | storage: { database: () => ({}) } |
| storage | host/platform/diagnostics/tests/health.test.ts:7 | storage: { database: () => ({}) } |
| storage | host/platform/diagnostics/tests/package-manager.test.ts:18 | storage: {} |
| cloudConfig | host/platform/errors/tests/cloud-config.test.ts:43 | cloudConfig: service |
| paths | host/platform/storage/tests/data-space.test.ts:17 | paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } } |
| log | host/platform/storage/tests/data-space.test.ts:18 | log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } |
| paths | host/platform/storage/tests/recovery-export-commands.test.ts:25 | paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } } |
| log | host/platform/storage/tests/recovery-export-commands.test.ts:26 | log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } |
| storageStartupSync | host/platform/storage/tests/recovery-export-commands.test.ts:27 | storageStartupSync: { resetDefaultAfterLocalPurge() {} } |
| paths | host/platform/storage/tests/staged-upload.test.ts:151 | paths: { os: { home: base, data: base, dataLocal: base, config: base, cache: appCacheDir, temp: base, download: null }, appCacheDir, appLocalDataDir: path.join(base, 'local'), } |
| log | host/platform/storage/tests/staged-upload.test.ts:156 | log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } |
| storageStartupSync | host/platform/storage/tests/staged-upload.test.ts:157 | storageStartupSync: { resetDefaultAfterLocalPurge() {} } |
| paths | host/platform/storage/tests/startup.test.ts:16 | paths: { os: { home: base, data: base, dataLocal: base, config: base, temp: base } } |
| log | host/platform/storage/tests/startup.test.ts:17 | log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } |
| storageStartupSync | host/platform/storage/tests/startup.test.ts:17 | storageStartupSync: { resetDefaultAfterLocalPurge: reset } |
| settings | host/platform/util/tests/model-assignments.test.ts:26 | settings: { get: (key: string) => (key === 'model_assignments' ? legacy : null), save: () => undefined, } |
| secrets | host/platform/util/tests/model-assignments.test.ts:30 | secrets: { isEncryptedFormat: () => false, openCrypto: async () => { throw new Error('crypto unused in this test'); }, } |
| vfsDatabase | host/platform/util/tests/model-assignments.test.ts:34 | vfsDatabase: {} |
| vfsRepo | host/platform/util/tests/model-assignments.test.ts:35 | vfsRepo: { essays: {} } |
| llmAdapters | host/platform/util/tests/model-assignments.test.ts:36 | llmAdapters: {} |
| nativeTokenizer | host/platform/util/tests/model-assignments.test.ts:37 | nativeTokenizer: tokenizer |
| nativeImage | host/platform/util/tests/model-assignments.test.ts:38 | nativeImage: image |
| settings | host/plugins/agent-orchestration/tests/services.test.ts:29 | settings: settingsStore() |
| storage | host/plugins/agent-orchestration/tests/services.test.ts:29 | storage: unavailableStorage() |
| settings | host/plugins/agent-orchestration/tests/services.test.ts:43 | settings: settingsStore() |
| storage | host/plugins/agent-orchestration/tests/services.test.ts:43 | storage: unavailableStorage() |
| settings | host/plugins/agent-orchestration/tests/services.test.ts:55 | settings: settingsStore() |
| storage | host/plugins/agent-orchestration/tests/services.test.ts:55 | storage: unavailableStorage() |
| settings | host/plugins/agent-orchestration/tests/services.test.ts:78 | settings: settingsStore() |
| storage | host/plugins/agent-orchestration/tests/services.test.ts:78 | storage: unavailableStorage() |
| chatSession | host/plugins/agent-orchestration/tests/services.test.ts:79 | chatSession: runner |
| chat.send@1 | host/plugins/agent-orchestration/tests/services.test.ts:79 | 'chat.send@1': pipeline |
| settings | host/plugins/agent-orchestration/tests/settings.test.ts:15 | settings |
| storage | host/plugins/agent-orchestration/tests/settings.test.ts:15 | storage: {} |
| settings | host/plugins/agent-orchestration/tests/settings.test.ts:31 | settings |
| storage | host/plugins/agent-orchestration/tests/settings.test.ts:31 | storage: {} |
| settings | host/plugins/agent-orchestration/tests/settings.test.ts:47 | settings |
| storage | host/plugins/agent-orchestration/tests/settings.test.ts:47 | storage: {} |
| chatSession | host/plugins/agent-orchestration/tests/super-state.test.ts:313 | chatSession: memory.chat |
| agentWorkspace | host/plugins/agent-orchestration/tests/super-state.test.ts:314 | agentWorkspace: workspace.port |
| settings | host/plugins/agent-skills/tests/agent-tools-registry.test.ts:32 | settings: memorySettings() |
| storage | host/plugins/agent-skills/tests/agent-tools-registry.test.ts:32 | storage: unavailableStorage() |
| settings | host/plugins/agent-skills/tests/files.test.ts:24 | settings: memorySettings() |
| storage | host/plugins/agent-skills/tests/files.test.ts:24 | storage: unavailableStorage() |
| settings | host/plugins/agent-skills/tests/files.test.ts:60 | settings: memorySettings() |
| storage | host/plugins/agent-skills/tests/files.test.ts:60 | storage: unavailableStorage() |
| settings | host/plugins/agent-skills/tests/files.test.ts:81 | settings: memorySettings() |
| storage | host/plugins/agent-skills/tests/files.test.ts:81 | storage: unavailableStorage() |
| settings | host/plugins/agent-skills/tests/ptc-production-wiring.test.ts:84 | settings: memorySettings() |
| storage | host/plugins/agent-skills/tests/ptc-production-wiring.test.ts:84 | storage: unavailableStorage() |
| nativeStarlark | host/plugins/agent-skills/tests/ptc-production-wiring.test.ts:84 | nativeStarlark: starlark |
| settings | host/plugins/agent-skills/tests/ptc-production-wiring.test.ts:102 | settings: memorySettings() |
| storage | host/plugins/agent-skills/tests/ptc-production-wiring.test.ts:102 | storage: unavailableStorage() |
| nativeStarlark | host/plugins/agent-skills/tests/ptc-production-wiring.test.ts:102 | nativeStarlark: starlark |
| settings | host/plugins/agent-skills/tests/ptc-production-wiring.test.ts:143 | settings: memorySettings() |
| storage | host/plugins/agent-skills/tests/ptc-production-wiring.test.ts:143 | storage: unavailableStorage() |
| nativeStarlark | host/plugins/agent-skills/tests/ptc-production-wiring.test.ts:144 | nativeStarlark: profile('before-replacement') |
| settings | host/plugins/agent-skills/tests/requires.test.ts:91 | settings: memorySettings() |
| storage | host/plugins/agent-skills/tests/requires.test.ts:91 | storage: unavailableStorage() |
| settings | host/plugins/agent-skills/tests/requires.test.ts:108 | settings: memorySettings() |
| storage | host/plugins/agent-skills/tests/requires.test.ts:108 | storage: unavailableStorage() |
| settings | host/plugins/agent-skills/tests/skill-package.test.ts:322 | settings: memorySettings() |
| storage | host/plugins/agent-skills/tests/skill-package.test.ts:322 | storage: unavailableStorage() |
| settings | host/plugins/agent-workspace/tests/completion-outbox-wiring.test.ts:16 | settings: memorySettings() |
| storage | host/plugins/agent-workspace/tests/completion-outbox-wiring.test.ts:16 | storage: { locations: { activeDir: '.' }, database: () => active } |
| settings | host/plugins/agent-workspace/tests/host-support.ts:11 | settings: memorySettings() |
| nativeRegex | host/plugins/agent-workspace/tests/native-regex-wiring.test.ts:34 | provides: ['nativeRegex'] |
| nativeRegex | host/plugins/agent-workspace/tests/native-regex-wiring.test.ts:35 | ctx.provide('nativeRegex', { ...real, compile, captures }) |
| settings | host/plugins/agent-workspace/tests/vfs-resolver-wiring.test.ts:13 | settings: memorySettings() |
| storage | host/plugins/agent-workspace/tests/vfs-resolver-wiring.test.ts:14 | storage: { locations: { activeDir: '.' }, database: () => db.executor } |
| vfs | host/plugins/agent-workspace/tests/vfs-resolver-wiring.test.ts:15 | vfs: { version: 1, database: { getConnSafe: () => db.executor, blobsDir: () => '.' } } |
| vfsRepo | host/plugins/agent-workspace/tests/vfs-resolver-wiring.test.ts:16 | vfsRepo: { files: { getContent }, blobs: {} } |
| docs | host/plugins/agent-workspace/tests/vfs-resolver-wiring.test.ts:25 | provides: ['docs'] |
| docs | host/plugins/agent-workspace/tests/vfs-resolver-wiring.test.ts:26 | ctx.provide('docs', { extractTextFromBase64: parse }) |
| docs | host/plugins/anki/tests/anki-generation-commands.test.ts:127 | docs: docsDouble |
| ankiGeneration@1 | host/plugins/anki/tests/anki-generation-commands.test.ts:127 | 'ankiGeneration@1': generationDouble |
| paths | host/plugins/anki/tests/env.ts:33 | paths: { appDataDir: dir, os: { temp: os.tmpdir() } } |
| storage | host/plugins/anki/tests/env.ts:34 | storage |
| llm.adapter-infos@1 | host/plugins/anki/tests/model-adapters.test.ts:22 | 'llm.adapter-infos@1': { listAdapterInfos: () => [...ADAPTER_INFOS] } |
| storage | host/plugins/backup/tests/jobs.test.ts:9 | storage: { locations: { activeDir: '/unused' } } |
| settings | host/plugins/backup/tests/jobs.test.ts:9 | settings: {} |
| secrets | host/plugins/backup/tests/jobs.test.ts:9 | secrets: {} |
| settings | host/plugins/browser/tests/feature-flag-commands.test.ts:21 | settings |
| log | host/plugins/browser/tests/feature-flag-commands.test.ts:21 | log: { logger: () => undefined } |
| storage | host/plugins/browser/tests/feature-flag-commands.test.ts:22 | storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } } |
| featureFlags | host/plugins/browser/tests/feature-flag-commands.test.ts:23 | featureFlags: { load: ( store: { getSetting(key: string): string \| null; saveSetting(key: string, value: string): void }, appVersion: string, options?: { debug?: boolean; userId?: string \| null }, ) => new FeatureFlagManager({ appVersion, debug: options?.debug ?? false, userId: options?.userId ?? null, }).loadFromDatabase({ get: key => store.getSet |
| settings | host/plugins/browser/tests/search-commands.test.ts:37 | settings |
| log | host/plugins/browser/tests/search-commands.test.ts:37 | log: { logger: () => undefined } |
| storage | host/plugins/browser/tests/search-commands.test.ts:38 | storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } } |
| featureFlags | host/plugins/browser/tests/search-commands.test.ts:39 | featureFlags: { load: () => { throw new Error('feature flags are not read by search commands'); }, save: () => undefined, } |
| log | host/plugins/browser/tests/settings.test.ts:12 | log: { logger: () => undefined } |
| storage | host/plugins/browser/tests/settings.test.ts:13 | storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } } |
| featureFlags | host/plugins/browser/tests/settings.test.ts:14 | featureFlags: { load: () => { throw new Error('feature flags are not read by setting commands'); }, save: () => undefined, } |
| settings | host/plugins/browser/tests/settings.test.ts:18 | settings: { get: (key: string) => values.get(key) ?? null, saveSecret: async (key: string, value: string) => { calls.push(['saveSecret', key, value]); values.set(key, value); }, getSecret: async (key: string) => { calls.push(['getSecret', key]); return values.get(key) ?? null; }, deleteSecret: async (key: string) => { calls.push(['deleteSecret', ke |
| log | host/plugins/browser/tests/settings.test.ts:61 | log: { logger: () => undefined } |
| storage | host/plugins/browser/tests/settings.test.ts:62 | storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } } |
| featureFlags | host/plugins/browser/tests/settings.test.ts:63 | featureFlags: { load: () => { throw new Error('feature flags are not read by setting commands'); }, save: () => undefined, } |
| settings | host/plugins/browser/tests/settings.test.ts:67 | settings: { get() { throw new Error('read failed'); }, async getSecret() { throw new Error('secure failed'); }, } |
| settings | host/plugins/browser/tests/tool-executor-execute.test.ts:151 | settings: new MemorySettings() |
| settings | host/plugins/browser/tests/tool-registration.test.ts:23 | settings |
| log | host/plugins/browser/tests/tool-registration.test.ts:24 | log: { logger: () => undefined } |
| storage | host/plugins/browser/tests/tool-registration.test.ts:25 | storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } } |
| featureFlags | host/plugins/browser/tests/tool-registration.test.ts:26 | featureFlags: { load: () => { throw new Error('feature flags are not read during registration'); }, save: () => undefined, } |
| agentTools | host/plugins/browser/tests/tool-registration.test.ts:30 | agentTools: { registerToolExecutors(executors: readonly AgentToolExecutor[]) { registered.push(...executors); }, } |
| storage | host/plugins/chat/tests/anki-blocks.test.ts:16 | storage: f.storage |
| vfs | host/plugins/chat/tests/anki-blocks.test.ts:16 | vfs: vfsStub |
| storage | host/plugins/chat/tests/approval.test.ts:80 | storage: f.storage |
| vfs | host/plugins/chat/tests/approval.test.ts:81 | vfs: vfsStub |
| settings | host/plugins/chat/tests/approval.test.ts:82 | settings: fakeSettings(state) |
| storage | host/plugins/chat/tests/approval.test.ts:176 | storage: f.storage |
| vfs | host/plugins/chat/tests/approval.test.ts:176 | vfs: vfsStub |
| settings | host/plugins/chat/tests/approval.test.ts:176 | settings: broken |
| agentApproval | host/plugins/chat/tests/approval.test.ts:176 | 'agentApproval': fakeApprovals(state) |
| storage | host/plugins/chat/tests/ask-user.test.ts:19 | storage: f.storage |
| vfs | host/plugins/chat/tests/ask-user.test.ts:19 | vfs: vfsStub |
| storage | host/plugins/chat/tests/branch.test.ts:32 | storage: f.storage |
| vfs | host/plugins/chat/tests/branch.test.ts:32 | vfs: vfsStub |
| storage | host/plugins/chat/tests/commands.test.ts:15 | storage: f.storage |
| vfs | host/plugins/chat/tests/commands.test.ts:15 | vfs: vfsStub |
| storage | host/plugins/chat/tests/compaction.test.ts:61 | storage: f.storage |
| vfs | host/plugins/chat/tests/compaction.test.ts:61 | vfs: vfsStub |
| storage | host/plugins/chat/tests/database-service.test.ts:17 | storage: f.storage |
| vfs | host/plugins/chat/tests/database-service.test.ts:17 | vfs: vfsStub |
| storage | host/plugins/chat/tests/deletion.test.ts:28 | storage: f.storage |
| vfs | host/plugins/chat/tests/deletion.test.ts:28 | vfs: vfsStub |
| storage | host/plugins/chat/tests/event-lifecycle.test.ts:9 | storage: f.storage |
| vfs | host/plugins/chat/tests/event-lifecycle.test.ts:9 | vfs: vfsStub |
| storage | host/plugins/chat/tests/event-lifecycle.test.ts:10 | storage: f.storage |
| vfs | host/plugins/chat/tests/event-lifecycle.test.ts:10 | vfs: vfsStub |
| storage | host/plugins/chat/tests/groups.test.ts:36 | storage: f.storage |
| vfs | host/plugins/chat/tests/groups.test.ts:36 | vfs |
| agentWorkspace | host/plugins/chat/tests/groups.test.ts:37 | agentWorkspace: { runtimeRootById: (id: string) => id === 'root_valid' ? { path: '/Users/test/root' } : null } |
| storage | host/plugins/chat/tests/kill-switch.test.ts:28 | storage: f.storage |
| vfs | host/plugins/chat/tests/kill-switch.test.ts:28 | vfs: vfsStub |
| storage | host/plugins/chat/tests/logger-lifecycle.test.ts:10 | storage: firstDb.storage |
| vfs | host/plugins/chat/tests/logger-lifecycle.test.ts:10 | vfs: vfsStub |
| storage | host/plugins/chat/tests/logger-lifecycle.test.ts:11 | storage: secondDb.storage |
| vfs | host/plugins/chat/tests/logger-lifecycle.test.ts:11 | vfs: vfsStub |
| storage | host/plugins/chat/tests/metadata-freeze.test.ts:14 | storage: f.storage |
| vfs | host/plugins/chat/tests/metadata-freeze.test.ts:14 | vfs: vfsStub |
| storage | host/plugins/chat/tests/migration.test.ts:85 | storage: f.storage |
| vfs | host/plugins/chat/tests/migration.test.ts:85 | vfs: vfsStub |
| storage | host/plugins/chat/tests/ocr.test.ts:25 | storage: f.storage |
| vfs | host/plugins/chat/tests/ocr.test.ts:25 | vfs: vfsStub |
| llm | host/plugins/chat/tests/ocr.test.ts:25 | llm |
| storage | host/plugins/chat/tests/plan-gate.test.ts:47 | storage: f.storage |
| vfs | host/plugins/chat/tests/plan-gate.test.ts:47 | vfs: vfsStub |
| chatPipeline | host/plugins/chat/tests/plan-gate.test.ts:47 | 'chatPipeline': { planGateManager: gates } |
| storage | host/plugins/chat/tests/plan-gate.test.ts:116 | storage: f.storage |
| vfs | host/plugins/chat/tests/plan-gate.test.ts:116 | vfs: vfsStub |
| storage | host/plugins/chat/tests/session-commands.test.ts:39 | storage: f.storage |
| vfs | host/plugins/chat/tests/session-commands.test.ts:39 | vfs: vfsStub |
| agentApproval | host/plugins/chat/tests/session-commands.test.ts:40 | agentApproval: { clearSessionRemembered(id: string) { clearedApprovals.push(id); } } |
| storage | host/plugins/chat/tests/session-commands.test.ts:440 | storage: f.storage |
| vfs | host/plugins/chat/tests/session-commands.test.ts:440 | vfs: vfsStub |
| storage | host/plugins/chat/tests/session-export.test.ts:32 | storage: f.storage |
| vfs | host/plugins/chat/tests/session-export.test.ts:32 | vfs: vfsStub |
| storage | host/plugins/chat/tests/snapshot.test.ts:20 | storage: f.storage |
| vfs | host/plugins/chat/tests/snapshot.test.ts:20 | vfs: vfsStub |
| storage | host/plugins/chat/tests/super-deletion.test.ts:15 | storage: f.storage |
| vfs | host/plugins/chat/tests/super-deletion.test.ts:15 | vfs: vfsStub |
| agentSubagent | host/plugins/chat/tests/super-deletion.test.ts:16 | agentSubagent: { onSessionRemoved(id: string, hard: boolean) { observations.push([id, hard, getSession(f.db, id)?.persistStatus ?? null, nextSessionSequenceId(id)]); } } |
| storage | host/plugins/chat/tests/variants.test.ts:40 | storage: f.storage |
| vfs | host/plugins/chat/tests/variants.test.ts:40 | vfs: vfsStub |
| storage | host/plugins/chat/tests/workspace-commands.test.ts:72 | storage: f.storage |
| vfs | host/plugins/chat/tests/workspace-commands.test.ts:72 | vfs: vfsStub |
| agentWorkspace | host/plugins/chat/tests/workspace-commands.test.ts:72 | agentWorkspace: coordinator.service |
| storage | host/plugins/chat/tests/workspace-profiles.test.ts:17 | storage: f.storage |
| vfs | host/plugins/chat/tests/workspace-profiles.test.ts:17 | vfs: vfsStub |
| agentWorkspace | host/plugins/chat/tests/workspace-profiles.test.ts:17 | agentWorkspace: { customAgentsDir: () => directory } |
| storage | host/plugins/chat-pipeline/tests/chat-host.ts:39 | storage |
| settings | host/plugins/chat-pipeline/tests/chat-host.ts:39 | settings |
| notes | host/plugins/chat-pipeline/tests/chat-host.ts:39 | notes: {} |
| settings | host/plugins/chatanki/tests/fsrs-settings.test.ts:78 | settings: { get: () => null, save: () => undefined } |
| review | host/plugins/chatanki/tests/fsrs-settings.test.ts:79 | review: scheduler |
| llm | host/plugins/chatanki/tests/fsrs-settings.test.ts:80 | llm: {} |
| anki | host/plugins/chatanki/tests/fsrs-settings.test.ts:81 | 'anki': {} |
| settings | host/plugins/chatanki/tests/fsrs-settings.test.ts:149 | settings: { get: () => null, save: () => undefined } |
| review | host/plugins/chatanki/tests/fsrs-settings.test.ts:150 | review: scheduler |
| llm | host/plugins/chatanki/tests/fsrs-settings.test.ts:151 | llm: {} |
| anki | host/plugins/chatanki/tests/fsrs-settings.test.ts:152 | 'anki': {} |
| settings | host/plugins/chatanki/tests/fsrs-settings.test.ts:175 | settings: { get: () => null, save: () => undefined } |
| review | host/plugins/chatanki/tests/fsrs-settings.test.ts:176 | review: {} |
| llm | host/plugins/chatanki/tests/fsrs-settings.test.ts:177 | llm: {} |
| anki | host/plugins/chatanki/tests/fsrs-settings.test.ts:178 | 'anki': {} |
| paths | host/plugins/chatanki/tests/real-host-wiring.test.ts:33 | paths: { appDataDir: dir, os: { home: dir, data: dir, temp: os.tmpdir() }, } |
| settings | host/plugins/chatanki/tests/real-host-wiring.test.ts:37 | settings: { get: () => null, save: () => undefined, getSetting: () => null, saveSetting: () => undefined, } |
| llm | host/plugins/chatanki/tests/real-host-wiring.test.ts:43 | llm: {} |
| storage | host/plugins/chatanki/tests/real-host-wiring.test.ts:44 | storage |
| paths | host/plugins/chatanki/tests/real-review-enqueue.test.ts:50 | paths: { appDataDir: dir, os: { home: dir, data: dir, temp: os.tmpdir() }, } |
| settings | host/plugins/chatanki/tests/real-review-enqueue.test.ts:54 | settings: { get: () => null, save: () => undefined, getSetting: () => null, saveSetting: () => undefined, } |
| llm | host/plugins/chatanki/tests/real-review-enqueue.test.ts:60 | llm: {} |
| storage | host/plugins/chatanki/tests/real-review-enqueue.test.ts:61 | storage |
| settings | host/plugins/chatanki/tests/review-tools.test.ts:30 | settings: { get: () => null, save: () => undefined } |
| review | host/plugins/chatanki/tests/review-tools.test.ts:31 | review: { getStats: () => stats() } |
| llm | host/plugins/chatanki/tests/review-tools.test.ts:32 | llm: {} |
| anki | host/plugins/chatanki/tests/review-tools.test.ts:33 | 'anki': {} |
| settings | host/plugins/chatanki/tests/review-tools.test.ts:66 | settings: { get: () => null, save: () => undefined } |
| review | host/plugins/chatanki/tests/review-tools.test.ts:67 | review: {} |
| llm | host/plugins/chatanki/tests/review-tools.test.ts:68 | llm: {} |
| anki | host/plugins/chatanki/tests/review-tools.test.ts:69 | 'anki': {} |
| settings | host/plugins/chatanki/tests/review-tools.test.ts:92 | settings: { get: () => null, save: () => undefined } |
| review | host/plugins/chatanki/tests/review-tools.test.ts:93 | review: {} |
| llm | host/plugins/chatanki/tests/review-tools.test.ts:94 | llm: {} |
| anki | host/plugins/chatanki/tests/review-tools.test.ts:95 | 'anki': { checkAnkiConnectAvailability: async () => true } |
| settings | host/plugins/chatanki/tests/review-tools.test.ts:109 | settings: { get: () => null, save: () => undefined } |
| review | host/plugins/chatanki/tests/review-tools.test.ts:110 | review: {} |
| llm | host/plugins/chatanki/tests/review-tools.test.ts:111 | llm: {} |
| anki | host/plugins/chatanki/tests/review-tools.test.ts:112 | 'anki': { checkAnkiConnectAvailability: async () => { throw new Error('connection refused'); }, } |
| settings | host/plugins/chatanki/tests/review-tools.test.ts:130 | settings: { get: () => null, save: () => undefined } |
| review | host/plugins/chatanki/tests/review-tools.test.ts:131 | review: {} |
| llm | host/plugins/chatanki/tests/review-tools.test.ts:132 | llm: {} |
| anki | host/plugins/chatanki/tests/review-tools.test.ts:133 | 'anki': {} |
| paths | host/plugins/integration/tests/crypto-verifier.test.ts:26 | paths: { os: {} } |
| log | host/plugins/integration/tests/crypto-verifier.test.ts:26 | log: { logger: () => logger } |
| storage | host/plugins/integration/tests/sync-conflict-fast-path.test.ts:30 | storage |
| paths | host/plugins/integration/tests/sync-conflict-fast-path.test.ts:31 | paths: { deviceId: async () => 'test-device' } |
| storage | host/plugins/integration/tests/sync-conflict-fast-path.test.ts:61 | storage |
| paths | host/plugins/integration/tests/sync-conflict-fast-path.test.ts:62 | paths: { deviceId: async () => 'test-device' } |
| storage | host/plugins/integration/tests/sync-history-e2e.test.ts:59 | storage: storageFor(db, dir) |
| paths | host/plugins/integration/tests/sync-history-e2e.test.ts:60 | paths: { deviceId: async () => 'device-local' } |
| notes | host/plugins/integration/tests/sync-history-e2e.test.ts:63 | notes: {} |
| secrets | host/plugins/integration/tests/sync-r12-locks.test.ts:662 | secrets: { backup: backupCrypto, openStore() { return { async getCloudCredentials() { return { ...credentials }; } }; }, } |
| backup | host/plugins/integration/tests/sync-r12-locks.test.ts:668 | backup: backupServiceStub(() => credentials) |
| secrets | host/plugins/integration/tests/webdav-contract.test.ts:84 | secrets: { backup: createBackupCrypto(), openStore() { return { async getCloudCredentials() { return { webdavPassword: 'secret' }; } }; }, } |
| backup | host/plugins/integration/tests/webdav-contract.test.ts:90 | backup: backupServiceStub(() => ({ webdavPassword: 'secret' })) |
| settings | host/plugins/llm/tests/anki_routing_service.test.ts:9 | settings: {} |
| secrets | host/plugins/llm/tests/anki_routing_service.test.ts:9 | secrets: {} |
| settings | host/plugins/llm/tests/anki_routing_service.test.ts:26 | settings: {} |
| secrets | host/plugins/llm/tests/anki_routing_service.test.ts:26 | secrets: {} |
| settings | host/plugins/llm/tests/config_decode.test.ts:10 | settings: { get: (key: string) => settings.get(key) ?? null, save: (key: string, value: string) => settings.set(key, value), getSecret: async () => null } |
| secrets | host/plugins/llm/tests/config_decode.test.ts:11 | secrets: { isEncryptedFormat: () => false } |
| settings | host/plugins/llm/tests/control.test.ts:16 | settings: { get: () => null } |
| secrets | host/plugins/llm/tests/control.test.ts:16 | secrets: secretsStub |
| settings | host/plugins/llm/tests/control.test.ts:25 | settings: {} |
| secrets | host/plugins/llm/tests/control.test.ts:25 | secrets: secretsStub |
| log | host/plugins/llm/tests/control.test.ts:26 | log: { logger: () => logger } |
| settings | host/plugins/llm/tests/control.test.ts:76 | settings: { get: () => raw } |
| secrets | host/plugins/llm/tests/control.test.ts:76 | secrets: secretsStub |
| settings | host/plugins/llm/tests/control.test.ts:84 | settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => { values.set(key, value); }, } |
| secrets | host/plugins/llm/tests/control.test.ts:87 | secrets: secretsStub |
| settings | host/plugins/llm/tests/control.test.ts:96 | settings: { get: () => { throw new Error('disk error'); }, save: () => { throw new Error('disk error'); }, } |
| secrets | host/plugins/llm/tests/control.test.ts:98 | secrets: secretsStub |
| settings | host/plugins/llm/tests/control.test.ts:106 | settings: { get: (key: string) => { if (key === 'llm_failover_policy') return '{'; throw new Error('disk unavailable'); } } |
| secrets | host/plugins/llm/tests/control.test.ts:107 | secrets: secretsStub |
| log | host/plugins/llm/tests/control.test.ts:108 | log: { logger: () => ({ info: () => {}, debug: () => {}, warn: (text: string) => warnings.push(text), error: (text: string) => errors.push(text) }) } |
| settings | host/plugins/llm/tests/embedding_service.test.ts:12 | settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => values.set(key, value) } |
| secrets | host/plugins/llm/tests/embedding_service.test.ts:12 | secrets: {} |
| storage | host/plugins/llm/tests/essay_grading_service.test.ts:30 | storage |
| nativeTokenizer | host/plugins/llm/tests/essay_grading_service.test.ts:30 | nativeTokenizer: tokenizer |
| nativeImage | host/plugins/llm/tests/essay_grading_service.test.ts:30 | nativeImage: image |
| vfsDatabase | host/plugins/llm/tests/essay_grading_service.test.ts:30 | vfsDatabase: { getConnSafe: () => storage.database('vfs') } |
| llmAdapters | host/plugins/llm/tests/essay_grading_service.test.ts:31 | llmAdapters: { createAdapter: () => new OpenAIAdapter() } |
| settings | host/plugins/llm/tests/essay_grading_service.test.ts:32 | settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => values.set(key, value), getSecret: async () => null } |
| secrets | host/plugins/llm/tests/essay_grading_service.test.ts:34 | secrets: { isEncryptedFormat: () => false } |
| notes | host/plugins/llm/tests/essay_grading_service.test.ts:36 | 'notes': {} |
| vfsDatabase | host/plugins/llm/tests/host.ts:8 | vfsDatabase: {} |
| vfsRepo | host/plugins/llm/tests/host.ts:8 | 'vfsRepo': { essays: {} } |
| llmAdapters | host/plugins/llm/tests/host.ts:8 | llmAdapters: {} |
| nativeTokenizer | host/plugins/llm/tests/host.ts:8 | nativeTokenizer: tokenizer |
| nativeImage | host/plugins/llm/tests/host.ts:8 | nativeImage: image |
| settings | host/plugins/llm/tests/model2_messages_service.test.ts:9 | settings: {} |
| secrets | host/plugins/llm/tests/model2_messages_service.test.ts:9 | secrets: {} |
| settings | host/plugins/llm/tests/model2_messages_service.test.ts:34 | settings: {} |
| secrets | host/plugins/llm/tests/model2_messages_service.test.ts:34 | secrets: {} |
| settings | host/plugins/llm/tests/model2_stream_events_service.test.ts:8 | settings: {} |
| secrets | host/plugins/llm/tests/model2_stream_events_service.test.ts:8 | secrets: {} |
| settings | host/plugins/llm/tests/model2_stream_events_service.test.ts:32 | settings: {} |
| secrets | host/plugins/llm/tests/model2_stream_events_service.test.ts:32 | secrets: {} |
| settings | host/plugins/llm/tests/ocr_hedge_service.test.ts:22 | settings: {} |
| secrets | host/plugins/llm/tests/ocr_hedge_service.test.ts:22 | secrets: {} |
| llmAdapters | host/plugins/llm/tests/ocr_hedge_service.test.ts:23 | llmAdapters: { createAdapter: () => new OpenAIAdapter() } |
| settings | host/plugins/llm/tests/ocr_models_service.test.ts:14 | settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => values.set(key, value) } |
| secrets | host/plugins/llm/tests/ocr_models_service.test.ts:15 | secrets: {} |
| settings | host/plugins/llm/tests/ocr_regions_service.test.ts:9 | settings: {} |
| secrets | host/plugins/llm/tests/ocr_regions_service.test.ts:9 | secrets: {} |
| nativeImage | host/plugins/llm/tests/ocr_regions_service.test.ts:10 | nativeImage: { dimensions: async () => ({ width: 999, height: 999 }) } |
| settings | host/plugins/llm/tests/provider_requests_service.test.ts:11 | settings: {} |
| secrets | host/plugins/llm/tests/provider_requests_service.test.ts:11 | secrets: {} |
| llmAdapters | host/plugins/llm/tests/provider_requests_service.test.ts:12 | llmAdapters: { createAdapter: () => new OpenAIResponsesAdapter() } |
| log | host/plugins/llm/tests/provider_requests_service.test.ts:12 | log: { logger: () => logger } |
| settings | host/plugins/llm/tests/question_parsing_service.test.ts:27 | settings: {} |
| secrets | host/plugins/llm/tests/question_parsing_service.test.ts:27 | secrets: {} |
| llmAdapters | host/plugins/llm/tests/question_parsing_service.test.ts:27 | llmAdapters: { createAdapter: () => new OpenAIAdapter() } |
| settings | host/plugins/llm/tests/rag_extension.test.ts:32 | settings: { get: () => null } |
| secrets | host/plugins/llm/tests/rag_extension.test.ts:32 | secrets: {} |
| llmAdapters | host/plugins/llm/tests/rag_extension.test.ts:32 | llmAdapters: { createAdapter: () => new OpenAIAdapter() } |
| settings | host/plugins/llm/tests/recovery.test.ts:79 | settings |
| secrets | host/plugins/llm/tests/recovery.test.ts:79 | secrets: secretsStub() |
| settings | host/plugins/llm/tests/recovery.test.ts:98 | settings |
| secrets | host/plugins/llm/tests/recovery.test.ts:98 | secrets: secretsStub() |
| settings | host/plugins/llm/tests/recovery.test.ts:127 | settings |
| secrets | host/plugins/llm/tests/recovery.test.ts:127 | secrets: secretsStub() |
| settings | host/plugins/llm/tests/recovery.test.ts:142 | settings |
| secrets | host/plugins/llm/tests/recovery.test.ts:142 | secrets: secretsStub() |
| settings | host/plugins/llm/tests/recovery.test.ts:151 | settings |
| secrets | host/plugins/llm/tests/recovery.test.ts:151 | secrets: secretsStub() |
| settings | host/plugins/llm/tests/streaming_service.test.ts:25 | settings: { get: () => null } |
| secrets | host/plugins/llm/tests/streaming_service.test.ts:25 | secrets: {} |
| llmAdapters | host/plugins/llm/tests/streaming_service.test.ts:25 | llmAdapters: { createAdapter: () => new OpenAIAdapter() } |
| settings | host/plugins/llm/tests/tokens_command.test.ts:7 | settings: {} |
| secrets | host/plugins/llm/tests/tokens_command.test.ts:7 | secrets: {} |
| settings | host/plugins/llm/tests/vendor_models.test.ts:190 | settings |
| secrets | host/plugins/llm/tests/vendor_models.test.ts:191 | secrets: { isEncryptedFormat: () => false, openCrypto: async () => { throw new Error('unused'); } } |
| settings | host/plugins/llm-providers/tests/codex-auth-service.test.ts:56 | settings |
| settings | host/plugins/llm-providers/tests/codex-auth-service.test.ts:61 | settings |
| settings | host/plugins/llm-providers/tests/codex-commands.test.ts:25 | settings |
| settings | host/plugins/llm-providers/tests/remote-image.test.ts:47 | settings: new MemorySettings() |
| settings | host/plugins/llm-providers/tests/services.test.ts:28 | settings: new MemorySettings() |
| settings | host/plugins/mcp/tests/bridge.test.ts:16 | settings: { get: () => null, save: () => undefined } |
| secrets | host/plugins/mcp/tests/bridge.test.ts:17 | secrets: { openStore: () => ({ saveSecret: async () => undefined, getSecret: async () => null, deleteSecret: async () => undefined, }), } |
| llm | host/plugins/mcp/tests/bridge.test.ts:24 | llm: {} |
| log | host/plugins/mcp/tests/bridge.test.ts:25 | log: { logger: () => undefined } |
| webSearch | host/plugins/mcp/tests/bridge.test.ts:26 | webSearch: { doSearch: async () => ({ name: 'web_search', ok: true, result: { raw: {}, provider: 'none' }, citations: [], }), } |
| settings | host/plugins/mcp/tests/config.test.ts:12 | settings: { get: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => { writes.push([key, value]); values.set(key, value); }, } |
| secrets | host/plugins/mcp/tests/config.test.ts:16 | secrets: { openStore: () => ({ saveSecret: async () => undefined, getSecret: async () => null, deleteSecret: async () => undefined, }), } |
| llm | host/plugins/mcp/tests/config.test.ts:23 | llm: {} |
| log | host/plugins/mcp/tests/config.test.ts:24 | log: { logger: () => undefined } |
| webSearch | host/plugins/mcp/tests/config.test.ts:25 | webSearch: { doSearch: async () => ({ name: 'web_search', ok: true, result: { raw: {}, provider: 'none' }, citations: [], }), } |
| settings | host/plugins/mcp/tests/sse-command.test.ts:11 | settings: { get: () => null, save: () => undefined } |
| secrets | host/plugins/mcp/tests/sse-command.test.ts:12 | secrets: { openStore: () => ({ saveSecret: async () => undefined, getSecret: async () => null, deleteSecret: async () => undefined, }), } |
| llm | host/plugins/mcp/tests/sse-command.test.ts:19 | llm: {} |
| log | host/plugins/mcp/tests/sse-command.test.ts:20 | log: { logger: () => undefined } |
| webSearch | host/plugins/mcp/tests/sse-command.test.ts:21 | webSearch: { doSearch: async () => ({ name: 'web_search', ok: true, result: { raw: {}, provider: 'none' }, citations: [], }), } |
| settings | host/plugins/mcp/tests/tool-cache-commands.test.ts:30 | settings: { get: () => null, save: () => undefined } |
| secrets | host/plugins/mcp/tests/tool-cache-commands.test.ts:31 | secrets: { openStore: () => ({ saveSecret: async () => undefined, getSecret: async () => null, deleteSecret: async () => undefined, }), } |
| llm | host/plugins/mcp/tests/tool-cache-commands.test.ts:38 | llm: options.llm ?? llmPort() |
| log | host/plugins/mcp/tests/tool-cache-commands.test.ts:39 | log: { logger: () => undefined } |
| webSearch | host/plugins/mcp/tests/tool-cache-commands.test.ts:40 | webSearch: { doSearch: async () => ({ name: 'web_search', ok: true, result: { raw: {}, provider: 'none' }, citations: [], }), } |
| settings | host/plugins/media/tests/bilibili-account.test.ts:236 | settings: { get: () => null, save: () => undefined } |
| secrets | host/plugins/media/tests/bilibili-account.test.ts:237 | secrets: { openStore: () => store } |
| settings | host/plugins/media/tests/bilibili-account.test.ts:251 | settings: { get: () => null, save: () => undefined } |
| settings | host/plugins/media/tests/bilibili-account.test.ts:331 | settings: { get: () => null, save: () => undefined } |
| secrets | host/plugins/media/tests/bilibili-account.test.ts:332 | secrets: { openStore: () => store } |
| settings | host/plugins/media/tests/bilibili-bridge-commands.test.ts:10 | settings: settings() |
| settings | host/plugins/media/tests/bilibili-bridge-commands.test.ts:27 | settings: settings() |
| settings | host/plugins/media/tests/bilibili-bridge-commands.test.ts:52 | settings: settings() |
| settings | host/plugins/media/tests/bilibili-commands.test.ts:28 | settings: settings() |
| secrets | host/plugins/media/tests/bilibili-commands.test.ts:28 | secrets: secrets() |
| settings | host/plugins/media/tests/bilibili-commands.test.ts:48 | settings: settings() |
| secrets | host/plugins/media/tests/bilibili-commands.test.ts:48 | secrets: secrets() |
| settings | host/plugins/media/tests/bilibili-commands.test.ts:62 | settings: settings() |
| secrets | host/plugins/media/tests/bilibili-commands.test.ts:62 | secrets: secrets() |
| settings | host/plugins/media/tests/bilibili-tasks.test.ts:10 | settings: { get: () => null, save: () => undefined } |
| settings | host/plugins/media/tests/bilibili-transport.test.ts:183 | settings: store |
| settings | host/plugins/media/tests/document-tasks.test.ts:43 | settings: { get: () => null, save: () => undefined } |
| storage | host/plugins/media/tests/document-tasks.test.ts:44 | storage: { database: (name: string) => storage.database(name as 'mistakes') } |
| settings | host/plugins/media/tests/exam-sheet.test.ts:358 | settings: { get: () => null, save: () => {} } |
| vfsDatabase | host/plugins/media/tests/exam-sheet.test.ts:359 | vfsDatabase: { getConnSafe: () => conn } |
| vfsRepo | host/plugins/media/tests/exam-sheet.test.ts:360 | vfsRepo: repos |
| nativeImage | host/plugins/media/tests/exam-sheet.test.ts:361 | nativeImage |
| paths | host/plugins/media/tests/exam-sheet.test.ts:362 | paths: { appDataDir: root } |
| settings | host/plugins/media/tests/image-base64.test.ts:30 | settings: settings() |
| paths | host/plugins/media/tests/image-base64.test.ts:30 | paths: { appDataDir: root } |
| settings | host/plugins/media/tests/media-commands.test.ts:76 | settings: settings() |
| vfsDatabase | host/plugins/media/tests/media-commands.test.ts:77 | vfsDatabase: database |
| nativeAudio | host/plugins/media/tests/media-commands.test.ts:78 | nativeAudio |
| vfsRepo | host/plugins/media/tests/media-commands.test.ts:79 | 'vfsRepo': repos |
| notes | host/plugins/media/tests/media-commands.test.ts:80 | 'notes': { repository: { getNoteContent: (id: string) => noteContents.get(id) ?? null, }, } |
| settings | host/plugins/media/tests/ocr-settings.test.ts:444 | settings: store |
| settings | host/plugins/media/tests/ocr-settings.test.ts:512 | settings: { get() { throw new Error('db failure'); }, save() { throw new Error('db failure'); }, } |
| settings | host/plugins/media/tests/ocr-settings.test.ts:540 | settings: store |
| llm | host/plugins/media/tests/ocr-settings.test.ts:541 | llm: { getApiConfigs: async () => [ { id: 'sf', baseUrl: 'https://api.siliconflow.cn/v1', model: 'zai-org/GLM-4.6V' }, { id: 'sf-new', baseUrl: 'https://api.siliconflow.cn/v1', model: 'zai-org/GLM-4.6V' }, { id: 'keep', baseUrl: 'https://api.example.com/v1', model: 'Qwen/Qwen2.5-VL-7B-Instruct' }, ], } |
| settings | host/plugins/media/tests/pdf-ocr.test.ts:34 | settings: settings() |
| settings | host/plugins/media/tests/plugin.test.ts:11 | settings: settings(values) |
| settings | host/plugins/media/tests/plugin.test.ts:38 | settings: { get() { throw new Error('db failure'); }, save() { throw new Error('db failure'); }, } |
| settings | host/plugins/media/tests/vfs-blob-path.test.ts:38 | settings: settings() |
| vfsDatabase | host/plugins/media/tests/vfs-blob-path.test.ts:38 | vfsDatabase |
| settings | host/plugins/media/tests/vfs-blob-path.test.ts:52 | settings: settings() |
| vfsDatabase | host/plugins/media/tests/vfs-blob-path.test.ts:52 | vfsDatabase: database(dir, sql => sql.includes('FROM files') ? null : undefined) |
| settings | host/plugins/media/tests/vfs-blob-path.test.ts:64 | settings: settings() |
| vfsDatabase | host/plugins/media/tests/vfs-blob-path.test.ts:64 | vfsDatabase: database(dir, () => null) |
| settings | host/plugins/media/tests/vfs-blob-path.test.ts:72 | settings: settings() |
| vfsDatabase | host/plugins/media/tests/vfs-blob-path.test.ts:72 | vfsDatabase: database(dir, sql => sql.includes('FROM files') ? 'abcdef' : undefined) |
| settings | host/plugins/media/tests/vfs-blob-path.test.ts:82 | settings: settings() |
| vfsDatabase | host/plugins/media/tests/vfs-blob-path.test.ts:82 | vfsDatabase: database(dir, sql => sql.includes('FROM files') ? 'abcdef' : 'ab/abcdef.pdf') |
| settings | host/plugins/media/tests/vfs-blob-path.test.ts:94 | settings: settings() |
| settings | host/plugins/media/tests/vfs-blob-path.test.ts:103 | settings: settings() |
| vfsDatabase | host/plugins/media/tests/vfs-blob-path.test.ts:103 | vfsDatabase: failingDatabase('boom') |
| settings | host/plugins/media/tests/vfs-blob-path.test.ts:114 | settings: settings() |
| vfsDatabase | host/plugins/media/tests/vfs-blob-path.test.ts:115 | vfsDatabase: { getConnSafe: () => ({ pluck: () => { throw new Error('files broken'); }, }) as unknown as SqlExecutor, blobsDir: () => '/nonexistent', } as unknown as VfsDatabase |
| settings | host/plugins/media/tests/vfs-blob-path.test.ts:132 | settings: settings() |
| vfsDatabase | host/plugins/media/tests/vfs-blob-path.test.ts:133 | vfsDatabase: { getConnSafe: () => ({ pluck: (sql: string) => { if (sql.includes('FROM files')) return 'abcdef'; throw new Error('blobs broken'); }, }) as unknown as SqlExecutor, blobsDir: () => '/nonexistent', } as unknown as VfsDatabase |
| settings | host/plugins/media/tests/voice-input.test.ts:350 | settings: service |
| llm | host/plugins/media/tests/voice-input.test.ts:351 | llm: fakeLlm([apiConfig('voice-asr', `${server.url}/v1`)], null) |
| settings | host/plugins/media/tests/voice-input.test.ts:375 | settings: service |
| llm | host/plugins/media/tests/voice-input.test.ts:376 | llm: fakeLlm([], null) |
| settings | host/plugins/media/tests/voice-input.test.ts:391 | settings: service |
| llm | host/plugins/media/tests/voice-input.test.ts:391 | llm: fakeLlm([], null) |
| storage | host/plugins/memory/tests/config.test.ts:32 | storage |
| notes | host/plugins/memory/tests/config.test.ts:32 | 'notes': createNotesDouble(db) |
| vfsRepo | host/plugins/memory/tests/config.test.ts:33 | 'vfsRepo': createReposDouble() |
| retrieval | host/plugins/memory/tests/config.test.ts:34 | 'retrieval': createRetrievalDouble(db) |
| vfsIndex | host/plugins/memory/tests/config.test.ts:34 | 'vfsIndex': createIndexDouble() |
| log | host/plugins/memory/tests/config.test.ts:35 | log: createLogDouble([]) |
| settings | host/plugins/memory/tests/config.test.ts:36 | settings: createSettingsDouble(db) |
| storage | host/plugins/memory/tests/insight-jobs.test.ts:29 | storage |
| notes | host/plugins/memory/tests/insight-jobs.test.ts:29 | 'notes': createNotesDouble(db) |
| vfsRepo | host/plugins/memory/tests/insight-jobs.test.ts:30 | 'vfsRepo': createReposDouble() |
| retrieval | host/plugins/memory/tests/insight-jobs.test.ts:31 | 'retrieval': createRetrievalDouble(db) |
| vfsIndex | host/plugins/memory/tests/insight-jobs.test.ts:31 | 'vfsIndex': createIndexDouble() |
| log | host/plugins/memory/tests/insight-jobs.test.ts:32 | log: createLogDouble([]) |
| settings | host/plugins/memory/tests/insight-jobs.test.ts:33 | settings: createSettingsDouble(db) |
| storage | host/plugins/memory/tests/support.ts:589 | storage |
| notes | host/plugins/memory/tests/support.ts:589 | 'notes': notes |
| vfsRepo | host/plugins/memory/tests/support.ts:590 | 'vfsRepo': repos |
| retrieval | host/plugins/memory/tests/support.ts:590 | 'retrieval': retrieval |
| vfsIndex | host/plugins/memory/tests/support.ts:591 | 'vfsIndex': index |
| log | host/plugins/memory/tests/support.ts:591 | log: createLogDouble(warnings) |
| settings | host/plugins/memory/tests/support.ts:592 | settings: createSettingsDouble(db) |
| storage | host/plugins/qbank/tests/authoring-copy.test.ts:75 | storage |
| paths | host/plugins/qbank/tests/authoring-copy.test.ts:76 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/authoring.test.ts:26 | storage |
| paths | host/plugins/qbank/tests/authoring.test.ts:27 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/csv-export.test.ts:32 | storage: {} |
| paths | host/plugins/qbank/tests/csv-export.test.ts:32 | paths: { deviceId: async () => 'qbank-test-device' } |
| storage | host/plugins/qbank/tests/exam-sheet-sessions.test.ts:24 | storage |
| paths | host/plugins/qbank/tests/exam-sheet-sessions.test.ts:25 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/export.test.ts:25 | storage |
| paths | host/plugins/qbank/tests/export.test.ts:26 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/generation-tasks.test.ts:79 | storage |
| paths | host/plugins/qbank/tests/generation-tasks.test.ts:80 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/generation-tasks.test.ts:108 | storage |
| paths | host/plugins/qbank/tests/generation-tasks.test.ts:109 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/grading-images.test.ts:34 | storage |
| paths | host/plugins/qbank/tests/grading-images.test.ts:35 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/grading-pipeline.test.ts:58 | storage |
| paths | host/plugins/qbank/tests/grading-pipeline.test.ts:59 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/import-sessions.test.ts:29 | storage |
| paths | host/plugins/qbank/tests/import-sessions.test.ts:30 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/legacy.test.ts:42 | storage |
| paths | host/plugins/qbank/tests/legacy.test.ts:43 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/management.test.ts:27 | storage |
| paths | host/plugins/qbank/tests/management.test.ts:28 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/mastery-submit.test.ts:32 | storage |
| paths | host/plugins/qbank/tests/mastery-submit.test.ts:33 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/misc-commands.test.ts:24 | storage |
| paths | host/plugins/qbank/tests/misc-commands.test.ts:25 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| docs | host/plugins/qbank/tests/misc-commands.test.ts:28 | docs: { extractTextFromBase64: async () => ' 第一段文字。 第二段文字。 ', } |
| storage | host/plugins/qbank/tests/practice.test.ts:28 | storage |
| paths | host/plugins/qbank/tests/practice.test.ts:29 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| llm | host/plugins/qbank/tests/practice.test.ts:32 | llm: { gradePracticeSnapshot: () => new Promise<never>(() => undefined) } |
| storage | host/plugins/qbank/tests/questions.test.ts:26 | storage |
| paths | host/plugins/qbank/tests/questions.test.ts:27 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/questions.test.ts:54 | storage |
| paths | host/plugins/qbank/tests/questions.test.ts:55 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/reparse.test.ts:61 | storage |
| paths | host/plugins/qbank/tests/reparse.test.ts:62 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/source-view.test.ts:21 | storage |
| paths | host/plugins/qbank/tests/source-view.test.ts:22 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/statistics.test.ts:25 | storage |
| paths | host/plugins/qbank/tests/statistics.test.ts:26 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/qbank/tests/verdict-three-paths.test.ts:24 | storage |
| paths | host/plugins/qbank/tests/verdict-three-paths.test.ts:25 | paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin', env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }) |
| storage | host/plugins/review/tests/e2e-mastery-bias.test.ts:48 | storage: fixture.storage |
| storage | host/plugins/review/tests/foreign-commands.test.ts:146 | storage |
| essayGrading | host/plugins/review/tests/foreign-commands.test.ts:146 | essayGrading: essay.service |
| insight | host/plugins/review/tests/foreign-commands.test.ts:146 | insight: insight.service |
| storage | host/plugins/review/tests/foreign-commands.test.ts:303 | storage |
| storage | host/plugins/review/tests/fsrs-commands.test.ts:23 | storage: fixture.storage |
| storage | host/plugins/review/tests/mastery.test.ts:14 | storage: f.storage |
| storage | host/plugins/review/tests/mastery.test.ts:37 | storage: f.storage |
| masteryProfileSink | host/plugins/review/tests/mastery.test.ts:37 | masteryProfileSink: { upsertWeakPointFromMastery: (_db: unknown, concept: string) => { upserts.push(concept); }, removeWeakPointFromMastery: (_db: unknown, concept: string) => { removals.push(concept); }, } |
| storage | host/plugins/review/tests/review-plan.test.ts:65 | storage: fixture.storage |
| vfsRepo | host/plugins/review/tests/review-plan.test.ts:65 | vfsRepo: createReviewPlanStore() |
| storage | host/plugins/review/tests/review-plan.test.ts:85 | storage: fixture.storage |
| vfsRepo | host/plugins/review/tests/review-plan.test.ts:85 | vfsRepo: createReviewPlanStore() |
| storage | host/plugins/review/tests/review-plan.test.ts:109 | storage: fixture.storage |
| vfsRepo | host/plugins/review/tests/review-plan.test.ts:109 | vfsRepo: createReviewPlanStore() |
| storage | host/plugins/review/tests/review-plan.test.ts:145 | storage: fixture.storage |
| vfsRepo | host/plugins/review/tests/review-plan.test.ts:145 | vfsRepo: createReviewPlanStore() |
| storage | host/plugins/review/tests/study-time.test.ts:41 | storage |
| storage | host/plugins/sync/tests/apply-databases-api.test.ts:24 | storage |
| paths | host/plugins/sync/tests/apply-databases-api.test.ts:24 | paths: { deviceId: async () => 'local' } |
| syncSupport | host/plugins/sync/tests/apply-databases-api.test.ts:24 | syncSupport: { state: { setCursor: ack } } |
| storage | host/plugins/sync/tests/change-upload.test.ts:18 | storage: {} |
| paths | host/plugins/sync/tests/change-upload.test.ts:18 | paths: {} |
| syncSupport | host/plugins/sync/tests/change-upload.test.ts:18 | syncSupport: { state: { bindInstance: () => undefined, nextUploadSeq: () => 43n, markPublishedSeq: published, } } |
| storage | host/plugins/sync/tests/cloud-commands.test.ts:36 | storage: {} |
| paths | host/plugins/sync/tests/cloud-commands.test.ts:37 | paths: { deviceId: async () => 'test-device' } |
| backup | host/plugins/sync/tests/cloud-commands.test.ts:38 | backup: { hydrateCloudConfig: async () => undefined } |
| syncProvider | host/plugins/sync/tests/cloud-commands.test.ts:39 | syncProvider: provider |
| vfsDatabase | host/plugins/sync/tests/cloud-commands.test.ts:40 | vfsDatabase: { isInMaintenanceMode: () => maintenance } |
| storage | host/plugins/sync/tests/conflicts.test.ts:73 | storage |
| paths | host/plugins/sync/tests/conflicts.test.ts:73 | paths: { deviceId: async () => 'test-device' } |
| storage | host/plugins/sync/tests/conflicts.test.ts:85 | storage |
| paths | host/plugins/sync/tests/conflicts.test.ts:85 | paths: { deviceId: async () => 'test-device' } |
| storage | host/plugins/sync/tests/detect-conflicts.test.ts:63 | storage |
| paths | host/plugins/sync/tests/detect-conflicts.test.ts:64 | paths: { deviceId: async () => 'local-device' } |
| backup | host/plugins/sync/tests/detect-conflicts.test.ts:65 | backup: { hydrateCloudConfig: async () => undefined } |
| syncProvider | host/plugins/sync/tests/detect-conflicts.test.ts:66 | syncProvider: { createStorage: async () => { if (cloud === undefined) throw new Error('cloud transport not supplied in test'); return cloud as unknown as CloudStorage; } } |
| storage | host/plugins/sync/tests/detect-conflicts.test.ts:117 | storage |
| paths | host/plugins/sync/tests/detect-conflicts.test.ts:117 | paths: { deviceId: async () => 'local-device' } |
| storage | host/plugins/sync/tests/download-commit.test.ts:17 | storage: {} |
| paths | host/plugins/sync/tests/download-commit.test.ts:17 | paths: {} |
| syncSupport | host/plugins/sync/tests/download-commit.test.ts:17 | syncSupport: { state } |
| storage | host/plugins/sync/tests/download-commit.test.ts:37 | storage |
| paths | host/plugins/sync/tests/download-commit.test.ts:37 | paths: {} |
| storage | host/plugins/sync/tests/history.test.ts:79 | storage |
| paths | host/plugins/sync/tests/history.test.ts:79 | paths: { deviceId: async () => 'd' } |
| storage | host/plugins/sync/tests/history.test.ts:116 | storage |
| paths | host/plugins/sync/tests/history.test.ts:116 | paths: { deviceId: async () => 'd' } |
| storage | host/plugins/sync/tests/list-commands.test.ts:77 | storage |
| paths | host/plugins/sync/tests/list-commands.test.ts:77 | paths: { deviceId: async () => 'd' } |
| storage | host/plugins/sync/tests/lossless-json-api.test.ts:48 | storage |
| paths | host/plugins/sync/tests/lossless-json-api.test.ts:48 | paths: {} |
| storage | host/plugins/sync/tests/manifest-upload.test.ts:48 | storage: {} |
| paths | host/plugins/sync/tests/manifest-upload.test.ts:48 | paths: {} |
| syncSupport | host/plugins/sync/tests/manifest-upload.test.ts:48 | syncSupport: { state } |
| vfsDatabase | host/plugins/sync/tests/mutation-commands.test.ts:10 | vfsDatabase: { isInMaintenanceMode: () => maintenance } |
| storage | host/plugins/sync/tests/mutation-commands.test.ts:10 | storage: {} |
| paths | host/plugins/sync/tests/mutation-commands.test.ts:10 | paths: {} |
| mastery | host/plugins/sync/tests/mutation-commands.test.ts:10 | mastery: {} |
| notes | host/plugins/sync/tests/note-history.test.ts:55 | notes: undefined |
| vfsRepo | host/plugins/sync/tests/note-history.test.ts:55 | vfsRepo: undefined |
| paths | host/plugins/sync/tests/note-history.test.ts:55 | paths: { deviceId: async () => 'note-history-test' } |
| storage | host/plugins/sync/tests/note-history.test.ts:314 | storage: target.storage |
| notes | host/plugins/sync/tests/note-history.test.ts:314 | notes: undefined |
| vfsRepo | host/plugins/sync/tests/note-history.test.ts:314 | vfsRepo: undefined |
| paths | host/plugins/sync/tests/note-history.test.ts:314 | paths: { deviceId: async () => 'note-history-target' } |
| storage | host/plugins/sync/tests/plugin.test.ts:17 | storage: {} |
| paths | host/plugins/sync/tests/plugin.test.ts:17 | paths: { deviceId: async () => 'test-device' } |
| storage | host/plugins/sync/tests/plugin.test.ts:34 | storage |
| paths | host/plugins/sync/tests/plugin.test.ts:34 | paths: {} |
| storage | host/plugins/sync/tests/plugin.test.ts:49 | storage: {} |
| paths | host/plugins/sync/tests/plugin.test.ts:49 | paths: { deviceId: async () => 'test-device' } |
| storage | host/plugins/sync/tests/plugin.test.ts:84 | storage: {} |
| paths | host/plugins/sync/tests/plugin.test.ts:84 | paths: { deviceId: async () => 'test-device' } |
| storage | host/plugins/sync/tests/plugin.test.ts:90 | storage: {} |
| paths | host/plugins/sync/tests/plugin.test.ts:90 | paths: { deviceId: async () => 'test-device' } |
| storage | host/plugins/sync/tests/pomodoro-counts.test.ts:13 | storage: {} |
| paths | host/plugins/sync/tests/pomodoro-counts.test.ts:13 | paths: {} |
| storage | host/plugins/sync/tests/prune-gap.test.ts:31 | storage |
| paths | host/plugins/sync/tests/prune-gap.test.ts:32 | paths: { deviceId: async () => { order.push('device'); return 'reader'; } } |
| backup | host/plugins/sync/tests/prune-gap.test.ts:33 | backup: { hydrateCloudConfig: async () => { order.push('hydrate'); } } |
| syncProvider | host/plugins/sync/tests/prune-gap.test.ts:34 | syncProvider: { createStorage: async () => { order.push('transport'); return { providerName: () => 'memory', instanceBindingHint: () => 'root', get: async (key: string) => objects.get(key) ?? null, listOutcome: async (prefix: string) => ({ files: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false, }),  |
| syncSupport | host/plugins/sync/tests/prune-gap.test.ts:45 | syncSupport: { state: { bindInstance: (...args: unknown[]) => { bindings.push(args); }, cursors: (id: string) => { expect(id).toBe('instance-a'); return new Map([['peer', cursor]]); }, setCursor: () => { throw new Error('preflight must not acknowledge'); }, } } |
| storage | host/plugins/sync/tests/remote-protocol.test.ts:50 | storage: {} |
| paths | host/plugins/sync/tests/remote-protocol.test.ts:50 | paths: { deviceId: async () => 'reader' } |
| syncSupport | host/plugins/sync/tests/remote-protocol.test.ts:51 | syncSupport: { state: { bindInstance: () => undefined, cursors: (instance: string) => instanceCursors.get(instance) ?? new Map(), getCursor: (instance: string, device: string) => instanceCursors.get(instance)?.get(device) ?? 0n, isLegacyProcessed: () => false, setCursor: () => { throw new Error('download must not acknowledge unapplied records'); }, |
| backup | host/plugins/sync/tests/run-sync.test.ts:17 | backup: { hydrateCloudConfig: vi.fn(async () => undefined) } |
| paths | host/plugins/sync/tests/run-sync.test.ts:17 | paths: { deviceId: async () => 'device' } |
| syncProvider | host/plugins/sync/tests/run-sync.test.ts:18 | syncProvider: { createStorage, setStatusHook: vi.fn(), clearStatusHook: vi.fn(), setCancelToken: vi.fn(), clearCancelToken: vi.fn(), isSyncCancelled: () => false } |
| secrets | host/plugins/sync/tests/run-sync.test.ts:19 | secrets: { backup: createBackupCrypto() } |
| vfsDatabase | host/plugins/sync/tests/run-sync.test.ts:19 | vfsDatabase: { isInMaintenanceMode: () => false } |
| storage | host/plugins/sync/tests/run-sync.test.ts:20 | storage: { locations: { activeDir: 'unused-before-format-gate' } } |
| storage | host/plugins/sync/tests/status.test.ts:43 | storage |
| paths | host/plugins/sync/tests/status.test.ts:44 | paths: { deviceId: async () => 'device-status-test' } |
| backup | host/plugins/sync/tests/tombstone-commands.test.ts:40 | backup: { hydrateCloudConfig: vi.fn(async () => undefined) } |
| paths | host/plugins/sync/tests/tombstone-commands.test.ts:40 | paths: { deviceId: async () => 'device' } |
| syncProvider | host/plugins/sync/tests/tombstone-commands.test.ts:41 | syncProvider: { createStorage } |
| secrets | host/plugins/sync/tests/tombstone-commands.test.ts:41 | secrets: { backup: createBackupCrypto() } |
| vfsDatabase | host/plugins/sync/tests/unsynced-items.test.ts:98 | vfsDatabase: { isInMaintenanceMode: () => false } |
| storage | host/plugins/sync/tests/unsynced-items.test.ts:98 | storage: { locations: { activeDir: '/unused' } } |
| backup | host/plugins/sync/tests/unsynced-items.test.ts:99 | backup: { hydrateCloudConfig: async () => { calls.push('hydrate'); } } |
| paths | host/plugins/sync/tests/unsynced-items.test.ts:99 | paths: { deviceId: async () => { calls.push('identity'); return 'reader'; } } |
| secrets | host/plugins/sync/tests/unsynced-items.test.ts:100 | secrets: { backup: undefined } |
| syncProvider | host/plugins/sync/tests/unsynced-items.test.ts:100 | syncProvider: { createStorage: async () => { calls.push('storage'); throw new Error('offline'); } } |
| notes | host/plugins/sync-support/tests/plugin.test.ts:19 | notes |
| storage | host/plugins/sync-support/tests/plugin.test.ts:20 | storage: { database: (name: string) => { if (name !== 'sync_state') throw new Error(`unexpected database ${name}`); return db; }, } |
| storage | host/plugins/sync-support/tests/service-host.ts:12 | storage: { database: () => db } |
| notes | host/plugins/sync-support/tests/service-host.ts:12 | notes: createFakeNotes(db) |
| storage | host/plugins/translation/tests/c1_cross_lang.test.ts:50 | storage: { locations: { activeDir: '/unused' } } |
| settings | host/plugins/translation/tests/c1_cross_lang.test.ts:50 | settings: {} |
| secrets | host/plugins/translation/tests/c1_cross_lang.test.ts:50 | secrets: {} |
| llm | host/plugins/translation/tests/commands.test.ts:90 | llm |
| storage | host/plugins/vfs/tests/database.test.ts:31 | storage |
| storage | host/plugins/vfs/tests/dstu-content-search.test.ts:31 | storage |
| storage | host/plugins/vfs/tests/dstu-create.test.ts:32 | storage |
| storage | host/plugins/vfs/tests/dstu-get.test.ts:31 | storage |
| storage | host/plugins/vfs/tests/dstu-list.test.ts:31 | storage |
| storage | host/plugins/vfs/tests/dstu-update.test.ts:32 | storage |
| storage | host/plugins/vfs/tests/folders.test.ts:47 | storage |
| storage | host/plugins/vfs/tests/locations.test.ts:32 | storage |
| vfsMaintenance | host/plugins/vfs-handlers/tests/pending-maintenance-provider.ts:14 | provides: ['vfsMaintenance'] |
| vfsMaintenance | host/plugins/vfs-handlers/tests/pending-maintenance-provider.ts:51 | ctx.provide('vfsMaintenance', service) |
| storage | host/plugins/vfs-index/tests/commands.test.ts:91 | storage |
| vector | host/plugins/vfs-index/tests/commands.test.ts:91 | vector: { connect: (path: string) => engine.connect(path) } |
| storage | host/plugins/vfs-index/tests/commands.test.ts:104 | storage |
| vector | host/plugins/vfs-index/tests/commands.test.ts:104 | vector: { connect: (path: string) => engine.connect(path) } |
| storage | host/plugins/vfs-index/tests/commands.test.ts:119 | storage |
| vector | host/plugins/vfs-index/tests/commands.test.ts:119 | vector: { connect: (path: string) => engine.connect(path) } |
| storage | host/plugins/vfs-index/tests/commands.test.ts:137 | storage |
| vector | host/plugins/vfs-index/tests/commands.test.ts:137 | vector: { connect: (path: string) => engine.connect(path) } |
| storage | host/plugins/vfs-index/tests/commands.test.ts:154 | storage |
| vector | host/plugins/vfs-index/tests/commands.test.ts:154 | vector: { connect: (path: string) => engine.connect(path) } |
| storage | host/plugins/vfs-index/tests/commands.test.ts:168 | storage |
| storage | host/plugins/vfs-index/tests/commands.test.ts:185 | storage |
| storage | host/plugins/vfs-index/tests/commands.test.ts:202 | storage |
| vector | host/plugins/vfs-index/tests/commands.test.ts:202 | vector: { connect: (path: string) => engine.connect(path) } |
| storage | host/plugins/vfs-index/tests/commands.test.ts:214 | storage |
| vector | host/plugins/vfs-index/tests/commands.test.ts:214 | vector: { connect: (path: string) => engine.connect(path) } |
| storage | host/plugins/vfs-index/tests/commands.test.ts:234 | storage |
| vector | host/plugins/vfs-index/tests/commands.test.ts:234 | vector: { connect: (path: string) => engine.connect(path) } |
| storage | host/plugins/vfs-index/tests/commands.test.ts:250 | storage |
| storage | host/plugins/vfs-index/tests/unit-maintenance.test.ts:57 | storage |
| storage | host/plugins/vfs-repos/tests/attachments.test.ts:23 | storage |
| paths | host/plugins/vfs-repos/tests/attachments.test.ts:23 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/attachments.test.ts:23 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/blobs.test.ts:21 | storage |
| paths | host/plugins/vfs-repos/tests/blobs.test.ts:21 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/blobs.test.ts:21 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/embedding-dims.test.ts:19 | storage |
| paths | host/plugins/vfs-repos/tests/embedding-dims.test.ts:19 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/embedding-dims.test.ts:19 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/embedding-repo.test.ts:20 | storage |
| paths | host/plugins/vfs-repos/tests/embedding-repo.test.ts:20 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/embedding-repo.test.ts:20 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/essays.test.ts:19 | storage |
| paths | host/plugins/vfs-repos/tests/essays.test.ts:19 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/essays.test.ts:19 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/exams.test.ts:20 | storage |
| paths | host/plugins/vfs-repos/tests/exams.test.ts:20 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/exams.test.ts:20 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/files.test.ts:20 | storage |
| paths | host/plugins/vfs-repos/tests/files.test.ts:20 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/files.test.ts:20 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/folders.test.ts:50 | storage |
| paths | host/plugins/vfs-repos/tests/folders.test.ts:50 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/folders.test.ts:50 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/index-segments.test.ts:21 | storage |
| paths | host/plugins/vfs-repos/tests/index-segments.test.ts:21 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/index-segments.test.ts:21 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/index-units.test.ts:20 | storage |
| paths | host/plugins/vfs-repos/tests/index-units.test.ts:20 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/index-units.test.ts:20 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/maintenance.test.ts:22 | storage |
| paths | host/plugins/vfs-repos/tests/maintenance.test.ts:22 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/maintenance.test.ts:22 | notes: notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/media-transcripts.test.ts:20 | storage |
| paths | host/plugins/vfs-repos/tests/media-transcripts.test.ts:20 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/media-transcripts.test.ts:20 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/mindmaps.test.ts:20 | storage |
| paths | host/plugins/vfs-repos/tests/mindmaps.test.ts:20 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/mindmaps.test.ts:20 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/path-cache.test.ts:23 | storage |
| paths | host/plugins/vfs-repos/tests/path-cache.test.ts:23 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/path-cache.test.ts:23 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/pomodoros.test.ts:20 | storage |
| paths | host/plugins/vfs-repos/tests/pomodoros.test.ts:20 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/pomodoros.test.ts:20 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/question-owner-writes.test.ts:17 | storage |
| paths | host/plugins/vfs-repos/tests/question-owner-writes.test.ts:17 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/question-owner-writes.test.ts:17 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/questions.test.ts:21 | storage |
| paths | host/plugins/vfs-repos/tests/questions.test.ts:21 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/questions.test.ts:21 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/resources.test.ts:20 | storage |
| paths | host/plugins/vfs-repos/tests/resources.test.ts:20 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/resources.test.ts:20 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/review-plans.test.ts:19 | storage |
| paths | host/plugins/vfs-repos/tests/review-plans.test.ts:19 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/review-plans.test.ts:19 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/sync-pomodoro-counts.test.ts:30 | storage |
| paths | host/plugins/vfs-repos/tests/sync-pomodoro-counts.test.ts:31 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/sync-pomodoro-counts.test.ts:32 | notes: notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/textbooks.test.ts:20 | storage |
| paths | host/plugins/vfs-repos/tests/textbooks.test.ts:20 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/textbooks.test.ts:20 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/todos.test.ts:23 | storage |
| paths | host/plugins/vfs-repos/tests/todos.test.ts:23 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/todos.test.ts:23 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/translations.test.ts:24 | storage |
| paths | host/plugins/vfs-repos/tests/translations.test.ts:24 | paths: pathsServiceDouble(TEST_DEVICE_ID) |
| notes | host/plugins/vfs-repos/tests/translations.test.ts:24 | 'notes': notesServiceDouble(() => storage.database('vfs')) |
| storage | host/plugins/vfs-repos/tests/worker-service.test.ts:19 | storage |
| paths | host/plugins/vfs-repos/tests/worker-service.test.ts:19 | paths: pathsServiceDouble() |
| notes | host/plugins/vfs-repos/tests/worker-service.test.ts:19 | 'notes': notesServiceDouble(() => storage.database('vfs')) |

## 绕过服务的 native 导入

- host/plugins/agent-skills/src/tools/ptc-runtime.ts:12 (reachable=true): `import { StarlarkToolFailure } from '../../../../platform/native/starlark/api.ts';`
- host/plugins/anki/src/anki-qa-lint.ts:63 (reachable=true): `import { NativeRegexCompileError } from '../../../platform/native/api.ts';`
- host/plugins/anki/src/streaming-anki.ts:17 (reachable=true): `import { NativeRegexCompileError } from '../../../platform/native/api.ts';`
- host/plugins/media/src/pipeline.ts:12 (reachable=true): `import { AudioDecodeError, type NativeAudio } from '../../../platform/native/api.ts';`
- host/plugins/review/src/fsrs-scheduler.ts:11 (reachable=true): `import { fsrs as nativeFsrs } from '../../../platform/native/fsrs/index.ts';`
- host/plugins/review/src/fsrs-scheduler.ts:12 (reachable=true): `import { DEFAULT_PARAMETERS, effectiveParameters, forgettingCurveConstants, retrievability, } from '../../../platform/native/fsrs/parameters.ts';`

## 动态表达式（包装器调用点已展开；不声称通用数据流证明）

- host/plugins/agent-orchestration/src/super-inbox-drain.ts:181: `ctx.get(name)`
- host/plugins/chatanki/index.ts:465: `this.ctx.get(name)`
- host/plugins/chatanki/index.ts:480: `ctx.get(name)`
- host/plugins/chatanki/index.ts:482: `ctx.inject([name], (child) => service.registerWith(child.get(name)))`
- host/plugins/chatanki/index.ts:482: `child.get(name)`
- host/plugins/memory/src/memory-utils.ts:198: `(ctx as unknown as { get(service: string): unknown }).get(name)`
- host/plugins/vfs-index/src/runtime-adapter.ts:43: `ctx.get(key)`

## 入口不可达模块中的服务引用

- paths: host/platform/settings/backup-commands.ts:83 (property)
- commands: host/platform/settings/backup-commands.ts:98 (property)
- settings: host/platform/settings/backup-commands.ts:100 (property)
- commands: host/platform/settings/backup-commands.ts:106 (property)
- settings: host/platform/settings/backup-commands.ts:109 (property)
- commands: host/platform/settings/backup-commands.ts:119 (property)
- shell: host/platform/settings/backup-commands.ts:120 (property)
- settings: host/platform/settings/backup-commands.ts:126 (property)
- settings: host/platform/settings/backup-commands.ts:128 (property)
- commands: host/platform/settings/backup-commands.ts:136 (property)
- settings: host/platform/settings/backup-commands.ts:138 (property)
- settings: host/platform/settings/backup-commands.ts:140 (property)
- commands: host/platform/settings/backup-commands.ts:148 (property)
- commands: host/platform/settings/backup-commands.ts:153 (property)
- settings: host/platform/settings/backup-commands.ts:155 (property)

## 入口加载错误

无。


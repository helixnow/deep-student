# 插件能力清单（Capability Seams）

> 自动生成，请勿手改：`node scripts/plugin-catalog/generate.mjs`。CI 用 `--check` 检测漂移。
> 与 DeepSeek Harness 的 `docs/capability-seams.md` 对齐：服务是插件之间唯一的跨 lane 编程接口，
> 命令与事件是面向 UI/main 的线缆。插件编写指南见 `docs/plugins/SDK.md`。

统计：26 个业务插件、9 个平台插件、126 个服务 seam、777 条命令、127 个契约事件。

## 1. 服务 seam

`inject` 是启动前必须就绪的强依赖；`ctx.get` 是运行时可选发现。`ctx` 上的服务名使用
lowerCamelCase，不带版本号、点号或 `@`；版本由 `api.ts` 导出的服务描述对象声明，
破坏性变更使用新名字并保留旧服务一个周期（见 `ARCHITECTURE.md` §3）。

| 服务 | 归属 | 提供方 | 消费方（inject） | 消费方（ctx.get） | 声明位置 | 提供方命令数 | lane 事件数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `agentApproval` | 插件 | dstu.agent-workspace | — | — | host/plugins/agent-workspace/api.ts | 12 | 9 |
| `agentAutomation` | 插件 | dstu.agent-orchestration | — | — | host/plugins/agent-orchestration/api.ts | 17 | 8 |
| `agentCompletionOutbox` | 插件 | dstu.agent-workspace | — | — | host/plugins/agent-workspace/api.ts | 12 | 9 |
| `agentSkills` | 插件 | dstu.agent-skills | — | — | host/plugins/agent-skills/api.ts | 22 | 4 |
| `agentSubagent` | 插件 | dstu.agent-orchestration | — | — | host/plugins/agent-orchestration/api.ts | 17 | 8 |
| `agentTodo` | 插件 | dstu.agent-orchestration | — | — | host/plugins/agent-orchestration/api.ts | 17 | 8 |
| `agentTools` | 插件 | dstu.agent-skills | — | dstu.backup<br>dstu.notes | host/plugins/agent-skills/api.ts | 22 | 4 |
| `agentTransformSandbox` | 插件 | dstu.agent-workspace | — | — | host/plugins/agent-workspace/api.ts | 12 | 9 |
| `agentVfsResolver` | 插件 | dstu.agent-workspace | dstu.chat-pipeline | — | host/plugins/agent-workspace/api.ts | 12 | 9 |
| `agentWorkspace` | 插件 | dstu.agent-workspace | — | dstu.agent-orchestration | host/plugins/agent-workspace/api.ts | 12 | 9 |
| `agentWorkspaceTools` | 插件 | dstu.agent-workspace | — | — | host/plugins/agent-workspace/api.ts | 12 | 9 |
| `anki` | 插件 | dstu.anki | dstu.chatanki | — | host/plugins/anki/api.ts | 61 | 2 |
| `app` | kernel | kernel（根 context） | — | — | — | 0 | 0 |
| `appCommandState` | 插件 | dstu.integration | — | dstu.media<br>dstu.platform.storage | host/plugins/integration/api.ts | 0 | 0 |
| `backendEvents` | kernel | kernel（根 context） | — | — | — | 0 | 0 |
| `backgroundTasks` | 插件 | dstu.platform.diagnostics | — | dstu.agent-orchestration<br>dstu.qbank | host/platform/diagnostics/api.ts | 9 | 1 |
| `backup` | 插件 | dstu.backup | dstu.sync<br>dstu.sync-providers | — | host/plugins/backup/api.ts | 33 | 2 |
| `browser` | 插件 | dstu.browser | — | dstu.browser | host/plugins/browser/api.ts | 39 | 13 |
| `browserSurface` | 插件 | **缺失** | — | dstu.browser | host/plugins/browser/api.ts | 0 | 0 |
| `browserToolPolicy` | 插件 | dstu.browser | — | — | host/plugins/browser/api.ts | 39 | 13 |
| `chatankiTools` | 插件 | dstu.chatanki | — | — | host/plugins/chatanki/api.ts | 0 | 1 |
| `chatAttachmentErrors` | 插件 | dstu.chat | — | — | host/plugins/chat/api.ts | 107 | 6 |
| `chatPipeline` | 插件 | dstu.chat-pipeline | — | dstu.agent-orchestration | host/plugins/chat-pipeline/api.ts | 0 | 0 |
| `chatRetrievalScope` | 插件 | dstu.chat | — | — | host/plugins/chat/api.ts | 107 | 6 |
| `chatSession` | 插件 | dstu.chat | dstu.chat-pipeline | dstu.agent-orchestration<br>dstu.agent-workspace<br>dstu.anki | host/plugins/chat/api.ts | 107 | 6 |
| `chatState` | 插件 | dstu.chat | — | dstu.agent-orchestration | host/plugins/chat/api.ts | 107 | 6 |
| `chatToolRuntime` | 插件 | **缺失** | — | dstu.chat-pipeline | — | 0 | 0 |
| `cloudConfig` | 插件 | dstu.backup | dstu.platform.cloud-config | — | host/plugins/backup/api.ts | 33 | 2 |
| `commands` | kernel | kernel（根 context） | — | — | — | 0 | 0 |
| `dataSpace` | 插件 | dstu.platform.storage | — | — | host/platform/storage/api.ts | 33 | 0 |
| `diagnostics` | 插件 | dstu.platform.diagnostics | — | — | host/platform/diagnostics/api.ts | 9 | 1 |
| `docs` | 插件 | dstu.media | dstu.vfs-handlers | dstu.agent-workspace<br>dstu.anki<br>dstu.chat-pipeline<br>dstu.qbank<br>dstu.vfs<br>dstu.vfs-repos | host/plugins/media/api.ts | 74 | 6 |
| `dstu` | 插件 | dstu.vfs | — | — | host/plugins/vfs/api.ts | 6 | 6 |
| `essayGrading` | 插件 | dstu.llm | — | — | host/plugins/llm/api.ts | 20 | 24 |
| `examSheetSession` | 插件 | dstu.media | — | dstu.qbank | host/plugins/media/api.ts | 74 | 6 |
| `featureFlags` | 插件 | dstu.platform.storage | dstu.browser | dstu.notes | host/platform/storage/api.ts | 33 | 0 |
| `fileManagerPaths` | 插件 | dstu.platform.storage | — | — | host/platform/storage/api.ts | 33 | 0 |
| `governance` | 插件 | dstu.backup | — | dstu.agent-workspace<br>dstu.notes | host/plugins/backup/api.ts | 33 | 2 |
| `hpiasResearch` | 插件 | dstu.memory | — | — | host/plugins/memory/api.ts | 0 | 3 |
| `imageQuality` | 插件 | dstu.platform.storage | — | — | host/platform/storage/api.ts | 33 | 0 |
| `injectionBudget` | 插件 | dstu.platform.storage | dstu.llm | — | host/platform/storage/api.ts | 33 | 0 |
| `insight` | 插件 | dstu.memory | — | — | host/plugins/memory/api.ts | 0 | 3 |
| `lanceEngine` | 插件 | dstu.vfs-index | — | — | host/plugins/vfs-index/api.ts | 3 | 7 |
| `llm` | 插件 | dstu.llm | dstu.chatanki<br>dstu.mcp<br>dstu.translation | dstu.anki<br>dstu.chat<br>dstu.chat-pipeline<br>dstu.media<br>dstu.qbank | host/plugins/llm/api.ts | 20 | 24 |
| `llmAdapterInfos` | 插件 | dstu.llm | — | dstu.anki | host/plugins/llm/api.ts | 20 | 24 |
| `llmAdapters` | 插件 | dstu.llm-providers | dstu.llm | — | host/plugins/llm-providers/api.ts | 5 | 0 |
| `llmAnkiRouting` | 插件 | dstu.llm | — | dstu.anki | host/plugins/llm/api.ts | 20 | 24 |
| `llmCodexAuth` | 插件 | dstu.llm-providers | dstu.llm<br>dstu.translation | dstu.media | host/plugins/llm-providers/api.ts | 5 | 0 |
| `llmEmbeddingModels` | 插件 | dstu.llm | — | — | host/plugins/llm/api.ts | 20 | 24 |
| `llmFileOcr` | 插件 | dstu.llm | — | — | host/plugins/llm/api.ts | 20 | 24 |
| `llmHttp` | 插件 | dstu.llm | dstu.translation | — | host/plugins/llm/api.ts | 20 | 24 |
| `llmMcpTools` | 插件 | dstu.llm | — | — | host/plugins/llm/api.ts | 20 | 24 |
| `llmModel2Messages` | 插件 | dstu.llm | — | — | host/plugins/llm/api.ts | 20 | 24 |
| `llmModel2Streaming` | 插件 | dstu.llm | — | dstu.chat-pipeline | host/plugins/llm/api.ts | 20 | 24 |
| `llmMultimodal` | 插件 | dstu.llm-providers | — | — | host/plugins/llm-providers/api.ts | 5 | 0 |
| `llmOcr` | 插件 | dstu.llm-providers | — | — | host/plugins/llm-providers/api.ts | 5 | 0 |
| `llmOcrHedge` | 插件 | dstu.llm | — | — | host/plugins/llm/api.ts | 20 | 24 |
| `llmOcrModels` | 插件 | dstu.llm | — | dstu.chat-pipeline<br>dstu.media<br>dstu.qbank | host/plugins/llm/api.ts | 20 | 24 |
| `llmOcrPages` | 插件 | dstu.llm | — | dstu.chat-pipeline | host/plugins/llm/api.ts | 20 | 24 |
| `llmOcrRegions` | 插件 | dstu.llm | — | — | host/plugins/llm/api.ts | 20 | 24 |
| `llmProviderRequests` | 插件 | dstu.llm | — | — | host/plugins/llm/api.ts | 20 | 24 |
| `llmQuestionAuthoring` | 插件 | dstu.llm | — | dstu.qbank | host/plugins/llm/api.ts | 20 | 24 |
| `llmQuestionParsing` | 插件 | dstu.llm | — | — | host/plugins/llm/api.ts | 20 | 24 |
| `llmRag` | 插件 | dstu.llm | — | — | host/plugins/llm/api.ts | 20 | 24 |
| `llmRawPrompt` | 插件 | dstu.llm | — | dstu.chat-pipeline | host/plugins/llm/api.ts | 20 | 24 |
| `llmStreamEvents` | 插件 | dstu.llm | — | dstu.chat-pipeline | host/plugins/llm/api.ts | 20 | 24 |
| `llmStreaming` | 插件 | dstu.llm | — | dstu.anki<br>dstu.qbank | host/plugins/llm/api.ts | 20 | 24 |
| `llmUsage` | 插件 | dstu.platform.storage | — | — | host/platform/storage/api.ts | 33 | 0 |
| `log` | 插件 | dstu.platform.log | dstu.browser<br>dstu.mcp<br>dstu.memory<br>dstu.platform.secrets<br>dstu.platform.storage | — | host/platform/log/api.ts | 14 | 1 |
| `mastery` | 插件 | dstu.review | — | dstu.qbank | host/plugins/review/api.ts | 70 | 1 |
| `masteryProfileSink` | 插件 | dstu.memory | — | dstu.review | host/plugins/memory/api.ts<br>host/plugins/review/api.ts | 0 | 3 |
| `mcp` | 插件 | dstu.mcp | — | — | host/plugins/mcp/api.ts | 23 | 13 |
| `media` | 插件 | dstu.media | — | — | host/plugins/media/api.ts | 74 | 6 |
| `mediaTranscriber` | 插件 | dstu.media | — | — | host/plugins/media/api.ts<br>host/plugins/vfs-index/api.ts | 74 | 6 |
| `memory` | 插件 | dstu.memory | — | — | host/plugins/memory/api.ts | 0 | 3 |
| `memoryConfig` | 插件 | dstu.memory | — | dstu.vfs | host/plugins/memory/api.ts | 0 | 3 |
| `memoryRetrieval` | 插件 | dstu.memory | — | — | host/plugins/memory/api.ts | 0 | 3 |
| `memoryToolMetadata` | 插件 | dstu.memory | — | — | host/plugins/memory/api.ts | 0 | 3 |
| `nativeArgon2` | 插件 | dstu.native | — | — | host/platform/native/argon2/api.ts | 0 | 0 |
| `nativeAudio` | 插件 | dstu.native | — | dstu.media | host/platform/native/audio/api.ts | 0 | 0 |
| `nativeCompression` | 插件 | dstu.native | dstu.sync | dstu.anki | host/platform/native/compression/api.ts | 0 | 0 |
| `nativeFsrs` | 插件 | dstu.native | — | — | host/platform/native/fsrs/api.ts | 0 | 0 |
| `nativeHeic` | 插件 | dstu.native | — | dstu.media | host/platform/native/heic/api.ts | 0 | 0 |
| `nativeImage` | 插件 | dstu.native | dstu.llm | dstu.media<br>dstu.qbank<br>dstu.vfs-repos | host/platform/native/image/api.ts | 0 | 0 |
| `nativeOffice` | 插件 | dstu.native | — | dstu.media | host/platform/native/office/api.ts | 0 | 0 |
| `nativeOfficeText` | 插件 | dstu.native | — | dstu.media<br>dstu.vfs-repos | host/platform/native/office/api.ts | 0 | 0 |
| `nativeOfficeWriter` | 插件 | dstu.native | — | dstu.media | host/platform/native/office/api.ts | 0 | 0 |
| `nativePdfium` | 插件 | dstu.native | — | dstu.media<br>dstu.vfs-repos | host/platform/native/pdfium/api.ts | 0 | 0 |
| `nativeProtobuf` | 插件 | dstu.native | — | — | host/platform/native/protobuf/api.ts | 0 | 0 |
| `nativeRegex` | 插件 | dstu.native | — | dstu.agent-workspace<br>dstu.anki<br>dstu.notes | host/platform/native/regex/api.ts | 0 | 0 |
| `nativeSandbox` | 插件 | dstu.native | — | dstu.agent-workspace | host/platform/native/sandbox/api.ts | 0 | 0 |
| `nativeStarlark` | 插件 | dstu.native | — | dstu.agent-skills | host/platform/native/starlark/api.ts | 0 | 0 |
| `nativeTokenizer` | 插件 | dstu.native | dstu.chat-pipeline<br>dstu.llm | — | host/platform/native/tokenizer/api.ts | 0 | 0 |
| `nativeWindowsFiles` | 插件 | dstu.native | — | dstu.agent-workspace | host/platform/native/windows/api.ts | 0 | 0 |
| `nativeWindowsSandbox` | 插件 | dstu.native | — | — | — | 0 | 0 |
| `noteAssets` | 插件 | dstu.platform.storage | — | — | host/platform/storage/api.ts | 33 | 0 |
| `notes` | 插件 | dstu.notes | dstu.memory<br>dstu.sync<br>dstu.sync-support<br>dstu.vfs<br>dstu.vfs-handlers | dstu.media<br>dstu.vfs-repos | host/plugins/notes/api.ts<br>host/plugins/vfs/api.ts | 81 | 9 |
| `ocr` | 插件 | dstu.media | — | — | host/plugins/media/api.ts | 74 | 6 |
| `pageRasterizer` | 插件 | dstu.media | — | dstu.qbank | host/plugins/media/api.ts | 74 | 6 |
| `paths` | 插件 | dstu.platform.paths | dstu.agent-skills<br>dstu.anki<br>dstu.media<br>dstu.qbank<br>dstu.sync<br>dstu.sync-providers<br>dstu.vfs-repos<br>dstu.platform.log<br>dstu.platform.secrets<br>dstu.platform.storage | dstu.chat-pipeline | host/platform/paths/api.ts | 0 | 0 |
| `protocols` | kernel | kernel（根 context） | — | — | — | 0 | 0 |
| `qbank` | 插件 | dstu.qbank | — | dstu.vfs<br>dstu.vfs-repos | host/plugins/qbank/api.ts | 88 | 10 |
| `questionImportVision` | 插件 | dstu.media | — | — | host/plugins/media/api.ts | 74 | 6 |
| `retrieval` | 插件 | dstu.vfs-index | dstu.vfs-handlers | — | host/plugins/vfs-index/api.ts | 3 | 7 |
| `review` | 插件 | dstu.review | dstu.chatanki | dstu.anki | host/plugins/review/api.ts | 70 | 1 |
| `reviewPlan` | 插件 | dstu.review | — | dstu.qbank<br>dstu.review | host/plugins/review/api.ts | 70 | 1 |
| `runtimeRoots` | 插件 | dstu.agent-workspace | — | dstu.browser | host/plugins/agent-workspace/api.ts | 12 | 9 |
| `secrets` | 插件 | dstu.platform.secrets | dstu.backup<br>dstu.llm<br>dstu.mcp<br>dstu.sync<br>dstu.sync-providers<br>dstu.platform.settings<br>dstu.platform.storage | dstu.media | host/platform/secrets/api.ts | 11 | 1 |
| `settings` | 插件 | dstu.platform.settings | dstu.agent-orchestration<br>dstu.agent-skills<br>dstu.agent-workspace<br>dstu.backup<br>dstu.browser<br>dstu.chat-pipeline<br>dstu.chatanki<br>dstu.llm<br>dstu.llm-providers<br>dstu.mcp<br>dstu.media<br>dstu.memory<br>dstu.vfs-handlers | dstu.anki<br>dstu.chat<br>dstu.notes<br>dstu.vfs | host/platform/settings/api.ts | 0 | 0 |
| `shell` | kernel | kernel（根 context） | — | — | — | 0 | 0 |
| `startupGate` | 插件 | **缺失** | — | dstu.agent-orchestration<br>dstu.backup<br>dstu.platform.storage | — | 0 | 0 |
| `storage` | 插件 | dstu.platform.storage | dstu.agent-orchestration<br>dstu.agent-skills<br>dstu.agent-workspace<br>dstu.anki<br>dstu.backup<br>dstu.browser<br>dstu.chat<br>dstu.chat-pipeline<br>dstu.integration<br>dstu.memory<br>dstu.notes<br>dstu.qbank<br>dstu.review<br>dstu.sync<br>dstu.sync-support<br>dstu.vfs<br>dstu.vfs-index<br>dstu.vfs-repos<br>dstu.platform.diagnostics<br>dstu.platform.settings | — | host/platform/storage/api.ts | 33 | 0 |
| `storageStartupSync` | 插件 | dstu.sync | — | dstu.platform.storage | host/platform/storage/api.ts | 24 | 1 |
| `sync` | 插件 | dstu.sync | — | dstu.backup | host/plugins/sync/api.ts | 24 | 1 |
| `syncProvider` | 插件 | dstu.sync-providers | dstu.sync | — | host/plugins/sync-providers/api.ts | 14 | 1 |
| `syncSupport` | 插件 | dstu.sync-support | dstu.sync | — | host/plugins/sync-support/api.ts | 0 | 1 |
| `systemNotification` | 插件 | **缺失** | — | dstu.agent-orchestration<br>dstu.chat | — | 0 | 0 |
| `translation` | 插件 | dstu.translation | — | — | host/plugins/translation/api.ts | 6 | 24 |
| `vector` | 插件 | dstu.vector | — | — | host/platform/vector/api.ts | 0 | 0 |
| `vfs` | 插件 | dstu.vfs | dstu.chat | dstu.agent-workspace<br>dstu.chat-pipeline<br>dstu.media | host/plugins/vfs/api.ts | 6 | 6 |
| `vfsDatabase` | 插件 | dstu.vfs | dstu.llm<br>dstu.sync<br>dstu.vfs-handlers | dstu.anki<br>dstu.browser<br>dstu.media<br>dstu.vfs<br>dstu.vfs-repos | host/plugins/vfs/api.ts | 6 | 6 |
| `vfsHooks` | 插件 | dstu.vfs-handlers | — | — | host/plugins/vfs-handlers/api.ts | 1 | 6 |
| `vfsIndex` | 插件 | dstu.vfs-index | dstu.vfs<br>dstu.vfs-handlers | dstu.browser<br>dstu.media<br>dstu.qbank | host/plugins/vfs-index/api.ts | 3 | 7 |
| `vfsIndexMaintenance` | 插件 | dstu.vfs-index | dstu.vfs-handlers | — | host/plugins/vfs-index/api.ts | 3 | 7 |
| `vfsMaintenance` | 插件 | **缺失** | dstu.vfs-handlers | dstu.backup | — | 0 | 0 |
| `vfsRefText` | 插件 | dstu.vfs-handlers | — | dstu.qbank | host/plugins/vfs-handlers/api.ts | 1 | 6 |
| `vfsRepo` | 插件 | **缺失** | dstu.chat-pipeline<br>dstu.llm<br>dstu.memory<br>dstu.notes<br>dstu.sync<br>dstu.sync-support<br>dstu.vfs<br>dstu.vfs-handlers | dstu.agent-orchestration<br>dstu.agent-workspace<br>dstu.anki<br>dstu.browser<br>dstu.media<br>dstu.qbank<br>dstu.review | host/plugins/vfs/api.ts | 0 | 0 |
| `vfsUnitBuilder` | 插件 | dstu.vfs-index | dstu.vfs-handlers | dstu.browser<br>dstu.vfs | — | 3 | 7 |
| `virtualFilePolicy` | 插件 | **缺失** | — | dstu.vfs | — | 0 | 0 |
| `webpageToolPolicy` | 插件 | dstu.browser | — | — | host/plugins/browser/api.ts | 39 | 13 |
| `webSearch` | 插件 | dstu.browser | dstu.mcp | — | host/plugins/mcp/api.ts | 39 | 13 |

说明：平台插件（`host/platform/*`）与 kernel 服务也列入表中；kernel 服务挂在根 context，插件无需 inject。
服务版本见提供方 `api.ts` 导出的描述对象（如 `export const ankiService = { name: 'anki', version: '1.0.0' }`）。
“提供方命令数”与“lane 事件数”按提供方插件/lane 汇总，用于判断 seam 的规模，不是服务方法级计数。
具体命令见 §3.1 提供方插件的分组，事件见 §4（按 lane 展开）。

## 2. 关系图

实线 = `meta.provides` / `inject`；虚线 = `ctx.get` 可选发现；红色虚线节点 = 声明了但没有提供方。

```mermaid
graph LR
  classDef plugin fill:#eef4ff,stroke:#4263a8,color:#1a2b4a;
  classDef service fill:#fff8e6,stroke:#b7791f,color:#4a3200;
  classDef missing fill:#fff5f5,stroke:#c53030,stroke-dasharray:4 2,color:#742a2a;
  p_dstu_agent_orchestration["dstu.agent-orchestration"]:::plugin
  p_dstu_agent_skills["dstu.agent-skills"]:::plugin
  p_dstu_agent_workspace["dstu.agent-workspace"]:::plugin
  p_dstu_anki["dstu.anki"]:::plugin
  p_dstu_backup["dstu.backup"]:::plugin
  p_dstu_browser["dstu.browser"]:::plugin
  p_dstu_chat["dstu.chat"]:::plugin
  p_dstu_chat_pipeline["dstu.chat-pipeline"]:::plugin
  p_dstu_chatanki["dstu.chatanki"]:::plugin
  p_dstu_integration["dstu.integration"]:::plugin
  p_dstu_llm["dstu.llm"]:::plugin
  p_dstu_llm_providers["dstu.llm-providers"]:::plugin
  p_dstu_mcp["dstu.mcp"]:::plugin
  p_dstu_media["dstu.media"]:::plugin
  p_dstu_memory["dstu.memory"]:::plugin
  p_dstu_notes["dstu.notes"]:::plugin
  p_dstu_qbank["dstu.qbank"]:::plugin
  p_dstu_review["dstu.review"]:::plugin
  p_dstu_sync["dstu.sync"]:::plugin
  p_dstu_sync_providers["dstu.sync-providers"]:::plugin
  p_dstu_sync_support["dstu.sync-support"]:::plugin
  p_dstu_translation["dstu.translation"]:::plugin
  p_dstu_vfs["dstu.vfs"]:::plugin
  p_dstu_vfs_handlers["dstu.vfs-handlers"]:::plugin
  p_dstu_vfs_index["dstu.vfs-index"]:::plugin
  p_dstu_vfs_repos["dstu.vfs-repos"]:::plugin
  p_dstu_platform_diagnostics["dstu.platform.diagnostics"]:::plugin
  p_dstu_platform_cloud_config["dstu.platform.cloud-config"]:::plugin
  p_dstu_platform_log["dstu.platform.log"]:::plugin
  p_dstu_native["dstu.native"]:::plugin
  p_dstu_platform_paths["dstu.platform.paths"]:::plugin
  p_dstu_platform_secrets["dstu.platform.secrets"]:::plugin
  p_dstu_platform_settings["dstu.platform.settings"]:::plugin
  p_dstu_platform_storage["dstu.platform.storage"]:::plugin
  p_dstu_vector["dstu.vector"]:::plugin
  s_agentApproval(["agentApproval"]):::service
  p_dstu_agent_workspace -->|provides| s_agentApproval
  s_agentAutomation(["agentAutomation"]):::service
  p_dstu_agent_orchestration -->|provides| s_agentAutomation
  s_agentCompletionOutbox(["agentCompletionOutbox"]):::service
  p_dstu_agent_workspace -->|provides| s_agentCompletionOutbox
  s_agentSkills(["agentSkills"]):::service
  p_dstu_agent_skills -->|provides| s_agentSkills
  s_agentSubagent(["agentSubagent"]):::service
  p_dstu_agent_orchestration -->|provides| s_agentSubagent
  s_agentTodo(["agentTodo"]):::service
  p_dstu_agent_orchestration -->|provides| s_agentTodo
  s_agentTools(["agentTools"]):::service
  p_dstu_agent_skills -->|provides| s_agentTools
  s_agentTools -.->|get| p_dstu_backup
  s_agentTools -.->|get| p_dstu_notes
  s_agentTransformSandbox(["agentTransformSandbox"]):::service
  p_dstu_agent_workspace -->|provides| s_agentTransformSandbox
  s_agentVfsResolver(["agentVfsResolver"]):::service
  p_dstu_agent_workspace -->|provides| s_agentVfsResolver
  s_agentVfsResolver -->|inject| p_dstu_chat_pipeline
  s_agentWorkspace(["agentWorkspace"]):::service
  p_dstu_agent_workspace -->|provides| s_agentWorkspace
  s_agentWorkspace -.->|get| p_dstu_agent_orchestration
  s_agentWorkspaceTools(["agentWorkspaceTools"]):::service
  p_dstu_agent_workspace -->|provides| s_agentWorkspaceTools
  s_anki(["anki"]):::service
  p_dstu_anki -->|provides| s_anki
  s_anki -->|inject| p_dstu_chatanki
  s_appCommandState(["appCommandState"]):::service
  p_dstu_integration -->|provides| s_appCommandState
  s_appCommandState -.->|get| p_dstu_media
  s_appCommandState -.->|get| p_dstu_platform_storage
  s_backgroundTasks(["backgroundTasks"]):::service
  p_dstu_platform_diagnostics -->|provides| s_backgroundTasks
  s_backgroundTasks -.->|get| p_dstu_agent_orchestration
  s_backgroundTasks -.->|get| p_dstu_qbank
  s_backup(["backup"]):::service
  p_dstu_backup -->|provides| s_backup
  s_backup -->|inject| p_dstu_sync
  s_backup -->|inject| p_dstu_sync_providers
  s_browser(["browser"]):::service
  p_dstu_browser -->|provides| s_browser
  s_browser -.->|get| p_dstu_browser
  s_browserSurface(["browserSurface"]):::missing
  s_browserSurface -.->|get| p_dstu_browser
  s_browserToolPolicy(["browserToolPolicy"]):::service
  p_dstu_browser -->|provides| s_browserToolPolicy
  s_chatankiTools(["chatankiTools"]):::service
  p_dstu_chatanki -->|provides| s_chatankiTools
  s_chatAttachmentErrors(["chatAttachmentErrors"]):::service
  p_dstu_chat -->|provides| s_chatAttachmentErrors
  s_chatPipeline(["chatPipeline"]):::service
  p_dstu_chat_pipeline -->|provides| s_chatPipeline
  s_chatPipeline -.->|get| p_dstu_agent_orchestration
  s_chatRetrievalScope(["chatRetrievalScope"]):::service
  p_dstu_chat -->|provides| s_chatRetrievalScope
  s_chatSession(["chatSession"]):::service
  p_dstu_chat -->|provides| s_chatSession
  s_chatSession -->|inject| p_dstu_chat_pipeline
  s_chatSession -.->|get| p_dstu_agent_orchestration
  s_chatSession -.->|get| p_dstu_agent_workspace
  s_chatSession -.->|get| p_dstu_anki
  s_chatState(["chatState"]):::service
  p_dstu_chat -->|provides| s_chatState
  s_chatState -.->|get| p_dstu_agent_orchestration
  s_chatToolRuntime(["chatToolRuntime"]):::missing
  s_chatToolRuntime -.->|get| p_dstu_chat_pipeline
  s_cloudConfig(["cloudConfig"]):::service
  p_dstu_backup -->|provides| s_cloudConfig
  s_cloudConfig -->|inject| p_dstu_platform_cloud_config
  s_dataSpace(["dataSpace"]):::service
  p_dstu_platform_storage -->|provides| s_dataSpace
  s_diagnostics(["diagnostics"]):::service
  p_dstu_platform_diagnostics -->|provides| s_diagnostics
  s_docs(["docs"]):::service
  p_dstu_media -->|provides| s_docs
  s_docs -->|inject| p_dstu_vfs_handlers
  s_docs -.->|get| p_dstu_agent_workspace
  s_docs -.->|get| p_dstu_anki
  s_docs -.->|get| p_dstu_chat_pipeline
  s_docs -.->|get| p_dstu_qbank
  s_docs -.->|get| p_dstu_vfs
  s_docs -.->|get| p_dstu_vfs_repos
  s_dstu(["dstu"]):::service
  p_dstu_vfs -->|provides| s_dstu
  s_essayGrading(["essayGrading"]):::service
  p_dstu_llm -->|provides| s_essayGrading
  s_examSheetSession(["examSheetSession"]):::service
  p_dstu_media -->|provides| s_examSheetSession
  s_examSheetSession -.->|get| p_dstu_qbank
  s_featureFlags(["featureFlags"]):::service
  p_dstu_platform_storage -->|provides| s_featureFlags
  s_featureFlags -->|inject| p_dstu_browser
  s_featureFlags -.->|get| p_dstu_notes
  s_fileManagerPaths(["fileManagerPaths"]):::service
  p_dstu_platform_storage -->|provides| s_fileManagerPaths
  s_governance(["governance"]):::service
  p_dstu_backup -->|provides| s_governance
  s_governance -.->|get| p_dstu_agent_workspace
  s_governance -.->|get| p_dstu_notes
  s_hpiasResearch(["hpiasResearch"]):::service
  p_dstu_memory -->|provides| s_hpiasResearch
  s_imageQuality(["imageQuality"]):::service
  p_dstu_platform_storage -->|provides| s_imageQuality
  s_injectionBudget(["injectionBudget"]):::service
  p_dstu_platform_storage -->|provides| s_injectionBudget
  s_injectionBudget -->|inject| p_dstu_llm
  s_insight(["insight"]):::service
  p_dstu_memory -->|provides| s_insight
  s_lanceEngine(["lanceEngine"]):::service
  p_dstu_vfs_index -->|provides| s_lanceEngine
  s_llm(["llm"]):::service
  p_dstu_llm -->|provides| s_llm
  s_llm -->|inject| p_dstu_chatanki
  s_llm -->|inject| p_dstu_mcp
  s_llm -->|inject| p_dstu_translation
  s_llm -.->|get| p_dstu_anki
  s_llm -.->|get| p_dstu_chat
  s_llm -.->|get| p_dstu_chat_pipeline
  s_llm -.->|get| p_dstu_media
  s_llm -.->|get| p_dstu_qbank
  s_llmAdapterInfos(["llmAdapterInfos"]):::service
  p_dstu_llm -->|provides| s_llmAdapterInfos
  s_llmAdapterInfos -.->|get| p_dstu_anki
  s_llmAdapters(["llmAdapters"]):::service
  p_dstu_llm_providers -->|provides| s_llmAdapters
  s_llmAdapters -->|inject| p_dstu_llm
  s_llmAnkiRouting(["llmAnkiRouting"]):::service
  p_dstu_llm -->|provides| s_llmAnkiRouting
  s_llmAnkiRouting -.->|get| p_dstu_anki
  s_llmCodexAuth(["llmCodexAuth"]):::service
  p_dstu_llm_providers -->|provides| s_llmCodexAuth
  s_llmCodexAuth -->|inject| p_dstu_llm
  s_llmCodexAuth -->|inject| p_dstu_translation
  s_llmCodexAuth -.->|get| p_dstu_media
  s_llmEmbeddingModels(["llmEmbeddingModels"]):::service
  p_dstu_llm -->|provides| s_llmEmbeddingModels
  s_llmFileOcr(["llmFileOcr"]):::service
  p_dstu_llm -->|provides| s_llmFileOcr
  s_llmHttp(["llmHttp"]):::service
  p_dstu_llm -->|provides| s_llmHttp
  s_llmHttp -->|inject| p_dstu_translation
  s_llmMcpTools(["llmMcpTools"]):::service
  p_dstu_llm -->|provides| s_llmMcpTools
  s_llmModel2Messages(["llmModel2Messages"]):::service
  p_dstu_llm -->|provides| s_llmModel2Messages
  s_llmModel2Streaming(["llmModel2Streaming"]):::service
  p_dstu_llm -->|provides| s_llmModel2Streaming
  s_llmModel2Streaming -.->|get| p_dstu_chat_pipeline
  s_llmMultimodal(["llmMultimodal"]):::service
  p_dstu_llm_providers -->|provides| s_llmMultimodal
  s_llmOcr(["llmOcr"]):::service
  p_dstu_llm_providers -->|provides| s_llmOcr
  s_llmOcrHedge(["llmOcrHedge"]):::service
  p_dstu_llm -->|provides| s_llmOcrHedge
  s_llmOcrModels(["llmOcrModels"]):::service
  p_dstu_llm -->|provides| s_llmOcrModels
  s_llmOcrModels -.->|get| p_dstu_chat_pipeline
  s_llmOcrModels -.->|get| p_dstu_media
  s_llmOcrModels -.->|get| p_dstu_qbank
  s_llmOcrPages(["llmOcrPages"]):::service
  p_dstu_llm -->|provides| s_llmOcrPages
  s_llmOcrPages -.->|get| p_dstu_chat_pipeline
  s_llmOcrRegions(["llmOcrRegions"]):::service
  p_dstu_llm -->|provides| s_llmOcrRegions
  s_llmProviderRequests(["llmProviderRequests"]):::service
  p_dstu_llm -->|provides| s_llmProviderRequests
  s_llmQuestionAuthoring(["llmQuestionAuthoring"]):::service
  p_dstu_llm -->|provides| s_llmQuestionAuthoring
  s_llmQuestionAuthoring -.->|get| p_dstu_qbank
  s_llmQuestionParsing(["llmQuestionParsing"]):::service
  p_dstu_llm -->|provides| s_llmQuestionParsing
  s_llmRag(["llmRag"]):::service
  p_dstu_llm -->|provides| s_llmRag
  s_llmRawPrompt(["llmRawPrompt"]):::service
  p_dstu_llm -->|provides| s_llmRawPrompt
  s_llmRawPrompt -.->|get| p_dstu_chat_pipeline
  s_llmStreamEvents(["llmStreamEvents"]):::service
  p_dstu_llm -->|provides| s_llmStreamEvents
  s_llmStreamEvents -.->|get| p_dstu_chat_pipeline
  s_llmStreaming(["llmStreaming"]):::service
  p_dstu_llm -->|provides| s_llmStreaming
  s_llmStreaming -.->|get| p_dstu_anki
  s_llmStreaming -.->|get| p_dstu_qbank
  s_llmUsage(["llmUsage"]):::service
  p_dstu_platform_storage -->|provides| s_llmUsage
  s_log(["log"]):::service
  p_dstu_platform_log -->|provides| s_log
  s_log -->|inject| p_dstu_browser
  s_log -->|inject| p_dstu_mcp
  s_log -->|inject| p_dstu_memory
  s_log -->|inject| p_dstu_platform_secrets
  s_log -->|inject| p_dstu_platform_storage
  s_mastery(["mastery"]):::service
  p_dstu_review -->|provides| s_mastery
  s_mastery -.->|get| p_dstu_qbank
  s_masteryProfileSink(["masteryProfileSink"]):::service
  p_dstu_memory -->|provides| s_masteryProfileSink
  s_masteryProfileSink -.->|get| p_dstu_review
  s_mcp(["mcp"]):::service
  p_dstu_mcp -->|provides| s_mcp
  s_media(["media"]):::service
  p_dstu_media -->|provides| s_media
  s_mediaTranscriber(["mediaTranscriber"]):::service
  p_dstu_media -->|provides| s_mediaTranscriber
  s_memory(["memory"]):::service
  p_dstu_memory -->|provides| s_memory
  s_memoryConfig(["memoryConfig"]):::service
  p_dstu_memory -->|provides| s_memoryConfig
  s_memoryConfig -.->|get| p_dstu_vfs
  s_memoryRetrieval(["memoryRetrieval"]):::service
  p_dstu_memory -->|provides| s_memoryRetrieval
  s_memoryToolMetadata(["memoryToolMetadata"]):::service
  p_dstu_memory -->|provides| s_memoryToolMetadata
  s_nativeArgon2(["nativeArgon2"]):::service
  p_dstu_native -->|provides| s_nativeArgon2
  s_nativeAudio(["nativeAudio"]):::service
  p_dstu_native -->|provides| s_nativeAudio
  s_nativeAudio -.->|get| p_dstu_media
  s_nativeCompression(["nativeCompression"]):::service
  p_dstu_native -->|provides| s_nativeCompression
  s_nativeCompression -->|inject| p_dstu_sync
  s_nativeCompression -.->|get| p_dstu_anki
  s_nativeFsrs(["nativeFsrs"]):::service
  p_dstu_native -->|provides| s_nativeFsrs
  s_nativeHeic(["nativeHeic"]):::service
  p_dstu_native -->|provides| s_nativeHeic
  s_nativeHeic -.->|get| p_dstu_media
  s_nativeImage(["nativeImage"]):::service
  p_dstu_native -->|provides| s_nativeImage
  s_nativeImage -->|inject| p_dstu_llm
  s_nativeImage -.->|get| p_dstu_media
  s_nativeImage -.->|get| p_dstu_qbank
  s_nativeImage -.->|get| p_dstu_vfs_repos
  s_nativeOffice(["nativeOffice"]):::service
  p_dstu_native -->|provides| s_nativeOffice
  s_nativeOffice -.->|get| p_dstu_media
  s_nativeOfficeText(["nativeOfficeText"]):::service
  p_dstu_native -->|provides| s_nativeOfficeText
  s_nativeOfficeText -.->|get| p_dstu_media
  s_nativeOfficeText -.->|get| p_dstu_vfs_repos
  s_nativeOfficeWriter(["nativeOfficeWriter"]):::service
  p_dstu_native -->|provides| s_nativeOfficeWriter
  s_nativeOfficeWriter -.->|get| p_dstu_media
  s_nativePdfium(["nativePdfium"]):::service
  p_dstu_native -->|provides| s_nativePdfium
  s_nativePdfium -.->|get| p_dstu_media
  s_nativePdfium -.->|get| p_dstu_vfs_repos
  s_nativeProtobuf(["nativeProtobuf"]):::service
  p_dstu_native -->|provides| s_nativeProtobuf
  s_nativeRegex(["nativeRegex"]):::service
  p_dstu_native -->|provides| s_nativeRegex
  s_nativeRegex -.->|get| p_dstu_agent_workspace
  s_nativeRegex -.->|get| p_dstu_anki
  s_nativeRegex -.->|get| p_dstu_notes
  s_nativeSandbox(["nativeSandbox"]):::service
  p_dstu_native -->|provides| s_nativeSandbox
  s_nativeSandbox -.->|get| p_dstu_agent_workspace
  s_nativeStarlark(["nativeStarlark"]):::service
  p_dstu_native -->|provides| s_nativeStarlark
  s_nativeStarlark -.->|get| p_dstu_agent_skills
  s_nativeTokenizer(["nativeTokenizer"]):::service
  p_dstu_native -->|provides| s_nativeTokenizer
  s_nativeTokenizer -->|inject| p_dstu_chat_pipeline
  s_nativeTokenizer -->|inject| p_dstu_llm
  s_nativeWindowsFiles(["nativeWindowsFiles"]):::service
  p_dstu_native -->|provides| s_nativeWindowsFiles
  s_nativeWindowsFiles -.->|get| p_dstu_agent_workspace
  s_nativeWindowsSandbox(["nativeWindowsSandbox"]):::service
  p_dstu_native -->|provides| s_nativeWindowsSandbox
  s_noteAssets(["noteAssets"]):::service
  p_dstu_platform_storage -->|provides| s_noteAssets
  s_notes(["notes"]):::service
  p_dstu_notes -->|provides| s_notes
  s_notes -->|inject| p_dstu_memory
  s_notes -->|inject| p_dstu_sync
  s_notes -->|inject| p_dstu_sync_support
  s_notes -->|inject| p_dstu_vfs
  s_notes -->|inject| p_dstu_vfs_handlers
  s_notes -.->|get| p_dstu_media
  s_notes -.->|get| p_dstu_vfs_repos
  s_ocr(["ocr"]):::service
  p_dstu_media -->|provides| s_ocr
  s_pageRasterizer(["pageRasterizer"]):::service
  p_dstu_media -->|provides| s_pageRasterizer
  s_pageRasterizer -.->|get| p_dstu_qbank
  s_paths(["paths"]):::service
  p_dstu_platform_paths -->|provides| s_paths
  s_paths -->|inject| p_dstu_agent_skills
  s_paths -->|inject| p_dstu_anki
  s_paths -->|inject| p_dstu_media
  s_paths -->|inject| p_dstu_qbank
  s_paths -->|inject| p_dstu_sync
  s_paths -->|inject| p_dstu_sync_providers
  s_paths -->|inject| p_dstu_vfs_repos
  s_paths -->|inject| p_dstu_platform_log
  s_paths -->|inject| p_dstu_platform_secrets
  s_paths -->|inject| p_dstu_platform_storage
  s_paths -.->|get| p_dstu_chat_pipeline
  s_qbank(["qbank"]):::service
  p_dstu_qbank -->|provides| s_qbank
  s_qbank -.->|get| p_dstu_vfs
  s_qbank -.->|get| p_dstu_vfs_repos
  s_questionImportVision(["questionImportVision"]):::service
  p_dstu_media -->|provides| s_questionImportVision
  s_retrieval(["retrieval"]):::service
  p_dstu_vfs_index -->|provides| s_retrieval
  s_retrieval -->|inject| p_dstu_vfs_handlers
  s_review(["review"]):::service
  p_dstu_review -->|provides| s_review
  s_review -->|inject| p_dstu_chatanki
  s_review -.->|get| p_dstu_anki
  s_reviewPlan(["reviewPlan"]):::service
  p_dstu_review -->|provides| s_reviewPlan
  s_reviewPlan -.->|get| p_dstu_qbank
  s_reviewPlan -.->|get| p_dstu_review
  s_runtimeRoots(["runtimeRoots"]):::service
  p_dstu_agent_workspace -->|provides| s_runtimeRoots
  s_runtimeRoots -.->|get| p_dstu_browser
  s_secrets(["secrets"]):::service
  p_dstu_platform_secrets -->|provides| s_secrets
  s_secrets -->|inject| p_dstu_backup
  s_secrets -->|inject| p_dstu_llm
  s_secrets -->|inject| p_dstu_mcp
  s_secrets -->|inject| p_dstu_sync
  s_secrets -->|inject| p_dstu_sync_providers
  s_secrets -->|inject| p_dstu_platform_settings
  s_secrets -->|inject| p_dstu_platform_storage
  s_secrets -.->|get| p_dstu_media
  s_settings(["settings"]):::service
  p_dstu_platform_settings -->|provides| s_settings
  s_settings -->|inject| p_dstu_agent_orchestration
  s_settings -->|inject| p_dstu_agent_skills
  s_settings -->|inject| p_dstu_agent_workspace
  s_settings -->|inject| p_dstu_backup
  s_settings -->|inject| p_dstu_browser
  s_settings -->|inject| p_dstu_chat_pipeline
  s_settings -->|inject| p_dstu_chatanki
  s_settings -->|inject| p_dstu_llm
  s_settings -->|inject| p_dstu_llm_providers
  s_settings -->|inject| p_dstu_mcp
  s_settings -->|inject| p_dstu_media
  s_settings -->|inject| p_dstu_memory
  s_settings -->|inject| p_dstu_vfs_handlers
  s_settings -.->|get| p_dstu_anki
  s_settings -.->|get| p_dstu_chat
  s_settings -.->|get| p_dstu_notes
  s_settings -.->|get| p_dstu_vfs
  s_startupGate(["startupGate"]):::missing
  s_startupGate -.->|get| p_dstu_agent_orchestration
  s_startupGate -.->|get| p_dstu_backup
  s_startupGate -.->|get| p_dstu_platform_storage
  s_storage(["storage"]):::service
  p_dstu_platform_storage -->|provides| s_storage
  s_storage -->|inject| p_dstu_agent_orchestration
  s_storage -->|inject| p_dstu_agent_skills
  s_storage -->|inject| p_dstu_agent_workspace
  s_storage -->|inject| p_dstu_anki
  s_storage -->|inject| p_dstu_backup
  s_storage -->|inject| p_dstu_browser
  s_storage -->|inject| p_dstu_chat
  s_storage -->|inject| p_dstu_chat_pipeline
  s_storage -->|inject| p_dstu_integration
  s_storage -->|inject| p_dstu_memory
  s_storage -->|inject| p_dstu_notes
  s_storage -->|inject| p_dstu_qbank
  s_storage -->|inject| p_dstu_review
  s_storage -->|inject| p_dstu_sync
  s_storage -->|inject| p_dstu_sync_support
  s_storage -->|inject| p_dstu_vfs
  s_storage -->|inject| p_dstu_vfs_index
  s_storage -->|inject| p_dstu_vfs_repos
  s_storage -->|inject| p_dstu_platform_diagnostics
  s_storage -->|inject| p_dstu_platform_settings
  s_storageStartupSync(["storageStartupSync"]):::service
  p_dstu_sync -->|provides| s_storageStartupSync
  s_storageStartupSync -.->|get| p_dstu_platform_storage
  s_sync(["sync"]):::service
  p_dstu_sync -->|provides| s_sync
  s_sync -.->|get| p_dstu_backup
  s_syncProvider(["syncProvider"]):::service
  p_dstu_sync_providers -->|provides| s_syncProvider
  s_syncProvider -->|inject| p_dstu_sync
  s_syncSupport(["syncSupport"]):::service
  p_dstu_sync_support -->|provides| s_syncSupport
  s_syncSupport -->|inject| p_dstu_sync
  s_systemNotification(["systemNotification"]):::missing
  s_systemNotification -.->|get| p_dstu_agent_orchestration
  s_systemNotification -.->|get| p_dstu_chat
  s_translation(["translation"]):::service
  p_dstu_translation -->|provides| s_translation
  s_vector(["vector"]):::service
  p_dstu_vector -->|provides| s_vector
  s_vfs(["vfs"]):::service
  p_dstu_vfs -->|provides| s_vfs
  s_vfs -->|inject| p_dstu_chat
  s_vfs -.->|get| p_dstu_agent_workspace
  s_vfs -.->|get| p_dstu_chat_pipeline
  s_vfs -.->|get| p_dstu_media
  s_vfsDatabase(["vfsDatabase"]):::service
  p_dstu_vfs -->|provides| s_vfsDatabase
  s_vfsDatabase -->|inject| p_dstu_llm
  s_vfsDatabase -->|inject| p_dstu_sync
  s_vfsDatabase -->|inject| p_dstu_vfs_handlers
  s_vfsDatabase -.->|get| p_dstu_anki
  s_vfsDatabase -.->|get| p_dstu_browser
  s_vfsDatabase -.->|get| p_dstu_media
  s_vfsDatabase -.->|get| p_dstu_vfs
  s_vfsDatabase -.->|get| p_dstu_vfs_repos
  s_vfsHooks(["vfsHooks"]):::service
  p_dstu_vfs_handlers -->|provides| s_vfsHooks
  s_vfsIndex(["vfsIndex"]):::service
  p_dstu_vfs_index -->|provides| s_vfsIndex
  s_vfsIndex -->|inject| p_dstu_vfs
  s_vfsIndex -->|inject| p_dstu_vfs_handlers
  s_vfsIndex -.->|get| p_dstu_browser
  s_vfsIndex -.->|get| p_dstu_media
  s_vfsIndex -.->|get| p_dstu_qbank
  s_vfsIndexMaintenance(["vfsIndexMaintenance"]):::service
  p_dstu_vfs_index -->|provides| s_vfsIndexMaintenance
  s_vfsIndexMaintenance -->|inject| p_dstu_vfs_handlers
  s_vfsMaintenance(["vfsMaintenance"]):::missing
  s_vfsMaintenance -->|inject| p_dstu_vfs_handlers
  s_vfsMaintenance -.->|get| p_dstu_backup
  s_vfsRefText(["vfsRefText"]):::service
  p_dstu_vfs_handlers -->|provides| s_vfsRefText
  s_vfsRefText -.->|get| p_dstu_qbank
  s_vfsRepo(["vfsRepo"]):::missing
  s_vfsRepo -->|inject| p_dstu_chat_pipeline
  s_vfsRepo -->|inject| p_dstu_llm
  s_vfsRepo -->|inject| p_dstu_memory
  s_vfsRepo -->|inject| p_dstu_notes
  s_vfsRepo -->|inject| p_dstu_sync
  s_vfsRepo -->|inject| p_dstu_sync_support
  s_vfsRepo -->|inject| p_dstu_vfs
  s_vfsRepo -->|inject| p_dstu_vfs_handlers
  s_vfsRepo -.->|get| p_dstu_agent_orchestration
  s_vfsRepo -.->|get| p_dstu_agent_workspace
  s_vfsRepo -.->|get| p_dstu_anki
  s_vfsRepo -.->|get| p_dstu_browser
  s_vfsRepo -.->|get| p_dstu_media
  s_vfsRepo -.->|get| p_dstu_qbank
  s_vfsRepo -.->|get| p_dstu_review
  s_vfsUnitBuilder(["vfsUnitBuilder"]):::service
  p_dstu_vfs_index -->|provides| s_vfsUnitBuilder
  s_vfsUnitBuilder -->|inject| p_dstu_vfs_handlers
  s_vfsUnitBuilder -.->|get| p_dstu_browser
  s_vfsUnitBuilder -.->|get| p_dstu_vfs
  s_virtualFilePolicy(["virtualFilePolicy"]):::missing
  s_virtualFilePolicy -.->|get| p_dstu_vfs
  s_webpageToolPolicy(["webpageToolPolicy"]):::service
  p_dstu_browser -->|provides| s_webpageToolPolicy
  s_webSearch(["webSearch"]):::service
  p_dstu_browser -->|provides| s_webSearch
  s_webSearch -->|inject| p_dstu_mcp
```

## 3. 插件目录

| 插件 id | lane | 类型 | provides | inject | 命令数 | 入口 |
| --- | --- | --- | --- | --- | --- | --- |
| `dstu.agent-orchestration` | L06-agent-orchestration | 业务 | `agentAutomation`<br>`agentSubagent`<br>`agentTodo` | `settings`<br>`storage` | 17 | host/plugins/agent-orchestration/index.ts |
| `dstu.agent-skills` | L07-agent-skills-ptc | 业务 | `agentSkills`<br>`agentTools` | `paths`<br>`settings`<br>`storage` | 22 | host/plugins/agent-skills/index.ts |
| `dstu.agent-workspace` | L05-agent-workspace | 业务 | `agentApproval`<br>`agentWorkspace`<br>`agentWorkspaceTools`<br>`agentVfsResolver`<br>`agentCompletionOutbox`<br>`runtimeRoots`<br>`agentTransformSandbox` | `settings`<br>`storage` | 12 | host/plugins/agent-workspace/index.ts |
| `dstu.anki` | L16-anki | 业务 | `anki` | `paths`<br>`storage` | 61 | host/plugins/anki/index.ts |
| `dstu.backup` | L21-backup-governance | 业务 | `backup`<br>`governance`<br>`cloudConfig` | `storage`<br>`settings`<br>`secrets` | 33 | host/plugins/backup/index.ts |
| `dstu.browser` | L19-mcp-browser | 业务 | `webSearch`<br>`browser`<br>`browserToolPolicy`<br>`webpageToolPolicy` | `settings`<br>`storage`<br>`log`<br>`featureFlags` | 39 | host/plugins/browser/index.ts |
| `dstu.chat` | L04-chat-session | 业务 | `chatState`<br>`chatSession`<br>`chatAttachmentErrors`<br>`chatRetrievalScope` | `storage`<br>`vfs` | 107 | host/plugins/chat/index.ts |
| `dstu.chat-pipeline` | L03-chat-pipeline | 业务 | `chatPipeline` | `nativeTokenizer`<br>`chatSession`<br>`settings`<br>`storage`<br>`vfsRepo`<br>`agentVfsResolver` | 0 | host/plugins/chat-pipeline/index.ts |
| `dstu.chatanki` | L24-chatanki | 业务 | `chatankiTools` | `settings`<br>`review`<br>`llm`<br>`anki` | 0 | host/plugins/chatanki/index.ts |
| `dstu.integration` | L22-app-commands | 业务 | `appCommandState` | `storage` | 0 | host/plugins/integration/index.ts |
| `dstu.llm` | L02-llm-manager | 业务 | `llm`<br>`essayGrading`<br>`llmStreaming`<br>`llmAdapterInfos`<br>`llmEmbeddingModels`<br>`llmOcrModels`<br>`llmRag`<br>`llmOcrRegions`<br>`llmOcrHedge`<br>`llmQuestionParsing`<br>`llmModel2Messages`<br>`llmProviderRequests`<br>`llmStreamEvents`<br>`llmAnkiRouting`<br>`llmMcpTools`<br>`llmModel2Streaming`<br>`llmHttp`<br>`llmRawPrompt`<br>`llmQuestionAuthoring`<br>`llmOcrPages`<br>`llmFileOcr` | `settings`<br>`secrets`<br>`vfsDatabase`<br>`vfsRepo`<br>`llmAdapters`<br>`nativeTokenizer`<br>`nativeImage`<br>`injectionBudget`<br>`llmCodexAuth` | 20 | host/plugins/llm/index.ts |
| `dstu.llm-providers` | L01-llm-providers | 业务 | `llmAdapters`<br>`llmOcr`<br>`llmMultimodal`<br>`llmCodexAuth` | `settings` | 5 | host/plugins/llm-providers/index.ts |
| `dstu.mcp` | L19-mcp-browser | 业务 | `mcp` | `settings`<br>`secrets`<br>`llm`<br>`webSearch`<br>`log` | 23 | host/plugins/mcp/index.ts |
| `dstu.media` | L18-media-docs | 业务 | `media`<br>`docs`<br>`ocr`<br>`examSheetSession`<br>`mediaTranscriber`<br>`pageRasterizer`<br>`questionImportVision` | `settings`<br>`paths` | 74 | host/plugins/media/index.ts |
| `dstu.memory` | L17-memory-research | 业务 | `memory`<br>`insight`<br>`masteryProfileSink`<br>`memoryRetrieval`<br>`hpiasResearch`<br>`memoryConfig`<br>`memoryToolMetadata` | `storage`<br>`settings`<br>`notes`<br>`vfsRepo`<br>`log` | 0 | host/plugins/memory/index.ts |
| `dstu.notes` | L10-notes | 业务 | `notes` | `storage`<br>`vfsRepo` | 81 | host/plugins/notes/index.ts |
| `dstu.qbank` | L14-qbank | 业务 | `qbank` | `storage`<br>`paths` | 88 | host/plugins/qbank/index.ts |
| `dstu.review` | L15-review-analytics | 业务 | `mastery`<br>`review`<br>`reviewPlan` | `storage` | 70 | host/plugins/review/index.ts |
| `dstu.sync` | L20-sync | 业务 | `sync`<br>`storageStartupSync` | `storage`<br>`paths`<br>`notes`<br>`backup`<br>`syncProvider`<br>`secrets`<br>`vfsDatabase`<br>`syncSupport`<br>`nativeCompression`<br>`vfsRepo` | 24 | host/plugins/sync/index.ts |
| `dstu.sync-providers` | L23-sync-providers | 业务 | `syncProvider` | `secrets`<br>`backup`<br>`paths` | 14 | host/plugins/sync-providers/index.ts |
| `dstu.sync-support` | L20-sync | 业务 | `syncSupport` | `storage`<br>`notes`<br>`vfsRepo` | 0 | host/plugins/sync-support/index.ts |
| `dstu.translation` | L02-llm-manager | 业务 | `translation` | `llm`<br>`llmCodexAuth`<br>`llmHttp` | 6 | host/plugins/translation/index.ts |
| `dstu.vfs` | L13-vfs-api | 业务 | `vfsDatabase`<br>`vfs`<br>`dstu` | `storage`<br>`notes`<br>`vfsRepo`<br>`vfsIndex` | 6 | host/plugins/vfs/index.ts |
| `dstu.vfs-handlers` | L13-vfs-api | 业务 | `vfsHooks`<br>`vfsRefText` | `vfsDatabase`<br>`vfsRepo`<br>`vfsMaintenance`<br>`notes`<br>`vfsIndex`<br>`vfsIndexMaintenance`<br>`vfsUnitBuilder`<br>`retrieval`<br>`settings`<br>`docs` | 1 | host/plugins/vfs-handlers/index.ts |
| `dstu.vfs-index` | L12-vfs-index | 业务 | `lanceEngine`<br>`retrieval`<br>`vfsIndex`<br>`vfsUnitBuilder`<br>`vfsIndexMaintenance` | `storage` | 3 | host/plugins/vfs-index/index.ts |
| `dstu.vfs-repos` | L11-vfs-repos | 业务 | — | `storage`<br>`paths` | 0 | host/plugins/vfs-repos/index.ts |
| `dstu.platform.diagnostics` | F4-security | 平台 | `diagnostics`<br>`backgroundTasks` | `storage` | 9 | host/platform/diagnostics/index.ts |
| `dstu.platform.cloud-config` | F4-security | 平台 | — | `cloudConfig` | 4 | host/platform/errors/index.ts |
| `dstu.platform.log` | F4-security | 平台 | `log` | `paths` | 14 | host/platform/log/index.ts |
| `dstu.native` | F7-native | 平台 | `nativeCompression`<br>`nativeHeic`<br>`nativeImage`<br>`nativeOffice`<br>`nativeOfficeText`<br>`nativeProtobuf`<br>`nativeTokenizer`<br>`nativePdfium`<br>`nativeFsrs`<br>`nativeRegex`<br>`nativeStarlark`<br>`nativeAudio`<br>`nativeOfficeWriter`<br>`nativeSandbox`<br>`nativeWindowsFiles`<br>`nativeWindowsSandbox`<br>`nativeArgon2` | — | 0 | host/platform/native/index.ts |
| `dstu.platform.paths` | F4-platform | 平台 | `paths` | — | 0 | host/platform/paths/index.ts |
| `dstu.platform.secrets` | F4-security | 平台 | `secrets` | `paths`<br>`log` | 11 | host/platform/secrets/index.ts |
| `dstu.platform.settings` | F4-platform | 平台 | `settings` | `storage`<br>`secrets` | 0 | host/platform/settings/index.ts |
| `dstu.platform.storage` | F3-storage | 平台 | `storage`<br>`dataSpace`<br>`featureFlags`<br>`injectionBudget`<br>`noteAssets`<br>`imageQuality`<br>`llmUsage`<br>`fileManagerPaths` | `secrets`<br>`paths`<br>`log` | 33 | host/platform/storage/index.ts |
| `dstu.vector` | F7-native | 平台 | `vector` | — | 0 | host/platform/vector/index.ts |

### 3.1 命令

命令名必须存在于 `contracts/ipc/*.json`；同一命令只能由一个插件注册。按插件分组：

<details><summary><code>dstu.agent-orchestration</code>（17）</summary>

- `super_session_get_settings`
- `super_session_set_settings`
- `chat_v2_automation_summary`
- `chat_v2_automation_set_background_enabled`
- `chat_v2_automation_retry_run`
- `chat_v2_automation_list`
- `chat_v2_automation_create`
- `chat_v2_automation_set_enabled`
- `chat_v2_automation_update`
- `chat_v2_automation_delete`
- `chat_v2_automation_runs`
- `chat_v2_automation_cancel_run`
- `chat_v2_automation_run_now`
- `chat_v2_super_deliver_inbox`
- `super_session_ensure`
- `super_session_get_state`
- `super_session_set_enabled`

</details>

<details><summary><code>dstu.agent-skills</code>（22）</summary>

- `skill_probe_requires`
- `skill_list_directories`
- `skill_list_package_files`
- `skill_read_file`
- `skill_create`
- `skill_update`
- `skill_delete`
- `skill_import_zip`
- `skill_tap_catalog`
- `skill_tap_install`
- `skill_export_tap`
- `skill_market_search`
- `skill_market_skill_detail`
- `skill_market_verify`
- `skill_market_download_and_scan`
- `skill_check_updates`
- `skill_update_from_source`
- `chat_v2_record_skill_activation`
- `chat_v2_list_skill_candidates`
- `chat_v2_replay_skill_candidate`
- `chat_v2_promote_skill_candidate`
- `chat_v2_rollback_skill_candidate`

</details>

<details><summary><code>dstu.agent-workspace</code>（12）</summary>

- `chat_v2_authorize_runtime_root`
- `chat_v2_delete_artifact`
- `chat_v2_list_runtime_directory`
- `chat_v2_list_runtime_roots`
- `chat_v2_read_runtime_file`
- `chat_v2_reset_workspace_root`
- `chat_v2_resolve_runtime_path`
- `chat_v2_revert_artifact_write`
- `chat_v2_revert_workspace_change`
- `chat_v2_revoke_runtime_root`
- `chat_v2_set_skill_trust`
- `chat_v2_set_workspace_root`

</details>

<details><summary><code>dstu.anki</code>（61）</summary>

- `read_anki_media`
- `import_apkg_to_library`
- `save_json_file`
- `save_template_debug_data`
- `check_anki_connect_status`
- `check_anki_connect_availability`
- `anki_get_deck_names`
- `get_anki_deck_names`
- `get_anki_model_names`
- `create_anki_deck`
- `import_anki_package`
- `get_all_custom_templates`
- `get_custom_template_by_id`
- `create_custom_template`
- `update_custom_template`
- `delete_custom_template`
- `count_custom_template_references`
- `export_template`
- `import_template`
- `import_custom_templates_bulk`
- `import_builtin_templates`
- `get_default_template_id`
- `set_default_template`
- `update_anki_card`
- `delete_anki_card`
- `delete_document_task`
- `delete_document_session`
- `get_document_cards`
- `get_document_tasks`
- `get_document_task_counts`
- `get_document_processing_state`
- `pause_document_processing`
- `cancel_document_processing`
- `get_task_cards`
- `recover_stuck_document_tasks`
- `set_document_session_source`
- `list_document_sessions`
- `get_anki_stats`
- `get_pending_memory_candidates`
- `dismiss_pending_memory_candidates`
- `mark_pending_memory_candidates_saved`
- `get_all_recent_cards`
- `save_anki_cards`
- `get_anki_library_card_content`
- `list_anki_library_cards`
- `add_cards_to_anki_connect`
- `get_model_adapter_options`
- `save_model_adapter_options`
- `reset_model_adapter_options`
- `export_cards_as_apkg`
- `export_cards_as_apkg_with_template`
- `export_multi_template_apkg`
- `export_anki_cards`
- `export_apkg_for_selection`
- `batch_export_cards`
- `generate_anki_cards_from_document`
- `generate_anki_cards_from_document_file`
- `generate_anki_cards_from_document_base64`
- `start_enhanced_document_processing`
- `resume_document_processing`
- `trigger_task_processing`

</details>

<details><summary><code>dstu.backup</code>（33）</summary>

- `cloud_config_test_connection_draft`
- `data_governance_auto_verify_latest_backup`
- `data_governance_backup_and_export_zip`
- `data_governance_backup_tiered`
- `data_governance_cancel_backup`
- `data_governance_check_disk_space_for_restore`
- `data_governance_cleanup_audit_logs`
- `data_governance_cleanup_persisted_jobs`
- `data_governance_delete_backup`
- `data_governance_export_zip`
- `data_governance_get_asset_types`
- `data_governance_get_audit_logs`
- `data_governance_get_backup_job`
- `data_governance_get_backup_list`
- `data_governance_get_database_status`
- `data_governance_get_maintenance_status`
- `data_governance_get_migration_diagnostic_report`
- `data_governance_get_migration_status`
- `data_governance_get_schema_registry`
- `data_governance_import_zip`
- `data_governance_list_backup_jobs`
- `data_governance_list_resumable_jobs`
- `data_governance_purge_all_data`
- `data_governance_restore_backup`
- `data_governance_restore_with_assets`
- `data_governance_resume_backup_job`
- `data_governance_run_backup`
- `data_governance_run_health_check`
- `data_governance_run_slot_c_empty_db_test`
- `data_governance_run_slot_d_clone_db_test`
- `data_governance_scan_assets`
- `data_governance_verify_backup`
- `data_governance_verify_backup_with_assets`

</details>

<details><summary><code>dstu.browser</code>（39）</summary>

- `save_setting`
- `get_setting`
- `delete_setting`
- `get_settings_by_prefix`
- `delete_settings_by_prefix`
- `get_security_status`
- `detect_tool_conflicts`
- `get_tools_namespace_config`
- `get_cn_whitelist_config`
- `get_provider_strategies_config`
- `save_provider_strategies_config`
- `get_feature_flags`
- `update_feature_flag`
- `is_feature_enabled`
- `test_search_engine`
- `test_web_search_connectivity`
- `test_all_search_engines`
- `network_probe`
- `browser_open_session`
- `browser_navigate`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_get_state`
- `browser_close`
- `browser_focus`
- `browser_release_surface_focus`
- `browser_set_surface_bounds`
- `browser_set_surface_visibility`
- `browser_get_surface_host_mode`
- `browser_content_user_input`
- `browser_take_over`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_set_input_files`
- `browser_list_downloads`
- `browser_list_task_downloads`
- `browser_scroll`

</details>

<details><summary><code>dstu.chat</code>（107）</summary>

- `chat_v2_get_session`
- `chat_v2_list_sessions`
- `chat_v2_count_sessions`
- `chat_v2_add_tag`
- `chat_v2_remove_tag`
- `chat_v2_get_session_tags`
- `chat_v2_get_tags_batch`
- `chat_v2_list_all_tags`
- `chat_v2_search_sessions`
- `chat_v2_search_content`
- `rebuild_chat_fts`
- `chat_v2_goal_get`
- `chat_v2_goal_edit`
- `chat_v2_has_active_stream`
- `chat_v2_get_emit_failure_count`
- `chat_v2_create_session`
- `chat_v2_update_session_settings`
- `chat_v2_archive_session`
- `chat_v2_save_session`
- `chat_v2_restore_session`
- `chat_v2_list_agent_sessions`
- `chat_v2_session_message_count`
- `chat_v2_get_message_summary`
- `chat_v2_set_authority_mode`
- `chat_v2_set_permission_preset`
- `chat_v2_get_rag_scope`
- `chat_v2_set_rag_scope`
- `chat_v2_copy_block_content`
- `chat_v2_update_block_content`
- `chat_v2_update_block_tool_output`
- `chat_v2_upsert_streaming_block`
- `chat_v2_load_session`
- `chat_v2_load_messages_page`
- `chat_v2_cancel_stream`
- `chat_v2_goal_pause`
- `chat_v2_goal_resume`
- `chat_v2_goal_clear`
- `chat_v2_soft_delete_session`
- `chat_v2_reorder_groups`
- `chat_v2_move_session_to_group`
- `chat_v2_freeze_available_skills_snapshot`
- `chat_v2_list_sessions_referencing`
- `chat_v2_switch_variant`
- `chat_v2_delete_variant`
- `chat_v2_cancel_variant`
- `chat_v2_get_anki_cards_from_block_by_document_id`
- `chat_v2_delete_message`
- `chat_v2_delete_session`
- `chat_v2_empty_deleted_sessions`
- `chat_v2_export_session`
- `chat_v2_export_session_jsonl`
- `chat_v2_export_session_meta`
- `chat_v2_export_session_messages`
- `chat_v2_import_session`
- `chat_v2_kill_switch_status`
- `chat_v2_emergency_stop`
- `chat_v2_resume_agents`
- `chat_v2_resume_automations`
- `workspace_create`
- `workspace_get`
- `workspace_list_agents`
- `workspace_send_message`
- `workspace_close`
- `workspace_delete`
- `workspace_cancel_agent`
- `workspace_manual_wake`
- `workspace_cancel_sleep`
- `workspace_run_agent`
- `workspace_create_agent`
- `workspace_restore_executions`
- `workspace_list_messages`
- `workspace_set_context`
- `workspace_get_context`
- `workspace_list_documents`
- `workspace_get_document`
- `workspace_list_all`
- `workspace_list_agent_profiles`
- `workspace_read_agent_profile_file`
- `workspace_delete_agent_profile_file`
- `workspace_save_agent_profile_file`
- `chat_v2_create_group`
- `chat_v2_update_group`
- `chat_v2_get_group`
- `chat_v2_list_groups`
- `chat_v2_archive_group`
- `chat_v2_restore_group`
- `chat_v2_delete_group`
- `chat_v2_tool_approval_respond`
- `chat_v2_tool_approval_cancel`
- `chat_v2_clear_approval_history`
- `chat_v2_ask_user_respond`
- `chat_v2_check_migration_status`
- `chat_v2_migrate_legacy_chat`
- `chat_v2_rollback_migration`
- `chat_v2_undo_compaction`
- `chat_v2_compact_session`
- `chat_v2_retry_message`
- `chat_v2_edit_and_resend`
- `chat_v2_retry_variant`
- `chat_v2_retry_variants`
- `chat_v2_branch_session`
- `chat_v2_plan_gate_respond`
- `chat_v2_perform_ocr`
- `chat_v2_stage_context_attachments`
- `chat_v2_send_message`
- `chat_v2_wake_session`
- `chat_v2_continue_message`

</details>

<details><summary><code>dstu.llm</code>（20）</summary>

- `cancel_stream`
- `llm_get_failover_policy`
- `llm_set_failover_policy`
- `get_api_configurations`
- `save_api_configurations`
- `get_vendor_configs`
- `save_vendor_configs`
- `get_model_profiles`
- `save_model_profiles`
- `get_model_assignments`
- `save_model_assignments`
- `get_injection_budget_config`
- `simulate_budget_allocation`
- `estimate_tokens`
- `opencode_go_get_usage`
- `check_api_config_status`
- `restore_default_api_configs`
- `fetch_vendor_models`
- `call_llm_for_boundary`
- `test_api_connection`

</details>

<details><summary><code>dstu.llm-providers</code>（5）</summary>

- `openai_codex_auth_status`
- `openai_codex_login_cancel`
- `openai_codex_login_start`
- `openai_codex_logout`
- `openai_codex_usage`

</details>

<details><summary><code>dstu.mcp</code>（23）</summary>

- `get_mcp_config`
- `import_mcp_config`
- `export_mcp_config`
- `get_mcp_status`
- `get_mcp_tools`
- `save_mcp_config`
- `mcp_stdio_start`
- `mcp_stdio_send`
- `mcp_stdio_close`
- `get_mcp_stdio_allow_unapproved`
- `set_mcp_stdio_allow_unapproved`
- `test_mcp_connection`
- `test_mcp_websocket`
- `test_mcp_sse`
- `test_mcp_http`
- `test_rmcp_streamable_http`
- `reload_mcp_client`
- `preheat_mcp_tools`
- `start_mcp_oauth`
- `cancel_mcp_oauth`
- `revoke_mcp_oauth`
- `get_mcp_oauth_status`
- `get_mcp_oauth_access_token`

</details>

<details><summary><code>dstu.media</code>（74）</summary>

- `tts_check_available`
- `tts_speak`
- `tts_stop`
- `get_ocr_engine_type`
- `set_ocr_thinking_enabled`
- `save_available_ocr_models`
- `get_ocr_thinking_enabled`
- `get_ocr_engines`
- `get_ocr_prompt_template`
- `infer_ocr_engine_from_model`
- `validate_ocr_model`
- `set_ocr_engine_type`
- `remove_ocr_engine`
- `update_ocr_engine_priority`
- `add_ocr_engine`
- `get_available_ocr_models`
- `media_library_list`
- `media_related_notes`
- `media_chapters`
- `media_checkpoints`
- `media_study_ledger`
- `media_progress_get`
- `media_progress_set`
- `media_transcript_get`
- `media_transcript_export`
- `media_transcript_import`
- `media_transcribe_cancel`
- `media_transcribe_estimate`
- `media_transcribe_start`
- `textbooks_update_bookmarks`
- `textbooks_relink`
- `textbooks_add`
- `get_image_as_base64`
- `convert_heic_to_jpeg`
- `compress_image`
- `get_recent_document_tasks`
- `test_pdfium_status`
- `cancel_pdf_ocr_session`
- `pause_pdf_ocr_session`
- `resume_pdf_ocr_session`
- `skip_pdf_ocr_page`
- `get_pdf_ocr_temp_dir`
- `save_pdf_to_temp`
- `vfs_get_file_blob_path`
- `media_bilibili_auth_status`
- `media_bilibili_logout`
- `media_bilibili_login_qr_poll`
- `media_bilibili_login_qr_start`
- `media_bilibili_cancel`
- `media_bilibili_link_get`
- `media_bilibili_probe`
- `media_bilibili_create`
- `media_bilibili_import_subtitle`
- `media_bilibili_stream_quality`
- `media_bilibili_transport_status`
- `media_bilibili_transport_configure`
- `media_bilibili_bridge_pair`
- `media_bilibili_bridge_approve`
- `media_bilibili_bridge_disconnect`
- `voice_input_transcribe`
- `handout_cancel`
- `handout_release`
- `notes_export_docx`
- `pin_images`
- `unpin_images`
- `handout_llm_complete`
- `handout_vlm_caption`
- `parse_document_from_path`
- `parse_document_from_base64`
- `init_pdf_ocr_session`
- `upload_pdf_ocr_page`
- `process_pdf_ocr`
- `start_pdf_ocr_backend`
- `test_ocr_engine`

</details>

<details><summary><code>dstu.notes</code>（81）</summary>

- `notes_state_get`
- `notes_state_list`
- `notes_state_put`
- `notes_state_delete`
- `notes_create`
- `notes_get`
- `notes_update`
- `notes_delete`
- `notes_restore`
- `notes_set_favorite`
- `notes_list`
- `notes_list_meta`
- `notes_list_advanced`
- `notes_list_deleted`
- `notes_list_tags`
- `notes_search`
- `notes_get_backlinks`
- `notes_get_outgoing_links`
- `notes_rebuild_links`
- `notes_unlinked_mentions`
- `notes_db_stats`
- `notes_db_vacuum`
- `notes_relation_get`
- `notes_relation_list`
- `notes_relation_put`
- `notes_relation_delete`
- `notes_reference_status`
- `notes_invalidate_resource_refs`
- `notes_list_referencing_resource`
- `notes_get_format`
- `notes_enable_columns`
- `notes_migrate_blocks`
- `notes_history_current`
- `notes_history_list`
- `notes_history_get`
- `notes_history_set_pinned`
- `notes_history_get_retention`
- `notes_history_set_retention`
- `notes_history_restore_copy`
- `notes_history_restore_selection_copy`
- `notes_history_restore_current`
- `notes_transfer_blocks`
- `notes_undo_transfer`
- `notes_review_save_as`
- `notes_editor_register`
- `notes_editor_heartbeat`
- `notes_editor_unregister`
- `notes_editor_begin`
- `notes_editor_lease_status`
- `notes_editor_freeze_ack`
- `notes_editor_flush`
- `notes_editor_finish`
- `notes_editor_refresh_ack`
- `notes_editor_release`
- `notes_set_pref`
- `notes_get_pref`
- `notes_mentions_search`
- `canvas_note_read`
- `canvas_note_append`
- `canvas_note_replace`
- `canvas_note_set`
- `notes_save_asset`
- `notes_list_assets`
- `notes_assets_index_scan`
- `notes_delete_asset`
- `notes_assets_bulk_delete`
- `notes_resolve_asset_path`
- `notes_assets_scan_orphans`
- `notes_hard_delete`
- `notes_empty_trash`
- `notes_import_markdown`
- `notes_import_markdown_batch`
- `rag_rebuild_fts_index`
- `notes_rag_rebuild_fts_index`
- `notes_get_subject_rag_config`
- `notes_update_subject_rag_config`
- `notes_export`
- `notes_export_single`
- `notes_import`
- `chat_v2_canvas_edit_ack`
- `chat_v2_canvas_edit_result`

</details>

<details><summary><code>dstu.qbank</code>（88）</summary>

- `get_csv_exportable_fields`
- `get_csv_preview`
- `import_questions_csv`
- `cancel_questions_csv_import`
- `export_questions_csv`
- `list_importing_sessions`
- `list_exam_sheet_sessions`
- `get_exam_sheet_session_detail`
- `update_exam_sheet_cards`
- `rename_exam_sheet_session`
- `qbank_get_generation_task`
- `qbank_list_generation_tasks`
- `qbank_list_questions`
- `qbank_list_mistakes`
- `qbank_search_questions`
- `qbank_rebuild_fts_index`
- `qbank_get_question`
- `qbank_get_question_by_card_id`
- `qbank_create_question`
- `qbank_batch_create_questions`
- `qbank_update_question`
- `qbank_batch_update_questions`
- `qbank_delete_question`
- `qbank_batch_delete_questions`
- `qbank_submit_answer`
- `qbank_toggle_favorite`
- `qbank_get_stats`
- `qbank_count_by_type`
- `qbank_refresh_stats`
- `qbank_get_history`
- `qbank_get_submissions`
- `qbank_reset_progress`
- `qbank_reset_questions_progress`
- `qbank_create_practice`
- `qbank_save_practice`
- `qbank_get_practice`
- `qbank_list_practices`
- `qbank_submit_practice`
- `qbank_delete_practice`
- `qbank_list_papers`
- `qbank_get_paper`
- `qbank_update_paper`
- `qbank_grade_practice_manually`
- `qbank_generate_paper`
- `qbank_retry_practice_grading`
- `qbank_resume_practice_grading`
- `qbank_get_learning_trend`
- `qbank_get_activity_heatmap`
- `qbank_get_knowledge_stats`
- `qbank_get_knowledge_stats_with_comparison`
- `qbank_get_check_in_calendar`
- `qbank_get_daily_practice`
- `qbank_start_timed_practice`
- `qbank_generate_mock_exam`
- `qbank_submit_mock_exam`
- `qbank_list_structure`
- `qbank_update_group`
- `qbank_delete_group`
- `qbank_get_authoring_draft`
- `qbank_list_authoring_drafts`
- `qbank_review_authoring_draft`
- `qbank_update_material`
- `qbank_delete_material`
- `qbank_commit_authoring_draft`
- `qbank_resolve_authoring_route`
- `qbank_export_document`
- `qbank_export_portable`
- `qbank_export_paper_docx`
- `qbank_crop_source_image`
- `qbank_remove_question_image`
- `qbank_ai_generate_questions`
- `qbank_cancel_generation_task`
- `qbank_cancel_grading`
- `qbank_ai_grade`
- `qbank_legacy_audit`
- `qbank_legacy_migrate_selected`
- `qbank_get_source_page`
- `qbank_get_source_images`
- `qbank_reparse_report`
- `qbank_reparse_resolve`
- `get_learning_heatmap`
- `qbank_complete_paper_export`
- `inspect_pdf_text_for_qbank`
- `get_enhanced_statistics`
- `cancel_question_bank_import`
- `import_question_bank`
- `import_question_bank_stream`
- `resume_question_import`

</details>

<details><summary><code>dstu.review</code>（70）</summary>

- `study_time_add`
- `study_time_range`
- `mastery_get_overview`
- `fsrs_enqueue_cards`
- `fsrs_get_due`
- `fsrs_preview_intervals`
- `fsrs_rate`
- `fsrs_undo_last_review`
- `fsrs_suspend_card`
- `fsrs_bury_card`
- `fsrs_unbury_card`
- `fsrs_unsuspend_card`
- `fsrs_get_stats`
- `fsrs_get_review_statistics`
- `fsrs_get_memory_overview`
- `fsrs_get_card_memory_history`
- `fsrs_get_scheduler_config`
- `fsrs_update_scheduler_config`
- `fsrs_optimize_parameters`
- `fsrs_reset_card_progress`
- `review_plan_create`
- `review_plan_process`
- `review_plan_get_due`
- `review_plan_get_due_with_filter`
- `review_plan_get_stats`
- `review_plan_refresh_stats`
- `review_plan_get_by_question`
- `review_plan_get`
- `review_plan_suspend`
- `review_plan_resume`
- `review_plan_delete`
- `review_plan_get_history`
- `review_plan_batch_create`
- `review_plan_create_for_exam`
- `review_plan_list_by_exam`
- `review_plan_get_or_create`
- `review_plan_get_calendar_data`
- `essay_grading_stream`
- `essay_grading_create_session`
- `essay_grading_get_session`
- `essay_grading_update_session`
- `essay_grading_delete_session`
- `essay_grading_list_sessions`
- `essay_grading_toggle_favorite`
- `essay_grading_get_rounds`
- `essay_grading_get_round`
- `essay_grading_get_latest_round_number`
- `essay_grading_get_modes`
- `essay_grading_get_mode`
- `essay_grading_create_custom_mode`
- `essay_grading_update_custom_mode`
- `essay_grading_delete_custom_mode`
- `essay_grading_list_custom_modes`
- `essay_grading_save_builtin_override`
- `essay_grading_reset_builtin_mode`
- `essay_grading_has_builtin_override`
- `essay_grading_get_models`
- `insight_create_draft`
- `insight_confirm`
- `insight_correct`
- `insight_delete`
- `insight_get`
- `insight_list`
- `insight_list_revisions`
- `insight_list_evidence`
- `insight_list_relations`
- `insight_list_events`
- `insight_record_feedback`
- `insight_add_relation`
- `insight_run_jobs`

</details>

<details><summary><code>dstu.sync</code>（24）</summary>

- `data_governance_count_record_conflicts`
- `data_governance_discard_quarantine`
- `data_governance_discard_all_quarantine`
- `data_governance_get_sync_status`
- `data_governance_list_sync_snapshot_batches`
- `data_governance_purge_resolved_conflicts`
- `data_governance_list_quarantine`
- `data_governance_list_record_conflicts`
- `data_governance_resolve_conflicts`
- `data_governance_retry_quarantine`
- `data_governance_retry_all_quarantine`
- `data_governance_cancel_sync`
- `data_governance_export_sync_data`
- `data_governance_repo_check`
- `data_governance_detect_conflicts`
- `data_governance_detect_prune_gap`
- `data_governance_import_sync_data`
- `data_governance_resolve_record_conflict`
- `data_governance_rollback_sync_snapshot_batch`
- `data_governance_run_sync`
- `data_governance_run_sync_with_progress`
- `data_governance_mark_blob_deleted`
- `data_governance_mark_asset_deleted`
- `data_governance_list_unsynced_items`

</details>

<details><summary><code>dstu.sync-providers</code>（14）</summary>

- `cloud_storage_check_connection`
- `cloud_storage_delete`
- `cloud_storage_exists`
- `cloud_storage_get`
- `cloud_storage_is_s3_enabled`
- `cloud_storage_list`
- `cloud_storage_put`
- `cloud_storage_stat`
- `cloud_sync_delete_version`
- `cloud_sync_download`
- `cloud_sync_get_device_id`
- `cloud_sync_get_status`
- `cloud_sync_list_versions`
- `cloud_sync_upload`

</details>

<details><summary><code>dstu.translation</code>（6）</summary>

- `translate_text_stream`
- `translate_text_candidates`
- `cancel_translation_candidates`
- `stream_chat_translation_aligned`
- `stream_chat_translation_plain`
- `ocr_extract_text`

</details>

<details><summary><code>dstu.vfs</code>（6）</summary>

- `dstu_parse_path`
- `dstu_watch`
- `dstu_unwatch`
- `vfs_upload_attachment`
- `vfs_upload_file`
- `vfs_download_paper`

</details>

<details><summary><code>dstu.vfs-handlers</code>（1）</summary>

- `filestream_check_access`

</details>

<details><summary><code>dstu.vfs-index</code>（3）</summary>

- `clear_message_embeddings`
- `optimize_chat_embeddings_table`
- `optimize_lance_database`

</details>

<details><summary><code>dstu.platform.diagnostics</code>（9）</summary>

- `check_package_manager`
- `check_all_package_managers`
- `auto_install_package_manager`
- `debug_get_database_stats`
- `debug_vfs_textbook_pages`
- `debug_vfs_migration_status`
- `write_test_report`
- `check_test_dependencies`
- `toggle_devtools`

</details>

<details><summary><code>dstu.platform.cloud-config</code>（4）</summary>

- `cloud_config_ssot_save`
- `cloud_config_ssot_get`
- `cloud_config_ssot_clear`
- `cloud_config_publish`

</details>

<details><summary><code>dstu.platform.log</code>（14）</summary>

- `get_debug_logs_info`
- `clear_debug_logs`
- `cleanup_old_debug_logs`
- `read_debug_log_file`
- `ensure_debug_log_dir`
- `save_test_log`
- `get_test_logs`
- `open_log_file`
- `open_logs_folder`
- `write_debug_logs`
- `report_frontend_log`
- `log_debug_message`
- `tauri_lab_frontend_log`
- `export_diagnostics_bundle`

</details>

<details><summary><code>dstu.platform.secrets</code>（11）</summary>

- `secure_save_cloud_credentials`
- `secure_get_cloud_credentials`
- `secure_delete_cloud_credentials`
- `secure_clear_cloud_encryption_password`
- `secure_store_is_available`
- `secure_store_get_keystore_protection`
- `secure_store_set_keystore_protection`
- `secret_prompt_submit`
- `secret_prompt_status`
- `secret_prompt_discard`
- `secret_prompt_capabilities`

</details>

<details><summary><code>dstu.platform.storage</code>（33）</summary>

- `get_data_space_info`
- `get_slot_directory`
- `get_test_slot_info`
- `clear_test_slots`
- `mark_data_space_pending_switch_to_inactive`
- `purge_all_database_files`
- `purge_active_data_dir_now`
- `get_startup_recovery_status`
- `retry_startup_recovery_preflight`
- `list_startup_recovery_incidents`
- `resolve_startup_recovery`
- `open_startup_recovery_incident_folder`
- `restart_app`
- `export_startup_recovery_incident`
- `export_startup_recovery_report`
- `get_database_info`
- `set_test_run_id`
- `switch_to_test_database`
- `reset_test_database`
- `switch_to_production_database`
- `seed_test_database`
- `staged_upload_begin`
- `staged_upload_append`
- `staged_upload_from_path`
- `staged_upload_abort`
- `llm_usage_get_trends`
- `llm_usage_by_model`
- `llm_usage_by_caller`
- `llm_usage_summary`
- `llm_usage_session_summary`
- `llm_usage_recent`
- `llm_usage_daily`
- `llm_usage_cleanup`

</details>

## 4. 事件

契约事件 127 个（来自 contracts/ipc）。lane 对应插件见第 3 节。

| 事件 | lane | 名称 | 载荷 | 插件 |
| --- | --- | --- | --- | --- |
| `{}_cancelled` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_error` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_id` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_memory_sources` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_rag_sources` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_reasoning` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_safety_blocked` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_start` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_truncated` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_unified_sources` | F4-security | 动态名 | — | dstu.platform.diagnostics<br>dstu.platform.cloud-config<br>dstu.platform.log<br>dstu.platform.secrets |
| `{}_usage` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_web_search` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `{}_web_search` | L19-mcp-browser | 动态名 | — | dstu.browser<br>dstu.mcp |
| `{}-closed` | L19-mcp-browser | 动态名 | — | dstu.browser<br>dstu.mcp |
| `{}-error` | L19-mcp-browser | 动态名 | — | dstu.browser<br>dstu.mcp |
| `{}-message` | L19-mcp-browser | 动态名 | — | dstu.browser<br>dstu.mcp |
| `acr:bridge-cancel` | L07-agent-skills-ptc | 静态 | `AcrBridgeCancel` | dstu.agent-skills |
| `acr:bridge-request` | L07-agent-skills-ptc | 静态 | `AcrBridgeRequest` | dstu.agent-skills |
| `anki_generation_event` | L16-anki | 静态 | — | dstu.anki |
| `backup-import-progress` | L21-backup-governance | 静态 | `dstu_storage__backup_common__ImportProgress` | dstu.backup |
| `backup-job-progress` | L21-backup-governance | 静态 | — | dstu.backup |
| `backup-jobs-resumable` | F2-shell | 静态 | — | — |
| `browser:closed` | L19-mcp-browser | 静态 | `BrowserClosedPayload` | dstu.browser<br>dstu.mcp |
| `browser:content-user-input` | L19-mcp-browser | 静态 | `BrowserContentUserInputPayload` | dstu.browser<br>dstu.mcp |
| `browser:control-mode-changed` | L19-mcp-browser | 静态 | `BrowserControlModeChangedPayload` | dstu.browser<br>dstu.mcp |
| `browser:navigated` | L19-mcp-browser | 静态 | `BrowserNavigatedPayload` | dstu.browser<br>dstu.mcp |
| `browser:navigation-blocked` | L19-mcp-browser | 静态 | `BrowserNavigationBlockedPayload` | dstu.browser<br>dstu.mcp |
| `browser:title-changed` | L19-mcp-browser | 静态 | `BrowserTitleChangedPayload` | dstu.browser<br>dstu.mcp |
| `canvas:ai-edit-request` | L10-notes | 静态 | `CanvasAIEditRequest` | dstu.notes |
| `chat_translation_{}` | L02-llm-manager | 动态名 | `ChatTranslationEvent` | dstu.llm<br>dstu.translation |
| `chat_v2_automation_run_completed` | L06-agent-orchestration | 静态 | — | dstu.agent-orchestration |
| `chat_v2_llm_request_body` | L02-llm-manager | 静态 | — | dstu.llm<br>dstu.translation |
| `chat_v2_migration` | L04-chat-session | 静态 | `MigrationEvent` | dstu.chat |
| `chat_v2_request_audit` | L04-chat-session | 静态 | — | dstu.chat |
| `chat_v2_session_{}` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `chat_v2_session_{}` | L04-chat-session | 动态名 | — | dstu.chat |
| `chat_v2_session_{}` | L06-agent-orchestration | 动态名 | — | dstu.agent-orchestration |
| `chat_v2://automations_changed` | L06-agent-orchestration | 静态 | — | dstu.agent-orchestration |
| `chat_v2://kill_switch_changed` | L04-chat-session | 静态 | `KillSwitchStatus` | dstu.chat |
| `chat_v2://model_assignments_changed` | L02-llm-manager | 静态 | — | dstu.llm<br>dstu.translation |
| `chat_v2://model_profiles_changed` | L02-llm-manager | 静态 | — | dstu.llm<br>dstu.translation |
| `chat_v2://settings_changed` | L02-llm-manager | 静态 | — | dstu.llm<br>dstu.translation |
| `chat_v2://settings_changed` | L07-agent-skills-ptc | 静态 | — | dstu.agent-skills |
| `cloud-sync-progress` | L23-sync-providers | 静态 | `CloudSyncProgressEvent` | dstu.sync-providers |
| `csv_import_progress` | L14-qbank | 静态 | `CsvImportProgress` | dstu.qbank |
| `data-governance-migration-status` | F2-shell | 静态 | — | — |
| `data-governance-sync-progress` | L20-sync | 静态 | `SyncProgress` | dstu.sync<br>dstu.sync-support |
| `deepseek_ocr_log` | L02-llm-manager | 静态 | — | dstu.llm<br>dstu.translation |
| `dstu:change` | L13-vfs-api | 静态 | — | dstu.vfs<br>dstu.vfs-handlers |
| `dstu:change` | L18-media-docs | 静态 | — | dstu.media |
| `dstu:change:{}` | L13-vfs-api | 动态名 | — | dstu.vfs<br>dstu.vfs-handlers |
| `dstu:change:{}` | L18-media-docs | 动态名 | — | dstu.media |
| `essay_grading_stream_{}` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `fsrs://changed` | L15-review-analytics | 静态 | — | dstu.review |
| `fsrs://changed` | L16-anki | 静态 | — | dstu.anki |
| `fsrs://changed` | L24-chatanki | 静态 | — | dstu.chatanki |
| `hpias_event` | L17-memory-research | 静态 | — | dstu.memory |
| `llm-failover` | L02-llm-manager | 静态 | — | dstu.llm<br>dstu.translation |
| `mcp_tools_changed` | F2-shell | 静态 | — | — |
| `mcp-bridge-request` | L19-mcp-browser | 静态 | — | dstu.browser<br>dstu.mcp |
| `mcp-bridge-tools-request` | L02-llm-manager | 静态 | — | dstu.llm<br>dstu.translation |
| `mcp-test-progress` | L19-mcp-browser | 静态 | — | dstu.browser<br>dstu.mcp |
| `media_bilibili_playback_error` | L18-media-docs | 静态 | — | dstu.media |
| `media-processing-completed` | L12-vfs-index | 静态 | — | dstu.vfs-index |
| `media-processing-error` | L12-vfs-index | 静态 | `MediaProcessingErrorEvent` | dstu.vfs-index |
| `media-processing-progress` | L12-vfs-index | 静态 | — | dstu.vfs-index |
| `memory://changed` | L17-memory-research | 静态 | — | dstu.memory |
| `menu://close-window` | F2-shell | 静态 | — | — |
| `menu://command-palette` | F2-shell | 静态 | — | — |
| `menu://documentation` | F2-shell | 静态 | — | — |
| `menu://new-session` | F2-shell | 静态 | — | — |
| `menu://preferences` | F2-shell | 静态 | — | — |
| `menu://report-issue` | F2-shell | 静态 | — | — |
| `menu://toggle-sidebar` | F2-shell | 静态 | — | — |
| `mistake_status_update` | L14-qbank | 静态 | — | dstu.qbank |
| `mm_index_progress` | L13-vfs-api | 静态 | `IndexProgressEvent` | dstu.vfs<br>dstu.vfs-handlers |
| `notes-import-progress` | L10-notes | 静态 | `dstu_notes__notes_exporter__ImportProgress` | dstu.notes |
| `notes:format-changed` | L10-notes | 静态 | — | dstu.notes |
| `notes:lease-changed` | L10-notes | 静态 | `LeaseStatus` | dstu.notes |
| `notes:lease-ended` | L10-notes | 静态 | — | dstu.notes |
| `notes:review-saved` | L10-notes | 静态 | `ReviewSaveResult` | dstu.notes |
| `notes:state-changed` | L10-notes | 静态 | `NoteState` | dstu.notes |
| `notes:transfer-completed` | L10-notes | 静态 | `TransferResult` | dstu.notes |
| `pdf_ocr_progress` | L18-media-docs | 静态 | — | dstu.media |
| `pdf-annotations:changed` | L13-vfs-api | 静态 | — | dstu.vfs<br>dstu.vfs-handlers |
| `pdf-annotations:changed` | L18-media-docs | 静态 | — | dstu.media |
| `pdf-processing-completed` | L12-vfs-index | 静态 | `MediaProcessingCompletedEvent` | dstu.vfs-index |
| `pdf-processing-error` | L12-vfs-index | 静态 | `MediaProcessingErrorEvent` | dstu.vfs-index |
| `pdf-processing-progress` | L12-vfs-index | 静态 | `MediaProcessingProgressEvent` | dstu.vfs-index |
| `plugin-activity` | F1-kernel | 静态 | `ActivityPayload` | — |
| `plugin-qrcode` | F1-kernel | 静态 | `QrcodePayload` | — |
| `plugin-state-changed` | F1-kernel | 静态 | `StateChangedPayload` | — |
| `qbank_generation_task_event` | L14-qbank | 静态 | `GenerationTaskView` | dstu.qbank |
| `qbank_grading_stream_{}` | L14-qbank | 动态名 | — | dstu.qbank |
| `qbank_grading_stream_{stream_session_id}` | L14-qbank | 动态名 | `QbankGradingStreamError` | dstu.qbank |
| `qbank-export-paper` | L14-qbank | 静态 | `ExportRequest` | dstu.qbank |
| `qbank-practice-updated` | L14-qbank | 静态 | — | dstu.qbank |
| `qbank://changed` | L14-qbank | 静态 | — | dstu.qbank |
| `question_import_progress` | L14-qbank | 静态 | `QuestionImportProgress` | dstu.qbank |
| `quick-assistant://shown` | L17-memory-research | 静态 | — | dstu.memory |
| `review://changed` | L14-qbank | 静态 | — | dstu.qbank |
| `session_management_change` | L06-agent-orchestration | 静态 | — | dstu.agent-orchestration |
| `skill-lifecycle-bridge-request` | L07-agent-skills-ptc | 静态 | — | dstu.agent-skills |
| `stream_error` | L02-llm-manager | 静态 | — | dstu.llm<br>dstu.translation |
| `super_session_changed` | L06-agent-orchestration | 静态 | `ChangedPayload` | dstu.agent-orchestration |
| `super_session_inbox_changed` | L06-agent-orchestration | 静态 | `InboxChangedPayload` | dstu.agent-orchestration |
| `textbook-import-progress` | L18-media-docs | 静态 | `TextbookImportProgress` | dstu.media |
| `todo://changed` | L06-agent-orchestration | 静态 | — | dstu.agent-orchestration |
| `todo://changed` | L10-notes | 静态 | — | dstu.notes |
| `todo://changed` | L13-vfs-api | 静态 | — | dstu.vfs<br>dstu.vfs-handlers |
| `translation_candidates_{}` | L02-llm-manager | 动态名 | `TranslationCandidatesEvent` | dstu.llm<br>dstu.translation |
| `translation_stream_{}` | L02-llm-manager | 动态名 | — | dstu.llm<br>dstu.translation |
| `vfs-index-progress` | L12-vfs-index | 静态 | — | dstu.vfs-index |
| `vfs-index-progress` | L13-vfs-api | 静态 | — | dstu.vfs<br>dstu.vfs-handlers |
| `vfs-index-progress` | L19-mcp-browser | 静态 | — | dstu.browser<br>dstu.mcp |
| `workspace_agent_completion` | L04-chat-session | 静态 | — | dstu.chat |
| `workspace_agent_joined` | L05-agent-workspace | 静态 | `WorkspaceAgentEvent` | dstu.agent-workspace |
| `workspace_agent_left` | L05-agent-workspace | 静态 | `WorkspaceAgentEvent` | dstu.agent-workspace |
| `workspace_agent_status_changed` | L05-agent-workspace | 静态 | `AgentStatusEvent` | dstu.agent-workspace |
| `workspace_closed` | L05-agent-workspace | 静态 | `WorkspaceClosedEvent` | dstu.agent-workspace |
| `workspace_coordinator_awakened` | L05-agent-workspace | 静态 | `CoordinatorAwakenedEvent` | dstu.agent-workspace |
| `workspace_document_updated` | L05-agent-workspace | 静态 | `WorkspaceDocumentEvent` | dstu.agent-workspace |
| `workspace_message_received` | L05-agent-workspace | 静态 | `WorkspaceMessageEvent` | dstu.agent-workspace |
| `workspace_warning` | L05-agent-workspace | 静态 | `WorkspaceWarningEvent` | dstu.agent-workspace |
| `workspace_worker_ready` | L04-chat-session | 静态 | — | dstu.chat |
| `workspace_worker_ready` | L05-agent-workspace | 静态 | — | dstu.agent-workspace |
| `workspace_worker_ready` | L06-agent-orchestration | 静态 | — | dstu.agent-orchestration |

## 5. 服务边界检查

本节由生成器静态检查，报告的是**需要提供方/消费方确认**的 seam 问题；不代替运行时 profile 校验。

### 5.1 声明了但未 provide（2）

“可选声明”指 `api.ts` 中类型带 `?` 的服务（例如由 F2/main 在运行时注入的端口）。

| 服务 | 可选声明 | 声明位置 | 消费方 |
| --- | --- | --- | --- |
| `browserSurface` | 是 | host/plugins/browser/api.ts | dstu.browser |
| `vfsRepo` | 否 | host/plugins/vfs/api.ts | dstu.chat-pipeline<br>dstu.llm<br>dstu.memory<br>dstu.notes<br>dstu.sync<br>dstu.sync-support<br>dstu.vfs<br>dstu.vfs-handlers<br>dstu.agent-orchestration<br>dstu.agent-workspace<br>dstu.anki<br>dstu.browser<br>dstu.media<br>dstu.qbank<br>dstu.review |

### 5.2 提供了但未在 api.ts 声明（2）

| 服务 | 提供方 | 运行时 provide 位置 |
| --- | --- | --- |
| `nativeWindowsSandbox` | dstu.native | dstu.native |
| `vfsUnitBuilder` | dstu.vfs-index | dstu.vfs-index |

### 5.3 多个提供方（0）

无。

### 5.4 消费了但既未声明也未提供（5）

| 服务名 | 消费方 |
| --- | --- |
| `chatToolRuntime` | ctx.get：dstu.chat-pipeline |
| `startupGate` | ctx.get：dstu.agent-orchestration<br>ctx.get：dstu.backup<br>ctx.get：dstu.platform.storage |
| `systemNotification` | ctx.get：dstu.agent-orchestration<br>ctx.get：dstu.chat |
| `vfsMaintenance` | inject：dstu.vfs-handlers<br>ctx.get：dstu.backup |
| `virtualFilePolicy` | ctx.get：dstu.vfs |

### 5.5 meta.provides 与运行时 provide 不一致（6）

| 插件 | 服务 | 问题 |
| --- | --- | --- |
| `dstu.chat` | `chatState` | meta 声明了，源码中未找到 provide 调用（可能是动态注册） |
| `dstu.chat` | `chatSession` | meta 声明了，源码中未找到 provide 调用（可能是动态注册） |
| `dstu.integration` | `appCommandState` | meta 声明了，源码中未找到 provide 调用（可能是动态注册） |
| `dstu.sync-providers` | `syncProvider` | meta 声明了，源码中未找到 provide 调用（可能是动态注册） |
| `dstu.platform.cloud-config` | `cloudConfig` | 运行时 provide 了，但 meta.provides 未声明（安装会失败） |
| `dstu.platform.storage` | `storageStartupSync` | 运行时 provide 了，但 meta.provides 未声明（安装会失败） |

### 5.6 绕过 api.ts 的跨插件 import（0）

无。

### 5.7 命令声明与契约（未知 0，重复 0）

无。

### 5.8 服务声明不在提供方 api.ts（2）

消费方通常会按“声明位置”去 import 类型；声明与提供分离会让 seam 的归属不清晰，需要提供方确认。

| 服务 | 提供方 | 声明位置 |
| --- | --- | --- |
| `storageStartupSync` | dstu.sync | host/platform/storage/api.ts |
| `webSearch` | dstu.browser | host/plugins/mcp/api.ts |

### 5.9 服务名不符合约定（0）

`ctx` 上的服务名应为 lowerCamelCase，不含版本号、点号或 `@`；版本通过 `api.ts` 描述对象声明，
破坏性变更使用新名字（如 `ankiV2`），旧服务保留一个周期，见 `ARCHITECTURE.md` §3。

无。

### 5.10 已提供但无运行时消费方（51）

提供方已注册服务，但除提供方自身外没有 `inject` / `ctx.get` 使用；可能是生产路径未接线，需确认。

| 服务 | 提供方 |
| --- | --- |
| `agentApproval` | dstu.agent-workspace |
| `agentAutomation` | dstu.agent-orchestration |
| `agentCompletionOutbox` | dstu.agent-workspace |
| `agentSkills` | dstu.agent-skills |
| `agentSubagent` | dstu.agent-orchestration |
| `agentTodo` | dstu.agent-orchestration |
| `agentTransformSandbox` | dstu.agent-workspace |
| `agentWorkspaceTools` | dstu.agent-workspace |
| `browser` | dstu.browser |
| `browserToolPolicy` | dstu.browser |
| `chatankiTools` | dstu.chatanki |
| `chatAttachmentErrors` | dstu.chat |
| `chatRetrievalScope` | dstu.chat |
| `dataSpace` | dstu.platform.storage |
| `diagnostics` | dstu.platform.diagnostics |
| `dstu` | dstu.vfs |
| `essayGrading` | dstu.llm |
| `fileManagerPaths` | dstu.platform.storage |
| `hpiasResearch` | dstu.memory |
| `imageQuality` | dstu.platform.storage |
| `insight` | dstu.memory |
| `lanceEngine` | dstu.vfs-index |
| `llmEmbeddingModels` | dstu.llm |
| `llmFileOcr` | dstu.llm |
| `llmMcpTools` | dstu.llm |
| `llmModel2Messages` | dstu.llm |
| `llmMultimodal` | dstu.llm-providers |
| `llmOcr` | dstu.llm-providers |
| `llmOcrHedge` | dstu.llm |
| `llmOcrRegions` | dstu.llm |
| `llmProviderRequests` | dstu.llm |
| `llmQuestionParsing` | dstu.llm |
| `llmRag` | dstu.llm |
| `llmUsage` | dstu.platform.storage |
| `mcp` | dstu.mcp |
| `media` | dstu.media |
| `mediaTranscriber` | dstu.media |
| `memory` | dstu.memory |
| `memoryRetrieval` | dstu.memory |
| `memoryToolMetadata` | dstu.memory |
| `nativeArgon2` | dstu.native |
| `nativeFsrs` | dstu.native |
| `nativeProtobuf` | dstu.native |
| `nativeWindowsSandbox` | dstu.native |
| `noteAssets` | dstu.platform.storage |
| `ocr` | dstu.media |
| `questionImportVision` | dstu.media |
| `translation` | dstu.translation |
| `vector` | dstu.vector |
| `vfsHooks` | dstu.vfs-handlers |
| `webpageToolPolicy` | dstu.browser |

## 6. 维护方式

- 新增/删除服务、命令、事件后运行 `node scripts/plugin-catalog/generate.mjs`，把结果与源码一起提交。
- CI 运行 `node scripts/plugin-catalog/generate.mjs --check`；文档与源码不一致时退出码 1。
- 服务接口以 `contracts/services/` 的草稿为评审依据；发布后消费方只从提供方 `api.ts` 导入类型。

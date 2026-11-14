// Reviewed classifications, not an allowlist: these never suppress missing names or --check.
// No-cross-plugin-consumer alone does not mean the feature is unreachable.
export const classifications = {
  agentSkills: ['command-surface', 'host/plugins/agent-skills/index.ts:208-259: skill_* commands call the same SkillsService instance'],
  browser: ['command-surface', 'host/plugins/browser/index.ts:92-135: browser_* commands call browserService'],
  diagnostics: ['command-surface', 'host/platform/diagnostics/index.ts:23-31: package-manager commands call service'],
  dstu: ['command-surface', 'host/plugins/vfs/index.ts:98-99: dstu_parse_path uses the same parseDstuPath function'],
  governance: ['command-surface', 'host/plugins/backup/index.ts:107-108,117-130: data_governance_* commands'],
  media: ['command-surface', 'host/plugins/media/index.ts:126-187: TTS/media commands; PDF gaps are separate findings'],
  memory: ['command-surface', 'host/plugins/memory/index.ts:90-245: memory_* commands call service; maintenance gaps remain'],
  plugins: ['command-surface', 'host/kernel/plugins.ts:80-118: plugin_* commands call manager'],
  'sync@1': ['command-surface', 'host/plugins/sync/index.ts:73-103: sync commands use service; SyncManager integration remains separate'],
  translation: ['command-surface', 'host/plugins/translation/index.ts:22-52: five commands and the exposed service share commands'],
  lanceEngine: ['local-implementation', 'host/plugins/vfs-index/index.ts:65-67,160-175: same local engine feeds VFS stores'],
  nativeFsrs: ['bypassed', 'host/plugins/review/src/fsrs-scheduler.ts:11,106-111: direct native module import, no Cordis substitution'],
  nativeRegex: ['bypassed', 'host/plugins/agent-workspace/src/tools/code-navigation.ts:17; host/plugins/notes/src/canvas-commands.ts:5: direct imports'],
  nativeStarlark: ['bypassed', 'host/plugins/agent-skills/src/tools/ptc-runtime.ts:12: direct import; executor roster still missing'],
  nativeCompression: ['bypassed', 'host/plugins/anki/src/apkg-import-zstd.ts:4,68-74: direct node:zlib instead of F7 codec service'],
  nativeProtobuf: ['bypassed', 'host/plugins/media/src/bilibili-grpc.ts:6,24-65: local protobuf/gzip implementation instead of F7 service'],
  featureFlags: ['bypassed', 'host/plugins/browser/index.ts:11,316-320: independent FeatureFlagManager instead of F3 service'],
  injectionBudget: ['bypassed', 'host/plugins/llm/index.ts:15-18,205: independent InjectionBudgetManager instead of F3 service'],
  // 9c13dfc39 review: paths below describe construction and method callers, not proof of apply/request success.
  mcp: ['local-implementation', 'host/plugins/mcp/index.ts:24-46,67-82 calls initializeGlobalClient in backend mode and dispose on the same provided instance; registry.callTool still needs the external dispatcher'],
  llmAdapterInfos: ['island', 'host/plugins/llm/index.ts:100 exposes registry.ts:115 listAdapterInfos; anki/src/model-adapters.ts:28 still gets llm.adapter-infos@1 instead of this service (W15)'],
  llmEmbeddingModels: ['island', 'host/plugins/llm/index.ts:101 creates the settings/model resolver; vfs-index/src/runtime-adapter.ts:141-168 still resolves assignments itself and waits for embedding@1 (W06)'],
  llmOcrModels: ['island', 'host/plugins/llm/index.ts:102-106 passes the same models to hedge/regions; their conditional calls exist at ocr_hedge_service.ts:87 and ocr_regions_service.ts:28, but neither outer request entry is wired (W06)'],
  llmOcrRegions: ['island', 'host/plugins/llm/index.ts:105-106 provides parse; ocr_regions_service.ts:27-80 performs dimensions/adapter parsing only if called, with no command/consumer request edge (W06)'],
  llmOcrHedge: ['island', 'host/plugins/llm/index.ts:104 provides prepareCandidates/runPrepared; ocr_hedge_service.ts:68,102,138 has the real conditional chain, but no production request driver (W06)'],
  llmStreaming: ['island', 'host/plugins/llm/index.ts:93-95,104 passes streaming to parsing/hedge; their singleShotCompletion sites at question_parsing_service.ts:79,85 and ocr_hedge_service.ts:138 are conditional on currently unwired outer requests (W05/W06)'],
  llmModel2Messages: ['island', 'host/plugins/llm/index.ts:96 exports buildModel2Messages as build; model2_messages.ts:54 is the implementation, with no production model2 request call into this service (W01/W05)'],
  llmProviderRequests: ['island', 'host/plugins/llm/index.ts:97 exposes provider_requests_service.ts:11 prepareModel2; shared preparePlainProviderRequest has other callers but this role-specific wrapper is not consumed (W01/W05)'],
  llmQuestionParsing: ['island', 'host/plugins/llm/index.ts:95 creates parse/parseStreaming; question_parsing_service.ts:77-98 drives real streaming when called, but no qbank command consumes the provided instance (W05)'],
  llmRag: ['rust-unwired-candidate', 'rag_service.ts:17 translateText mirrors Rust rag_extension.rs:896 translate_text (definition without a caller); active translation_executor.rs:1028 uses run_translation, not this helper. No new production activation; adjudication remains separate'],
  vfsIndexMaintenance: ['island', 'vfs-index/index.ts:179-190 shares unitIndex with the used unit builder/background sync; unit-sync-service.ts:114,140 maintenance methods are not reached by handlers, which still call deps.maintenance at index-admin.ts:74,110 (W09)'],
  browserToolPolicy: ['island', 'browser/index.ts:94 exposes the singleton from src/tool-executor.ts:192-208; browser commands call browserService, not this policy; agent roster/policy invocation remains unwired (W02)'],
  webpageToolPolicy: ['island', 'browser/index.ts:95 exposes indexWebpageToolPolicy from src/index-webpage.ts:217-225; no VFS persistence/executor method consumes it (W02)'],
  // Newly visible in the refreshed main; do not turn implementation presence into request completion.
  llmStreamEvents: ['island', 'llm/index.ts:98 exposes model2_stream_events.ts:136 createStreamEventsService; the outer model2 stream driver has not connected it (W01/W05)'],
  llmAnkiRouting: ['island', 'llm/index.ts:99 exposes anki_routing_service.ts:12-30; Anki generation still waits on generation-port.ts:39,56 rather than this role resolver (W04/W05)'],
  llmCodexAuth: ['command-surface', 'llm-providers/index.ts:63-92,101-123 shares the same manager between the provided auth service and real OAuth commands; request preparation/refresh consumers remain separate'],
  runtimeRoots: ['command-surface', 'agent-workspace/index.ts:105-114 exposes the same runtimeRootById/revalidate functions used by runtime directory commands; cross-plugin group/root lookup still needs W10'],
  vfsWorker: ['island', 'vfs-repos/index.ts:138-139 constructs and disposes the lazy worker; a disposal hook alone does not invoke owner worker operations (W09)'],
  startupGate: ['island', 'electron/index.ts:35-36 provides the gate; no completion mark/finalizer registration is connected. Profile inclusion is fixed; D2 startup completion still needs F3/F2 wiring (W21)'],
  nativeHeic: ['not-approved', 'D5/D9 (docs/dev/electron-migration/decisions.md:129,152) prohibit backend HEIC expansion: Rust desktop returns its validation error. Do not install libheif-js or wire a new successful backend'],
};

// Real islands: expected production call sites are enumerated by task in X4-wiring-audit.md.
export const islands = {
  agentCompletionOutbox: 'W03', agentVfsResolver: 'W02', agentWorkspaceTools: 'W02',
  backgroundTasks: 'W17', chatankiTools: 'W02/W04',
  llmMultimodal: 'W06', llmOcr: 'W06', nativeAudio: 'W08',
  nativeHeic: 'W08', nativeImage: 'W08', nativeOfficeText: 'W08', nativePdfium: 'W07',
  noteAssets: 'W17', syncSupport: 'W13', vfsHooks: 'W11', websearch: 'W02',
};

# 跨 lane 服务草稿：L12-vfs-index

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（77 个条目，其中 77 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_vfs::vfs::lance_store::VfsLanceStore` | struct | `crates/dstu-vfs/src/vfs/lance_store.rs:148` | L17-memory-research 39/0<br>L13-vfs-api 33/0<br>L05-agent-workspace 3/0<br>L03-chat-pipeline 2/0<br>L04-chat-session 2/0<br>L10-notes 2/0<br>L07-agent-skills-ptc 1/0<br>L11-vfs-repos 1/0<br>F2-shell 1/0<br>L22-app-commands 0/2 | `pub struct VfsLanceStore` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService` | struct | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:573` | L13-vfs-api 13/0<br>L18-media-docs 12/0<br>L03-chat-pipeline 2/0<br>L04-chat-session 2/0<br>L07-agent-skills-ptc 1/0<br>L22-app-commands 1/1 | `pub struct PdfProcessingService` |
| `dstu_vfs::vfs::pdf_processing_service::ProcessingStage` | enum | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:134` | L13-vfs-api 9/0<br>L18-media-docs 5/2 | `pub enum ProcessingStage` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore::new` ? | method | `crates/dstu-vfs/src/vfs/lance_store.rs:165` | L03-chat-pipeline 6/0<br>L17-memory-research 4/0<br>L05-agent-workspace 1/0<br>L13-vfs-api 1/0<br>F2-shell 1/0<br>L22-app-commands 0/2 | `pub fn new(db: Arc<VfsDatabase>) -> VfsResult<Self>` |
| `dstu_vfs::vfs::retrieval_planner::ActiveGenerationModel` ? | enum | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:257` | L03-chat-pipeline 11/7<br>L13-vfs-api 1/0 | `pub enum ActiveGenerationModel` |
| `dstu_vfs::vfs::retrieval_planner::FusedRetrievalHit` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:763` | L17-memory-research 6/6<br>L13-vfs-api 3/1 | `pub struct FusedRetrievalHit` |
| `dstu_vfs::vfs::retrieval_planner::GenerationRoute` ? | enum | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:264` | L03-chat-pipeline 6/5<br>L04-chat-session 1/0<br>L13-vfs-api 1/0 | `pub enum GenerationRoute` |
| `dstu_vfs::vfs::retrieval_planner::QueryModality` | enum | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:239` | L03-chat-pipeline 3/5<br>L17-memory-research 3/0<br>L13-vfs-api 2/0 | `pub enum QueryModality` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService::new` | method | `crates/dstu-vfs/src/vfs/indexing.rs:1888` | L13-vfs-api 3/0<br>L17-memory-research 2/0<br>L19-mcp-browser 1/0<br>F2-shell 1/0 | `pub fn new( db: Arc<VfsDatabase>, llm_manager: Arc<LLMManager>, lance_store: Arc<VfsLanceStore>, ) -> VfsResult<Self>` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:1875` | L13-vfs-api 3/0<br>L17-memory-research 2/0<br>L19-mcp-browser 1/0 | `pub struct VfsFullIndexingService` |
| `dstu_vfs::vfs::retrieval_planner::CapabilityState::unavailable` | method | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:165` | L03-chat-pipeline 5/3 | `pub const fn unavailable() -> Self` |
| `dstu_vfs::vfs::retrieval_planner::CapabilitySnapshot` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:206` | L13-vfs-api 2/0<br>L03-chat-pipeline 1/4<br>L04-chat-session 1/0 | `pub struct CapabilitySnapshot` |
| `dstu_vfs::lance_vector_store::LanceVectorStore::new` | method | `crates/dstu-vfs/src/lance_vector_store.rs:644` | L22-app-commands 3/0<br>F2-shell 1/0 | `pub fn new(database: Arc<Database>) -> Result<Self>` |
| `dstu_vfs::vfs::indexing::VfsFullSearchService` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:4816` | L05-agent-workspace 3/0<br>L13-vfs-api 1/0 | `pub struct VfsFullSearchService` |
| `dstu_vfs::vfs::indexing::VfsIndexingService::new` | method | `crates/dstu-vfs/src/vfs/indexing.rs:1587` | L13-vfs-api 3/0<br>F2-shell 1/0 | `pub fn new(db: Arc<VfsDatabase>) -> Self` |
| `dstu_vfs::vfs::indexing::VfsSearchParams` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:4641` | L13-vfs-api 3/0<br>L05-agent-workspace 1/0 | `pub struct VfsSearchParams` |
| `dstu_vfs::vfs::indexing::VfsSearchResult` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:4677` | L13-vfs-api 3/0<br>L05-agent-workspace 1/0 | `pub struct VfsSearchResult` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalRouteFailure` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:735` | L13-vfs-api 4/0 | `pub struct RetrievalRouteFailure` |
| `dstu_vfs::vfs::retrieval_planner::CapabilityState::available` ? | method | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:176` | L03-chat-pipeline 3/7 | `pub const fn available() -> Self` |
| `dstu_vfs::vfs::embedding_service::EmbeddingProgressCallback` | type | `crates/dstu-vfs/src/vfs/embedding_service.rs:43` | L13-vfs-api 2/0<br>L19-mcp-browser 1/0 | `pub type EmbeddingProgressCallback = Box<dyn Fn(usize, usize) + Send + Sync>` |
| `dstu_vfs::vfs::indexing::VfsIndexingService` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:1582` | L13-vfs-api 3/0 | `pub struct VfsIndexingService` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalService` | struct | `crates/dstu-vfs/src/vfs/multimodal_service.rs:156` | L13-vfs-api 2/0<br>L03-chat-pipeline 1/0 | `pub struct VfsMultimodalService` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalService::new` ? | method | `crates/dstu-vfs/src/vfs/multimodal_service.rs:165` | L03-chat-pipeline 1/0<br>L13-vfs-api 1/0<br>F2-shell 1/0 | `pub fn new( vfs_db: Arc<VfsDatabase>, llm_manager: Arc<LLMManager>, lance_store: Arc<VfsLanceStore>, ) -> Self` |
| `dstu_vfs::vfs::pdf_processing_service::ProcessingStatus` | struct | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:285` | L13-vfs-api 3/0 | `pub struct ProcessingStatus` |
| `dstu_vfs::vfs::unified_retriever::UnifiedRetrievalRequest` | struct | `crates/dstu-vfs/src/vfs/unified_retriever.rs:103` | L17-memory-research 2/0<br>L13-vfs-api 1/0 | `pub struct UnifiedRetrievalRequest` |
| `dstu_vfs::vfs::unified_retriever::UnifiedRetrievalResponse` | struct | `crates/dstu-vfs/src/vfs/unified_retriever.rs:158` | L13-vfs-api 3/0 | `pub struct UnifiedRetrievalResponse` |
| `dstu_vfs::vfs::unified_retriever::VfsUnifiedRetriever::new` | method | `crates/dstu-vfs/src/vfs/unified_retriever.rs:192` | L17-memory-research 2/0<br>L13-vfs-api 1/0 | `pub fn new( db: Arc<VfsDatabase>, lance_store: Arc<VfsLanceStore>, llm_manager: Arc<LLMManager>, ) -> Self` |
| `dstu_vfs::vfs::retrieval_planner::plan_generation` | fn | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:286` | L03-chat-pipeline 1/4<br>L13-vfs-api 1/0 | `pub fn plan_generation( snapshot: &CapabilitySnapshot, requested_active: Option<ActiveGenerationModel>, query: QueryModality, ) -> GenerationPlan` |
| `dstu_vfs::vfs::retrieval_planner::CapabilityState` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:154` | L03-chat-pipeline 1/1<br>L13-vfs-api 1/0 | `pub struct CapabilityState` |
| `dstu_vfs::vfs::retrieval_planner::GenerationPlan` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:275` | L04-chat-session 1/0<br>L13-vfs-api 1/0<br>L03-chat-pipeline 0/1 | `pub struct GenerationPlan` |
| `dstu_vfs::vfs::indexing::VfsContentExtractor` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:399` | L13-vfs-api 2/0 | `pub struct VfsContentExtractor` |
| `dstu_vfs::vfs::indexing::VfsEmbeddingStats` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:4697` | L13-vfs-api 2/0 | `pub struct VfsEmbeddingStats` |
| `dstu_vfs::vfs::indexing::VfsFullSearchService::new` | method | `crates/dstu-vfs/src/vfs/indexing.rs:4825` | L05-agent-workspace 2/0 | `pub fn new( db: Arc<VfsDatabase>, lance_store: Arc<VfsLanceStore>, llm_manager: Arc<LLMManager>, ) -> Self` |
| `dstu_vfs::vfs::indexing::VfsSearchService` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:4713` | L13-vfs-api 2/0 | `pub struct VfsSearchService` |
| `dstu_vfs::vfs::indexing::VfsSearchService::new` | method | `crates/dstu-vfs/src/vfs/indexing.rs:4718` | L13-vfs-api 2/0 | `pub fn new(db: Arc<VfsDatabase>) -> Self` |
| `dstu_vfs::vfs::unified_retriever::VfsUnifiedRetriever` | struct | `crates/dstu-vfs/src/vfs/unified_retriever.rs:185` | L17-memory-research 1/0<br>L13-vfs-api 1/0 | `pub struct VfsUnifiedRetriever` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService::new` | method | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:602` | F2-shell 1/0<br>L22-app-commands 0/1 | `pub fn new( db: Arc<VfsDatabase>, settings_db: Arc<Database>, llm_manager: Arc<LLMManager>, file_manager: Arc<FileManager>, ) -> Self` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalHit` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:710` | L13-vfs-api 1/0<br>L17-memory-research 0/1 | `pub struct RetrievalHit` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalIdentity` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:679` | L13-vfs-api 1/0<br>L17-memory-research 0/1 | `pub struct RetrievalIdentity` |
| `dstu_vfs::lance_vector_store::default_lance_root_from_db_path` | fn | `crates/dstu-vfs/src/lance_vector_store.rs:93` | L10-notes 1/0 | `pub fn default_lance_root_from_db_path(db_path: Option<PathBuf>) -> Result<PathBuf>` |
| `dstu_vfs::lance_vector_store::ensure_mobile_tmpdir_within` | fn | `crates/dstu-vfs/src/lance_vector_store.rs:121` | L10-notes 1/0 | `pub fn ensure_mobile_tmpdir_within(sandbox_root: &Path) -> Result<PathBuf>` |
| `dstu_vfs::vfs::embedding_service::ChunkWithEmbedding` | struct | `crates/dstu-vfs/src/vfs/embedding_service.rs:47` | L13-vfs-api 1/0 | `pub struct ChunkWithEmbedding` |
| `dstu_vfs::vfs::embedding_service::EmbeddingResult` | struct | `crates/dstu-vfs/src/vfs/embedding_service.rs:54` | L13-vfs-api 1/0 | `pub struct EmbeddingResult` |
| `dstu_vfs::vfs::embedding_service::VfsEmbeddingPipeline` | struct | `crates/dstu-vfs/src/vfs/embedding_service.rs:468` | L13-vfs-api 1/0 | `pub struct VfsEmbeddingPipeline` |
| `dstu_vfs::vfs::embedding_service::VfsEmbeddingService` | struct | `crates/dstu-vfs/src/vfs/embedding_service.rs:89` | L13-vfs-api 1/0 | `pub struct VfsEmbeddingService` |
| `dstu_vfs::vfs::indexing::ChunkingConfig` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:44` | L13-vfs-api 1/0 | `pub struct ChunkingConfig` |
| `dstu_vfs::vfs::indexing::IndexingConfig` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:64` | L13-vfs-api 1/0 | `pub struct IndexingConfig` |
| `dstu_vfs::vfs::indexing::PageText` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:120` | L13-vfs-api 1/0 | `pub struct PageText` |
| `dstu_vfs::vfs::indexing::SearchConfig` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:90` | L13-vfs-api 1/0 | `pub struct SearchConfig` |
| `dstu_vfs::vfs::indexing::TextChunk` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:107` | L13-vfs-api 1/0 | `pub struct TextChunk` |
| `dstu_vfs::vfs::indexing::VfsChunker` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:126` | L13-vfs-api 1/0 | `pub struct VfsChunker` |
| `dstu_vfs::vfs::indexing::VfsContentExtractor::extract_mindmap_text` | method | `crates/dstu-vfs/src/vfs/indexing.rs:697` | L13-vfs-api 1/0 | `pub fn extract_mindmap_text(data: &str) -> Option<String>` |
| `dstu_vfs::vfs::indexing::VfsDimensionStat` | struct | `crates/dstu-vfs/src/vfs/indexing.rs:4705` | L13-vfs-api 1/0 | `pub struct VfsDimensionStat` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService::recover_stuck_indexing` | method | `crates/dstu-vfs/src/vfs/indexing.rs:1978` | F2-shell 1/0 | `pub fn recover_stuck_indexing(db: &VfsDatabase) -> VfsResult<usize>` |
| `dstu_vfs::vfs::indexing::VfsSearchMode` | enum | `crates/dstu-vfs/src/vfs/indexing.rs:4795` | L13-vfs-api 1/0 | `pub enum VfsSearchMode` |
| `dstu_vfs::vfs::lance_store::LanceTableDiagnostic` | struct | `crates/dstu-vfs/src/vfs/lance_store.rs:125` | L13-vfs-api 1/0 | `pub struct LanceTableDiagnostic` |
| `dstu_vfs::vfs::lance_store::VfsLanceRow` | struct | `crates/dstu-vfs/src/vfs/lance_store.rs:88` | L13-vfs-api 1/0 | `pub struct VfsLanceRow` |
| `dstu_vfs::vfs::lance_store::VfsLanceSearchResult` | struct | `crates/dstu-vfs/src/vfs/lance_store.rs:105` | L13-vfs-api 1/0 | `pub struct VfsLanceSearchResult` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalIndexResult` | struct | `crates/dstu-vfs/src/vfs/multimodal_service.rs:56` | L13-vfs-api 1/0 | `pub struct VfsMultimodalIndexResult` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalPage` | struct | `crates/dstu-vfs/src/vfs/multimodal_service.rs:41` | L13-vfs-api 1/0 | `pub struct VfsMultimodalPage` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalSearchResult` | struct | `crates/dstu-vfs/src/vfs/multimodal_service.rs:67` | L13-vfs-api 1/0 | `pub struct VfsMultimodalSearchResult` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalStats` | struct | `crates/dstu-vfs/src/vfs/multimodal_service.rs:1728` | L13-vfs-api 1/0 | `pub struct VfsMultimodalStats` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingCompletedEvent` | type | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:434` | L13-vfs-api 1/0 | `pub type PdfProcessingCompletedEvent = MediaProcessingCompletedEvent` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingErrorEvent` | type | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:435` | L13-vfs-api 1/0 | `pub type PdfProcessingErrorEvent = MediaProcessingErrorEvent` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingProgressEvent` | type | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:433` | L13-vfs-api 1/0 | `pub type PdfProcessingProgressEvent = MediaProcessingProgressEvent` |
| `dstu_vfs::vfs::pdf_processing_service::ProcessingProgress` | struct | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:225` | L13-vfs-api 1/0 | `pub struct ProcessingProgress` |
| `dstu_vfs::vfs::pdf_processing_service::ProcessingStage::from_str` | method | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:190` | L13-vfs-api 1/0 | `pub fn from_str(s: &str) -> Self` |
| `dstu_vfs::vfs::retrieval_planner::CapabilityKind` | enum | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:140` | L13-vfs-api 1/0 | `pub enum CapabilityKind` |
| `dstu_vfs::vfs::retrieval_planner::fuse_route_results` | fn | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:801` | L13-vfs-api 1/0 | `pub fn fuse_route_results( route_results: Vec<Result<RetrievalRouteResult, RetrievalRouteFailure>>, top_k: usize, ) -> FusedRetrievalResult` |
| `dstu_vfs::vfs::retrieval_planner::FusedRetrievalResult` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:779` | L13-vfs-api 1/0 | `pub struct FusedRetrievalResult` |
| `dstu_vfs::vfs::retrieval_planner::IndexProfileCapability` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:379` | L13-vfs-api 1/0 | `pub struct IndexProfileCapability` |
| `dstu_vfs::vfs::retrieval_planner::plan_retrieval` | fn | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:501` | L13-vfs-api 1/0 | `pub fn plan_retrieval( snapshot: &CapabilitySnapshot, query_modality: QueryModality, profiles: &[IndexProfileCapability], top_k: usize, ) -> RetrievalPlan` |
| `dstu_vfs::vfs::retrieval_planner::PlannedRetrievalRoute` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:467` | L13-vfs-api 1/0 | `pub struct PlannedRetrievalRoute` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalHitProvenance` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:747` | L13-vfs-api 1/0 | `pub struct RetrievalHitProvenance` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalPlan` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:486` | L13-vfs-api 1/0 | `pub struct RetrievalPlan` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalRouteKind` | enum | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:430` | L13-vfs-api 1/0 | `pub enum RetrievalRouteKind` |
| `dstu_vfs::vfs::retrieval_planner::RetrievalRouteResult` | struct | `crates/dstu-vfs/src/vfs/retrieval_planner.rs:727` | L13-vfs-api 1/0 | `pub struct RetrievalRouteResult` |

### 引用点样例

- `dstu_vfs::vfs::lance_store::VfsLanceStore` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:80`, `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:329`, `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:338`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:137`, `crates/dstu-agent/src/chat_v2/pipeline.rs:145`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor.rs:121`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:421`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:153`；L17-memory-research: `crates/dstu-memory/src/memory/evolution.rs:54`, `crates/dstu-memory/src/memory/handlers.rs:74`, `crates/dstu-memory/src/memory/handlers.rs:128`, `crates/dstu-memory/src/memory/handlers.rs:177`；L13-vfs-api: `crates/dstu-vfs/src/dstu/handlers.rs:1668`, `crates/dstu-vfs/src/dstu/handlers.rs:4464`, `crates/dstu-vfs/src/dstu/handlers.rs:5146`, `crates/dstu-vfs/src/dstu/handlers.rs:5269`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/file_repo.rs:1759`；L10-notes: `src/cmd/notes.rs:1467`, `src/cmd/notes.rs:1599`；F2-shell: `src/lib.rs:3296`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:27`, `tests/phase8_9_executor_e2e.rs:31`
- `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:238`, `crates/dstu-agent/src/chat_v2/pipeline.rs:398`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor.rs:161`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:444`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:166`；L18-media-docs: `crates/dstu-media/src/media/bilibili.rs:1221`, `crates/dstu-media/src/media/bilibili.rs:1320`, `crates/dstu-media/src/media/commands.rs:329`, `crates/dstu-media/src/media/commands.rs:370`；L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:1332`, `crates/dstu-vfs/src/vfs/handlers.rs:1348`, `crates/dstu-vfs/src/vfs/handlers.rs:2114`, `crates/dstu-vfs/src/vfs/handlers.rs:2133`；L22-app-commands: `src/commands.rs:694`, `tests/dstu_canvas_executor_e2e.rs:47`
- `dstu_vfs::vfs::pdf_processing_service::ProcessingStage` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:23`, `crates/dstu-vfs/src/vfs/handlers.rs:1597`, `crates/dstu-vfs/src/vfs/handlers.rs:1599`, `crates/dstu-vfs/src/vfs/handlers.rs:2224`；L18-media-docs: `src/chat_v2/tools/document_processing_executor.rs:127`, `src/chat_v2/tools/document_processing_executor.rs:445`, `src/chat_v2/tools/document_processing_executor.rs:451`, `src/chat_v2/tools/document_processing_executor.rs:130`
- `dstu_vfs::vfs::lance_store::VfsLanceStore::new` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:339`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:2104`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs:1621`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs:1721`, `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:263`；L17-memory-research: `crates/dstu-memory/src/memory/evolution.rs:81`, `crates/dstu-memory/src/memory/mod.rs:110`, `crates/dstu-research/src/hpias/retrieval_backend.rs:208`, `src/chat_v2/tools/memory_executor.rs:462`；L13-vfs-api: `src/chat_v2/tools/builtin_retrieval_executor.rs:116`；F2-shell: `src/lib.rs:3517`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:75`, `tests/phase8_9_executor_e2e.rs:45`
- `dstu_vfs::vfs::retrieval_planner::ActiveGenerationModel` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:23`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:157`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:161`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:881`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:92`
- `dstu_vfs::vfs::retrieval_planner::FusedRetrievalHit` — L17-memory-research: `crates/dstu-research/src/hpias/retrieval_backend.rs:104`, `crates/dstu-research/src/hpias/retrieval_backend.rs:105`, `crates/dstu-research/src/hpias/retrieval_backend.rs:233`, `crates/dstu-research/src/hpias/retrieval_backend.rs:254`；L13-vfs-api: `crates/dstu-vfs/src/vfs/media_index.rs:263`, `crates/dstu-vfs/src/vfs/media_index.rs:274`, `crates/dstu-vfs/src/vfs/media_index.rs:553`, `crates/dstu-vfs/src/vfs/mod.rs:92`
- `dstu_vfs::vfs::retrieval_planner::GenerationRoute` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:681`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:556`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:822`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:824`；L04-chat-session: `crates/dstu-agent/src/chat_v2/types.rs:1412`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:92`
- `dstu_vfs::vfs::retrieval_planner::QueryModality` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:23`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:186`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:188`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:163`；L17-memory-research: `crates/dstu-memory/src/memory/service.rs:872`, `crates/dstu-research/src/hpias/retrieval_backend.rs:15`, `crates/dstu-research/src/hpias/retrieval_backend.rs:121`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:92`, `src/chat_v2/tools/builtin_retrieval_executor.rs:1457`
- `dstu_vfs::vfs::indexing::VfsFullIndexingService::new` — L17-memory-research: `crates/dstu-memory/src/memory/handlers.rs:133`, `crates/dstu-memory/src/memory/service.rs:663`；L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:3204`, `crates/dstu-vfs/src/vfs/handlers.rs:3917`, `crates/dstu-vfs/src/vfs/index_handlers.rs:94`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:284`；F2-shell: `src/lib.rs:3353`
- `dstu_vfs::vfs::indexing::VfsFullIndexingService` — L17-memory-research: `crates/dstu-memory/src/memory/handlers.rs:8`, `crates/dstu-memory/src/memory/service.rs:11`；L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:3126`, `crates/dstu-vfs/src/vfs/index_handlers.rs:10`, `crates/dstu-vfs/src/vfs/mod.rs:66`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:30`
- `dstu_vfs::vfs::retrieval_planner::CapabilityState::unavailable` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:164`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:165`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:169`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:174`
- `dstu_vfs::vfs::retrieval_planner::CapabilitySnapshot` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:163`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:874`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:266`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:318`；L04-chat-session: `crates/dstu-agent/src/chat_v2/types.rs:1408`；L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:6359`, `crates/dstu-vfs/src/vfs/mod.rs:92`
- `dstu_vfs::lance_vector_store::LanceVectorStore::new` — L22-app-commands: `src/commands.rs:2069`, `src/commands.rs:2096`, `src/commands.rs:3788`；F2-shell: `src/lib.rs:1652`
- `dstu_vfs::vfs::indexing::VfsFullSearchService` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:58`, `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:66`, `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:331`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::VfsIndexingService::new` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:3358`, `crates/dstu-vfs/src/vfs/handlers.rs:3876`, `crates/dstu-vfs/src/vfs/index_handlers.rs:89`；F2-shell: `src/lib.rs:3326`
- `dstu_vfs::vfs::indexing::VfsSearchParams` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:201`；L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:3134`, `crates/dstu-vfs/src/vfs/handlers.rs:4931`, `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::VfsSearchResult` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:93`；L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:3136`, `crates/dstu-vfs/src/vfs/handlers.rs:4869`, `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::retrieval_planner::RetrievalRouteFailure` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:92`, `src/chat_v2/tools/builtin_retrieval_executor.rs:478`, `src/chat_v2/tools/builtin_retrieval_executor.rs:1184`, `src/chat_v2/tools/builtin_retrieval_executor.rs:1239`
- `dstu_vfs::vfs::retrieval_planner::CapabilityState::available` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:167`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:172`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:177`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:875`
- `dstu_vfs::vfs::embedding_service::EmbeddingProgressCallback` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:3216`, `crates/dstu-vfs/src/vfs/handlers.rs:3958`；L19-mcp-browser: `src/chat_v2/tools/index_webpage_executor.rs:246`
- `dstu_vfs::vfs::indexing::VfsIndexingService` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:3126`, `crates/dstu-vfs/src/vfs/index_handlers.rs:10`, `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::multimodal_service::VfsMultimodalService` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:59`；L13-vfs-api: `crates/dstu-vfs/src/vfs/index_handlers.rs:12`, `crates/dstu-vfs/src/vfs/mod.rs:73`
- `dstu_vfs::vfs::multimodal_service::VfsMultimodalService::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs:236`；L13-vfs-api: `crates/dstu-vfs/src/vfs/index_handlers.rs:111`；F2-shell: `src/lib.rs:3422`
- `dstu_vfs::vfs::pdf_processing_service::ProcessingStatus` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:6511`, `crates/dstu-vfs/src/vfs/handlers.rs:6636`, `crates/dstu-vfs/src/vfs/mod.rs:77`
- `dstu_vfs::vfs::unified_retriever::UnifiedRetrievalRequest` — L17-memory-research: `crates/dstu-memory/src/memory/service.rs:868`, `crates/dstu-research/src/hpias/retrieval_backend.rs:117`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:100`
- `dstu_vfs::vfs::unified_retriever::UnifiedRetrievalResponse` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:6258`, `crates/dstu-vfs/src/vfs/handlers.rs:6343`, `crates/dstu-vfs/src/vfs/mod.rs:100`
- `dstu_vfs::vfs::unified_retriever::VfsUnifiedRetriever::new` — L17-memory-research: `crates/dstu-memory/src/memory/service.rs:862`, `crates/dstu-research/src/hpias/retrieval_backend.rs:103`；L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:6360`
- `dstu_vfs::vfs::retrieval_planner::plan_generation` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:182`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:271`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:324`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:354`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:92`
- `dstu_vfs::vfs::retrieval_planner::CapabilityState` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:23`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:163`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:92`
- `dstu_vfs::vfs::retrieval_planner::GenerationPlan` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:879`；L04-chat-session: `crates/dstu-agent/src/chat_v2/types.rs:1392`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:92`
- `dstu_vfs::vfs::indexing::VfsContentExtractor` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:66`, `crates/dstu-vfs/src/vfs/ref_handlers.rs:22`
- `dstu_vfs::vfs::indexing::VfsEmbeddingStats` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:3321`, `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::VfsFullSearchService::new` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:83`, `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:332`
- `dstu_vfs::vfs::indexing::VfsSearchService` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:3126`, `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::VfsSearchService::new` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:3147`, `crates/dstu-vfs/src/vfs/handlers.rs:3323`
- `dstu_vfs::vfs::unified_retriever::VfsUnifiedRetriever` — L17-memory-research: `crates/dstu-research/src/hpias/retrieval_backend.rs:16`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:100`
- `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService::new` — F2-shell: `src/lib.rs:3600`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:63`
- `dstu_vfs::vfs::retrieval_planner::RetrievalHit` — L17-memory-research: `crates/dstu-research/src/hpias/synthesis.rs:114`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:92`
- `dstu_vfs::vfs::retrieval_planner::RetrievalIdentity` — L17-memory-research: `crates/dstu-research/src/hpias/synthesis.rs:115`；L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:92`
- `dstu_vfs::lance_vector_store::default_lance_root_from_db_path` — L10-notes: `crates/dstu-notes/src/notes_manager.rs:162`
- `dstu_vfs::lance_vector_store::ensure_mobile_tmpdir_within` — L10-notes: `crates/dstu-notes/src/notes_manager.rs:178`
- `dstu_vfs::vfs::embedding_service::ChunkWithEmbedding` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:62`
- `dstu_vfs::vfs::embedding_service::EmbeddingResult` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:62`
- `dstu_vfs::vfs::embedding_service::VfsEmbeddingPipeline` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:62`
- `dstu_vfs::vfs::embedding_service::VfsEmbeddingService` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:62`
- `dstu_vfs::vfs::indexing::ChunkingConfig` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::IndexingConfig` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::PageText` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::SearchConfig` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::TextChunk` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::VfsChunker` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::VfsContentExtractor::extract_mindmap_text` — L13-vfs-api: `crates/dstu-vfs/src/vfs/ref_handlers.rs:874`
- `dstu_vfs::vfs::indexing::VfsDimensionStat` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::indexing::VfsFullIndexingService::recover_stuck_indexing` — F2-shell: `src/lib.rs:3636`
- `dstu_vfs::vfs::indexing::VfsSearchMode` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:66`
- `dstu_vfs::vfs::lance_store::LanceTableDiagnostic` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:6477`
- `dstu_vfs::vfs::lance_store::VfsLanceRow` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:72`
- `dstu_vfs::vfs::lance_store::VfsLanceSearchResult` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:72`
- `dstu_vfs::vfs::multimodal_service::VfsMultimodalIndexResult` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:73`
- `dstu_vfs::vfs::multimodal_service::VfsMultimodalPage` — L13-vfs-api: `crates/dstu-vfs/src/vfs/mod.rs:73`
- 其余 17 个条目的引用点见 `draft.json`。

## 消费其他 lane

### L13-vfs-api（37 个条目，prod 589 / test 33）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::error::VfsError` ? | enum | 223/5 | `crates/dstu-vfs/src/vfs/embedding_service.rs`, `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/lance_store.rs` 等 7 个 |
| `dstu_vfs::vfs::error::VfsResult` | type | 198/0 | `crates/dstu-vfs/src/vfs/embedding_service.rs`, `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/lance_store.rs` 等 7 个 |
| `dstu_vfs::vfs::types::VfsResourceType` ? | enum | 65/4 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 32/1 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/lance_store.rs`, `crates/dstu-vfs/src/vfs/lance_store_stub.rs` 等 6 个 |
| `dstu_vfs::vfs::types::VfsResource` ? | struct | 6/2 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::ocr_utils::OCR_FAILED_MARKER` | const | 6/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::ocr_utils::has_valid_text` | fn | 4/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::ocr_utils::parse_ocr_pages_json` | fn | 4/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::types::PdfPreviewJson` | struct | 4/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::unit_builder::trait_def::UnitBuildInput` | struct | 4/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::media_index::TRANSCRIPT_TEXT_SOURCE` | const | 3/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::ocr_utils::has_valid_ocr_pages` | fn | 3/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::qbank_read::context_with_conn` | fn | 3/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::VECTOR_INDEX_AVAILABLE` | const | 3/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::media_index::MediaTimeRange` | struct | 2/1 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/retrieval_planner.rs` |
| `dstu_vfs::vfs::hooks::MediaTranscriptionProgress` | struct | 2/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::index_service::VfsIndexService` | struct | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::index_service::VfsIndexService::new` ? | method | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::media_index::range_for_unit` | fn | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::media_index::segment_metadata_json` | fn | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::media_index::unit_time_ranges` | fn | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::ocr_utils::classify_pdf_content` | fn | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::ocr_utils::join_ocr_pages_text` | fn | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::qbank_read::context_text` | fn | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::types::VfsResourceMetadata` ? | struct | 1/2 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vector_store::VectorStore` | trait | 1/0 | `crates/dstu-vfs/src/lance_vector_store.rs` |
| `dstu_vfs::vfs::app_handle` | fn | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::hooks::media_transcriber` | fn | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::hooks::MediaTranscriptionRequest` | struct | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::lexical_bm25::bm25_scores` | fn | 1/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::lexical_bm25::Bm25Options` | struct | 1/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::lexical_bm25::tokenize` | fn | 1/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::media_index::attach_media_time_ranges` | fn | 1/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::ocr_utils::PdfContentKind` | enum | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::types::VfsResourceType::from_str` ? | method | 1/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | 0/15 | `crates/dstu-vfs/src/vfs/lance_store.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::types::StorageMode` ? | enum | 0/3 | `crates/dstu-vfs/src/vfs/indexing.rs` |

### L11-vfs-repos（82 个条目，prod 257 / test 17）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::embedding_repo::MODALITY_TEXT` | const | 36/1 | `crates/dstu-vfs/src/vfs/embedding_service.rs`, `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::MODALITY_MULTIMODAL` | const | 17/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::get_blob_path_with_conn` | method | 11/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::refresh_counts_from_segments` | fn | 10/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexingConfigRepo::get_i32` | method | 10/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::IndexState` | enum | 10/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::VfsIndexProfile` ? | struct | 8/4 | `crates/dstu-vfs/src/vfs/lance_store.rs`, `crates/dstu-vfs/src/vfs/lance_store_stub.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::model_fingerprint_for_config` ? | fn | 7/2 | `crates/dstu-vfs/src/vfs/embedding_service.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::INDEX_STATE_INDEXED` | const | 7/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_failed` | method | 6/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::get_resource` ? | method | 6/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_pending` | method | 5/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::set_index_state_with_conn` | method | 5/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::get_by_resource` | fn | 5/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::set_index_profile` | fn | 4/1 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/lance_store.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo` | struct | 4/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::embedding_dim_repo::list_by_modality` | fn | 4/0 | `crates/dstu-vfs/src/vfs/lance_store.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::register` | fn | 4/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexingConfigRepo::get_bool` | method | 4/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::CreateSegmentInput` | struct | 4/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::replace_by_unit_and_modality` | fn | 4/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::get_blob_path` | method | 3/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::get_by_key` | fn | 3/0 | `crates/dstu-vfs/src/vfs/lance_store.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_disabled_with_reason` | method | 3/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_content_with_conn` | method | 3/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::VfsIndexUnit` | struct | 3/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::get_active_profile` | fn | 2/1 | `crates/dstu-vfs/src/vfs/lance_store.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::get_profile_by_id` | fn | 2/1 | `crates/dstu-vfs/src/vfs/lance_store.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::MAX_DIMENSION` ? | const | 2/1 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::decrement_ref_with_conn` | method | 2/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::store_blob_with_conn` ? | method | 2/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::embedding_protocol_for_modality` | fn | 2/0 | `crates/dstu-vfs/src/vfs/lance_store.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::increment_count` | fn | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::list_active_profiles` | fn | 2/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::MIN_DIMENSION` | const | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::set_ann_status` | fn | 2/0 | `crates/dstu-vfs/src/vfs/lance_store.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::set_profile_ann_status` | fn | 2/0 | `crates/dstu-vfs/src/vfs/lance_store.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::INDEX_STATE_INDEXING` | const | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexingConfigRepo` | struct | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo` | struct | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_mm_failed` | method | 2/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::set_index_state` | method | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::pdf_preview::PdfPreviewConfig` | struct | 2/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo` | struct | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::is_safe_original_path` | method | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::store_blob` ? | method | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::list_all` | fn | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::model_fingerprint` | fn | 1/0 | `crates/dstu-vfs/src/vfs/lance_store.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::register_with_model_fingerprint` | fn | 1/0 | `crates/dstu-vfs/src/vfs/lance_store.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsEmbedding` | struct | 1/0 | `crates/dstu-vfs/src/vfs/embedding_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsEmbedding::generate_id` | method | 1/0 | `crates/dstu-vfs/src/vfs/embedding_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexingConfigRepo::get_config` | method | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::claim_mm_indexing_resources` | method | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::claim_pending_resources` | method | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::get_index_state` ? | method | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::get_mm_index_state` | method | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::get_pending_resources` | method | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_indexed` | method | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_indexing` | method | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_mm_failed_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::set_mm_index_state` | method | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::set_mm_index_state_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo` | struct | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_file` ? | method | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::enqueue_and_delete_by_resource_and_modality` | fn | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::enqueue_lance_orphan` | fn | 1/0 | `crates/dstu-vfs/src/vfs/lance_store.rs` |
| `dstu_vfs::vfs::repos::index_segment_repo::get_by_unit_and_modality` | fn | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::clear_multimodal_index` | fn | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::CreateUnitInput` | struct | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::delete_by_resource` | fn | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::list_pending_mm` | fn | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::purge_index_artifacts_by_resource` | fn | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::set_mm_indexed` | fn | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::set_mm_state` | fn | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::sync_multimodal_units` | fn | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::plan_info_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::SEGMENT_SOURCE_IMPORT` | const | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::pdf_preview::render_pdf_preview_with_progress` | fn | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::get_resource_with_conn` ? | method | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::create_or_reuse` ? | method | 0/3 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::register_with_model` ? | fn | 0/2 | `crates/dstu-vfs/src/vfs/lance_store.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_vfs::vfs::repos::embedding_dim_repo::model_fingerprint_with_transport` | fn | 0/1 | `crates/dstu-vfs/src/vfs/lance_store.rs` |

### F4-security（12 个条目，prod 244 / test 12）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError::database` | method | 187/0 | `crates/dstu-vfs/src/lance_vector_store.rs` |
| `dstu_core::llm_config::ApiConfig` ? | struct | 10/10 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_core::models::DocumentChunkWithEmbedding` | struct | 9/1 | `crates/dstu-vfs/src/lance_vector_store.rs` |
| `dstu_core::models::RetrievedChunk` | struct | 9/0 | `crates/dstu-vfs/src/lance_vector_store.rs`, `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_core::models::DocumentChunk` | struct | 8/1 | `crates/dstu-vfs/src/lance_vector_store.rs`, `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_core::models::PdfOcrTextBlock` | struct | 7/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_core::models::AppError::validation` | method | 5/0 | `crates/dstu-vfs/src/lance_vector_store.rs` |
| `dstu_core::media_types::MediaKind` | enum | 2/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_core::models::AppError` | struct | 2/0 | `crates/dstu-vfs/src/lance_vector_store.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_core::models::AppError::file_system` ? | method | 2/0 | `crates/dstu-vfs/src/lance_vector_store.rs` |
| `dstu_core::models::VectorStoreStats` | struct | 2/0 | `crates/dstu-vfs/src/lance_vector_store.rs` |
| `dstu_core::media_types::media_kind` | fn | 1/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |

### L02-llm-manager（4 个条目，prod 31 / test 4）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | 23/0 | `crates/dstu-vfs/src/lance_vector_store.rs`, `crates/dstu-vfs/src/vfs/embedding_service.rs`, `crates/dstu-vfs/src/vfs/indexing.rs` 等 6 个 |
| `dstu_llm::llm_manager::OcrRuntimeCandidate` | enum | 4/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_llm::llm_manager::MAX_OCR_CONCURRENCY` | const | 2/4 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_llm::llm_manager::ImagePayload` | struct | 2/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |

### L01-llm-providers（15 个条目，prod 31 / test 4）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::multimodal::types::IndexProgressEvent::new` | method | 6/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_llm::multimodal::types::MultimodalInput` | struct | 4/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_llm::multimodal::types::IndexProgressEvent` | struct | 3/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_llm::multimodal::types::MultimodalImage` | enum | 3/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_llm::ocr_adapters::types::OcrTaskType` ? | enum | 3/0 | `crates/dstu-vfs/src/vfs/indexing.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_llm::multimodal::types::MultimodalInput::image_base64` ? | method | 2/1 | `crates/dstu-vfs/src/vfs/multimodal_service.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_llm::multimodal::types::MultimodalInput::text` ? | method | 2/1 | `crates/dstu-vfs/src/vfs/multimodal_service.rs`, `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_llm::multimodal::embedding_service::EmbeddingProgress` | struct | 2/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_llm::ocr_adapters::types::OcrEngineType` ? | enum | 2/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_llm::multimodal::embedding_service::MultimodalEmbeddingService` | struct | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_llm::multimodal::embedding_service::MultimodalEmbeddingService::new` | method | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_llm::multimodal::page_indexer::AttachmentPreview` | struct | 1/0 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::infer_engine_from_model` | method | 1/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_llm::multimodal::types::MultimodalInput::image_url` ? | method | 0/1 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |
| `dstu_llm::multimodal::types::MultimodalInput::text_and_image` ? | method | 0/1 | `crates/dstu-vfs/src/vfs/multimodal_service.rs` |

### F3-storage（5 个条目，prod 15 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 11/0 | `crates/dstu-vfs/src/lance_vector_store.rs`, `crates/dstu-vfs/src/vfs/multimodal_service.rs`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_storage::file_manager::FileManager` | struct | 3/0 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |
| `dstu_storage::llm_usage::types::CallerType` ? | enum | 1/0 | `crates/dstu-vfs/src/vfs/unified_retriever.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/1 | `crates/dstu-vfs/src/lance_vector_store.rs` |
| `dstu_storage::file_manager::FileManager::new` ? | method | 0/1 | `crates/dstu-vfs/src/vfs/pdf_processing_service.rs` |

### L18-media-docs（3 个条目，prod 4 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_docs::pdfium_utils::PDF_PAGE_SEPARATOR` | const | 2/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_docs::pdfium_utils::extract_text_from_pdf_bytes` | fn | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_docs::pdfium_utils::load_pdfium` | fn | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |

### L10-notes（3 个条目，prod 3 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo` | struct | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_location_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_with_conn` | method | 1/0 | `crates/dstu-vfs/src/vfs/indexing.rs` |

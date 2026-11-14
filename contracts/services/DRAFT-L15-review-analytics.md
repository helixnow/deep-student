# 跨 lane 服务草稿：L15-review-analytics

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（42 个条目，其中 35 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_anki::fsrs_review_service::FsrsReviewService::new` ? | method | `crates/dstu-anki/src/fsrs_review_service.rs:997` | L24-chatanki 13/3<br>L16-anki 5/7<br>L17-memory-research 2/0 | `pub fn new(db: Arc<Database>) -> Self` |
| `dstu_anki::fsrs_review_service::FsrsAgentReviewStateSnapshot` ? | struct | `crates/dstu-anki/src/fsrs_review_service.rs:228` | L24-chatanki 14/2<br>L16-anki 1/1 | `pub struct FsrsAgentReviewStateSnapshot` |
| `dstu_anki::fsrs_review_service::FsrsAgentReviewMutationOutcome` ? | enum | `crates/dstu-anki/src/fsrs_review_service.rs:243` | L24-chatanki 12/3 | `pub enum FsrsAgentReviewMutationOutcome` |
| `dstu_learning::mastery::service::MasteryService::new` ? | method | `crates/dstu-learning/src/mastery/service.rs:97` | L14-qbank 9/4<br>L17-memory-research 1/0<br>L21-backup-governance 1/0 | `pub fn new(vfs_db: Arc<VfsDatabase>) -> Self` |
| `dstu_qbank::review_plan_service::ReviewPlanService::new` ? | method | `crates/dstu-qbank/src/review_plan_service.rs:111` | L14-qbank 8/1<br>L17-memory-research 1/0 | `pub fn new(vfs_db: Arc<VfsDatabase>) -> Self` |
| `dstu_anki::fsrs_review_service::FsrsReviewService` ? | struct | `crates/dstu-anki/src/fsrs_review_service.rs:992` | L16-anki 3/3<br>L24-chatanki 2/0<br>L17-memory-research 1/0 | `pub struct FsrsReviewService` |
| `dstu_qbank::review_plan_service::ReviewPlanService` ? | struct | `crates/dstu-qbank/src/review_plan_service.rs:102` | L14-qbank 5/0<br>L17-memory-research 1/0 | `pub struct ReviewPlanService` |
| `dstu_anki::fsrs_review_service::FsrsState` | enum | `crates/dstu-anki/src/fsrs_review_service.rs:45` | L16-anki 5/9 | `pub enum FsrsState` |
| `dstu_anki::fsrs_review_service::FsrsLibraryEnqueueOutcome` ? | enum | `crates/dstu-anki/src/fsrs_review_service.rs:287` | L24-chatanki 5/0 | `pub enum FsrsLibraryEnqueueOutcome` |
| `dstu_anki::fsrs_review_service::FsrsFeedbackRow` ? | struct | `crates/dstu-anki/src/fsrs_review_service.rs:331` | L16-anki 4/6 | `pub struct FsrsFeedbackRow` |
| `dstu_anki::fsrs_review_service::FsrsEnqueueResult` ? | struct | `crates/dstu-anki/src/fsrs_review_service.rs:261` | L24-chatanki 2/3<br>L16-anki 1/0 | `pub struct FsrsEnqueueResult` |
| `dstu_anki::fsrs_review_service::FsrsEnqueuedCard` ? | struct | `crates/dstu-anki/src/fsrs_review_service.rs:304` | L24-chatanki 3/2 | `pub struct FsrsEnqueuedCard` |
| `dstu_anki::fsrs_review_service::FsrsImportedSchedule` | struct | `crates/dstu-anki/src/fsrs_review_service.rs:942` | L16-anki 3/0 | `pub struct FsrsImportedSchedule` |
| `dstu_anki::fsrs_review_service::FsrsSchedulerConfigUpdate` ? | struct | `crates/dstu-anki/src/fsrs_review_service.rs:480` | L24-chatanki 2/0 | `pub struct FsrsSchedulerConfigUpdate` |
| `dstu_learning::mastery::profile_sink::MasteryWeakPointEvidence` | struct | `crates/dstu-learning/src/mastery/profile_sink.rs:23` | L17-memory-research 2/0 | `pub struct MasteryWeakPointEvidence` |
| `dstu_learning::mastery::profile_sink::WEAK_POINT_SOURCE_MASTERY` | const | `crates/dstu-learning/src/mastery/profile_sink.rs:19` | L17-memory-research 2/0 | `pub const WEAK_POINT_SOURCE_MASTERY: &str = "mastery"` |
| `dstu_learning::study_loop::media_source::prepare_media_text_for_generation` | fn | `crates/dstu-learning/src/study_loop/media_source.rs:211` | L14-qbank 1/0<br>L24-chatanki 1/0 | `pub fn prepare_media_text_for_generation(conn: &Connection, file_id: &str, text: String) -> String` |
| `dstu_anki::fsrs_review_service::FsrsStats` ? | struct | `crates/dstu-anki/src/fsrs_review_service.rs:352` | L24-chatanki 1/1 | `pub struct FsrsStats` |
| `dstu_anki::fsrs_review_service::emit_fsrs_enqueue_changed` | fn | `crates/dstu-anki/src/fsrs_review_service.rs:5476` | L16-anki 1/0 | `pub fn emit_fsrs_enqueue_changed( app: &tauri::AppHandle, service: &FsrsReviewService, result: &FsrsEnqueueResult, )` |
| `dstu_anki::fsrs_review_service::FsrsImportedSchedule::new_card` | method | `crates/dstu-anki/src/fsrs_review_service.rs:957` | L16-anki 1/0 | `pub fn new_card(now_ms: i64, suspended: bool) -> Self` |
| `dstu_anki::fsrs_review_service::FsrsLibraryEnqueueCard` ? | struct | `crates/dstu-anki/src/fsrs_review_service.rs:272` | L24-chatanki 1/0 | `pub struct FsrsLibraryEnqueueCard` |
| `dstu_anki::fsrs_review_service::FsrsReviewService::enqueue_imported_cards_in_tx` | method | `crates/dstu-anki/src/fsrs_review_service.rs:1460` | L16-anki 1/0 | `pub fn enqueue_imported_cards_in_tx( conn: &rusqlite::Connection, cards: &[(String, Option<FsrsImportedSchedule>)], ) -> Result<FsrsImportEnqueueSummary>` |
| `dstu_learning::fsrs_scheduler::DEFAULT_DAY_ROLLOVER_HOUR` | const | `crates/dstu-learning/src/fsrs_scheduler.rs:21` | L16-anki 1/0 | `pub const DEFAULT_DAY_ROLLOVER_HOUR: u32 = 4` |
| `dstu_learning::fsrs_scheduler::forgetting_curve_constants` | fn | `crates/dstu-learning/src/fsrs_scheduler.rs:414` | L16-anki 1/0 | `pub fn forgetting_curve_constants(params: &[f32]) -> (f64, f64)` |
| `dstu_learning::fsrs_scheduler::logical_day_bounds_ms` | fn | `crates/dstu-learning/src/fsrs_scheduler.rs:471` | L16-anki 1/0 | `pub fn logical_day_bounds_ms<Tz: TimeZone>(now_ms: i64, tz: &Tz, rollover_hour: u32) -> (i64, i64)` |
| `dstu_learning::fsrs_scheduler::logical_days_between` | fn | `crates/dstu-learning/src/fsrs_scheduler.rs:443` | L16-anki 1/0 | `pub fn logical_days_between<Tz: TimeZone>( from_ms: i64, to_ms: i64, tz: &Tz, rollover_hour: u32, ) -> u32` |
| `dstu_learning::fsrs_scheduler::retrievability` | fn | `crates/dstu-learning/src/fsrs_scheduler.rs:421` | L16-anki 1/0 | `pub fn retrievability(elapsed_days: f64, stability: f64, decay: f64, factor: f64) -> f64` |
| `dstu_learning::mastery::profile_sink::MasteryProfileSink` | trait | `crates/dstu-learning/src/mastery/profile_sink.rs:31` | L17-memory-research 1/0 | `pub trait MasteryProfileSink: Send + Sync` |
| `dstu_learning::mastery::profile_sink::register_mastery_profile_sink` | fn | `crates/dstu-learning/src/mastery/profile_sink.rs:51` | L17-memory-research 1/0 | `pub fn register_mastery_profile_sink( sink: Arc<dyn MasteryProfileSink>, ) -> Result<Disposer, SlotOccupied>` |
| `dstu_learning::mastery::service::MasteryService::recompute_all_states_with_conn` ? | method | `crates/dstu-learning/src/mastery/service.rs:705` | L21-backup-governance 1/0 | `pub fn recompute_all_states_with_conn(conn: &Connection) -> Result<usize, AppError>` |
| `dstu_learning::mastery::types::MasteryState` | struct | `crates/dstu-learning/src/mastery/types.rs:98` | L14-qbank 1/0 | `pub struct MasteryState` |
| `dstu_learning::study_loop::media_source::contains_media_anchor` | fn | `crates/dstu-learning/src/study_loop/media_source.rs:122` | L14-qbank 1/0 | `pub fn contains_media_anchor(text: &str) -> bool` |
| `dstu_learning::study_loop::media_source::media_citation_seconds_for` | fn | `crates/dstu-learning/src/study_loop/media_source.rs:106` | L18-media-docs 1/0 | `pub fn media_citation_seconds_for(text: &str, resource_id: &str) -> Option<u32>` |
| `dstu_learning::study_loop::media_source::MEDIA_QUESTION_REQUIREMENTS` | const | `crates/dstu-learning/src/study_loop/media_source.rs:30` | L14-qbank 1/0 | `pub const MEDIA_QUESTION_REQUIREMENTS: &str = "## 音视频课程出处要求\n\ 参考资料含音视频转写（每行 [mm:ss] 为该句开始时间，片段标题含 [媒体@资源ID:时间] 锚点）：\n\ - 每题 explanation 末尾另起一行写依据出处 [媒体@资源ID:mm:ss]（资源 ID 取所在片段标题，时间取依据所在行，≥1 小时写 h:mm:ss），不得编造。\n\ - 题目必须基于课程实际讲到的内容；「上文回顾」引用块只帮助理解语境，不要单独据此出题；不同片段重复讲到的知识点只出一次。\n\n"` |
| `dstu_learning::study_loop::study_time::range` | fn | `crates/dstu-learning/src/study_loop/study_time.rs:85` | L17-memory-research 1/0 | `pub fn range(conn: &Connection, from: &str, to: &str) -> rusqlite::Result<Vec<StudyTimeDay>>` |
| `dstu_learning::mastery::service::set_now_override_ms` ? | fn | `crates/dstu-learning/src/mastery/service.rs:44` | L14-qbank 0/7 | `pub fn set_now_override_ms(ms: Option<i64>)` |
| `dstu_anki::fsrs_review_service::FsrsAgentLatestReviewSnapshot` ? | struct | `crates/dstu-anki/src/fsrs_review_service.rs:218` | L24-chatanki 0/1<br>L16-anki 0/1 | `pub struct FsrsAgentLatestReviewSnapshot` |
| `dstu_learning::mastery::service::MasteryService` ? | struct | `crates/dstu-learning/src/mastery/service.rs:92` | L14-qbank 0/2 | `pub struct MasteryService` |
| `dstu_anki::fsrs_review_service::FsrsCardState` ? | struct | `crates/dstu-anki/src/fsrs_review_service.rs:107` | L24-chatanki 0/1 | `pub struct FsrsCardState` |
| `dstu_learning::mastery::service::MIN_TOTAL_FOR_WEAK` ? | const | `crates/dstu-learning/src/mastery/service.rs:26` | L14-qbank 0/1 | `pub const MIN_TOTAL_FOR_WEAK: i32 = 3` |
| `dstu_learning::mastery::service::WEAK_SCORE_THRESHOLD` ? | const | `crates/dstu-learning/src/mastery/service.rs:25` | L14-qbank 0/1 | `pub const WEAK_SCORE_THRESHOLD: f64 = 0.5` |
| `dstu_learning::study_loop::study_time::add_seconds` | fn | `crates/dstu-learning/src/study_loop/study_time.rs:56` | L17-memory-research 0/1 | `pub fn add_seconds( conn: &Connection, date: &str, seconds: i64, now_ms: i64, ) -> rusqlite::Result<StudyTimeDay>` |

### 引用点样例

- `dstu_anki::fsrs_review_service::FsrsReviewService::new` — L16-anki: `crates/dstu-anki/src/anki_fsrs_feedback.rs:724`, `crates/dstu-anki/src/anki_fsrs_feedback.rs:744`, `crates/dstu-anki/src/apkg_importer_service.rs:4901`, `crates/dstu-anki/src/apkg_importer_service.rs:5157`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:2406`, `src/chat_v2/tools/chatanki_executor.rs:2663`, `src/chat_v2/tools/chatanki_executor.rs:3299`, `src/chat_v2/tools/chatanki_executor.rs:3377`；L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:173`, `src/chat_v2/tools/learning_overview_executor.rs:200`
- `dstu_anki::fsrs_review_service::FsrsAgentReviewStateSnapshot` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:12098`, `src/chat_v2/tools/chatanki_executor.rs:12252`, `src/chat_v2/tools/chatanki_executor.rs:12272`, `src/chat_v2/tools/chatanki_executor.rs:12296`；L16-anki: `src/cmd/enhanced_anki.rs:903`, `src/cmd/enhanced_anki.rs:402`
- `dstu_anki::fsrs_review_service::FsrsAgentReviewMutationOutcome` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:12024`, `src/chat_v2/tools/chatanki_executor.rs:12063`, `src/chat_v2/tools/chatanki_executor.rs:12097`, `src/chat_v2/tools/chatanki_executor.rs:12030`
- `dstu_learning::mastery::service::MasteryService::new` — L14-qbank: `crates/dstu-qbank/src/qbank_grading/pipeline.rs:455`, `crates/dstu-qbank/src/qbank_practice.rs:476`, `crates/dstu-qbank/src/qbank_practice.rs:561`, `crates/dstu-qbank/src/qbank_practice.rs:952`；L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:196`；L21-backup-governance: `src/data_governance/commands_backup.rs:599`
- `dstu_qbank::review_plan_service::ReviewPlanService::new` — L14-qbank: `crates/dstu-qbank/src/qbank_grading/pipeline.rs:440`, `crates/dstu-qbank/src/qbank_practice.rs:549`, `crates/dstu-qbank/src/qbank_practice.rs:947`, `crates/dstu-qbank/src/qbank_practice.rs:1114`；L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:151`
- `dstu_anki::fsrs_review_service::FsrsReviewService` — L16-anki: `crates/dstu-anki/src/anki_fsrs_feedback.rs:30`, `crates/dstu-anki/src/apkg_importer_service.rs:2`, `crates/dstu-anki/src/apkg_importer_service.rs:2655`, `crates/dstu-anki/src/enhanced_anki_service.rs:491`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:12213`, `src/chat_v2/tools/fsrs_settings_executor.rs:34`；L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:16`
- `dstu_qbank::review_plan_service::ReviewPlanService` — L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:17`；L14-qbank: `src/chat_v2/tools/review_executor.rs:61`, `src/chat_v2/tools/review_executor.rs:162`, `src/chat_v2/tools/review_executor.rs:598`, `src/chat_v2/tools/review_executor.rs:618`
- `dstu_anki::fsrs_review_service::FsrsState` — L16-anki: `crates/dstu-anki/src/apkg_importer_service.rs:4874`, `crates/dstu-anki/src/apkg_importer_service.rs:4879`, `crates/dstu-anki/src/apkg_importer_service.rs:4890`, `crates/dstu-anki/src/apkg_importer_service.rs:4895`
- `dstu_anki::fsrs_review_service::FsrsLibraryEnqueueOutcome` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:78`, `src/chat_v2/tools/chatanki_executor.rs:3866`, `src/chat_v2/tools/chatanki_executor.rs:3911`, `src/chat_v2/tools/chatanki_executor.rs:3924`
- `dstu_anki::fsrs_review_service::FsrsFeedbackRow` — L16-anki: `crates/dstu-anki/src/anki_fsrs_feedback.rs:173`, `crates/dstu-anki/src/anki_fsrs_feedback.rs:200`, `crates/dstu-anki/src/anki_fsrs_feedback.rs:302`, `crates/dstu-anki/src/anki_fsrs_feedback.rs:455`
- `dstu_anki::fsrs_review_service::FsrsEnqueueResult` — L16-anki: `crates/dstu-anki/src/enhanced_anki_service.rs:492`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:12178`, `src/chat_v2/tools/chatanki_executor.rs:12214`, `src/chat_v2/tools/chatanki_executor.rs:16097`, `src/chat_v2/tools/chatanki_executor.rs:16163`
- `dstu_anki::fsrs_review_service::FsrsEnqueuedCard` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:12179`, `src/chat_v2/tools/chatanki_executor.rs:12186`, `src/chat_v2/tools/chatanki_executor.rs:12190`, `src/chat_v2/tools/chatanki_executor.rs:16135`
- `dstu_anki::fsrs_review_service::FsrsImportedSchedule` — L16-anki: `crates/dstu-anki/src/apkg_importer_service.rs:2328`, `crates/dstu-anki/src/apkg_importer_service.rs:2495`, `crates/dstu-anki/src/apkg_importer_service.rs:2526`
- `dstu_anki::fsrs_review_service::FsrsSchedulerConfigUpdate` — L24-chatanki: `src/chat_v2/tools/fsrs_settings_executor.rs:76`, `src/chat_v2/tools/fsrs_settings_executor.rs:83`
- `dstu_learning::mastery::profile_sink::MasteryWeakPointEvidence` — L17-memory-research: `crates/dstu-memory/src/memory/learner_profile.rs:1022`, `crates/dstu-memory/src/memory/mastery_hook.rs:22`
- `dstu_learning::mastery::profile_sink::WEAK_POINT_SOURCE_MASTERY` — L17-memory-research: `crates/dstu-memory/src/memory/learner_profile.rs:1043`, `crates/dstu-memory/src/memory/learner_profile.rs:1077`
- `dstu_learning::study_loop::media_source::prepare_media_text_for_generation` — L14-qbank: `crates/dstu-qbank/src/qbank_generation/reference.rs:220`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:10079`
- `dstu_anki::fsrs_review_service::FsrsStats` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:12238`, `src/chat_v2/tools/chatanki_executor.rs:16058`
- `dstu_anki::fsrs_review_service::emit_fsrs_enqueue_changed` — L16-anki: `crates/dstu-anki/src/enhanced_anki_service.rs:519`
- `dstu_anki::fsrs_review_service::FsrsImportedSchedule::new_card` — L16-anki: `crates/dstu-anki/src/apkg_importer_service.rs:2504`
- `dstu_anki::fsrs_review_service::FsrsLibraryEnqueueCard` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:3849`
- `dstu_anki::fsrs_review_service::FsrsReviewService::enqueue_imported_cards_in_tx` — L16-anki: `crates/dstu-anki/src/apkg_importer_service.rs:2413`
- `dstu_learning::fsrs_scheduler::DEFAULT_DAY_ROLLOVER_HOUR` — L16-anki: `crates/dstu-anki/src/apkg_exporter_service.rs:572`
- `dstu_learning::fsrs_scheduler::forgetting_curve_constants` — L16-anki: `crates/dstu-anki/src/anki_fsrs_feedback.rs:177`
- `dstu_learning::fsrs_scheduler::logical_day_bounds_ms` — L16-anki: `crates/dstu-anki/src/apkg_exporter_service.rs:604`
- `dstu_learning::fsrs_scheduler::logical_days_between` — L16-anki: `crates/dstu-anki/src/apkg_exporter_service.rs:587`
- `dstu_learning::fsrs_scheduler::retrievability` — L16-anki: `crates/dstu-anki/src/anki_fsrs_feedback.rs:178`
- `dstu_learning::mastery::profile_sink::MasteryProfileSink` — L17-memory-research: `crates/dstu-memory/src/memory/mastery_hook.rs:17`
- `dstu_learning::mastery::profile_sink::register_mastery_profile_sink` — L17-memory-research: `crates/dstu-memory/src/memory/mastery_hook.rs:40`
- `dstu_learning::mastery::service::MasteryService::recompute_all_states_with_conn` — L21-backup-governance: `src/data_governance/commands_backup.rs:552`
- `dstu_learning::mastery::types::MasteryState` — L14-qbank: `crates/dstu-qbank/src/question_bank_service.rs:91`
- `dstu_learning::study_loop::media_source::contains_media_anchor` — L14-qbank: `crates/dstu-qbank/src/qbank_generation/reference.rs:51`
- `dstu_learning::study_loop::media_source::media_citation_seconds_for` — L18-media-docs: `crates/dstu-media/src/media/ledger.rs:212`
- `dstu_learning::study_loop::media_source::MEDIA_QUESTION_REQUIREMENTS` — L14-qbank: `crates/dstu-qbank/src/qbank_generation/types.rs:314`
- `dstu_learning::study_loop::study_time::range` — L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:977`
- `dstu_learning::mastery::service::set_now_override_ms` — L14-qbank: `crates/dstu-qbank/src/question_bank_service.rs:3651`, `crates/dstu-qbank/src/question_bank_service.rs:3653`, `crates/dstu-qbank/src/question_bank_service.rs:3660`, `crates/dstu-qbank/src/question_bank_service.rs:3665`
- `dstu_anki::fsrs_review_service::FsrsAgentLatestReviewSnapshot` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:14966`；L16-anki: `src/cmd/enhanced_anki.rs:911`
- `dstu_learning::mastery::service::MasteryService` — L14-qbank: `crates/dstu-qbank/src/question_bank_service.rs:3579`, `tests/mastery_qbank_correction.rs:43`
- `dstu_anki::fsrs_review_service::FsrsCardState` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:16109`
- `dstu_learning::mastery::service::MIN_TOTAL_FOR_WEAK` — L14-qbank: `src/question_bank_service/tests.rs:96`
- `dstu_learning::mastery::service::WEAK_SCORE_THRESHOLD` — L14-qbank: `src/question_bank_service/tests.rs:95`
- `dstu_learning::study_loop::study_time::add_seconds` — L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:1311`

## 消费其他 lane

### F4-security（15 个条目，prod 369 / test 19）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError::database` | method | 229/0 | `crates/dstu-anki/src/fsrs_review_service.rs`, `crates/dstu-learning/src/mastery/service.rs`, `crates/dstu-learning/src/study_loop/study_time.rs` 等 4 个 |
| `dstu_core::models::AppError::validation` | method | 51/0 | `crates/dstu-anki/src/fsrs_review_service.rs`, `crates/dstu-learning/src/mastery/service.rs`, `crates/dstu-learning/src/study_loop/study_time.rs` |
| `dstu_core::models::AppError` | struct | 50/1 | `crates/dstu-anki/src/fsrs_review_service.rs`, `crates/dstu-learning/src/mastery/service.rs`, `crates/dstu-learning/src/study_loop/study_time.rs` 等 7 个 |
| `dstu_core::models::AppError::not_found` | method | 18/0 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_core::models::AppError::conflict` | method | 12/0 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_core::models::AppError::internal` | method | 3/0 | `crates/dstu-learning/src/study_loop/study_time.rs`, `src/cmd/fsrs_review.rs` |
| `dstu_core::models::AppErrorType` | enum | 1/7 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_core::models::AppError::with_details` ? | method | 1/0 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_core::spaced_repetition::calculate_next_review` | fn | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_core::spaced_repetition::calculate_next_review_date` | fn | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_core::spaced_repetition::DEFAULT_EASE_FACTOR` | const | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_core::spaced_repetition::PASSING_GRADE` | const | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_core::models::AnkiCard` | struct | 0/5 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_core::models::TaskStatus` ? | enum | 0/4 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_core::models::DocumentTask` | struct | 0/2 | `crates/dstu-anki/src/fsrs_review_service.rs` |

### L11-vfs-repos（37 个条目，prod 71 / test 14）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::review_plan_repo::ReviewPlan` | struct | 17/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::ReviewPlanStatus` | enum | 7/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::DueReviewsResult` | struct | 6/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::ReviewStats` | struct | 4/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::DueReviewsFilter` | struct | 3/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::ReviewHistory` | struct | 3/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionFilters` | struct | 2/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_question` ? | method | 2/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::CalendarHeatmapData` | struct | 2/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::get_plan` | method | 2/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::list_due_reviews` | method | 2/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo` | struct | 1/2 | `crates/dstu-qbank/src/review_plan_service.rs`, `src/mastery/service/tests.rs`, `src/review_plan_service/tests.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::list_questions` ? | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::CreateReviewPlanParams` | struct | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::RecordReviewHistoryParams` | struct | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::UpdateReviewPlanParams` | struct | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo` | struct | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::create_plan` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::delete_plan` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::delete_plan_if_unchanged` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::get_calendar_data` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::get_history` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::get_plan_by_question` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::get_stats` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::list_plans_by_exam` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::record_history_with_conn` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::refresh_stats` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::resume_plan` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::resume_plan_if_unchanged` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::suspend_plan` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::suspend_plan_if_unchanged` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::VfsReviewPlanRepo::update_plan_with_conn` | method | 1/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::create_exam_sheet` ? | method | 0/3 | `src/review_plan_service/tests.rs` |
| `dstu_vfs::vfs::repos::question_repo::CreateQuestionParams` | struct | 0/3 | `src/mastery/service/tests.rs`, `src/review_plan_service/tests.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::create_question` ? | method | 0/3 | `src/mastery/service/tests.rs`, `src/review_plan_service/tests.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionType` ? | enum | 0/2 | `src/mastery/service/tests.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo` | struct | 0/1 | `src/review_plan_service/tests.rs` |

### L22-app-commands（1 个条目，prod 52 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 52/0 | `src/cmd/fsrs_review.rs`, `src/essay_grading/mod.rs`, `src/insight/handlers.rs` |

### L13-vfs-api（8 个条目，prod 41 / test 10）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 31/4 | `crates/dstu-learning/src/mastery/mod.rs`, `crates/dstu-learning/src/mastery/profile_sink.rs`, `crates/dstu-learning/src/mastery/service.rs` 等 8 个 |
| `dstu_vfs::vfs::error::VfsResult` | type | 4/0 | `crates/dstu-learning/src/mastery/profile_sink.rs` |
| `dstu_vfs::vfs::types::VfsEssaySession` | struct | 3/0 | `src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::error::VfsError` ? | enum | 2/0 | `crates/dstu-qbank/src/review_plan_service.rs` |
| `dstu_vfs::vfs::types::VfsUpdateEssaySessionParams` | struct | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::types::VfsCreateExamSheetParams` | struct | 0/3 | `src/review_plan_service/tests.rs` |
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | 0/2 | `src/fsrs_review_service/tests.rs`, `src/mastery/service/tests.rs` |
| `dstu_vfs::vfs::database::VfsDatabase::new` | method | 0/1 | `src/review_plan_service/tests.rs` |

### L02-llm-manager（27 个条目，prod 34 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_tutor::essay_grading::types::GradingMode` ? | struct | 7/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::types::GradingRoundResponse` | struct | 2/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::custom_modes::CreateModeInput` ? | struct | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::custom_modes::SaveBuiltinOverrideInput` ? | struct | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::custom_modes::UpdateModeInput` ? | struct | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_create_custom_mode` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_create_session` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_delete_custom_mode` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_delete_session` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_get_latest_round_number` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_get_mode` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_get_models` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_get_modes` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_get_round` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_get_rounds` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_get_session` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_has_builtin_override` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_list_custom_modes` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_list_sessions` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_reset_builtin_mode` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_save_builtin_override` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_stream` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_toggle_favorite` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_update_custom_mode` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::essay_grading_update_session` | fn | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::types::GradingRequest` ? | struct | 1/0 | `src/essay_grading/mod.rs` |
| `dstu_tutor::essay_grading::types::GradingResponse` | struct | 1/0 | `src/essay_grading/mod.rs` |

### F3-storage（12 个条目，prod 7 / test 70）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::AnkiLibraryScope` | struct | 5/0 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_storage::database::Database` | struct | 2/20 | `crates/dstu-anki/src/fsrs_review_service.rs`, `src/fsrs_review_service/tests.rs`, `src/mastery/service/tests.rs` |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 0/14 | `crates/dstu-anki/src/fsrs_review_service.rs`, `src/fsrs_review_service/tests.rs`, `src/mastery/service/tests.rs` 等 4 个 |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 0/7 | `crates/dstu-anki/src/fsrs_review_service.rs`, `src/fsrs_review_service/tests.rs`, `src/mastery/service/tests.rs` 等 4 个 |
| `dstu_storage::migration::mistakes::MISTAKES_MIGRATIONS` | const | 0/7 | `crates/dstu-anki/src/fsrs_review_service.rs`, `src/fsrs_review_service/tests.rs` |
| `dstu_storage::database::AnkiLibraryScope::agent` ? | method | 0/5 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_storage::database::AnkiLibraryCardDeleteOutcome` | enum | 0/4 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/4 | `crates/dstu-anki/src/fsrs_review_service.rs`, `src/fsrs_review_service/tests.rs`, `src/mastery/service/tests.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 0/4 | `crates/dstu-anki/src/fsrs_review_service.rs`, `src/fsrs_review_service/tests.rs`, `src/mastery/service/tests.rs` 等 4 个 |
| `dstu_storage::database::AnkiLibraryDiagnosticFilter` | enum | 0/2 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_storage::database::AnkiLibraryScheduleFilter` | enum | 0/2 | `crates/dstu-anki/src/fsrs_review_service.rs` |
| `dstu_storage::database::AnkiCardVersionDelete` ? | enum | 0/1 | `crates/dstu-anki/src/fsrs_review_service.rs` |

### F1-kernel（5 个条目，prod 4 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_kernel::disposer::Disposer` | struct | 1/0 | `crates/dstu-learning/src/mastery/profile_sink.rs` |
| `dstu_kernel::slot::Slot` | struct | 1/0 | `crates/dstu-learning/src/mastery/profile_sink.rs` |
| `dstu_kernel::slot::Slot::new` | method | 1/0 | `crates/dstu-learning/src/mastery/profile_sink.rs` |
| `dstu_kernel::slot::SlotOccupied` | struct | 1/0 | `crates/dstu-learning/src/mastery/profile_sink.rs` |
| `deep_student_lib::extensions::register_extensions` | fn | 0/2 | `src/mastery/service/tests.rs` |

### L17-memory-research（4 个条目，prod 3 / test 4）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_research::insight::jobs::InsightJobWorker::new` ? | method | 1/0 | `src/insight/handlers.rs` |
| `dstu_research::insight::service::InsightService` ? | struct | 1/0 | `src/insight/handlers.rs` |
| `dstu_research::insight::service::InsightService::new` ? | method | 1/0 | `src/insight/handlers.rs` |
| `dstu_memory::memory::learner_profile::load_profile_from_db` | fn | 0/4 | `src/mastery/service/tests.rs` |

### L14-qbank（2 个条目，prod 0 / test 3）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_qbank::question_bank_service::QuestionBankService::new` ? | method | 0/2 | `src/mastery/service/tests.rs` |
| `dstu_qbank::question_bank_service::QuestionBankService` ? | struct | 0/1 | `src/mastery/service/tests.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 F2-shell 导入：`use dstu_anki::fsrs_review_service::*` @ `src/lib.rs:89`
- 被 F2-shell 导入：`use dstu_learning::mastery::*` @ `src/lib.rs:114`
- 被 F2-shell 导入：`use dstu_learning::mastery::service::*` @ `src/lib.rs:116`
- 被 F2-shell 导入：`use dstu_qbank::review_plan_service::*` @ `src/lib.rs:182`
- 导入 L02-llm-manager：`use dstu_tutor::essay_grading::*` @ `src/essay_grading/mod.rs:8`
- 导入 F2-shell：`use deep_student_lib::fsrs_review_service::*` @ `src/fsrs_review_service/tests.rs:10`（test）
- 导入 L17-memory-research：`use dstu_research::insight::types::*` @ `src/insight/handlers.rs:9`
- 导入 F2-shell：`use deep_student_lib::mastery::service::*` @ `src/mastery/service/tests.rs:9`（test）
- 导入 F2-shell：`use deep_student_lib::review_plan_service::*` @ `src/review_plan_service/tests.rs:6`（test）

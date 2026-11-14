# 跨 lane 服务草稿：L24-chatanki

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（39 个条目，其中 7 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `deep_student_lib::chat_v2::tools::fsrs_settings_executor::FsrsSettingsExecutor` | struct | `src/chat_v2/tools/fsrs_settings_executor.rs:25` | F1-kernel 1/2<br>L13-vfs-api 1/0 | `pub struct FsrsSettingsExecutor` |
| `deep_student_lib::chat_v2::tools::template_executor::TemplateDesignerExecutor` | struct | `src/chat_v2/tools/template_executor.rs:168` | F1-kernel 1/1<br>L13-vfs-api 1/0<br>L22-app-commands 0/1 | `pub struct TemplateDesignerExecutor` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiToolExecutor` | struct | `src/chat_v2/tools/chatanki_executor.rs:1725` | F1-kernel 1/1<br>L13-vfs-api 1/0 | `pub struct ChatAnkiToolExecutor` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiToolExecutor::new` | method | `src/chat_v2/tools/chatanki_executor.rs:1728` | F1-kernel 1/1 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::install_agent_hooks` | fn | `src/chat_v2/tools/chatanki_executor.rs:370` | F1-kernel 1/0 | `pub(crate) fn install_agent_hooks(scope: &mut dstu_kernel::Scope)` |
| `deep_student_lib::chat_v2::tools::fsrs_settings_executor::FsrsSettingsExecutor::new` | method | `src/chat_v2/tools/fsrs_settings_executor.rs:28` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::template_executor::TemplateDesignerExecutor::new` | method | `src/chat_v2/tools/template_executor.rs:177` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiRoute` | enum | `src/chat_v2/tools/chatanki_executor.rs:1696` | L16-anki 0/11 | `pub enum ChatAnkiRoute` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::resolve_route_decision` | fn | `src/chat_v2/tools/chatanki_executor.rs:9473` | L16-anki 0/8 | `pub fn resolve_route_decision( forced_route: Option<ChatAnkiRoute>, llm_plan: Option<&RoutePlan>, ref_data: &VfsContextRefData, ) -> RouteDecision` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::parse_route_plan_response` | fn | `src/chat_v2/tools/chatanki_executor.rs:9363` | L16-anki 0/6 | `pub fn parse_route_plan_response(response: &str) -> Option<RoutePlan>` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiRetemplateStrategy` | enum | `src/chat_v2/tools/chatanki_executor.rs:1450` | L16-anki 0/5 | `pub enum ChatAnkiRetemplateStrategy` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::RouteSource` | enum | `src/chat_v2/tools/chatanki_executor.rs:9404` | L16-anki 0/5 | `pub enum RouteSource` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::text_has_valid_cloze_markup` | fn | `src/chat_v2/tools/chatanki_transform_script.rs:251` | L16-anki 0/5 | `pub fn text_has_valid_cloze_markup(text: &str) -> bool` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::TransformFields` | struct | `src/chat_v2/tools/chatanki_transform.rs:428` | L16-anki 0/5 | `pub struct TransformFields` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::RoutePlan` | struct | `src/chat_v2/tools/chatanki_executor.rs:9176` | L16-anki 0/3 | `pub struct RoutePlan` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::evaluate_script_output` | fn | `src/chat_v2/tools/chatanki_transform_script.rs:468` | L16-anki 0/3 | `pub fn evaluate_script_output( raw: &[u8], selected: &[crate::models::AnkiCard], ) -> Result<ScriptTransformEvaluation, ScriptOutputError>` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::compile_transform_ops` | fn | `src/chat_v2/tools/chatanki_transform.rs:392` | L16-anki 0/3 | `pub fn compile_transform_ops( ops: &[NormalizedTransformOp], ) -> Result<Vec<CompiledTransformOp>, InvalidPatternError>` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformOp` | enum | `src/chat_v2/tools/chatanki_transform.rs:133` | L16-anki 0/3 | `pub enum NormalizedTransformOp` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::select_transform_cards` | fn | `src/chat_v2/tools/chatanki_transform.rs:727` | L16-anki 0/3 | `pub fn select_transform_cards( cards: Vec<crate::models::AnkiCard>, selection: &NormalizedTransformSelection, ) -> Result<Vec<crate::models::AnkiCard>, TransformSelectionError>` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::transform_fields_are_valid` | fn | `src/chat_v2/tools/chatanki_transform.rs:704` | L16-anki 0/3 | `pub fn transform_fields_are_valid(fields: &TransformFields) -> bool` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::TransformCardPlan` | enum | `src/chat_v2/tools/chatanki_transform.rs:676` | L16-anki 0/3 | `pub enum TransformCardPlan` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::build_analyze_output` | fn | `src/chat_v2/tools/chatanki_executor.rs:9578` | L16-anki 0/2 | `pub fn build_analyze_output( goal: Option<&str>, content: &str, ref_data: Option<&VfsContextRefData>, decision: &RouteDecision, warnings: &[Value], ) -> Value` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::changed_field_names` | fn | `src/chat_v2/tools/chatanki_transform.rs:656` | L16-anki 0/2 | `pub fn changed_field_names(before: &TransformFields, after: &TransformFields) -> Vec<&'static str>` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::check_expected_versions` | fn | `src/chat_v2/tools/chatanki_transform.rs:782` | L16-anki 0/2 | `pub fn check_expected_versions( selected_card_ids: &[String], expected_versions: &HashMap<String, String>, ) -> Result<(), ExpectedVersionsMismatch>` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformKind` | enum | `src/chat_v2/tools/chatanki_transform.rs:148` | L16-anki 0/2 | `pub enum NormalizedTransformKind` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformSelection` | enum | `src/chat_v2/tools/chatanki_transform.rs:155` | L16-anki 0/2 | `pub enum NormalizedTransformSelection` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::TransformMode` | enum | `src/chat_v2/tools/chatanki_transform.rs:49` | L16-anki 0/2 | `pub enum TransformMode` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::RouteDecision` | struct | `src/chat_v2/tools/chatanki_executor.rs:9429` | L16-anki 0/1 | `pub struct RouteDecision` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::build_script_input` | fn | `src/chat_v2/tools/chatanki_transform_script.rs:175` | L16-anki 0/1 | `pub fn build_script_input(document_id: &str, cards: &[crate::models::AnkiCard]) -> Value` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::resolve_interpreter_in_dirs` | fn | `src/chat_v2/tools/chatanki_transform_script.rs:627` | L16-anki 0/1 | `pub fn resolve_interpreter_in_dirs(candidates: &[&str], dirs: &[PathBuf]) -> Option<PathBuf>` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::ScriptOutputError` | enum | `src/chat_v2/tools/chatanki_transform_script.rs:205` | L16-anki 0/1 | `pub enum ScriptOutputError` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::transform_sandbox_policy` | fn | `src/chat_v2/tools/chatanki_transform_script.rs:704` | L16-anki 0/1 | `pub fn transform_sandbox_policy(job_dir: &Path, interpreter: &Path) -> SandboxPolicy` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::apply_transform_ops` | fn | `src/chat_v2/tools/chatanki_transform.rs:602` | L16-anki 0/1 | `pub fn apply_transform_ops( ops: &[CompiledTransformOp], fields: &TransformFields, ) -> Result<TransformFields, TransformFieldGrowthError>` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::ChatAnkiTransformArgs` | struct | `src/chat_v2/tools/chatanki_transform.rs:116` | L16-anki 0/1 | `pub struct ChatAnkiTransformArgs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::ChatAnkiTransformArgs::normalize` | method | `src/chat_v2/tools/chatanki_transform.rs:175` | L16-anki 0/1 | `pub fn normalize(self) -> Result<NormalizedTransformRequest, String>` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformRequest` | struct | `src/chat_v2/tools/chatanki_transform.rs:163` | L16-anki 0/1 | `pub struct NormalizedTransformRequest` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::plan_transform_ops` | fn | `src/chat_v2/tools/chatanki_transform.rs:685` | L16-anki 0/1 | `pub fn plan_transform_ops( ops: &[CompiledTransformOp], selected: &[crate::models::AnkiCard], ) -> Vec<TransformCardPlan>` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::TransformFields::from_card` | method | `src/chat_v2/tools/chatanki_transform.rs:436` | L16-anki 0/1 | `pub fn from_card(card: &crate::models::AnkiCard) -> Self` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::TransformSelectionError` | enum | `src/chat_v2/tools/chatanki_transform.rs:719` | L16-anki 0/1 | `pub enum TransformSelectionError` |

### 引用点样例

- `deep_student_lib::chat_v2::tools::fsrs_settings_executor::FsrsSettingsExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:83`, `src/agent_wiring/tests/headless_tests.rs:30`；L13-vfs-api: `src/chat_v2/tools/mod.rs:65`
- `deep_student_lib::chat_v2::tools::template_executor::TemplateDesignerExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:88`；L13-vfs-api: `src/chat_v2/tools/mod.rs:79`；L22-app-commands: `tests/tool_pack_integration_tests.rs:46`
- `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiToolExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:58`；L13-vfs-api: `src/chat_v2/tools/mod.rs:59`
- `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:46`, `src/agent_wiring/tests/custom_agent_tests.rs:29`
- `deep_student_lib::chat_v2::tools::chatanki_executor::install_agent_hooks` — F1-kernel: `src/extensions.rs:275`
- `deep_student_lib::chat_v2::tools::fsrs_settings_executor::FsrsSettingsExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:71`
- `deep_student_lib::chat_v2::tools::template_executor::TemplateDesignerExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:76`
- `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiRoute` — L16-anki: `tests/anki_ai_native_integration.rs:429`, `tests/anki_ai_native_integration.rs:438`, `tests/anki_ai_native_integration.rs:457`, `tests/anki_ai_native_integration.rs:468`
- `deep_student_lib::chat_v2::tools::chatanki_executor::resolve_route_decision` — L16-anki: `tests/anki_ai_native_integration.rs:455`, `tests/anki_ai_native_integration.rs:466`, `tests/anki_ai_native_integration.rs:475`, `tests/anki_ai_native_integration.rs:486`
- `deep_student_lib::chat_v2::tools::chatanki_executor::parse_route_plan_response` — L16-anki: `tests/anki_ai_native_integration.rs:425`, `tests/anki_ai_native_integration.rs:434`, `tests/anki_ai_native_integration.rs:441`, `tests/anki_ai_native_integration.rs:442`
- `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiRetemplateStrategy` — L16-anki: `tests/anki_ai_native_integration.rs:579`, `tests/anki_ai_native_integration.rs:584`, `tests/anki_ai_native_integration.rs:572`, `tests/anki_ai_native_integration.rs:573`
- `deep_student_lib::chat_v2::tools::chatanki_executor::RouteSource` — L16-anki: `tests/anki_ai_native_integration.rs:456`, `tests/anki_ai_native_integration.rs:467`, `tests/anki_ai_native_integration.rs:478`, `tests/anki_ai_native_integration.rs:487`
- `deep_student_lib::chat_v2::tools::chatanki_transform_script::text_has_valid_cloze_markup` — L16-anki: `tests/anki_ai_native_integration.rs:398`, `tests/anki_ai_native_integration.rs:399`, `tests/anki_ai_native_integration.rs:400`, `tests/anki_ai_native_integration.rs:401`
- `deep_student_lib::chat_v2::tools::chatanki_transform::TransformFields` — L16-anki: `tests/anki_ai_native_integration.rs:181`, `tests/anki_ai_native_integration.rs:189`, `tests/anki_ai_native_integration.rs:190`, `tests/anki_ai_native_integration.rs:298`
- `deep_student_lib::chat_v2::tools::chatanki_executor::RoutePlan` — L16-anki: `tests/anki_ai_native_integration.rs:460`, `tests/anki_ai_native_integration.rs:471`, `tests/anki_ai_native_integration.rs:504`
- `deep_student_lib::chat_v2::tools::chatanki_transform_script::evaluate_script_output` — L16-anki: `tests/anki_ai_native_integration.rs:331`, `tests/anki_ai_native_integration.rs:353`, `tests/anki_ai_native_integration.rs:366`
- `deep_student_lib::chat_v2::tools::chatanki_transform::compile_transform_ops` — L16-anki: `tests/anki_ai_native_integration.rs:171`, `tests/anki_ai_native_integration.rs:272`, `tests/anki_ai_native_integration.rs:286`
- `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformOp` — L16-anki: `tests/anki_ai_native_integration.rs:263`, `tests/anki_ai_native_integration.rs:266`, `tests/anki_ai_native_integration.rs:281`
- `deep_student_lib::chat_v2::tools::chatanki_transform::select_transform_cards` — L16-anki: `tests/anki_ai_native_integration.rs:165`, `tests/anki_ai_native_integration.rs:238`, `tests/anki_ai_native_integration.rs:254`
- `deep_student_lib::chat_v2::tools::chatanki_transform::transform_fields_are_valid` — L16-anki: `tests/anki_ai_native_integration.rs:291`, `tests/anki_ai_native_integration.rs:293`, `tests/anki_ai_native_integration.rs:304`
- `deep_student_lib::chat_v2::tools::chatanki_transform::TransformCardPlan` — L16-anki: `tests/anki_ai_native_integration.rs:46`, `tests/anki_ai_native_integration.rs:175`, `tests/anki_ai_native_integration.rs:186`
- `deep_student_lib::chat_v2::tools::chatanki_executor::build_analyze_output` — L16-anki: `tests/anki_ai_native_integration.rs:516`, `tests/anki_ai_native_integration.rs:549`
- `deep_student_lib::chat_v2::tools::chatanki_transform::changed_field_names` — L16-anki: `tests/anki_ai_native_integration.rs:181`, `tests/anki_ai_native_integration.rs:190`
- `deep_student_lib::chat_v2::tools::chatanki_transform::check_expected_versions` — L16-anki: `tests/anki_ai_native_integration.rs:217`, `tests/anki_ai_native_integration.rs:223`
- `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformKind` — L16-anki: `tests/anki_ai_native_integration.rs:46`, `tests/anki_ai_native_integration.rs:168`
- `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformSelection` — L16-anki: `tests/anki_ai_native_integration.rs:46`, `tests/anki_ai_native_integration.rs:240`
- `deep_student_lib::chat_v2::tools::chatanki_transform::TransformMode` — L16-anki: `tests/anki_ai_native_integration.rs:154`, `tests/anki_ai_native_integration.rs:214`
- `deep_student_lib::chat_v2::tools::chatanki_executor::RouteDecision` — L16-anki: `tests/anki_ai_native_integration.rs:543`
- `deep_student_lib::chat_v2::tools::chatanki_transform_script::build_script_input` — L16-anki: `tests/anki_ai_native_integration.rs:317`
- `deep_student_lib::chat_v2::tools::chatanki_transform_script::resolve_interpreter_in_dirs` — L16-anki: `tests/anki_ai_native_integration.rs:389`
- `deep_student_lib::chat_v2::tools::chatanki_transform_script::ScriptOutputError` — L16-anki: `tests/anki_ai_native_integration.rs:354`
- `deep_student_lib::chat_v2::tools::chatanki_transform_script::transform_sandbox_policy` — L16-anki: `tests/anki_ai_native_integration.rs:411`
- `deep_student_lib::chat_v2::tools::chatanki_transform::apply_transform_ops` — L16-anki: `tests/anki_ai_native_integration.rs:289`
- `deep_student_lib::chat_v2::tools::chatanki_transform::ChatAnkiTransformArgs` — L16-anki: `tests/anki_ai_native_integration.rs:113`
- `deep_student_lib::chat_v2::tools::chatanki_transform::ChatAnkiTransformArgs::normalize` — L16-anki: `tests/anki_ai_native_integration.rs:115`
- `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformRequest` — L16-anki: `tests/anki_ai_native_integration.rs:111`
- `deep_student_lib::chat_v2::tools::chatanki_transform::plan_transform_ops` — L16-anki: `tests/anki_ai_native_integration.rs:172`
- `deep_student_lib::chat_v2::tools::chatanki_transform::TransformFields::from_card` — L16-anki: `tests/anki_ai_native_integration.rs:287`
- `deep_student_lib::chat_v2::tools::chatanki_transform::TransformSelectionError` — L16-anki: `tests/anki_ai_native_integration.rs:245`

## 消费其他 lane

### F4-security（34 个条目，prod 376 / test 150）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::agent::ToolResultInfo` ? | struct | 56/2 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `src/chat_v2/tools/template_executor.rs` |
| `dstu_core::agent::ToolCall` ? | struct | 51/1 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `src/chat_v2/tools/template_executor.rs` 等 4 个 |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 43/0 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `src/chat_v2/tools/template_executor.rs` |
| `dstu_core::models::AnkiCard` | struct | 41/10 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/chatanki_transform.rs`, `src/chat_v2/tools/chatanki_transform_script.rs` |
| `dstu_core::models::AppErrorType` | enum | 27/4 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::models::FieldExtractionRule` | struct | 16/3 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/template_executor.rs` |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 14/0 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `src/chat_v2/tools/template_executor.rs` |
| `dstu_core::models::TaskStatus` ? | enum | 13/74 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 13/0 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `src/chat_v2/tools/template_executor.rs` |
| `dstu_core::agent::block_status::ERROR` ? | const | 12/1 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_util::utils::text::safe_truncate_chars` ? | fn | 11/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::models::DocumentTask` | struct | 10/10 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::models::AppError` | struct | 9/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::models::CustomAnkiTemplate` | struct | 8/6 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/template_executor.rs` |
| `dstu_core::models::FieldType` ? | enum | 7/2 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/template_executor.rs` |
| `dstu_core::models::CreateTemplateRequest` | struct | 5/8 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/template_executor.rs` |
| `dstu_core::agent::block_types::ANKI_CARDS` ? | const | 5/4 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::agent::block_status::RUNNING` ? | const | 5/3 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::agent::block_status::SUCCESS` ? | const | 5/2 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::agent::MessageBlock` ? | struct | 5/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::events::event_types::ANKI_CARDS` ? | const | 5/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::models::UpdateTemplateRequest` | struct | 4/3 | `src/chat_v2/tools/template_executor.rs` |
| `dstu_core::models::AnkiGenerationOptions` | struct | 3/1 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::agent::block_status::PENDING` ? | const | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::agent::block_types::CONTENT` ? | const | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::events::event_types::TOOL_CALL` ? | const | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::models::AnkiDocumentGenerationRequest` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::models::AppError::with_details` ? | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::models::StandardModel2Output` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::models::TemplateDescription` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::tool_args::with_localized_message` ? | fn | 1/0 | `src/chat_v2/tools/fsrs_settings_executor.rs` |
| `dstu_core::agent::ToolCall::new` ? | method | 0/11 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_core::agent::MessageBlock::new` ? | method | 0/4 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_core::models::AnkiLibraryCard` | struct | 0/1 | `src/chat_v2/tools/chatanki_executor.rs` |

### L04-chat-session（31 个条目，prod 124 / test 71）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 67/4 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `src/chat_v2/tools/template_executor.rs` 等 4 个 |
| `dstu_agent::chat_v2::database::ChatV2Database` ? | struct | 19/5 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_block_v2` ? | method | 9/16 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::resource_types::ContextRef` ? | struct | 9/3 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter` ? | struct | 5/2 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 3/1 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `src/chat_v2/tools/template_executor.rs` 等 4 个 |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_block_v2` ? | method | 2/2 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_messages_with_conn` ? | method | 2/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::types::MessageRole` ? | enum | 2/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo` ? | struct | 1/1 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::resource_types::ContextRef::new` ? | method | 1/1 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::handlers::manage_session::StaleAnkiBlockReaper` ? | trait | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::kill_switch::EmergencyCancelHook` ? | trait | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_message_blocks_with_conn` ? | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_message_v2` ? | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_message_v2` ? | method | 0/6 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_block_v2` ? | method | 0/4 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_session_v2` ? | method | 0/4 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext::new` ? | method | 0/3 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::types::ChatSession::new` ? | method | 0/3 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::database::ChatV2Database::new` ? | method | 0/2 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::resource_types::ContextSnapshot` ? | struct | 0/2 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::types::ChatMessage::new_assistant` ? | method | 0/2 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::types::ChatMessage::new_user` ? | method | 0/2 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::types::MessageMeta` ? | struct | 0/2 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new` ? | method | 0/1 | `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new_headless` ? | method | 0/1 | `src/chat_v2/tools/fsrs_settings_executor.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new_windowless_for_test` ? | method | 0/1 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::delete_block_v2` ? | method | 0/1 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::types::ChatMessage` ? | struct | 0/1 | `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_agent::chat_v2::types::ChatSession` ? | struct | 0/1 | `tests/chatanki_apkg_executor_e2e.rs` |

### F3-storage（23 个条目，prod 94 / test 77）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 17/7 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `src/chat_v2/tools/template_executor.rs` 等 4 个 |
| `dstu_storage::database::AnkiCardVersionUpdate` ? | enum | 12/6 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiRetemplateBatchResult` ? | enum | 10/15 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiCardVersionDelete` ? | enum | 8/8 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiLibraryScope::agent` ? | method | 7/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiLibraryScheduleFilter` | enum | 6/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiRetemplateSelector` ? | enum | 5/15 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiRetemplateCardUpdate` | struct | 5/2 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiLibraryCardDeleteOutcome` | enum | 5/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiLibraryCardRecord` | struct | 4/2 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiLibraryCardVersionUpdate` | enum | 4/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiLibraryDiagnosticFilter` | enum | 3/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::llm_usage::types::CallerType` ? | enum | 3/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiLibraryCardLocator` | struct | 2/3 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiRetemplateTarget` | struct | 1/2 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::database::AnkiLibraryScope` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::unified_file_manager::is_virtual_uri` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 0/6 | `src/chat_v2/tools/fsrs_settings_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 0/4 | `src/chat_v2/tools/fsrs_settings_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/3 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 0/2 | `src/chat_v2/tools/fsrs_settings_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_storage::database::AnkiRetemplateMissingField` | struct | 0/1 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_storage::migration::mistakes::MISTAKES_MIGRATIONS` | const | 0/1 | `src/chat_v2/tools/fsrs_settings_executor.rs` |

### L15-review-analytics（13 个条目，prod 56 / test 16）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_anki::fsrs_review_service::FsrsAgentReviewStateSnapshot` ? | struct | 14/2 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsReviewService::new` ? | method | 13/3 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsAgentReviewMutationOutcome` ? | enum | 12/3 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsLibraryEnqueueOutcome` ? | enum | 5/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsEnqueuedCard` ? | struct | 3/2 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsEnqueueResult` ? | struct | 2/3 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsReviewService` ? | struct | 2/0 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsSchedulerConfigUpdate` ? | struct | 2/0 | `src/chat_v2/tools/fsrs_settings_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsStats` ? | struct | 1/1 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsLibraryEnqueueCard` ? | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_learning::study_loop::media_source::prepare_media_text_for_generation` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsAgentLatestReviewSnapshot` ? | struct | 0/1 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::fsrs_review_service::FsrsCardState` ? | struct | 0/1 | `src/chat_v2/tools/chatanki_executor.rs` |

### L13-vfs-api（7 个条目，prod 55 / test 99）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::types::VfsResourceType` ? | enum | 27/43 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::types::VfsContextRefData` | struct | 17/42 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 7/2 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_vfs::vfs::types::VfsResourceRef` | struct | 2/8 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::types::VfsFile` ? | struct | 2/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | 0/3 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::database::VfsDatabase::new` | method | 0/1 | `tests/chatanki_apkg_executor_e2e.rs` |

### L16-anki（34 个条目，prod 50 / test 22）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_anki::anki_preference_memory::SessionObservation` | struct | 7/7 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::apkg_importer_service::MAX_APKG_ARCHIVE_BYTES` | const | 4/1 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_connect_service::check_anki_connect_availability` | fn | 3/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::document_processing_service::DocumentProcessingService::new` | method | 3/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::enhanced_anki_service::EnhancedAnkiService::new` | method | 3/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::streaming_anki_service::StreamingAnkiService::new` | method | 3/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_preference_memory::PreferenceStore` | struct | 2/4 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_preference_memory::CardEditObservation` | struct | 2/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::apkg_importer_service::ApkgImporterService::new` | method | 2/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `deep_student_lib::cmd::anki_connect::sanitize_filename_with_extension` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `deep_student_lib::cmd::anki_connect::save_json_file` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_connect_service::add_notes_to_anki_detailed` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_connect_service::AnkiConnectSyncOptions::from_setting_strings` | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_connect_service::create_deck_if_not_exists` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_connect_service::template_model_name` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_gold_set::ContentProvenance::user` | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_gold_set::insert_content_provenance` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_image_occlusion::build_occlusion_draft_marker` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_image_occlusion::build_occlusion_draft_marker_from_spec` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_image_occlusion::OcclusionConfig` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_image_occlusion::parse_occlusion_boxes_from_vlm` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_image_occlusion::strip_occlusion_boxes_blocks` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_preference_memory::CardDeleteObservation` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_preference_memory::consolidate_observation` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_preference_memory::ConsolidateOutcome` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_preference_memory::DEFAULT_PROMPT_TOKEN_BUDGET` | const | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_preference_memory::retrieve_preference_prompt` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::apkg_exporter_service::export_multi_template_apkg_report` | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::apkg_importer_service::ApkgImporterService` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::enhanced_anki_service::EnhancedAnkiService` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_image_occlusion::extract_occlusion_draft_fields` | fn | 0/4 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::anki_image_occlusion::parse_occlusion_field` | fn | 0/4 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::apkg_importer_service::ApkgImportResult` | struct | 0/1 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_anki::apkg_importer_service::ApkgMediaReport` | struct | 0/1 | `src/chat_v2/tools/chatanki_executor.rs` |

### F1-kernel（4 个条目，prod 18 / test 24）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 14/21 | `src/chat_v2/tools/chatanki_executor.rs`, `src/chat_v2/tools/fsrs_settings_executor.rs`, `src/chat_v2/tools/template_executor.rs` |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 3/2 | `src/chat_v2/tools/fsrs_settings_executor.rs` |
| `dstu_kernel::plugin::Scope` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `deep_student_lib::extensions::register_extensions` | fn | 0/1 | `src/chat_v2/tools/chatanki_executor.rs` |

### L05-agent-workspace（13 个条目，prod 12 / test 14）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::shell_sandbox::SandboxPolicy` ? | struct | 2/0 | `src/chat_v2/tools/chatanki_transform_script.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::SandboxEffectReport` ? | struct | 1/2 | `src/chat_v2/tools/chatanki_transform_script.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::SandboxCapability` ? | enum | 1/1 | `src/chat_v2/tools/chatanki_transform_script.rs` |
| `dstu_agent::chat_v2::runtime_roots::temp_root` ? | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::cleanup_finished_process_group` ? | fn | 1/0 | `src/chat_v2/tools/chatanki_transform_script.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::platform_sandbox_contract` ? | fn | 1/0 | `src/chat_v2/tools/chatanki_transform_script.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::PlatformSandboxBackend::new` ? | method | 1/0 | `src/chat_v2/tools/chatanki_transform_script.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::SandboxBackend` ? | trait | 1/0 | `src/chat_v2/tools/chatanki_transform_script.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::terminate_process_group` ? | fn | 1/0 | `src/chat_v2/tools/chatanki_transform_script.rs` |
| `dstu_agent::chat_v2::workspace::card_read_scope::workspace_card_read_scope` ? | fn | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::workspace::card_read_scope::WorkspaceCardReadScopeGuard` ? | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::workspace::card_read_scope::install_workspace_card_read_scope` ? | fn | 0/10 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::PlatformSandboxBackend` ? | struct | 0/1 | `src/chat_v2/tools/chatanki_transform_script.rs` |

### L02-llm-manager（4 个条目，prod 11 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::ImagePayload` | struct | 4/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_llm::llm_manager::LLMManager` | struct | 3/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_llm::anki_model_routing::AnkiModelRole` | enum | 2/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_llm::anki_model_routing::RoutingMode` | enum | 2/0 | `src/chat_v2/tools/chatanki_executor.rs` |

### L11-vfs-repos（11 个条目，prod 10 / test 12）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::get_blob_path` | method | 2/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo` | struct | 1/1 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo` | struct | 1/1 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_content_with_conn` | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_file` ? | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo` | struct | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::get_by_hash_with_conn` | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::get_resource` ? | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::get_resource_with_conn` ? | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::create_file` ? | method | 0/6 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::store_blob` ? | method | 0/4 | `src/chat_v2/tools/chatanki_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |

### L18-media-docs（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_docs::document_parser::DocumentParser::new` | method | 1/0 | `src/chat_v2/tools/chatanki_executor.rs` |

### L19-mcp-browser（3 个条目，prod 0 / test 4）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_mcp::tools::ToolRegistry::new` ? | method | 0/2 | `src/chat_v2/tools/fsrs_settings_executor.rs`, `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_mcp::tools::ToolRegistry` | struct | 0/1 | `tests/chatanki_apkg_executor_e2e.rs` |
| `dstu_mcp::tools::ToolRegistry::new_with` | method | 0/1 | `src/chat_v2/tools/chatanki_executor.rs` |

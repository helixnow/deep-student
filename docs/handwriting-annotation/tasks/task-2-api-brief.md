# Task2 API — typed shared service and Tauri registration

Repo /home/xutao/deepstudent/deep-student featurebranch。Allowed new `dstu-vfs/src/vfs/ink_commands.rs` + vfs/mod.rs `pub mod ink_commands` registration ONLY (do not touch existing ink mod), `src-tauri/src/lib.rs` command registration + permissions/build.rs only necessary existing pattern, `src/features/ink/api.ts`+its own api.test.ts, task report. Other agents own ink/types/operations, ink_repo, sync, renderer/Office/policy. No edits those files.

FIRST tests+minimal compiling shared service wrappers/scaffold→NEEDS_RED_VERIFICATION STOP. NO tests/build/install/agents/commit/push. Main runs. Do not install dependencies, change root shared APIs or widengenericfile editing.

## Commands

`vfs_ink_create` input request {title,ruling,width,height,operation_id,folder_id?}; `vfs_ink_get` {document_id}; `vfs_ink_get_page` {document_id,page_id}; `vfs_ink_save_page` {document_id,expected_revision,operation_id,page}; `vfs_ink_copy` {document_id,title,operation_id,folder_id?}. camelCase Tauri outercommand args request or input according consistent choice, wire struct snake_case like Ink. `#[serde(deny_unknown_fields)]` request structs. Common core methods take &VfsDatabase, get_conn_safe and call VfsInkRepo::*_with_conn directly, no await while lock. Tauri async uses spawn_blocking with clonedArcDB to avoid blocking main async executor. `State<Arc<VfsDatabase>>` same asvfs handlers.

Responses Result<T,InkCommandError> {code,message,hint,retryable,current_revision?}. Map VfsError::Conflict keys ink.operation_state_unknown→OPERATION_STATE_UNKNOWN, ink.operation_id_reused→INVALID_ARGUMENT, ink.revision_conflict→REVISION_CONFLICT, invalidformat→UNSUPPORTED_FORMAT, corruption/missing resource→RESOURCE_NOT_FOUND or INVALID_ARGUMENT truthful. Low-level DB/IO failures safe text not blob payload/path leak. Convert serde/domain limits preserve LIMIT_EXCEEDED/UNSUPPORTED_SCHEMA if possible (repo currentlymapsInvalidArgument; don't editrepo now, note mapperlimit and main will adapt).

On successful mutations emit typed `ink:changed` event {document_id,revision,operation_id,affected_page_ids} fromcommand with AppHandle, editor/tool later share commonservice eventnot duplicate writes. App is foreground; no commandswrite arbitrarypath. Initial tests check real migrated DB create/get/save throughservice, structured unsupported ordinary file, staleversion, not just command text.

TS api dynamic Tauri invoke via existing `@tauri-apps/api/core` asneeded. Export functions with request/domain types imported existingtypes; new requestinterfaces may liveapi until ops added (do not edittypes). Do NOT swallow failures/return success: reject `InkApiError` preserves code/current_revision, UIusesgetErrorMessage. Use hasTauri runtime guard only if repo style callsforit; browserCT injectionlater.

Tests first 2 realRust successful servicepaths scaffold errors; TS behavior boundary invalid arguments/errors not assertions merelymockexists. Requestshape can be verified fake transport receiving exact original nested page and revision, returned structured errors propagated. Keep thin forwarding helpers untested if no real behavior. Aftermainred implement/green, productionregistration verified by cargo check app and existing command registry tests (find exacttargetneeded; report selectors).

No prepare/render/export commandyet; those later share service without rebuild. Don't claim tools now exist; this slice only editor/APIaccess. Return brief report exactselectors, static compile concerns. Avoid broadreadsthroughapp; register commandsadjacenttoVFS groupinlib andappropriatecapability pattern.

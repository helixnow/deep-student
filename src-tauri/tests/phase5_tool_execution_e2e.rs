use std::sync::{Arc, Mutex};

use deep_student_lib::chat_v2::automations::{
    list_automation_runs, load_automations, AUTOMATIONS_CHANGED_EVENT,
};
use deep_student_lib::chat_v2::events::ChatV2EventEmitter;
use deep_student_lib::chat_v2::tools::automation_executor::tool_names;
use deep_student_lib::chat_v2::tools::user_todo_executor::{
    USER_TODO_CREATE_ITEM, USER_TODO_CREATE_LIST, USER_TODO_DELETE_ITEM, USER_TODO_DELETE_LIST,
    USER_TODO_LIST_TRASH, USER_TODO_REORDER, USER_TODO_RESTORE, USER_TODO_SEARCH,
    USER_TODO_UPDATE_ITEM, USER_TODO_UPDATE_LIST,
};
use deep_student_lib::chat_v2::tools::{
    AutomationExecutor, ExecutionContext, ToolExecutor, UserTodoExecutor,
};
use deep_student_lib::chat_v2::types::{ToolCall, ToolResultInfo};
use deep_student_lib::data_governance::migration::coordinator::MigrationCoordinator;
use deep_student_lib::data_governance::schema_registry::DatabaseId;
use deep_student_lib::database::Database;
use deep_student_lib::tools::ToolRegistry;
use deep_student_lib::vfs::repos::VfsTodoRepo;
use deep_student_lib::vfs::VfsDatabase;
use serde_json::{json, Value};
use tauri::Listener;
use tempfile::TempDir;

struct Phase5Harness {
    _app: tauri::App,
    _main_dir: TempDir,
    _vfs_dir: TempDir,
    main_db: Arc<Database>,
    vfs_db: Arc<VfsDatabase>,
    window: tauri::Window,
}

fn create_main_db() -> (TempDir, Arc<Database>) {
    let dir = TempDir::new().expect("main database temp dir");
    let mut coordinator = MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Mistakes)
        .expect("apply production main-database migrations");
    let db = Database::new(&dir.path().join("mistakes.db")).expect("open migrated main database");
    (dir, Arc::new(db))
}

fn create_vfs_db() -> (TempDir, Arc<VfsDatabase>) {
    let dir = TempDir::new().expect("VFS temp dir");
    let mut coordinator = MigrationCoordinator::new(dir.path().to_path_buf()).with_audit_db(None);
    coordinator
        .migrate_single(DatabaseId::Vfs)
        .expect("apply production VFS migrations");
    let db = VfsDatabase::new(dir.path()).expect("open migrated VFS database");
    (dir, Arc::new(db))
}

fn create_harness(label: &str) -> Phase5Harness {
    let (main_dir, main_db) = create_main_db();
    let (vfs_dir, vfs_db) = create_vfs_db();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(main_db.clone())
        .manage(vfs_db.clone())
        .build(tauri::generate_context!())
        .expect("build phase 5 executor test app");
    let webview = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default())
        .build()
        .expect("build phase 5 executor test window");
    let window = webview.as_ref().window();
    Phase5Harness {
        _app: app,
        _main_dir: main_dir,
        _vfs_dir: vfs_dir,
        main_db,
        vfs_db,
        window,
    }
}

fn execution_context(harness: &Phase5Harness, call_id: &str) -> ExecutionContext {
    let emitter = Arc::new(ChatV2EventEmitter::new(
        harness.window.clone(),
        "phase5-execution-session".to_string(),
    ));
    ExecutionContext::new(
        "phase5-execution-session".to_string(),
        "phase5-execution-message".to_string(),
        format!("block-{call_id}"),
        emitter,
        Arc::new(ToolRegistry::new()),
        harness.window.clone(),
    )
    .with_main_db(Some(harness.main_db.clone()))
    .with_vfs_db(Some(harness.vfs_db.clone()))
    .with_tool_call_id(call_id)
}

async fn execute_tool(
    executor: &dyn ToolExecutor,
    harness: &Phase5Harness,
    call_id: &str,
    tool_name: &str,
    arguments: Value,
) -> ToolResultInfo {
    executor
        .execute(
            &ToolCall::new(
                call_id.to_string(),
                format!("builtin-{tool_name}"),
                arguments,
            ),
            &execution_context(harness, call_id),
        )
        .await
        .expect("production executor returns ToolResultInfo")
}

fn capture_json_events(window: &tauri::Window, event_name: &str) -> Arc<Mutex<Vec<Value>>> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    window.listen(event_name.to_string(), move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(payload);
        }
    });
    events
}

fn event_count(events: &Arc<Mutex<Vec<Value>>>) -> usize {
    events
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .len()
}

async fn wait_for_event(
    events: &Arc<Mutex<Vec<Value>>>,
    action: &str,
    run_id: Option<&str>,
) -> Value {
    for _ in 0..50 {
        let matched = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|payload| {
                payload["action"] == action
                    && run_id.is_none_or(|run_id| payload["runId"] == run_id)
            })
            .cloned();
        if let Some(payload) = matched {
            return payload;
        }
        tokio::task::yield_now().await;
    }
    panic!("missing event action={action} run_id={run_id:?}");
}

fn assert_success(result: &ToolResultInfo) -> &Value {
    assert!(result.success, "tool failed unexpectedly: {result:?}");
    &result.output
}

fn structured_error(result: &ToolResultInfo) -> Value {
    assert!(!result.success, "tool unexpectedly succeeded: {result:?}");
    serde_json::from_str(
        result
            .error
            .as_deref()
            .expect("failed result must carry an error"),
    )
    .expect("expected a structured tool error")
}

fn assert_error_code(result: &ToolResultInfo, code: &str) -> Value {
    let error = structured_error(result);
    assert_eq!(error["code"], code, "{error}");
    error
}

async fn user_todo_executor_runs_crud_occ_trash_restore_and_reorder_on_production_vfs() {
    let harness = create_harness("phase5-user-todo-execution");
    let executor = UserTodoExecutor::new();
    let events = capture_json_events(&harness.window, "todo://changed");

    let invalid_create = execute_tool(
        &executor,
        &harness,
        "todo-invalid-create",
        USER_TODO_CREATE_ITEM,
        json!({}),
    )
    .await;
    assert_error_code(&invalid_create, "TODO_OPERATION_FAILED");
    assert_eq!(event_count(&events), 0);

    let created_list = execute_tool(
        &executor,
        &harness,
        "todo-create-list",
        USER_TODO_CREATE_LIST,
        json!({"title": "Phase 5 List", "description": "production migration path"}),
    )
    .await;
    let list_id = assert_success(&created_list)["list"]["id"]
        .as_str()
        .expect("created list id")
        .to_string();
    let create_list_event = wait_for_event(&events, "create_list", Some("todo-create-list")).await;
    assert_eq!(create_list_event["source"], "ai");
    assert_eq!(create_list_event["entityIds"], json!([list_id]));
    assert_eq!(created_list.output["reversible"], false);
    assert_eq!(created_list.output["reversibleWithApproval"], true);
    assert_eq!(
        created_list.output["restoreWith"]["tool"],
        USER_TODO_DELETE_LIST
    );

    let first_create = execute_tool(
        &executor,
        &harness,
        "todo-create-first",
        USER_TODO_CREATE_ITEM,
        json!({"list_id": list_id, "title": "Original task", "tags": ["phase5"]}),
    )
    .await;
    let first_id = assert_success(&first_create)["item"]["id"]
        .as_str()
        .expect("first item id")
        .to_string();
    let first_revision = first_create.output["item"]["updatedAt"]
        .as_str()
        .expect("first revision")
        .to_string();
    let create_item_event = wait_for_event(&events, "create_item", Some("todo-create-first")).await;
    assert_eq!(create_item_event["entityIds"], json!([first_id, list_id]));
    assert_eq!(
        first_create.output["restoreWith"]["arguments"]["expected_updated_at"],
        first_revision
    );

    let second_create = execute_tool(
        &executor,
        &harness,
        "todo-create-second",
        USER_TODO_CREATE_ITEM,
        json!({"list_id": list_id, "title": "Second task"}),
    )
    .await;
    let second_id = assert_success(&second_create)["item"]["id"]
        .as_str()
        .expect("second item id")
        .to_string();
    wait_for_event(&events, "create_item", Some("todo-create-second")).await;

    let events_before_missing_occ = event_count(&events);
    let missing_item_occ = execute_tool(
        &executor,
        &harness,
        "todo-update-missing-occ",
        USER_TODO_UPDATE_ITEM,
        json!({"item_id": first_id, "title": "Missing baseline"}),
    )
    .await;
    assert_error_code(&missing_item_occ, "TODO_OCC_REQUIRED");
    assert_eq!(event_count(&events), events_before_missing_occ);

    let updated_item = execute_tool(
        &executor,
        &harness,
        "todo-update-item",
        USER_TODO_UPDATE_ITEM,
        json!({
            "item_id": first_id,
            "expected_updated_at": first_revision,
            "title": "Updated task",
            "priority": "high"
        }),
    )
    .await;
    let updated_revision = assert_success(&updated_item)["item"]["updatedAt"]
        .as_str()
        .expect("updated revision")
        .to_string();
    assert_eq!(updated_item.output["previous"]["title"], "Original task");
    wait_for_event(&events, "update_item", Some("todo-update-item")).await;

    let events_before_stale_item = event_count(&events);
    let stale_item = execute_tool(
        &executor,
        &harness,
        "todo-update-stale",
        USER_TODO_UPDATE_ITEM,
        json!({
            "item_id": first_id,
            "expected_updated_at": first_revision,
            "title": "Stale overwrite"
        }),
    )
    .await;
    let stale_item_error = assert_error_code(&stale_item, "TODO_CONFLICT");
    assert_eq!(stale_item_error["current"]["id"], first_id);
    assert_eq!(stale_item_error["currentUpdatedAt"], updated_revision);
    assert_eq!(event_count(&events), events_before_stale_item);
    assert_eq!(
        VfsTodoRepo::get_todo_item(&harness.vfs_db, &first_id)
            .unwrap()
            .unwrap()
            .title,
        "Updated task"
    );

    let search = execute_tool(
        &executor,
        &harness,
        "todo-search",
        USER_TODO_SEARCH,
        json!({"query": "Updated", "page": 1, "page_size": 20}),
    )
    .await;
    assert_eq!(assert_success(&search)["total"], 1);
    assert_eq!(search.output["items"][0]["id"], first_id);

    let list_revision = VfsTodoRepo::get_todo_list(&harness.vfs_db, &list_id)
        .unwrap()
        .unwrap()
        .updated_at;
    let events_before_missing_reorder = event_count(&events);
    let missing_reorder_occ = execute_tool(
        &executor,
        &harness,
        "todo-reorder-missing-occ",
        USER_TODO_REORDER,
        json!({"list_id": list_id, "item_ids": [second_id, first_id]}),
    )
    .await;
    assert_error_code(&missing_reorder_occ, "TODO_OCC_REQUIRED");
    assert_eq!(event_count(&events), events_before_missing_reorder);

    let reordered = execute_tool(
        &executor,
        &harness,
        "todo-reorder",
        USER_TODO_REORDER,
        json!({
            "list_id": list_id,
            "item_ids": [second_id, first_id],
            "expected_updated_at": list_revision
        }),
    )
    .await;
    assert_eq!(assert_success(&reordered)["reorderedCount"], 2);
    assert_eq!(
        reordered.output["previous"]["itemIds"],
        json!([first_id, second_id])
    );
    assert!(
        reordered.output["restoreWith"]["arguments"]["expected_updated_at"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    wait_for_event(&events, "reorder", Some("todo-reorder")).await;
    let ordered = VfsTodoRepo::list_items_by_list(&harness.vfs_db, &list_id, true).unwrap();
    assert_eq!(ordered[0].id, second_id);
    assert_eq!(ordered[1].id, first_id);
    let reordered_first_revision = VfsTodoRepo::get_todo_item(&harness.vfs_db, &first_id)
        .unwrap()
        .unwrap()
        .updated_at;
    assert_ne!(reordered_first_revision, updated_revision);

    let events_before_delete_missing = event_count(&events);
    let delete_missing_occ = execute_tool(
        &executor,
        &harness,
        "todo-delete-missing-occ",
        USER_TODO_DELETE_ITEM,
        json!({"item_id": first_id}),
    )
    .await;
    assert_error_code(&delete_missing_occ, "TODO_OCC_REQUIRED");
    assert_eq!(event_count(&events), events_before_delete_missing);

    let stale_delete = execute_tool(
        &executor,
        &harness,
        "todo-delete-stale",
        USER_TODO_DELETE_ITEM,
        json!({"item_id": first_id, "expected_updated_at": first_revision}),
    )
    .await;
    let stale_delete_error = assert_error_code(&stale_delete, "TODO_CONFLICT");
    assert_eq!(stale_delete_error["current"]["id"], first_id);
    assert_eq!(
        stale_delete_error["currentUpdatedAt"],
        reordered_first_revision
    );
    let deleted_item = execute_tool(
        &executor,
        &harness,
        "todo-delete-item",
        USER_TODO_DELETE_ITEM,
        json!({"item_id": first_id, "expected_updated_at": reordered_first_revision}),
    )
    .await;
    assert_eq!(assert_success(&deleted_item)["softDeleted"], true);
    assert_eq!(
        deleted_item.output["restoreWith"]["tool"],
        USER_TODO_RESTORE
    );
    wait_for_event(&events, "delete_item", Some("todo-delete-item")).await;

    let item_trash = execute_tool(
        &executor,
        &harness,
        "todo-item-trash",
        USER_TODO_LIST_TRASH,
        json!({"entity_type": "item"}),
    )
    .await;
    assert_eq!(assert_success(&item_trash)["total"], 1);
    assert_eq!(item_trash.output["items"][0]["id"], first_id);
    let restored_item = execute_tool(
        &executor,
        &harness,
        "todo-restore-item",
        USER_TODO_RESTORE,
        json!({"entity_type": "item", "entity_id": first_id}),
    )
    .await;
    assert_eq!(assert_success(&restored_item)["entity"]["id"], first_id);
    assert_eq!(
        restored_item.output["restoreWith"]["tool"],
        USER_TODO_DELETE_ITEM
    );
    wait_for_event(&events, "restore", Some("todo-restore-item")).await;

    let list_revision = VfsTodoRepo::get_todo_list(&harness.vfs_db, &list_id)
        .unwrap()
        .unwrap()
        .updated_at;
    let events_before_list_missing = event_count(&events);
    let list_missing_occ = execute_tool(
        &executor,
        &harness,
        "todo-list-update-missing-occ",
        USER_TODO_UPDATE_LIST,
        json!({"list_id": list_id, "title": "Missing baseline"}),
    )
    .await;
    assert_error_code(&list_missing_occ, "TODO_OCC_REQUIRED");
    assert_eq!(event_count(&events), events_before_list_missing);

    let updated_list = execute_tool(
        &executor,
        &harness,
        "todo-update-list",
        USER_TODO_UPDATE_LIST,
        json!({
            "list_id": list_id,
            "expected_updated_at": list_revision,
            "title": "Updated Phase 5 List"
        }),
    )
    .await;
    let updated_list_revision = assert_success(&updated_list)["list"]["updatedAt"]
        .as_str()
        .expect("updated list revision")
        .to_string();
    wait_for_event(&events, "update_list", Some("todo-update-list")).await;

    let stale_list = execute_tool(
        &executor,
        &harness,
        "todo-update-list-stale",
        USER_TODO_UPDATE_LIST,
        json!({
            "list_id": list_id,
            "expected_updated_at": list_revision,
            "title": "Stale list overwrite"
        }),
    )
    .await;
    let stale_list_error = assert_error_code(&stale_list, "TODO_CONFLICT");
    assert_eq!(stale_list_error["current"]["id"], list_id);
    assert_eq!(stale_list_error["currentUpdatedAt"], updated_list_revision);
    let stale_list_delete = execute_tool(
        &executor,
        &harness,
        "todo-delete-list-stale",
        USER_TODO_DELETE_LIST,
        json!({"list_id": list_id, "expected_updated_at": list_revision}),
    )
    .await;
    let stale_list_delete_error = assert_error_code(&stale_list_delete, "TODO_CONFLICT");
    assert_eq!(stale_list_delete_error["current"]["id"], list_id);
    assert_eq!(
        stale_list_delete_error["currentUpdatedAt"],
        updated_list_revision
    );

    let deleted_list = execute_tool(
        &executor,
        &harness,
        "todo-delete-list",
        USER_TODO_DELETE_LIST,
        json!({"list_id": list_id, "expected_updated_at": updated_list_revision}),
    )
    .await;
    assert_eq!(assert_success(&deleted_list)["softDeleted"], true);
    assert_eq!(
        deleted_list.output["restoreWith"]["tool"],
        USER_TODO_RESTORE
    );
    wait_for_event(&events, "delete_list", Some("todo-delete-list")).await;

    let list_trash = execute_tool(
        &executor,
        &harness,
        "todo-list-trash",
        USER_TODO_LIST_TRASH,
        json!({"entity_type": "list"}),
    )
    .await;
    assert_eq!(assert_success(&list_trash)["total"], 1);
    assert_eq!(list_trash.output["items"][0]["id"], list_id);
    let restored_list = execute_tool(
        &executor,
        &harness,
        "todo-restore-list",
        USER_TODO_RESTORE,
        json!({"entity_type": "list", "entity_id": list_id}),
    )
    .await;
    assert_eq!(assert_success(&restored_list)["entity"]["id"], list_id);
    assert_eq!(restored_list.output["reversible"], false);
    assert_eq!(restored_list.output["reversibleWithApproval"], true);
    wait_for_event(&events, "restore", Some("todo-restore-list")).await;
}

async fn automation_executor_runs_db_occ_events_restore_contracts_and_manual_wrapper() {
    let harness = create_harness("phase5-automation-execution");
    let executor = AutomationExecutor::new();
    let events = capture_json_events(&harness.window, AUTOMATIONS_CHANGED_EVENT);

    let invalid = execute_tool(
        &executor,
        &harness,
        "automation-invalid-propose",
        tool_names::AUTOMATION_PROPOSE,
        json!({"name": "Invalid", "prompt": "missing schedule"}),
    )
    .await;
    assert!(!invalid.success);
    assert!(invalid
        .error
        .as_deref()
        .is_some_and(|error| error.contains("schedule")));
    assert_eq!(event_count(&events), 0);

    let proposed = execute_tool(
        &executor,
        &harness,
        "automation-propose",
        tool_names::AUTOMATION_PROPOSE,
        json!({
            "name": "Phase 5 Automation",
            "schedule": {"kind": "daily", "time": "08:00", "timezone": "UTC"},
            "prompt": "Create the phase 5 reminder",
            "enabled": true,
            "action_type": "notify"
        }),
    )
    .await;
    let automation_id = assert_success(&proposed)["id"]
        .as_str()
        .expect("automation id")
        .to_string();
    assert_eq!(proposed.output["storage"], "automation_definitions");
    assert_eq!(proposed.output["reversible"], false);
    assert_eq!(proposed.output["reversibleWithApproval"], true);
    assert_eq!(
        proposed.output["restoreWith"],
        json!({
            "tool": tool_names::AUTOMATION_DELETE,
            "arguments": {"id": automation_id, "expected_version": 1}
        })
    );
    let create_event = wait_for_event(&events, "create", None).await;
    assert_eq!(create_event["automationId"], automation_id);

    let listed = execute_tool(
        &executor,
        &harness,
        "automation-list",
        tool_names::AUTOMATION_LIST,
        json!({}),
    )
    .await;
    assert_eq!(assert_success(&listed)["count"], 1);
    assert_eq!(listed.output["automations"][0]["id"], automation_id);
    assert_eq!(listed.output["automations"][0]["version"], 1);

    let events_before_missing_set = event_count(&events);
    let missing_set_occ = execute_tool(
        &executor,
        &harness,
        "automation-disable-missing-occ",
        tool_names::AUTOMATION_SET_ENABLED,
        json!({"id": automation_id, "enabled": false}),
    )
    .await;
    let missing_set_error = assert_error_code(&missing_set_occ, "AUTOMATION_OCC_REQUIRED");
    assert_eq!(missing_set_error["requiredField"], "expected_version");
    assert_eq!(event_count(&events), events_before_missing_set);

    let disabled = execute_tool(
        &executor,
        &harness,
        "automation-disable",
        tool_names::AUTOMATION_SET_ENABLED,
        json!({"id": automation_id, "expected_version": 1, "enabled": false}),
    )
    .await;
    let disabled_version = assert_success(&disabled)["current"]["version"]
        .as_u64()
        .expect("disabled version");
    assert_eq!(disabled.output["previous"]["enabled"], true);
    assert_eq!(disabled.output["restoreWith"]["arguments"]["enabled"], true);
    assert_eq!(
        disabled.output["restoreWith"]["arguments"]["expected_version"],
        disabled_version
    );
    let disabled_event = wait_for_event(&events, "set_enabled", None).await;
    assert_eq!(disabled_event["automationId"], automation_id);

    let events_before_missing_occ = event_count(&events);
    let missing_occ = execute_tool(
        &executor,
        &harness,
        "automation-update-missing-occ",
        tool_names::AUTOMATION_UPDATE,
        json!({"id": automation_id, "name": "Missing OCC"}),
    )
    .await;
    let missing_update_error = assert_error_code(&missing_occ, "AUTOMATION_OCC_REQUIRED");
    assert_eq!(missing_update_error["requiredField"], "expected_version");
    assert_eq!(event_count(&events), events_before_missing_occ);

    let updated = execute_tool(
        &executor,
        &harness,
        "automation-update",
        tool_names::AUTOMATION_UPDATE,
        json!({
            "id": automation_id,
            "expected_version": disabled_version,
            "name": "Updated Phase 5 Automation",
            "prompt": "Updated phase 5 reminder"
        }),
    )
    .await;
    let updated_version = assert_success(&updated)["current"]["version"]
        .as_u64()
        .expect("updated version");
    assert_eq!(updated_version, disabled_version + 1);
    assert_eq!(updated.output["previous"]["name"], "Phase 5 Automation");
    assert_eq!(
        updated.output["restoreWith"]["arguments"]["expected_version"],
        updated_version
    );
    wait_for_event(&events, "update", None).await;

    let events_before_conflict = event_count(&events);
    let stale = execute_tool(
        &executor,
        &harness,
        "automation-update-stale",
        tool_names::AUTOMATION_UPDATE,
        json!({
            "id": automation_id,
            "expected_version": disabled_version,
            "name": "Stale overwrite"
        }),
    )
    .await;
    let conflict = assert_error_code(&stale, "AUTOMATION_VERSION_CONFLICT");
    assert_eq!(conflict["expectedVersion"], disabled_version);
    assert_eq!(conflict["currentVersion"], updated_version);
    assert_eq!(conflict["current"]["name"], "Updated Phase 5 Automation");
    assert_eq!(event_count(&events), events_before_conflict);

    let stale_set = execute_tool(
        &executor,
        &harness,
        "automation-enable-stale",
        tool_names::AUTOMATION_SET_ENABLED,
        json!({
            "id": automation_id,
            "expected_version": disabled_version,
            "enabled": true
        }),
    )
    .await;
    let set_conflict = assert_error_code(&stale_set, "AUTOMATION_VERSION_CONFLICT");
    assert_eq!(set_conflict["currentVersion"], updated_version);
    assert_eq!(set_conflict["current"]["id"], automation_id);

    let events_before_missing_run = event_count(&events);
    let missing_run_occ = execute_tool(
        &executor,
        &harness,
        "automation-run-now-missing-occ",
        tool_names::AUTOMATION_RUN_NOW,
        json!({"id": automation_id}),
    )
    .await;
    let missing_run_error = assert_error_code(&missing_run_occ, "AUTOMATION_OCC_REQUIRED");
    assert_eq!(missing_run_error["requiredField"], "expected_version");
    assert_eq!(event_count(&events), events_before_missing_run);

    let stale_run = execute_tool(
        &executor,
        &harness,
        "automation-run-now-stale",
        tool_names::AUTOMATION_RUN_NOW,
        json!({"id": automation_id, "expected_version": disabled_version}),
    )
    .await;
    let run_conflict = assert_error_code(&stale_run, "AUTOMATION_VERSION_CONFLICT");
    assert_eq!(run_conflict["currentVersion"], updated_version);
    assert_eq!(run_conflict["current"]["id"], automation_id);
    assert!(
        list_automation_runs(&harness.main_db, Some(&automation_id), 10)
            .unwrap()
            .is_empty()
    );

    let run_now = execute_tool(
        &executor,
        &harness,
        "automation-run-now",
        tool_names::AUTOMATION_RUN_NOW,
        json!({"id": automation_id, "expected_version": updated_version}),
    )
    .await;
    assert_eq!(assert_success(&run_now)["result"]["status"], "notified");
    assert_eq!(run_now.output["reversible"], false);
    assert!(run_now.output["restoreWith"].is_null());
    let run_event = wait_for_event(&events, "run_now", None).await;
    assert_eq!(run_event["automationId"], automation_id);
    let runs = list_automation_runs(&harness.main_db, Some(&automation_id), 10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].trigger_type, "manual");
    assert!(runs[0]
        .status
        .as_deref()
        .is_some_and(|status| status != "running"));

    let events_before_missing_delete = event_count(&events);
    let missing_delete_occ = execute_tool(
        &executor,
        &harness,
        "automation-delete-missing-occ",
        tool_names::AUTOMATION_DELETE,
        json!({"id": automation_id}),
    )
    .await;
    let missing_delete_error = assert_error_code(&missing_delete_occ, "AUTOMATION_OCC_REQUIRED");
    assert_eq!(missing_delete_error["requiredField"], "expected_version");
    assert_eq!(event_count(&events), events_before_missing_delete);

    let stale_delete = execute_tool(
        &executor,
        &harness,
        "automation-delete-stale",
        tool_names::AUTOMATION_DELETE,
        json!({"id": automation_id, "expected_version": disabled_version}),
    )
    .await;
    let delete_conflict = assert_error_code(&stale_delete, "AUTOMATION_VERSION_CONFLICT");
    assert_eq!(delete_conflict["currentVersion"], updated_version);
    assert_eq!(delete_conflict["current"]["id"], automation_id);
    assert_eq!(load_automations(&harness.main_db).unwrap().len(), 1);

    let deleted = execute_tool(
        &executor,
        &harness,
        "automation-delete",
        tool_names::AUTOMATION_DELETE,
        json!({"id": automation_id, "expected_version": updated_version}),
    )
    .await;
    assert_eq!(assert_success(&deleted)["deleted"]["id"], automation_id);
    assert_eq!(deleted.output["reversible"], false);
    assert!(deleted.output["restoreWith"].is_null());
    let delete_event = wait_for_event(&events, "delete", None).await;
    assert_eq!(delete_event["automationId"], automation_id);
    assert!(load_automations(&harness.main_db).unwrap().is_empty());
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build phase 5 current-thread runtime");
    runtime.block_on(async {
        user_todo_executor_runs_crud_occ_trash_restore_and_reorder_on_production_vfs().await;
        automation_executor_runs_db_occ_events_restore_contracts_and_manual_wrapper().await;
    });
}

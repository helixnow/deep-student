//! R10-android：在 R07（`sync_android_restart.rs`）与 R09
//! （`sync_android_device_switch.rs`）已合入的 Android 换机/重启覆盖之上做**增量**：
//!
//! 1. **content URI（SAF）宿主可测半边**：`unified_file_manager` 此前完全没有
//!    针对 content:// / SAF 路径分类、文件名/扩展名解析、编码保留的测试。
//!    这些纯函数是 Android 备份 ZIP 导入/导出物化路径的第一道分叉
//!    （`commands_zip.rs` 以 `is_virtual_uri` 决定是否走临时物化），本文件钉死其契约。
//! 2. **物化路径与重启命令壳的源码锚定**：`ensure_local_path` 虚拟分支与
//!    `restart_app` 在宿主上不可执行（见下方缺口声明），退而以源码文本锚定
//!    命令层的物化编排（temp_zip_import / temp_zip_export / 清理承诺）与
//!    重启壳的注册及"先落盘标记、后重启"顺序，任何改动都会显式打断本测试。
//! 3. **恢复切槽租约的身份对账增量**：R07/R09 已覆盖租约登记/幂等/拒启/两段式
//!    解除；本文件补齐**提交阶段**的 fail-closed 边界（错 backup_id、错活动槽
//!    路径、无租约时的幂等 false）与 rollback trash 跨切槽重启的生命周期。
//!
//! ## 真机缺口声明（宿主机无法闭合，如实记录）
//!
//! 1. **content:// 实际读写不可宿主测**：`ensure_local_path` 的虚拟分支经
//!    `Window::fs()`（tauri-plugin-fs）走 Android ContentResolver；签名要求
//!    `tauri::Window`（默认 `Window<Wry>`），而 dev-deps 的 `tauri::test`
//!    mock runtime 产出 `Window<MockRuntime>`，类型不兼容，无法从 tests/
//!    驱动。SAF 授权、SecurityException（编码被破坏时）、不透明 document ID
//!    的 ContentResolver 元数据查询均需真机/模拟器验证（已列入 R11-android2
//!    的真机核对单任务）。本文件只锁宿主可测的分类/解析/编码保留半边。
//! 2. **`restart_app` 命令壳不可宿主测**：`data_space::restart_app` 调用
//!    `AppHandle::restart()` 直接结束进程。重启后的切槽语义已由 R07/R09 用
//!    "同一 base_dir 上的新 `DataSpaceManager::initialize_on_start`"等价覆盖，
//!    本文件对壳本身只做注册与调用顺序的源码锚定。
//! 3. **双重编码的 content URI**：`is_virtual_uri` 仍为 false；命令入口与
//!    `classify_path` 走 `reject_double_encoded_virtual_uri` 可读拒绝，
//!    不解码后当虚拟路径（避免拆掉 document ID）。生产前端始终传原始
//!    content:// URI；对抗性输入的真机表现仍见手册 4.1–4.3。
//! 4. **persistable URI grant**：ZIP/同步入口把 `content://` 原子写入
//!    `filesDir/pending_saf_persist/<hash>.uri`（旧单文件双读）；MainActivity
//!    前台轮询 `takePersistableUriPermission`。`ACTION_GET_CONTENT` 拒绝 persist
//!    时必须删队列并 warn，不得假装已授权。真机强杀/重开仍见手册 4.1–4.3。
//!
//! 本文件锁定宿主可测半边与源码编排；ContentResolver 真机授权不能冒充绿灯。

use std::path::Path;

use deep_student_lib::data_space::{DataSpaceManager, Slot};
use deep_student_lib::unified_file_manager::{
    extract_extension, extract_file_name, is_opaque_document_id, is_virtual_uri,
    persistable_saf_queue_file, queue_persistable_saf_uri, reject_double_encoded_virtual_uri,
    sanitize_file_name_for_fs, sanitize_for_legacy, DOUBLE_ENCODED_VIRTUAL_URI_REJECTED,
    PENDING_SAF_PERSIST_DIR, PENDING_SAF_PERSIST_FILE,
};

// ============================================================================
// 第一部分：content URI / SAF 路径分类（物化路径的第一道分叉）
// ============================================================================

/// `commands_zip.rs` 的导入/导出都以 `is_virtual_uri` 决定是否走
/// "先物化到应用私有临时目录"的 Android 路径。这里钉死分类契约：
/// content:// 与 SAF 前缀（primary:/secondary:/raw:）必须判虚拟，
/// 普通本地路径、file://、Windows 盘符路径必须判本地。
#[test]
fn content_uri_and_saf_paths_classify_as_virtual() {
    let virtual_inputs = [
        // 标准 DocumentsProvider URI（编码的 document ID）
        "content://com.android.externalstorage.documents/document/primary%3ADownload%2Fbackup.zip",
        // Downloads provider 的不透明数字 ID
        "content://com.android.providers.downloads.documents/document/446",
        // 大小写与前导空白容错
        "CONTENT://authority/document/1",
        "  content://authority/document/2",
        // SAF 树路径三前缀
        "primary:Download/QQ/backup.zip",
        "secondary:Backups/backup.zip",
        "raw:/storage/emulated/0/Download/backup.zip",
        // 其余移动端虚拟 scheme
        "asset://bundle/file.pdf",
        "ph://ABCD-1234/L0/001",
    ];
    for input in virtual_inputs {
        assert!(
            is_virtual_uri(input),
            "必须判为虚拟 URI（走物化路径）: {input:?}"
        );
    }

    let local_inputs = [
        "/storage/emulated/0/Download/backup.zip",
        "/home/student/backup.zip",
        "C:\\Users\\alice\\Documents\\backup.zip",
        "file:///home/student/backup.zip",
        "./relative/backup.zip",
        "",
    ];
    for input in local_inputs {
        assert!(
            !is_virtual_uri(input),
            "必须判为本地路径（直接读写，不物化）: {input:?}"
        );
    }
}

/// 双重编码的 content URI：`is_virtual_uri` 仍为 false（不把拆坏的
/// URI 交给 ContentResolver）；命令入口与 classify 走可读拒绝，
/// 不得当本地路径半处理，也不得解码后当虚拟路径读写。
#[test]
fn double_encoded_content_uri_is_not_classified_virtual() {
    let double_encoded =
        "content%3A%2F%2Fcom.android.externalstorage.documents%2Fdocument%2Fprimary%3Abackup.zip";
    assert!(
        !is_virtual_uri(double_encoded),
        "当前契约：双重编码输入不得被 is_virtual_uri 认成虚拟 URI"
    );
    let err = reject_double_encoded_virtual_uri(double_encoded).expect_err("双重编码必须可读拒绝");
    assert_eq!(err.to_string(), DOUBLE_ENCODED_VIRTUAL_URI_REJECTED);
}

/// Rust 侧只负责把合法 `content://` 写入应用私有队列；本地/`primary:`
/// 不写，双重编码在入队前拒绝。真正的 persist 由 MainActivity 做。
#[test]
fn rust_side_must_queue_content_uri_for_main_activity_persist() {
    let dir = tempfile::tempdir().expect("persist queue dir");
    let content =
        "content://com.android.externalstorage.documents/document/primary%3ADownload%2Fbackup.zip";
    queue_persistable_saf_uri(dir.path(), content).expect("content:// 必须入队");
    assert_eq!(
        std::fs::read_to_string(persistable_saf_queue_file(dir.path(), content))
            .expect("read queue"),
        content
    );
    assert_eq!(PENDING_SAF_PERSIST_FILE, "pending_saf_persist.uri");
    assert_eq!(PENDING_SAF_PERSIST_DIR, "pending_saf_persist");
}

// ============================================================================
// 第二部分：SAF 文件名/扩展名解析与不透明 document ID
// ============================================================================

/// SAF document ID 中 %3A/%2F 是编码后的 `:` 与 `/`：文件名提取必须
/// 先取 URI 最后一段、解码、再取子路径最后一段，扩展名统一小写。
#[test]
fn saf_document_id_resolves_to_real_file_name_and_extension() {
    let uri = "content://com.android.externalstorage.documents/document/primary%3ADownload%2FQuarkDownloads%2F%E8%AE%B2%E4%B9%89%20v2.PDF";
    assert_eq!(
        extract_file_name(uri),
        "讲义 v2.PDF",
        "必须解码 document ID 并取子路径最后一段"
    );
    assert_eq!(
        extract_extension(uri).as_deref(),
        Some("pdf"),
        "扩展名必须统一小写"
    );

    // Windows 反斜杠路径与普通路径同样适用
    assert_eq!(
        extract_file_name("C:\\Users\\alice\\Documents\\report.pdf"),
        "report.pdf"
    );
    assert_eq!(extract_file_name("/tmp/backup.zip"), "backup.zip");
    assert_eq!(extract_extension("/tmp/noext"), None, "无扩展名返回 None");
}

/// 不透明 document ID（Downloads provider 数字 ID、`document:<数字>`、
/// `msf:<数字>`）不得被当作真实文件名——物化路径依赖该判断触发
/// magic-bytes 类型嗅探（后者需要 Window，属真机缺口）。
#[test]
fn opaque_document_ids_are_detected() {
    for opaque in ["document:1000019790", "image:12345", "msf:62", "446"] {
        assert!(
            is_opaque_document_id(opaque),
            "必须判为不透明 document ID: {opaque:?}"
        );
    }
    for real in ["IMG_2026.jpg", "backup.zip", "primary:Download", "讲义.pdf"] {
        assert!(
            !is_opaque_document_id(real),
            "不得把真实文件名误判为不透明 ID: {real:?}"
        );
    }
}

/// 落盘文件名清洗：Windows/Android 文件系统非法字符与控制字符替换为 `_`，
/// CJK 与空格保留。该函数决定物化临时文件与资产落盘名的安全性。
#[test]
fn file_name_sanitization_replaces_unsafe_characters_only() {
    assert_eq!(
        sanitize_file_name_for_fs("讲义: 第1章?<v2>|\"x\".pdf"),
        "讲义_ 第1章__v2___x_.pdf"
    );
    assert_eq!(
        sanitize_file_name_for_fs("a\u{0}b\tc"),
        "a_b_c",
        "NUL 与控制字符必须替换"
    );
    assert_eq!(
        sanitize_file_name_for_fs("正常 文件名-2026.zip"),
        "正常 文件名-2026.zip",
        "合法字符不得被改写"
    );
}

/// 编码保留契约：content:// URI 的 %3A/%2F 编码具有语义（解码会破坏
/// document ID 结构，导致 ContentResolver 权限校验 SecurityException），
/// `sanitize_for_legacy` 对特殊 scheme 必须原样保留；对 file:// 本地路径
/// 则必须剥前缀并解码。真机侧的 SecurityException 行为见模块文档缺口 1。
#[test]
fn legacy_sanitizer_preserves_content_uri_encoding_but_decodes_local_paths() {
    let content_uri =
        "content://com.android.externalstorage.documents/document/primary%3ADownload%2Fbackup.zip";
    assert_eq!(
        sanitize_for_legacy(content_uri),
        content_uri,
        "content:// 的百分号编码必须逐字节保留"
    );

    assert_eq!(
        sanitize_for_legacy("file:///home/student/my%20notes.pdf"),
        "/home/student/my notes.pdf",
        "file:// 本地路径必须剥前缀并解码"
    );
}

// ============================================================================
// 第三部分：物化路径 / 重启命令壳的源码锚定（宿主不可执行，锁编排契约）
// ============================================================================

fn read_source(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("读取源码锚定文件失败 {relative}: {error}"))
}

/// Android 备份 ZIP 的物化编排锚定（`commands_zip.rs`）：
/// - 导入：content:// 的 ZIP 必须先经 `ensure_local_path` 物化到
///   `temp_zip_import`（ZIP 解析需要随机访问），导入结束后清理临时文件；
/// - 导出：目标为虚拟 URI 时先导出到 `temp_zip_export` 本地临时文件，
///   完成后经 `copy_temp_zip_to_virtual_uri` 复制到目标；复制失败时
///   清理临时导出并向用户报告（错误文案即契约）。
/// 该编排的运行时验证需要 `Window<Wry>`（真机缺口 1），此处锁定源码结构，
/// 使重命名/删除物化步骤的改动显式失败。
#[test]
fn zip_command_materialization_orchestration_is_anchored() {
    let source = read_source("src/data_governance/commands_zip.rs");

    // 导入侧：虚拟 URI 分叉 → temp_zip_import 物化 → 事后清理。
    for marker in [
        "is_virtual_uri(&zip_path)",
        "reject_double_encoded_virtual_uri(&zip_path)",
        "temp_zip_import",
        "ensure_local_path(&window, &zip_path, &temp_dir)",
    ] {
        assert!(
            source.contains(marker),
            "导入物化编排缺少锚点 {marker:?}——若重构了物化路径，请同步更新本测试与真机核对单"
        );
    }
    let import_fork = source.find("temp_zip_import").expect("导入物化分叉存在");
    assert!(
        source[import_fork..].contains("remove_file"),
        "导入完成后必须清理从 content:// 物化的临时 ZIP"
    );

    let copy_source = read_source("src/unified_file_manager.rs");
    for marker in [
        "digest_copy",
        "目标回读失败，已停止并不得报成功",
        "目标回读校验失败",
        "ensure_enough_temp_space",
        "临时物化空间不足，已停止以免半包",
    ] {
        assert!(
            copy_source.contains(marker),
            "SAF 物化必须回读校验并预检临时卷空间，缺少锚点 {marker:?}"
        );
    }

    // 导出侧：temp_zip_export 临时导出 → 复制回虚拟 URI → 失败也清理。
    for marker in [
        "is_virtual_uri(&output_path)",
        "reject_double_encoded_virtual_uri(&output_path)",
        "temp_zip_export",
        "fn copy_temp_zip_to_virtual_uri",
        "复制 ZIP 到目标 URI 失败，临时导出已清理",
        "queue_persistable_saf_uri(&app_data_dir, &output_path)",
        "queue_persistable_saf_uri(&app_data_dir, path)",
        "queue_persistable_saf_uri(&app_data_dir, &zip_path)",
    ] {
        assert!(
            source.contains(marker),
            "导出物化编排缺少锚点 {marker:?}——清理承诺（含失败路径）是用户可见契约"
        );
    }

    let sync_source = read_source("src/data_governance/commands_sync.rs");
    for marker in [
        "queue_persistable_saf_uri(&app_data_dir, p)",
        "queue_persistable_saf_uri(&app_data_dir, &input_path)",
    ] {
        assert!(
            sync_source.contains(marker),
            "同步导入/导出必须把 content:// 入队给 MainActivity persist，缺少锚点 {marker:?}"
        );
    }

    let persist_source = read_source("src/unified_file_manager.rs");
    for marker in [
        "pub const PENDING_SAF_PERSIST_FILE: &str = \"pending_saf_persist.uri\"",
        "pub const PENDING_SAF_PERSIST_DIR: &str = \"pending_saf_persist\"",
        "pub fn persistable_saf_queue_file",
        "pub fn queue_persistable_saf_uri",
        "with_extension(\"uri.tmp\")",
        "takePersistableUriPermission",
        "ACTION_GET_CONTENT",
    ] {
        assert!(
            persist_source.contains(marker),
            "persistable 队列契约缺少锚点 {marker:?}"
        );
    }

    let activity = read_source("mobile/android/MainActivity.kt");
    for marker in [
        "pending_saf_persist.uri",
        "PENDING_SAF_PERSIST_DIR = \"pending_saf_persist\"",
        "it.name.endsWith(\".uri\")",
        "takePersistableUriPermission",
        "PERSIST_POLL_MS = 400L",
        "SecurityException",
        "likely ACTION_GET_CONTENT",
        "pending.delete()",
    ] {
        assert!(
            activity.contains(marker),
            "MainActivity persist 轮询缺少锚点 {marker:?}——SecurityException 必须删队列，不得假装已授权"
        );
    }
}

/// 重启命令壳锚定：
/// 1. `data_space::restart_app` 必须仍是注册进 invoke handler 的 Tauri 命令
///    （前端「立即重启」按钮的唯一后端出口）；其实现必须直达
///    `AppHandle::restart()`，不得夹带业务逻辑——切槽/清理决策一律在
///    `initialize_on_start` 的下一次启动路径上做（R07/R09 已测）。
/// 2. 「清空所有数据」必须**先落盘清理标记、后重启**：标记写失败时不得重启
///    （否则重启后无标记、清理静默丢失）。真机上的 `app.restart()` 行为
///    （Android 上为结束进程由系统拉起）见模块文档缺口 2。
#[test]
fn restart_command_shell_registration_and_ordering_are_anchored() {
    let lib_source = read_source("src/lib.rs");
    assert!(
        lib_source.contains("data_space::restart_app"),
        "restart_app 必须保持注册在 invoke handler（恢复后「立即重启」依赖它）"
    );

    let data_space_source = read_source("src/data_space.rs");
    let shell_start = data_space_source
        .find("pub fn restart_app")
        .expect("data_space.rs 必须保留 restart_app 命令壳");
    let shell_body: String = data_space_source[shell_start..].chars().take(200).collect();
    assert!(
        shell_body.contains("app.restart()"),
        "restart_app 壳必须直达 AppHandle::restart()，实际片段: {shell_body}"
    );

    // 「清空所有数据」的标记先行契约：写标记（可失败返回）在 restart 之前。
    let backup_source = read_source("src/data_governance/commands_backup.rs");
    let marker_write = backup_source
        .find("写入清理标记失败")
        .expect("清空数据必须先写清理标记（失败可返回错误）");
    let restart_call = backup_source
        .find("app.restart()")
        .expect("清空数据路径必须以重启收尾");
    assert!(
        marker_write < restart_call,
        "必须先落盘清理标记、后调用 app.restart()——顺序颠倒会让清理在重启后静默丢失"
    );
}

// ============================================================================
// 第四部分：恢复切槽租约——提交阶段身份对账增量（R07/R09 未覆盖的边界）
// ============================================================================

fn seed_slot(dir: &Path, payload: &[u8]) {
    std::fs::create_dir_all(dir).expect("create slot dir");
    std::fs::write(dir.join("mistakes.db"), payload).expect("write slot payload");
}

/// 换机恢复的激活提交必须做**身份对账**：`mark_restore_activation_committed`
/// 对错误的 backup_id 或错误的活动槽路径都必须 fail-closed 且不改租约；
/// 提交后 `complete_restore_cutover` 对错误路径同样拒绝；正确路径一次性
/// 解除；租约已清空后的重复解除幂等返回 false（崩溃重试安全）。
#[test]
fn lease_activation_commit_requires_matching_backup_id_and_active_dir() {
    let base = tempfile::tempdir().expect("base dir");
    let backup_id = "backup-r10-android";

    // 会话 1：登记切槽租约。
    let mgr = DataSpaceManager::new(base.path().to_path_buf());
    mgr.initialize_on_start().expect("首次启动");
    seed_slot(&mgr.slot_dir(Slot::A), b"device-current");
    seed_slot(&mgr.slot_dir(Slot::B), b"restored-backup");
    mgr.mark_restore_cutover_pending(Slot::B, backup_id)
        .expect("登记恢复切槽租约");

    // 会话 2（重启）：pending 生效，进入提交窗口。
    let restarted = DataSpaceManager::new(base.path().to_path_buf());
    restarted.initialize_on_start().expect("重启切槽");
    assert_eq!(restarted.active_slot(), Slot::B);
    let active_dir = restarted.active_dir();

    // 错 backup_id：拒绝提交，租约保持未提交。
    let wrong_backup = restarted
        .mark_restore_activation_committed(&active_dir, "backup-someone-else")
        .expect_err("错误 backup_id 的激活提交必须被拒绝");
    assert_eq!(wrong_backup.kind(), std::io::ErrorKind::InvalidData);
    assert!(
        wrong_backup.to_string().contains("不匹配"),
        "拒绝原因必须指向租约身份不匹配，实际: {wrong_backup}"
    );

    // 错活动槽路径（拿非活动 A 槽路径冒充）：同样拒绝。
    let wrong_dir = restarted
        .mark_restore_activation_committed(&restarted.slot_dir(Slot::A), backup_id)
        .expect_err("错误活动槽路径的激活提交必须被拒绝");
    assert_eq!(wrong_dir.kind(), std::io::ErrorKind::InvalidData);

    let lease = restarted
        .restore_cutover_pending()
        .expect("read lease")
        .expect("被拒的提交不得动租约");
    assert!(
        !lease.activation_committed,
        "两次被拒的提交后租约必须仍是未提交状态"
    );

    // 正确身份提交后：错误路径的解除仍被拒；正确路径一次性解除。
    restarted
        .mark_restore_activation_committed(&active_dir, backup_id)
        .expect("正确身份的激活提交应成功");
    let complete_wrong_dir = restarted
        .complete_restore_cutover(&restarted.slot_dir(Slot::A))
        .expect_err("错误活动槽路径不得解除维护租约");
    assert_eq!(
        complete_wrong_dir.kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert!(
        restarted
            .complete_restore_cutover(&active_dir)
            .expect("正确路径解除租约"),
        "首次解除应返回 true"
    );

    // 幂等：租约已清空后再次解除返回 false 而非报错（崩溃重试安全）。
    assert!(
        !restarted
            .complete_restore_cutover(&active_dir)
            .expect("重复解除不得报错"),
        "租约已清空后的重复解除必须幂等返回 false"
    );
}

/// rollback trash 的跨重启生命周期：恢复前清空非活动槽会把残留移入
/// `slots/<slot>.trash-*` 作为兜底；激活该槽的那次启动才回收它的 trash，
/// 而**旧活动槽**的 trash（上一次恢复的回滚点）必须在切槽启动中幸存——
/// 切换失败时它是唯一找回旧数据的途径。
#[test]
fn rollback_trash_of_old_slot_survives_cutover_restart() {
    let base = tempfile::tempdir().expect("base dir");

    // 会话 1：active=A；B 槽有残留 → 清场移入 trash → 恢复写入 → 登记租约。
    let mgr = DataSpaceManager::new(base.path().to_path_buf());
    mgr.initialize_on_start().expect("首次启动");
    seed_slot(&mgr.slot_dir(Slot::A), b"device-current");
    seed_slot(&mgr.slot_dir(Slot::B), b"stale-residual");

    let slot_b_trash = mgr
        .clear_slot_for_restore(Slot::B)
        .expect("恢复前清空非活动槽")
        .expect("有残留时必须移入 trash 兜底");
    assert!(
        slot_b_trash.is_dir(),
        "trash 目录必须真实存在（可手动找回）"
    );
    let slots_dir = slot_b_trash.parent().expect("trash 在 slots 目录下");

    // 人为放置旧活动槽 A 的 rollback trash（模拟上一次恢复留下的回滚点）。
    let slot_a_trash = slots_dir.join("slotA.trash-20260824000000-manual");
    std::fs::create_dir_all(&slot_a_trash).expect("create slotA trash");
    std::fs::write(slot_a_trash.join("mistakes.db"), b"previous-rollback")
        .expect("write rollback payload");

    seed_slot(&mgr.slot_dir(Slot::B), b"restored-backup");
    mgr.mark_restore_cutover_pending(Slot::B, "backup-r10-trash")
        .expect("登记切槽租约");
    assert!(
        slot_b_trash.is_dir(),
        "切槽发生前，B 槽残留的 trash 必须保留（此刻它仍是唯一兜底）"
    );

    // 会话 2（重启，激活 B）：B 槽自身的 trash 被回收，A 槽回滚点幸存。
    let restarted = DataSpaceManager::new(base.path().to_path_buf());
    restarted.initialize_on_start().expect("重启切槽");
    assert_eq!(restarted.active_slot(), Slot::B);
    assert!(
        !slot_b_trash.exists(),
        "激活 B 槽的启动必须回收 B 槽自己的 trash（防止完整数据副本无限累积）"
    );
    assert!(
        slot_a_trash.is_dir(),
        "旧活动槽 A 的回滚 trash 必须在切槽启动中幸存——它是切换失败时找回旧数据的途径"
    );
    assert_eq!(
        std::fs::read(slot_a_trash.join("mistakes.db")).expect("read rollback payload"),
        b"previous-rollback"
    );
}

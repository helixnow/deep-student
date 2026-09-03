//! [R12-decoded-dead] FINDINGS-R11 P2-1 的关闭锁定：`get_file_decoded` 已删除。
//!
//! 背景：`data_governance/sync/mod.rs` 曾定义 `get_file_decoded`（文件级对象
//! 下载 + 透明 DSBK 解包），全仓零调用，且在本端启用加密时**接受明文对象**——
//! 与真实下载路径 `download_file_object` 的防降级门禁（缺 `cipher_sha256` 的
//! 明文遗留在启用加密时拒收，R04 防降级延伸）语义相悖。死代码若被后来者当成
//! 可用积木接回，会静默重新打开防降级豁免。
//!
//! 本文件钉住两件事：
//!
//! 1. `get_file_decoded`（及其唯一消费者 `file_has_dsbk_magic`）在 `src/` 里
//!    **不存在**——既没有定义，也没有调用。若未来确有文件级解包下载的新需求，
//!    必须走（或对齐）`download_file_object` 的加密门禁，并同步更新本测试与
//!    FINDINGS-R11/FIX-QUEUE 台账；
//! 2. `download_file_object` 的防降级门禁仍在：明文遗留分支（`cipher_sha256
//!    = None`）在 `encryption_enabled()` 时拒收，错误文案不被顺手删除。
//!
//! 全部用例只读源码，不触网、不建库，可与其他测试并行。

use std::path::{Path, PathBuf};

/// `src-tauri/`（CARGO_MANIFEST_DIR）为基准读仓库内文件。
fn read_repo_file(rel: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读取 {} 失败（文件被移动/删除？）: {}", path.display(), e))
}

/// 递归收集目录下所有 `.rs` 文件路径。
fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries =
        std::fs::read_dir(dir).unwrap_or_else(|e| panic!("读取目录 {} 失败: {}", dir.display(), e));
    for entry in entries {
        let path = entry.expect("读取目录项失败").path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

// ============================================================================
// 1. get_file_decoded 不存在（定义与调用双重锁定，覆盖整个 src/）
// ============================================================================

/// `src/` 全树不得出现 `get_file_decoded` / `file_has_dsbk_magic` 的定义或
/// 调用。注释里提及函数名（墓碑注释、台账引用）是允许的：只匹配
/// `fn <name>`（定义）与 `<name>(`（调用/定义头）两种代码形态。
#[test]
fn p2_1_get_file_decoded_is_gone_from_src() {
    let src_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    assert!(
        !files.is_empty(),
        "src/ 下应能收集到 .rs 文件（路径基准漂移？）"
    );

    for name in ["get_file_decoded", "file_has_dsbk_magic"] {
        let def = format!("fn {name}");
        let call = format!("{name}(");
        for file in &files {
            let content = std::fs::read_to_string(file)
                .unwrap_or_else(|e| panic!("读取 {} 失败: {}", file.display(), e));
            assert!(
                !content.contains(&def) && !content.contains(&call),
                "{} 中出现了 `{}` 的定义或调用。该函数是 FINDINGS-R11 P2-1 \
                 删除的死代码（启用加密时接受明文对象，绕过 download_file_object \
                 的防降级门禁），不得接回；若确有新需求，必须实现与 \
                 download_file_object 相同的加密门禁并更新本锁定测与台账。",
                file.display(),
                name
            );
        }
    }
}

/// 删除处保留的墓碑注释仍在：向后来者解释「为什么没有这个函数」，
/// 防止清理注释后有人按旧文档/旧提交把死代码原样接回。
#[test]
fn p2_1_tombstone_comment_survives() {
    let source = read_repo_file("src/data_governance/sync/mod.rs");
    assert!(
        source.contains("[FINDINGS-R11 P2-1]"),
        "sync/mod.rs 应保留 FINDINGS-R11 P2-1 的墓碑注释（解释 get_file_decoded \
         为何被删除、新需求应走 download_file_object）"
    );
}

// ============================================================================
// 2. download_file_object 的防降级门禁仍在（不再有「加密时收明文」旁路）
// ============================================================================

/// 明文遗留分支（`cipher_sha256 = None`）在本端启用加密时必须拒收：
/// 锁定 `encryption_enabled()` 判断与拒收文案同时存在于函数体内，
/// 防止后续重构悄悄恢复「启用加密时也接受明文对象」的旧 get_file_decoded 语义。
#[test]
fn p2_1_download_file_object_keeps_antidowngrade_gate() {
    let source = read_repo_file("src/data_governance/sync/mod.rs");

    let start = source
        .find("async fn download_file_object")
        .expect("download_file_object 应仍存在于 sync/mod.rs（文件级对象下载的唯一路径）");
    // 只在函数附近的窗口内断言，避免误匹配文件其他位置的同名文案。
    // 函数体约 70 行，4 KiB 窗口足够覆盖且不至于跨到无关函数。
    let window = &source[start..source.len().min(start + 4096)];

    assert!(
        window.contains("self.encryption_enabled()"),
        "download_file_object 的明文遗留分支应保留 encryption_enabled() 门禁"
    );
    assert!(
        window.contains("为防止密文被明文静默替换已拒绝下载"),
        "download_file_object 应保留启用加密时拒收明文遗留对象的错误文案（R04 防降级延伸）"
    );
}

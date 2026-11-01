//! Deep Student 共享测试夹具 crate（dev-only）。
//!
//! 只被 dev-dependency（以及 dstu-vfs 的 `test-util` feature）引用，不进入产品构建。
//!
//! 夹具不依赖上层 crate 的具体数据库类型：例如 VFS 测试库由
//! `dstu_vfs::vfs::database::setup_migrated_test_db()` 调用 [`setup_migrated_vfs`]，
//! 并传入它自己的 `VfsDatabase::new`。这样 dstu-vfs 自身的单测（`cfg(test)` 编译的
//! 那一份 crate）与下游 crate 的单测拿到的都是各自看到的同一个 `VfsDatabase` 类型，
//! 不会出现 dev-dependency 环导致的“同名不同类型”。

use std::path::Path;

use dstu_storage::migration::MigrationCoordinator;
use dstu_storage::schema_registry::DatabaseId;
use tempfile::TempDir;

/// 创建临时数据目录，并对其中的 VFS 数据库执行全部迁移。
///
/// 走与生产一致的迁移路径（`MigrationCoordinator::migrate_single(Vfs)`），
/// 迁移完成后 `<dir>/databases/vfs.db` 处于最新 schema。
pub fn migrated_vfs_temp_dir() -> TempDir {
    let temp_dir = TempDir::new().expect("Failed to create temp dir");
    let mut coordinator = MigrationCoordinator::new(temp_dir.path().to_path_buf());
    coordinator
        .migrate_single(DatabaseId::Vfs)
        .expect("VFS migrations should apply cleanly");
    temp_dir
}

/// 在 [`migrated_vfs_temp_dir`] 上用调用方给出的构造函数打开 VFS 数据库。
///
/// 返回的 `TempDir` 必须与数据库同生命周期持有（drop 即删除目录）。
pub fn setup_migrated_vfs<D, E: std::fmt::Debug>(
    open: impl FnOnce(&Path) -> Result<D, E>,
) -> (TempDir, D) {
    let temp_dir = migrated_vfs_temp_dir();
    let db = open(temp_dir.path()).expect("Failed to create VFS database");
    (temp_dir, db)
}

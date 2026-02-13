use crate::backup_common::{check_disk_space, copy_directory_safe, log_and_skip_entry_err};
use crate::models::AppError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing::{error, info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Slot {
    A,
    B,
    /// 测试专用插槽 C（模拟生产环境的 A）
    C,
    /// 测试专用插槽 D（模拟生产环境的 B）
    D,
}

impl Slot {
    /// 判断是否为测试插槽
    pub fn is_test_slot(&self) -> bool {
        matches!(self, Slot::C | Slot::D)
    }

    /// 获取插槽名称
    pub fn name(&self) -> &'static str {
        match self {
            Slot::A => "slotA",
            Slot::B => "slotB",
            Slot::C => "slotC",
            Slot::D => "slotD",
        }
    }

    /// 从字符串解析插槽
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "slotA" | "A" => Some(Slot::A),
            "slotB" | "B" => Some(Slot::B),
            "slotC" | "C" => Some(Slot::C),
            "slotD" | "D" => Some(Slot::D),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SlotState {
    active: String,
    pending: Option<String>,
}

impl Default for SlotState {
    fn default() -> Self {
        Self {
            active: "slotA".to_string(),
            pending: None,
        }
    }
}

pub struct DataSpaceManager {
    base_dir: PathBuf,
}

impl DataSpaceManager {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn slots_dir(&self) -> PathBuf {
        self.base_dir.join("slots")
    }
    fn state_path(&self) -> PathBuf {
        self.slots_dir().join("state.json")
    }
    pub fn slot_dir(&self, slot: Slot) -> PathBuf {
        self.slots_dir().join(slot.name())
    }

    /// 获取测试插槽目录
    pub fn test_slot_dir(&self, slot: Slot) -> PathBuf {
        assert!(slot.is_test_slot(), "只能获取测试插槽 C/D 的目录");
        self.slot_dir(slot)
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    pub fn ensure_layout(&self) -> std::io::Result<()> {
        // 创建生产插槽 A/B
        fs::create_dir_all(self.slot_dir(Slot::A))?;
        fs::create_dir_all(self.slot_dir(Slot::B))?;
        // 创建测试插槽 C/D（用于真实的端到端测试）
        fs::create_dir_all(self.slot_dir(Slot::C))?;
        fs::create_dir_all(self.slot_dir(Slot::D))?;
        if !self.state_path().exists() {
            let st = SlotState::default();
            fs::create_dir_all(self.slots_dir())?;
            // 使用原子写入，即使首次写入也要保证安全
            self.write_state(&st)?;
        }
        // 一次性迁移：若为首次启用双空间且 slotA/slotB 为空，将 base_dir 下现有数据迁移到 slotA
        let slot_a = self.slot_dir(Slot::A);
        let slot_b = self.slot_dir(Slot::B);
        let slot_a_empty = fs::read_dir(&slot_a)
            .map(|mut it| it.next().is_none())
            .unwrap_or(true);
        let slot_b_empty = fs::read_dir(&slot_b)
            .map(|mut it| it.next().is_none())
            .unwrap_or(true);
        if slot_a_empty && slot_b_empty {
            info!("[DataSpace] 检测到首次启用双空间模式，开始数据迁移到 slotA...");
            let mut migration_errors: Vec<String> = Vec::new();

            if let Ok(iter) = fs::read_dir(&self.base_dir) {
                for en in iter.filter_map(log_and_skip_entry_err) {
                    let p = en.path();
                    if p.file_name().and_then(|n| n.to_str()) == Some("slots") {
                        continue;
                    }
                    let dst = slot_a.join(en.file_name());
                    // 尝试重命名，失败则复制
                    if fs::rename(&p, &dst).is_err() {
                        if p.is_dir() {
                            // P1 修复: 使用安全版本复制，防止符号链接攻击
                            match copy_directory_safe(&p, &slot_a) {
                                Ok(_) => {
                                    if let Err(e) = fs::remove_dir_all(&p) {
                                        warn!("[DataSpace] 迁移后清理源目录失败 {:?}: {}", p, e);
                                    }
                                }
                                Err(e) => {
                                    let msg = format!("[DataSpace] 复制目录失败 {:?}: {}", p, e);
                                    error!("{}", msg);
                                    migration_errors.push(msg);
                                }
                            }
                        } else {
                            if let Err(e) = fs::create_dir_all(&slot_a) {
                                let msg =
                                    format!("[DataSpace] 创建目标目录失败 {:?}: {}", slot_a, e);
                                error!("{}", msg);
                                migration_errors.push(msg);
                                continue;
                            }
                            match fs::copy(&p, &dst) {
                                Ok(_) => {
                                    if let Err(e) = fs::remove_file(&p) {
                                        warn!("[DataSpace] 迁移后清理源文件失败 {:?}: {}", p, e);
                                    }
                                }
                                Err(e) => {
                                    let msg = format!(
                                        "[DataSpace] 复制文件失败 {:?} -> {:?}: {}",
                                        p, dst, e
                                    );
                                    error!("{}", msg);
                                    migration_errors.push(msg);
                                }
                            }
                        }
                    }
                }
            }

            if !migration_errors.is_empty() {
                // P1 修复: 迁移失败时返回错误而非静默继续
                let error_summary = migration_errors.join("; ");
                error!(
                    "[DataSpace] 数据迁移过程中发生 {} 个错误，部分数据可能未迁移成功: {}",
                    migration_errors.len(),
                    error_summary
                );
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!(
                        "数据迁移失败 ({} 个错误): {}",
                        migration_errors.len(),
                        error_summary
                    ),
                ));
            } else {
                info!("[DataSpace] 数据迁移完成");
            }
        }
        Ok(())
    }

    fn read_state(&self) -> std::io::Result<SlotState> {
        let state_path = self.state_path();
        let tmp_path = self.slots_dir().join("state.json.tmp");

        // 1. 尝试从 state.json 读取
        match fs::read_to_string(&state_path) {
            Ok(content) => match serde_json::from_str::<SlotState>(&content) {
                Ok(st) => return Ok(st),
                Err(e) => {
                    error!(
                        "[DataSpace] state.json 内容损坏，解析失败: {}。尝试从 .tmp 文件恢复...",
                        e
                    );
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // state.json 不存在，继续尝试 .tmp 和推断
                warn!("[DataSpace] state.json 不存在: {}", e);
            }
            Err(e) => {
                error!(
                    "[DataSpace] 读取 state.json 失败: {}。尝试从 .tmp 文件恢复...",
                    e
                );
            }
        }

        // 2. 尝试从 state.json.tmp（原子写入的中间文件）恢复
        if tmp_path.exists() {
            match fs::read_to_string(&tmp_path) {
                Ok(content) => match serde_json::from_str::<SlotState>(&content) {
                    Ok(st) => {
                        warn!(
                            "[DataSpace] 已从 state.json.tmp 恢复状态 (active={})",
                            st.active
                        );
                        // 将恢复的状态写回 state.json，防止下次启动时再次走恢复流程
                        if let Err(e) = self.write_state(&st) {
                            error!("[DataSpace] 恢复后回写 state.json 失败: {}", e);
                        }
                        return Ok(st);
                    }
                    Err(e) => {
                        error!("[DataSpace] state.json.tmp 也已损坏: {}", e);
                    }
                },
                Err(e) => {
                    error!("[DataSpace] 读取 state.json.tmp 失败: {}", e);
                }
            }
        }

        // 3. 两个文件都损坏/不存在，通过检查 slot 目录推断活跃空间
        let inferred = self.infer_active_slot_from_dirs();
        warn!(
            "[DataSpace] state.json 和 .tmp 均不可用，通过目录推断活跃空间为: {}",
            inferred.active
        );
        // 将推断结果持久化
        if let Err(e) = self.write_state(&inferred) {
            error!("[DataSpace] 推断后写入 state.json 失败: {}", e);
        }
        Ok(inferred)
    }

    /// 当 state.json 和 .tmp 都损坏时，通过检查 slot 目录的存在和内容推断活跃空间
    fn infer_active_slot_from_dirs(&self) -> SlotState {
        let slot_a_dir = self.slot_dir(Slot::A);
        let slot_b_dir = self.slot_dir(Slot::B);

        let slot_a_valid = Self::dir_has_data(&slot_a_dir);
        let slot_b_valid = Self::dir_has_data(&slot_b_dir);

        let active = match (slot_a_valid, slot_b_valid) {
            (true, false) => {
                info!("[DataSpace] 推断: 仅 slotA 包含有效数据，设为活跃");
                "slotA"
            }
            (false, true) => {
                info!("[DataSpace] 推断: 仅 slotB 包含有效数据，设为活跃");
                "slotB"
            }
            (true, true) => {
                // 两个 slot 都有数据，比较最近修改时间以推断
                let a_mtime = Self::dir_latest_mtime(&slot_a_dir);
                let b_mtime = Self::dir_latest_mtime(&slot_b_dir);
                if b_mtime > a_mtime {
                    info!("[DataSpace] 推断: slotA 和 slotB 均有数据，slotB 修改更新，设为活跃");
                    "slotB"
                } else {
                    info!("[DataSpace] 推断: slotA 和 slotB 均有数据，默认 slotA 为活跃");
                    "slotA"
                }
            }
            (false, false) => {
                info!("[DataSpace] 推断: 两个 slot 均无数据，默认 slotA");
                "slotA"
            }
        };

        SlotState {
            active: active.to_string(),
            pending: None,
        }
    }

    /// 检查目录是否存在且包含文件/子目录
    fn dir_has_data(dir: &Path) -> bool {
        dir.is_dir()
            && fs::read_dir(dir)
                .map(|mut it| it.next().is_some())
                .unwrap_or(false)
    }

    /// 获取目录下文件的最近修改时间（秒级时间戳），用于推断活跃空间
    fn dir_latest_mtime(dir: &Path) -> u64 {
        fs::read_dir(dir)
            .ok()
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter_map(|e| e.metadata().ok())
                    .filter_map(|m| m.modified().ok())
                    .filter_map(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    }

    // ========================================================================
    // 空间大小计算与磁盘空间检查
    // ========================================================================

    /// 递归计算目录总大小（字节）
    pub fn calculate_dir_size(dir: &Path) -> std::io::Result<u64> {
        let mut total: u64 = 0;
        if !dir.is_dir() {
            return Ok(0);
        }
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                total += Self::calculate_dir_size(&entry.path())?;
            } else if metadata.is_file() {
                total += metadata.len();
            }
            // 跳过符号链接，防止循环引用
        }
        Ok(total)
    }

    /// 计算指定 slot 的占用空间（字节）
    pub fn slot_size(&self, slot: Slot) -> std::io::Result<u64> {
        Self::calculate_dir_size(&self.slot_dir(slot))
    }

    /// 检查目标分区是否有足够空间容纳源 slot 的数据
    ///
    /// 使用 backup_common 的 check_disk_space（包含 20% 安全余量）
    pub fn check_space_for_switch(&self, source: Slot, target_dir: &Path) -> std::io::Result<()> {
        let source_size = self.slot_size(source)?;
        info!(
            "[DataSpace] 源插槽 {} 大小: {:.2} MB",
            source.name(),
            source_size as f64 / 1024.0 / 1024.0
        );

        // 使用 backup_common 的磁盘空间检查（含 20% 余量）
        check_disk_space(target_dir, source_size).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("磁盘空间检查失败: {}", e.message),
            )
        })?;

        Ok(())
    }

    // ========================================================================
    // Slot 目录完整性验证
    // ========================================================================

    /// 验证 slot 目录的完整性。
    ///
    /// 检查项：
    /// 1. 目录是否存在
    /// 2. 目录是否包含数据库文件（*.db 或 *.sqlite）
    /// 3. 目录是否包含必要子目录（如 images 等，可选检查）
    ///
    /// 返回 `SlotIntegrityReport` 包含详细检查结果。
    pub fn verify_slot_integrity(&self, slot: Slot) -> SlotIntegrityReport {
        let dir = self.slot_dir(slot);
        let mut report = SlotIntegrityReport {
            slot: slot.name().to_string(),
            dir_path: dir.to_string_lossy().to_string(),
            exists: false,
            has_data: false,
            has_database: false,
            database_files: Vec::new(),
            subdirectories: Vec::new(),
            total_size_bytes: 0,
            file_count: 0,
            issues: Vec::new(),
        };

        // 1. 检查目录是否存在
        if !dir.is_dir() {
            report.issues.push("插槽目录不存在".to_string());
            return report;
        }
        report.exists = true;

        // 2. 检查是否包含数据
        report.has_data = Self::dir_has_data(&dir);
        if !report.has_data {
            report.issues.push("插槽目录为空".to_string());
            return report;
        }

        // 3. 扫描目录内容
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();

                if path.is_dir() {
                    report.subdirectories.push(name);
                } else if path.is_file() {
                    report.file_count += 1;
                    if let Ok(meta) = entry.metadata() {
                        report.total_size_bytes += meta.len();
                    }
                    // 检查数据库文件
                    let lower = name.to_lowercase();
                    if lower.ends_with(".db")
                        || lower.ends_with(".sqlite")
                        || lower.ends_with(".sqlite3")
                    {
                        report.database_files.push(name);
                    }
                }
            }
        }

        // 4. 递归计算子目录大小
        for subdir_name in &report.subdirectories {
            let subdir_path = dir.join(subdir_name);
            if let Ok(size) = Self::calculate_dir_size(&subdir_path) {
                report.total_size_bytes += size;
            }
        }

        // 5. 检查是否包含数据库文件
        report.has_database = !report.database_files.is_empty();
        if !report.has_database {
            report
                .issues
                .push("未找到数据库文件 (*.db / *.sqlite / *.sqlite3)".to_string());
        }

        report
    }

    fn write_state(&self, st: &SlotState) -> std::io::Result<()> {
        // P2 修复: 序列化理论上不会失败，但仍使用 map_err 转换为 io::Error
        let s = serde_json::to_string_pretty(st).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("序列化状态失败: {}", e),
            )
        })?;
        self.atomic_write_state_file(&s)
    }

    /// 原子写入 state.json：先写临时文件并 fsync，再 rename 替换，防止崩溃/断电导致文件损坏
    fn atomic_write_state_file(&self, content: &str) -> std::io::Result<()> {
        use std::io::Write;

        let target = self.state_path();
        let tmp = self.slots_dir().join("state.json.tmp");

        // 1. 写入临时文件
        {
            let mut file = fs::File::create(&tmp)?;
            file.write_all(content.as_bytes())?;
            // 2. fsync 确保数据刷盘
            file.sync_all()?;
        }

        // 3. 原子性 rename：在 POSIX 系统上 rename 是原子操作
        fs::rename(&tmp, &target)?;

        // 4. fsync 父目录，确保目录条目更新持久化（防止断电后目录项丢失）
        #[cfg(unix)]
        {
            if let Ok(dir) = fs::File::open(self.slots_dir()) {
                let _ = dir.sync_all();
            }
        }

        Ok(())
    }

    pub fn initialize_on_start(&self) {
        if self.ensure_layout().is_err() {
            return;
        }
        if let Ok(mut st) = self.read_state() {
            if let Some(pending) = st.pending.take() {
                // 在应用 pending 切换之前，验证目标 slot 目录有效
                if let Some(target_slot) = Slot::from_name(&pending) {
                    let target_dir = self.slot_dir(target_slot);
                    if target_dir.is_dir() && Self::dir_has_data(&target_dir) {
                        info!(
                            "[DataSpace] 启动时应用 pending 切换: {} -> {}",
                            st.active, pending
                        );
                        st.active = pending;
                    } else {
                        error!(
                            "[DataSpace] pending 切换目标 {} 目录无效或为空，取消切换，保持 {}",
                            pending, st.active
                        );
                    }
                } else {
                    error!(
                        "[DataSpace] pending 切换目标名称无效: {}，取消切换",
                        pending
                    );
                }
                let _ = self.write_state(&st);
            }
        }
    }

    pub fn active_slot(&self) -> Slot {
        if let Ok(st) = self.read_state() {
            if st.active == "slotB" {
                Slot::B
            } else {
                Slot::A
            }
        } else {
            Slot::A
        }
    }

    pub fn inactive_slot(&self) -> Slot {
        match self.active_slot() {
            Slot::A => Slot::B,
            Slot::B => Slot::A,
            // 测试插槽不参与生产环境的切换
            Slot::C => Slot::D,
            Slot::D => Slot::C,
        }
    }

    pub fn active_dir(&self) -> PathBuf {
        self.slot_dir(self.active_slot())
    }
    pub fn inactive_dir(&self) -> PathBuf {
        self.slot_dir(self.inactive_slot())
    }

    /// 标记下次重启时切换到目标 slot。
    ///
    /// 事务性保证：
    /// 1. 切换前验证目标 slot 目录存在且包含有效数据
    /// 2. 仅在验证通过后才更新 state.json 的 pending 字段
    /// 3. 实际切换在下次启动时 `initialize_on_start` 中执行
    /// 4. 如果 state.json 写入失败（如崩溃/断电），pending 不会生效，
    ///    下次启动仍使用原 active slot，保证数据安全
    pub fn mark_pending_switch(&self, target: Slot) -> std::io::Result<()> {
        // 验证目标 slot 目录存在且包含数据
        let target_dir = self.slot_dir(target);
        if !target_dir.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("目标插槽目录不存在: {}，无法切换", target_dir.display()),
            ));
        }
        if !Self::dir_has_data(&target_dir) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "目标插槽 {} 目录为空，没有可用数据，无法切换",
                    target.name()
                ),
            ));
        }

        info!("[DataSpace] 验证通过，标记下次重启切换到 {}", target.name());
        let mut st = self.read_state().unwrap_or_default();
        st.pending = Some(target.name().to_string());
        self.write_state(&st)
    }

    // ========================================================================
    // 测试插槽专用方法
    // ========================================================================

    /// 获取测试插槽 C 的目录路径
    pub fn test_slot_c_dir(&self) -> PathBuf {
        self.slot_dir(Slot::C)
    }

    /// 获取测试插槽 D 的目录路径
    pub fn test_slot_d_dir(&self) -> PathBuf {
        self.slot_dir(Slot::D)
    }

    /// 清空测试插槽（用于测试前的环境准备）
    pub fn clear_test_slots(&self) -> std::io::Result<()> {
        let slot_c = self.slot_dir(Slot::C);
        let slot_d = self.slot_dir(Slot::D);

        // 删除并重建目录
        if slot_c.exists() {
            fs::remove_dir_all(&slot_c)?;
        }
        fs::create_dir_all(&slot_c)?;

        if slot_d.exists() {
            fs::remove_dir_all(&slot_d)?;
        }
        fs::create_dir_all(&slot_d)?;

        Ok(())
    }

    /// 在测试插槽 C 中初始化测试数据
    pub fn init_test_data_in_slot_c(&self) -> std::io::Result<PathBuf> {
        let slot_c = self.slot_dir(Slot::C);
        fs::create_dir_all(&slot_c)?;
        Ok(slot_c)
    }

    /// 获取测试插槽的配对（C <-> D，类似于生产环境的 A <-> B）
    pub fn test_slot_pair(&self, slot: Slot) -> Option<Slot> {
        match slot {
            Slot::C => Some(Slot::D),
            Slot::D => Some(Slot::C),
            _ => None, // 生产插槽不返回测试配对
        }
    }
}

static DATA_SPACE: OnceLock<DataSpaceManager> = OnceLock::new();

pub fn init_data_space_manager(base_dir: PathBuf) {
    let mgr = DataSpaceManager::new(base_dir);
    mgr.initialize_on_start();
    let _ = DATA_SPACE.set(mgr);
}

pub fn get_data_space_manager() -> Option<&'static DataSpaceManager> {
    DATA_SPACE.get()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataSpaceInfo {
    pub active_slot: String,
    pub inactive_slot: String,
    pub pending_slot: Option<String>,
    pub active_dir: String,
    pub inactive_dir: String,
}

/// Slot 目录完整性报告
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotIntegrityReport {
    /// 插槽名称
    pub slot: String,
    /// 插槽目录路径
    pub dir_path: String,
    /// 目录是否存在
    pub exists: bool,
    /// 是否包含数据
    pub has_data: bool,
    /// 是否包含数据库文件
    pub has_database: bool,
    /// 发现的数据库文件列表
    pub database_files: Vec<String>,
    /// 子目录列表
    pub subdirectories: Vec<String>,
    /// 总大小（字节）
    pub total_size_bytes: u64,
    /// 文件数量（不含子目录内文件的递归统计）
    pub file_count: usize,
    /// 检出的问题列表
    pub issues: Vec<String>,
}

impl SlotIntegrityReport {
    /// 判断 slot 是否完整可用（无问题）
    pub fn is_healthy(&self) -> bool {
        self.issues.is_empty()
    }

    /// 格式化为人类可读的摘要
    pub fn summary(&self) -> String {
        if self.is_healthy() {
            format!(
                "插槽 {} 完整: {} 个数据库文件, {} 个子目录, {:.2} MB",
                self.slot,
                self.database_files.len(),
                self.subdirectories.len(),
                self.total_size_bytes as f64 / 1024.0 / 1024.0
            )
        } else {
            format!("插槽 {} 异常: {}", self.slot, self.issues.join("; "))
        }
    }
}

/// 空间大小信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotSizeInfo {
    pub slot: String,
    pub size_bytes: u64,
    pub size_mb: f64,
}

#[tauri::command]
pub fn get_data_space_info() -> Result<DataSpaceInfo, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;
    // 读取 state 以获取 pending
    let st: SlotState = mgr
        .read_state()
        .map_err(|e| AppError::internal(format!("读取数据空间状态失败: {}", e)))?;
    let active_slot = if st.active == "slotB" {
        "slotB"
    } else {
        "slotA"
    }
    .to_string();
    let inactive_slot = if active_slot == "slotA" {
        "slotB"
    } else {
        "slotA"
    }
    .to_string();
    let info = DataSpaceInfo {
        active_slot: active_slot.clone(),
        inactive_slot: inactive_slot.clone(),
        pending_slot: st.pending.clone(),
        active_dir: mgr.active_dir().to_string_lossy().to_string(),
        inactive_dir: mgr.inactive_dir().to_string_lossy().to_string(),
    };
    Ok(info)
}

#[tauri::command]
pub fn mark_data_space_pending_switch_to_inactive() -> Result<String, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;
    let target = mgr.inactive_slot();
    mgr.mark_pending_switch(target)
        .map_err(|e| AppError::file_system(format!("标记切换失败: {}", e)))?;
    Ok(format!("已标记下次重启切换到 {}", target.name()))
}

// ============================================================================
// 测试插槽专用命令
// ============================================================================

/// 测试插槽信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestSlotInfo {
    pub slot_c_dir: String,
    pub slot_d_dir: String,
    pub slot_c_exists: bool,
    pub slot_d_exists: bool,
    pub slot_c_file_count: usize,
    pub slot_d_file_count: usize,
}

/// 获取测试插槽信息
#[tauri::command]
pub fn get_test_slot_info() -> Result<TestSlotInfo, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;

    let slot_c = mgr.test_slot_c_dir();
    let slot_d = mgr.test_slot_d_dir();

    let count_files =
        |path: &PathBuf| -> usize { fs::read_dir(path).map(|it| it.count()).unwrap_or(0) };

    Ok(TestSlotInfo {
        slot_c_dir: slot_c.to_string_lossy().to_string(),
        slot_d_dir: slot_d.to_string_lossy().to_string(),
        slot_c_exists: slot_c.exists(),
        slot_d_exists: slot_d.exists(),
        slot_c_file_count: count_files(&slot_c),
        slot_d_file_count: count_files(&slot_d),
    })
}

/// 清空测试插槽（测试前准备）
#[tauri::command]
pub fn clear_test_slots() -> Result<String, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;

    mgr.clear_test_slots()
        .map_err(|e| AppError::file_system(format!("清空测试插槽失败: {}", e)))?;

    Ok("测试插槽 C 和 D 已清空".to_string())
}

/// 重启应用
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// 获取指定插槽的目录路径
#[tauri::command]
pub fn get_slot_directory(slot_name: String) -> Result<String, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;

    let slot = Slot::from_name(&slot_name)
        .ok_or_else(|| AppError::validation(format!("无效的插槽名称: {}", slot_name)))?;

    Ok(mgr.slot_dir(slot).to_string_lossy().to_string())
}

// ============================================================================
// 空间大小与完整性检查命令
// ============================================================================

/// 获取指定插槽的占用空间大小
#[tauri::command]
pub fn get_slot_size(slot_name: String) -> Result<SlotSizeInfo, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;

    let slot = Slot::from_name(&slot_name)
        .ok_or_else(|| AppError::validation(format!("无效的插槽名称: {}", slot_name)))?;

    let size_bytes = mgr
        .slot_size(slot)
        .map_err(|e| AppError::file_system(format!("计算插槽大小失败: {}", e)))?;

    Ok(SlotSizeInfo {
        slot: slot.name().to_string(),
        size_bytes,
        size_mb: size_bytes as f64 / 1024.0 / 1024.0,
    })
}

/// 验证指定插槽的完整性
#[tauri::command]
pub fn verify_slot_integrity(slot_name: String) -> Result<SlotIntegrityReport, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;

    let slot = Slot::from_name(&slot_name)
        .ok_or_else(|| AppError::validation(format!("无效的插槽名称: {}", slot_name)))?;

    let report = mgr.verify_slot_integrity(slot);
    info!("[DataSpace] 完整性检查: {}", report.summary());
    Ok(report)
}

/// 验证所有生产插槽的完整性
#[tauri::command]
pub fn verify_all_slots_integrity() -> Result<Vec<SlotIntegrityReport>, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;

    let reports = vec![
        mgr.verify_slot_integrity(Slot::A),
        mgr.verify_slot_integrity(Slot::B),
    ];

    for report in &reports {
        info!("[DataSpace] 完整性检查: {}", report.summary());
    }

    Ok(reports)
}

/// 检查是否有足够磁盘空间进行插槽切换
#[tauri::command]
pub fn check_switch_disk_space() -> Result<String, AppError> {
    let mgr = get_data_space_manager()
        .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;

    let active = mgr.active_slot();
    let inactive = mgr.inactive_slot();
    let inactive_dir = mgr.slot_dir(inactive);

    mgr.check_space_for_switch(active, &inactive_dir)
        .map_err(|e| AppError::file_system(format!("磁盘空间检查失败: {}", e)))?;

    let active_size = mgr
        .slot_size(active)
        .map_err(|e| AppError::file_system(format!("计算活跃插槽大小失败: {}", e)))?;

    Ok(format!(
        "磁盘空间充足，活跃插槽 {} 大小为 {:.2} MB",
        active.name(),
        active_size as f64 / 1024.0 / 1024.0
    ))
}

// ============================================================================
// 单元 / 集成测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    /// 创建一个隔离的 DataSpaceManager，使用临时目录
    fn make_manager() -> (TempDir, DataSpaceManager) {
        let tmp = TempDir::new().expect("创建临时目录失败");
        let mgr = DataSpaceManager::new(tmp.path().to_path_buf());
        (tmp, mgr)
    }

    /// 辅助：在指定 slot 目录下放入一个占位文件，使其 "非空"
    fn populate_slot(mgr: &DataSpaceManager, slot: Slot) {
        let dir = mgr.slot_dir(slot);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("placeholder.txt"), "data").unwrap();
    }

    /// 辅助：在指定 slot 目录下放入一个 .db 文件，使完整性检查通过
    fn populate_slot_with_db(mgr: &DataSpaceManager, slot: Slot) {
        let dir = mgr.slot_dir(slot);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.db"), "sqlite-fake-content").unwrap();
    }

    // -----------------------------------------------------------------------
    // 1. ensure_layout — 创建所有必要目录
    // -----------------------------------------------------------------------
    #[test]
    fn test_ensure_layout_creates_directories() {
        let (_tmp, mgr) = make_manager();

        mgr.ensure_layout().expect("ensure_layout 应成功");

        // 验证四个 slot 目录均已创建
        assert!(mgr.slot_dir(Slot::A).is_dir(), "slotA 目录应存在");
        assert!(mgr.slot_dir(Slot::B).is_dir(), "slotB 目录应存在");
        assert!(mgr.slot_dir(Slot::C).is_dir(), "slotC 目录应存在");
        assert!(mgr.slot_dir(Slot::D).is_dir(), "slotD 目录应存在");

        // 验证 state.json 已创建
        assert!(mgr.state_path().exists(), "state.json 应已创建");
    }

    // -----------------------------------------------------------------------
    // 2. read_state / write_state — 读写往返一致
    // -----------------------------------------------------------------------
    #[test]
    fn test_read_write_state_roundtrip() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 写入自定义状态
        let state = SlotState {
            active: "slotB".to_string(),
            pending: Some("slotA".to_string()),
        };
        mgr.write_state(&state).expect("write_state 应成功");

        // 读取并验证
        let read_back = mgr.read_state().expect("read_state 应成功");
        assert_eq!(read_back.active, "slotB");
        assert_eq!(read_back.pending, Some("slotA".to_string()));
    }

    // -----------------------------------------------------------------------
    // 3. 原子写入 — state.json 内容正确
    // -----------------------------------------------------------------------
    #[test]
    fn test_atomic_write_state_file_content() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        let state = SlotState {
            active: "slotA".to_string(),
            pending: None,
        };
        mgr.write_state(&state).unwrap();

        // 直接读取文件验证 JSON 内容
        let raw = fs::read_to_string(mgr.state_path()).expect("应能读取 state.json");
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).expect("state.json 应为有效 JSON");
        assert_eq!(parsed["active"], "slotA");
        assert!(parsed["pending"].is_null());

        // 原子写入后 .tmp 文件不应存在（rename 将其替换为正式文件）
        let tmp_path = mgr.slots_dir().join("state.json.tmp");
        assert!(!tmp_path.exists(), "原子写入后 .tmp 文件不应残留");
    }

    // -----------------------------------------------------------------------
    // 4. 损坏恢复 — 主文件损坏，从 .tmp 恢复
    // -----------------------------------------------------------------------
    #[test]
    fn test_corruption_recovery_from_tmp() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 先写一份正确状态到 .tmp 文件（模拟原子写入的中间态）
        let tmp_path = mgr.slots_dir().join("state.json.tmp");
        let valid_state = SlotState {
            active: "slotB".to_string(),
            pending: None,
        };
        let valid_json = serde_json::to_string_pretty(&valid_state).unwrap();
        fs::write(&tmp_path, &valid_json).unwrap();

        // 破坏 state.json（写入无效 JSON）
        fs::write(mgr.state_path(), "THIS IS NOT JSON!!!").unwrap();

        // read_state 应从 .tmp 恢复
        let recovered = mgr.read_state().expect("应能从 .tmp 恢复");
        assert_eq!(recovered.active, "slotB", "应恢复到 slotB");
    }

    // -----------------------------------------------------------------------
    // 5. 损坏恢复 — 目录推断（两个文件都不存在）
    // -----------------------------------------------------------------------
    #[test]
    fn test_corruption_recovery_infer_from_dirs() {
        let (_tmp, mgr) = make_manager();

        // 只创建 slots 目录和 slotB（不创建 state.json）
        fs::create_dir_all(mgr.slot_dir(Slot::A)).unwrap();
        let slot_b = mgr.slot_dir(Slot::B);
        fs::create_dir_all(&slot_b).unwrap();
        // 仅在 slotB 放入数据
        fs::write(slot_b.join("data.db"), "content").unwrap();

        // 此时 state.json 和 .tmp 均不存在
        assert!(!mgr.state_path().exists());

        // read_state 应通过目录推断
        let inferred = mgr.read_state().expect("应能通过目录推断");
        assert_eq!(inferred.active, "slotB", "仅 slotB 有数据时应推断为活跃");
    }

    // -----------------------------------------------------------------------
    // 6. mark_pending_switch — 正确写入 pending 状态
    // -----------------------------------------------------------------------
    #[test]
    fn test_mark_pending_switch() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 在 slotB 放入数据（mark_pending_switch 要求目标非空）
        populate_slot(&mgr, Slot::B);

        mgr.mark_pending_switch(Slot::B)
            .expect("mark_pending_switch 应成功");

        let st = mgr.read_state().unwrap();
        assert_eq!(
            st.pending,
            Some("slotB".to_string()),
            "pending 应被标记为 slotB"
        );
    }

    // -----------------------------------------------------------------------
    // 6b. mark_pending_switch — 目标为空时应失败
    // -----------------------------------------------------------------------
    #[test]
    fn test_mark_pending_switch_empty_target_fails() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // slotB 为空，mark_pending_switch 应失败
        let result = mgr.mark_pending_switch(Slot::B);
        assert!(result.is_err(), "目标 slot 为空时应返回错误");
    }

    // -----------------------------------------------------------------------
    // 7. initialize_on_start — 有效 pending：pending 指向有效 slot，成功切换
    // -----------------------------------------------------------------------
    #[test]
    fn test_initialize_on_start_valid_pending() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 在 slotB 放入数据
        populate_slot(&mgr, Slot::B);

        // 手动写入 pending = slotB
        let state = SlotState {
            active: "slotA".to_string(),
            pending: Some("slotB".to_string()),
        };
        mgr.write_state(&state).unwrap();

        // 模拟启动
        mgr.initialize_on_start();

        // 验证切换成功
        let after = mgr.read_state().unwrap();
        assert_eq!(after.active, "slotB", "应已切换到 slotB");
        assert!(after.pending.is_none(), "pending 应已清除");
    }

    // -----------------------------------------------------------------------
    // 8. initialize_on_start — 无效 pending：pending 指向无效 slot，保持原状态
    // -----------------------------------------------------------------------
    #[test]
    fn test_initialize_on_start_invalid_pending() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 写入 pending 指向一个完全无效的名称
        let state = SlotState {
            active: "slotA".to_string(),
            pending: Some("slotZ_nonexistent".to_string()),
        };
        mgr.write_state(&state).unwrap();

        mgr.initialize_on_start();

        // 应保持 slotA
        let after = mgr.read_state().unwrap();
        assert_eq!(after.active, "slotA", "无效 pending 时应保持原 active");
        assert!(after.pending.is_none(), "pending 应已清除");
    }

    // -----------------------------------------------------------------------
    // 8b. initialize_on_start — pending 指向空目录，保持原状态
    // -----------------------------------------------------------------------
    #[test]
    fn test_initialize_on_start_pending_empty_slot() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // slotB 目录存在但为空
        let state = SlotState {
            active: "slotA".to_string(),
            pending: Some("slotB".to_string()),
        };
        mgr.write_state(&state).unwrap();

        mgr.initialize_on_start();

        // slotB 为空，不应切换
        let after = mgr.read_state().unwrap();
        assert_eq!(
            after.active, "slotA",
            "pending 指向空 slot 时应保持原 active"
        );
        assert!(after.pending.is_none(), "pending 应已清除");
    }

    // -----------------------------------------------------------------------
    // 9. verify_slot_integrity — 有数据的 slot 报告健康
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_slot_integrity_healthy() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 放入数据库文件和子目录
        populate_slot_with_db(&mgr, Slot::A);
        let subdir = mgr.slot_dir(Slot::A).join("images");
        fs::create_dir_all(&subdir).unwrap();
        fs::write(subdir.join("photo.jpg"), "fake-image-bytes").unwrap();

        let report = mgr.verify_slot_integrity(Slot::A);

        assert!(report.exists, "目录应存在");
        assert!(report.has_data, "应有数据");
        assert!(report.has_database, "应检测到数据库文件");
        assert!(
            report.database_files.contains(&"main.db".to_string()),
            "应包含 main.db"
        );
        assert!(
            report.subdirectories.contains(&"images".to_string()),
            "应包含 images 子目录"
        );
        assert!(report.is_healthy(), "报告应为健康状态");
        assert!(report.total_size_bytes > 0, "总大小应 > 0");
    }

    // -----------------------------------------------------------------------
    // 10. verify_slot_integrity — 空 slot 报告问题
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_slot_integrity_empty_slot() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // slotB 在 ensure_layout 后为空
        let report = mgr.verify_slot_integrity(Slot::B);

        assert!(report.exists, "目录应存在");
        assert!(!report.has_data, "不应有数据");
        assert!(!report.is_healthy(), "空 slot 应不健康");
        assert!(
            report.issues.iter().any(|i| i.contains("为空")),
            "issues 应包含空目录相关信息"
        );
    }

    // -----------------------------------------------------------------------
    // 10b. verify_slot_integrity — 目录不存在
    // -----------------------------------------------------------------------
    #[test]
    fn test_verify_slot_integrity_missing_dir() {
        let (tmp, _) = make_manager();
        // 创建一个新 manager 指向不存在的子目录
        let mgr = DataSpaceManager::new(tmp.path().join("nonexistent_base"));

        let report = mgr.verify_slot_integrity(Slot::A);

        assert!(!report.exists, "目录不应存在");
        assert!(!report.is_healthy(), "不存在的 slot 应不健康");
        assert!(
            report.issues.iter().any(|i| i.contains("不存在")),
            "issues 应包含不存在相关信息"
        );
    }

    // -----------------------------------------------------------------------
    // 11. SlotIntegrityReport.is_healthy — 有问题时返回 false
    // -----------------------------------------------------------------------
    #[test]
    fn test_slot_integrity_report_is_healthy() {
        // 无 issues → healthy
        let healthy_report = SlotIntegrityReport {
            slot: "slotA".to_string(),
            dir_path: "/tmp/test".to_string(),
            exists: true,
            has_data: true,
            has_database: true,
            database_files: vec!["main.db".to_string()],
            subdirectories: vec![],
            total_size_bytes: 1024,
            file_count: 1,
            issues: vec![],
        };
        assert!(healthy_report.is_healthy());

        // 有 issues → not healthy
        let unhealthy_report = SlotIntegrityReport {
            slot: "slotB".to_string(),
            dir_path: "/tmp/test".to_string(),
            exists: true,
            has_data: true,
            has_database: false,
            database_files: vec![],
            subdirectories: vec![],
            total_size_bytes: 100,
            file_count: 1,
            issues: vec!["未找到数据库文件".to_string()],
        };
        assert!(!unhealthy_report.is_healthy());
    }

    // -----------------------------------------------------------------------
    // 12. slot_size — 计算正确
    // -----------------------------------------------------------------------
    #[test]
    fn test_slot_size_calculation() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 空 slot 大小应为 0
        let empty_size = mgr.slot_size(Slot::A).unwrap();
        assert_eq!(empty_size, 0, "空 slot 大小应为 0");

        // 写入已知大小的文件
        let content = b"hello world 1234567890"; // 22 bytes
        fs::write(mgr.slot_dir(Slot::A).join("file1.txt"), content).unwrap();

        let size_after = mgr.slot_size(Slot::A).unwrap();
        assert_eq!(size_after, 22, "应精确计算单文件大小");

        // 创建子目录并写入更多文件
        let subdir = mgr.slot_dir(Slot::A).join("nested");
        fs::create_dir_all(&subdir).unwrap();
        let content2 = b"abcdefgh"; // 8 bytes
        fs::write(subdir.join("file2.txt"), content2).unwrap();

        let total = mgr.slot_size(Slot::A).unwrap();
        assert_eq!(total, 30, "应递归计算总大小 (22 + 8 = 30)");
    }

    // -----------------------------------------------------------------------
    // 补充: Slot 基础方法测试
    // -----------------------------------------------------------------------
    #[test]
    fn test_slot_basic_methods() {
        // name()
        assert_eq!(Slot::A.name(), "slotA");
        assert_eq!(Slot::B.name(), "slotB");
        assert_eq!(Slot::C.name(), "slotC");
        assert_eq!(Slot::D.name(), "slotD");

        // from_name()
        assert_eq!(Slot::from_name("slotA"), Some(Slot::A));
        assert_eq!(Slot::from_name("A"), Some(Slot::A));
        assert_eq!(Slot::from_name("slotB"), Some(Slot::B));
        assert_eq!(Slot::from_name("B"), Some(Slot::B));
        assert_eq!(Slot::from_name("C"), Some(Slot::C));
        assert_eq!(Slot::from_name("D"), Some(Slot::D));
        assert_eq!(Slot::from_name("invalid"), None);

        // is_test_slot()
        assert!(!Slot::A.is_test_slot());
        assert!(!Slot::B.is_test_slot());
        assert!(Slot::C.is_test_slot());
        assert!(Slot::D.is_test_slot());
    }

    // -----------------------------------------------------------------------
    // 补充: ensure_layout 幂等性测试
    // -----------------------------------------------------------------------
    #[test]
    fn test_ensure_layout_idempotent() {
        let (_tmp, mgr) = make_manager();

        mgr.ensure_layout().unwrap();
        let first_state = fs::read_to_string(mgr.state_path()).unwrap();

        // 再次调用不应出错，state.json 内容不变
        mgr.ensure_layout().unwrap();
        let second_state = fs::read_to_string(mgr.state_path()).unwrap();

        assert_eq!(
            first_state, second_state,
            "重复 ensure_layout 不应改变 state.json"
        );
    }

    // -----------------------------------------------------------------------
    // 补充: active_slot / inactive_slot 测试
    // -----------------------------------------------------------------------
    #[test]
    fn test_active_inactive_slot() {
        let (_tmp, mgr) = make_manager();
        mgr.ensure_layout().unwrap();

        // 默认应为 slotA
        assert_eq!(mgr.active_slot(), Slot::A);
        assert_eq!(mgr.inactive_slot(), Slot::B);

        // 切换到 slotB
        let state = SlotState {
            active: "slotB".to_string(),
            pending: None,
        };
        mgr.write_state(&state).unwrap();
        assert_eq!(mgr.active_slot(), Slot::B);
        assert_eq!(mgr.inactive_slot(), Slot::A);
    }

    // -----------------------------------------------------------------------
    // 补充: summary() 方法测试
    // -----------------------------------------------------------------------
    #[test]
    fn test_slot_integrity_report_summary() {
        let healthy = SlotIntegrityReport {
            slot: "slotA".to_string(),
            dir_path: "/test".to_string(),
            exists: true,
            has_data: true,
            has_database: true,
            database_files: vec!["main.db".to_string()],
            subdirectories: vec!["images".to_string()],
            total_size_bytes: 2 * 1024 * 1024, // 2 MB
            file_count: 1,
            issues: vec![],
        };
        let summary = healthy.summary();
        assert!(summary.contains("完整"), "健康报告应包含 '完整'");
        assert!(summary.contains("1 个数据库文件"), "应显示数据库文件数");

        let unhealthy = SlotIntegrityReport {
            slot: "slotB".to_string(),
            dir_path: "/test".to_string(),
            exists: false,
            has_data: false,
            has_database: false,
            database_files: vec![],
            subdirectories: vec![],
            total_size_bytes: 0,
            file_count: 0,
            issues: vec!["插槽目录不存在".to_string()],
        };
        let summary = unhealthy.summary();
        assert!(summary.contains("异常"), "异常报告应包含 '异常'");
        assert!(summary.contains("不存在"), "应显示具体问题");
    }
}

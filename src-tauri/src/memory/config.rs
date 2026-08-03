use rusqlite::params;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::types::VfsFolder;

const CONFIG_KEY_ROOT_FOLDER_ID: &str = "memory_root_folder_id";
const CONFIG_KEY_AUTO_CREATE_SUBFOLDERS: &str = "auto_create_subfolders";
const CONFIG_KEY_DEFAULT_CATEGORY: &str = "default_category";
const CONFIG_KEY_PRIVACY_MODE: &str = "privacy_mode";
const CONFIG_KEY_AUTO_EXTRACT_FREQUENCY: &str = "auto_extract_frequency";

// ---- evolution 生命周期阈值（memory_config KV，可调；缺失/非法时取默认值） ----
/// 搜索命中活跃窗口（天）：距 `_last_hit` 不超过该天数视为活跃，不参与 stale 降级
const CONFIG_KEY_EVOLUTION_STALE_HIT_DAYS: &str = "evolution_stale_hit_days";
/// 注入在场保护窗口（天）：无搜索命中但距 `_last_injected` 不超过该天数时受在场保护。
/// 大于命中窗口——"被塞进 prompt"是弱于"被搜索命中"的信号，仅提供有限期保护，
/// 避免分类聚合成员因每轮注入刷新 `_last_injected` 而永不衰老。
const CONFIG_KEY_EVOLUTION_STALE_INJECTED_DAYS: &str = "evolution_stale_injected_days";
/// stale 命中数门槛：累计命中数（`_hits`）达到该值的记忆不参与 stale 降级
/// 与休眠归档（历史证明过价值的记忆只按时效降权，不打 `_stale`/`_archived`）
const CONFIG_KEY_EVOLUTION_STALE_MIN_HITS: &str = "evolution_stale_min_hits";
/// stale 后归档等待期（天）：已 stale 的记忆在信号超期基础上再无活跃信号
/// 持续该天数后自动归档（打 `_archived` + 移出检索索引，笔记本体保留可恢复）
const CONFIG_KEY_EVOLUTION_ARCHIVE_AFTER_STALE_DAYS: &str = "evolution_archive_after_stale_days";
/// 分类配额：单个分类文件夹的活跃（非 stale/非归档）记忆预算，
/// 超限时 evolution 先跑溢出合并，仍超限则按"最弱优先"归档超出部分
const CONFIG_KEY_EVOLUTION_CATEGORY_QUOTA: &str = "evolution_category_quota";
/// 语义去重每轮 LLM 判定预算：semantic_dedup pass 一轮最多送多少对候选进
/// LLM 判定（成本控制；0 表示关闭语义去重，另受进程内硬上限兜底）
const CONFIG_KEY_EVOLUTION_SEMANTIC_MERGE_MAX_PAIRS: &str = "evolution_semantic_merge_max_pairs";
/// 语义去重相似度预筛门槛：相似检索得分低于该值的候选不送 LLM 判定
/// （搜索分数为"相对 top-1 归一 × 标签权重 × 时间衰减"，宽松预筛即可）
const CONFIG_KEY_EVOLUTION_SEMANTIC_MERGE_MIN_SCORE: &str = "evolution_semantic_merge_min_score";
/// 语义去重节流间隔（分钟）：semantic_dedup pass 的常规档执行间隔;
/// aggressive 档取其 1/3（下限 30 分钟）
const CONFIG_KEY_EVOLUTION_SEMANTIC_DEDUP_INTERVAL_MINUTES: &str =
    "evolution_semantic_dedup_interval_minutes";

/// 双阈值默认值：距 `_last_hit` 90 天内视为活跃（沿用原 stale 阈值）
const DEFAULT_EVOLUTION_STALE_HIT_DAYS: i64 = 90;
/// 双阈值默认值：距 `_last_injected` 180 天内视为在场保护
const DEFAULT_EVOLUTION_STALE_INJECTED_DAYS: i64 = 180;
/// 默认命中数门槛：累计命中 2 次及以上不参与 stale 降级（沿用原常量）
const DEFAULT_EVOLUTION_STALE_MIN_HITS: u32 = 2;
/// 默认 stale 后再 90 天无信号即归档
const DEFAULT_EVOLUTION_ARCHIVE_AFTER_STALE_DAYS: i64 = 90;
/// 默认单分类活跃记忆预算 50 条
const DEFAULT_EVOLUTION_CATEGORY_QUOTA: usize = 50;
/// 默认每轮最多 3 对候选送 LLM 判定
const DEFAULT_EVOLUTION_SEMANTIC_MERGE_MAX_PAIRS: usize = 3;
/// 默认相似度预筛门槛 0.35（分数是相对归一分，非余弦相似度）
const DEFAULT_EVOLUTION_SEMANTIC_MERGE_MIN_SCORE: f32 = 0.35;
/// 默认语义去重间隔 360 分钟（6 小时;aggressive 档 = 1/3 即 2 小时，维持原常量行为）
const DEFAULT_EVOLUTION_SEMANTIC_DEDUP_INTERVAL_MINUTES: i64 = 360;

const DEFAULT_FOLDER_TITLE: &str = "记忆";

/// 自动提取频率档位
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoExtractFrequency {
    /// 仅关闭对话后的自动提取；已有记忆的生命周期管理（evolution/晋升）照常运行
    Off,
    /// 平衡模式（默认）：每轮对话提取，内容门槛 10 字符
    Balanced,
    /// 积极模式：降低门槛（4 字符），更频繁的分类刷新和自进化
    Aggressive,
}

impl AutoExtractFrequency {
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "off" => Self::Off,
            "balanced" => Self::Balanced,
            "aggressive" => Self::Aggressive,
            other => {
                warn!(
                    "[Memory::Config] Unknown auto_extract_frequency '{}', defaulting to Balanced",
                    other
                );
                Self::Balanced
            }
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Balanced => "balanced",
            Self::Aggressive => "aggressive",
        }
    }

    /// 内容最短门槛（字符数），低于此值的对话不触发提取
    pub fn content_min_chars(&self) -> usize {
        match self {
            Self::Off => usize::MAX,
            Self::Balanced => 10,
            Self::Aggressive => 4,
        }
    }

    /// 分类刷新条件：给定记忆总数，是否应刷新分类文件
    pub fn should_refresh_categories(&self, total_memories: usize) -> bool {
        match self {
            Self::Off => false,
            Self::Balanced => total_memories <= 5 || total_memories.is_multiple_of(5),
            Self::Aggressive => true,
        }
    }

    /// 自进化周期间隔（毫秒）——同时作为"日志→画像"晋升 pass 的间隔
    ///
    /// off 档不再返回 `i64::MAX` 使生命周期管理停摆：off 的语义只是
    /// "关闭对话后的自动提取"（见 `content_min_chars`/`should_refresh_categories`），
    /// 已有记忆的整理（stale/important/溢出合并）与画像晋升仍按保守的
    /// 24 小时间隔照常运行。
    pub fn evolution_interval_ms(&self) -> i64 {
        match self {
            Self::Off => 24 * 60 * 60 * 1000,
            Self::Balanced => 30 * 60 * 1000,
            Self::Aggressive => 15 * 60 * 1000,
        }
    }
}

/// evolution 生命周期调优参数快照（语义见 `CONFIG_KEY_EVOLUTION_*` 常量注释）
#[derive(Debug, Clone, Copy)]
pub struct EvolutionTuning {
    /// 距 `_last_hit` 视为活跃的天数（默认 90）
    pub stale_hit_days: i64,
    /// 距 `_last_injected` 视为在场保护的天数（默认 180）
    pub stale_injected_days: i64,
    /// 命中数门槛（默认 2）：累计 `_hits` 达到该值不参与 stale 降级/休眠归档
    pub stale_min_hits: u32,
    /// stale 且信号继续超期该天数后自动归档（默认再 90 天）
    pub archive_after_stale_days: i64,
    /// 单分类文件夹活跃记忆预算（默认 50）
    pub category_quota: usize,
    /// 语义去重每轮 LLM 判定对数预算（默认 3；0 表示关闭语义去重）
    pub semantic_merge_max_pairs: usize,
    /// 语义去重相似度预筛门槛（默认 0.35，相对归一分）
    pub semantic_merge_min_score: f32,
    /// 语义去重节流间隔（分钟，默认 360；aggressive 档取 1/3、下限 30 分钟）
    pub semantic_dedup_interval_minutes: i64,
}

#[derive(Clone)]
pub struct MemoryConfig {
    db: Arc<VfsDatabase>,
}

impl MemoryConfig {
    pub fn new(db: Arc<VfsDatabase>) -> Self {
        Self { db }
    }

    pub fn get(&self, key: &str) -> VfsResult<Option<String>> {
        let conn = self.db.get_conn_safe()?;
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM memory_config WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .ok();
        Ok(value.filter(|v| !v.is_empty()))
    }

    pub fn set(&self, key: &str, value: &str) -> VfsResult<()> {
        let conn = self.db.get_conn_safe()?;
        conn.execute(
            "INSERT OR REPLACE INTO memory_config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))",
            params![key, value],
        )?;
        debug!("[Memory::Config] Set {} = {}", key, value);
        Ok(())
    }

    pub fn get_root_folder_id(&self) -> VfsResult<Option<String>> {
        self.get(CONFIG_KEY_ROOT_FOLDER_ID)
    }

    pub fn set_root_folder_id(&self, folder_id: &str) -> VfsResult<()> {
        self.set(CONFIG_KEY_ROOT_FOLDER_ID, folder_id)
    }

    pub fn get_or_create_root_folder(&self) -> VfsResult<String> {
        if let Some(folder_id) = self.get_root_folder_id()? {
            if VfsFolderRepo::folder_exists(&self.db, &folder_id)? {
                debug!("[Memory::Config] Using existing root folder: {}", folder_id);
                return Ok(folder_id);
            }
            warn!(
                "[Memory::Config] Configured folder {} not found, creating new one",
                folder_id
            );
        }

        // J8a 修复：memory_config 是 BackupOnly（不跨设备同步），而 folders/notes 走
        // RowSync。第二台设备本地 config 无值时若直接新建根文件夹，会与已同步过来的
        // 原根分叉（双方记忆经 is_note_in_memory_root 过滤后互不可见）。因此新建前
        // 先探测并认领已同步过来的记忆根。仅 config 无值/失效时走到这里，常规路径不受影响。
        if let Some(synced_root_id) = self.find_synced_memory_root()? {
            self.set_root_folder_id(&synced_root_id)?;
            info!(
                "[Memory::Config] Claimed synced memory root folder: {}",
                synced_root_id
            );
            return Ok(synced_root_id);
        }

        let folder = VfsFolder::new(DEFAULT_FOLDER_TITLE.to_string(), None, None, None);
        VfsFolderRepo::create_folder(&self.db, &folder)?;
        self.set_root_folder_id(&folder.id)?;
        info!(
            "[Memory::Config] Created default memory folder: {} ({})",
            DEFAULT_FOLDER_TITLE, folder.id
        );
        Ok(folder.id)
    }

    /// 探测"已通过 RowSync 同步过来的记忆根"（J8a）。
    ///
    /// 算法：找出包含记忆系统保留笔记（标题匹配 `__cat_*` / `__daily_log_*` /
    /// `__user_profile__` / `__learner_profile*`）的文件夹，以及 `__system__`
    /// 文件夹本身，沿 parent_id 爬到各自的顶层根（parent_id IS NULL，记忆根
    /// 始终建在顶层），按根聚合记忆笔记数：
    /// - 无候选 → None（调用方新建根）；
    /// - 唯一候选 → 认领它；
    /// - 多个候选（说明两台设备已经分叉出多个根）→ 选记忆笔记数最多的为主根
    ///   并 warn；自动合并多个根超出本修复范围，其余根保持原样。
    ///
    /// 代价：一次带递归 CTE 的只读查询（notes 按标题过滤 + 沿祖先链上爬），
    /// 只在 config 无值或已配置根不存在时执行，不影响常规读取路径。
    fn find_synced_memory_root(&self) -> VfsResult<Option<String>> {
        let conn = self.db.get_conn_safe()?;
        // climb 使用 UNION（而非 UNION ALL）去重，防御 parent_id 环导致的死循环
        let mut stmt = conn.prepare(
            r#"
            WITH RECURSIVE marker(folder_id, note_count) AS (
                SELECT fi.folder_id, COUNT(*)
                FROM notes n
                JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
                WHERE n.deleted_at IS NULL AND fi.deleted_at IS NULL
                  AND (n.title LIKE '\_\_cat\_%' ESCAPE '\'
                    OR n.title LIKE '\_\_daily\_log\_%' ESCAPE '\'
                    OR n.title LIKE '\_\_user\_profile\_\_%' ESCAPE '\'
                    OR n.title LIKE '\_\_learner\_profile%' ESCAPE '\')
                GROUP BY fi.folder_id
                UNION ALL
                SELECT f.id, 0
                FROM folders f
                WHERE f.deleted_at IS NULL AND f.title = '__system__'
            ),
            climb(marker_folder_id, folder_id, parent_id, note_count) AS (
                SELECT m.folder_id, f.id, f.parent_id, m.note_count
                FROM marker m
                JOIN folders f ON f.id = m.folder_id AND f.deleted_at IS NULL
                UNION
                SELECT c.marker_folder_id, f.id, f.parent_id, c.note_count
                FROM climb c
                JOIN folders f ON f.id = c.parent_id AND f.deleted_at IS NULL
            )
            SELECT folder_id, SUM(note_count) AS memory_note_count
            FROM climb
            WHERE parent_id IS NULL
            GROUP BY folder_id
            ORDER BY memory_note_count DESC, folder_id ASC
            "#,
        )?;
        let candidates: Vec<(String, i64)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;

        match candidates.as_slice() {
            [] => Ok(None),
            [(root_id, note_count)] => {
                debug!(
                    "[Memory::Config] Found synced memory root candidate {} ({} memory notes)",
                    root_id, note_count
                );
                Ok(Some(root_id.clone()))
            }
            multiple => {
                // 已分叉：多台设备各建过根。选记忆笔记数最多的为主根，其余不动。
                warn!(
                    "[Memory::Config] 检测到 {} 个记忆根候选（设备间已分叉），选记忆笔记数最多的为主根；\
                     其余根中的记忆不会自动合并，候选: {:?}",
                    multiple.len(),
                    multiple
                );
                Ok(Some(multiple[0].0.clone()))
            }
        }
    }

    pub fn create_root_folder(&self, title: &str) -> VfsResult<String> {
        let folder = VfsFolder::new(title.to_string(), None, None, None);
        VfsFolderRepo::create_folder(&self.db, &folder)?;
        self.set_root_folder_id(&folder.id)?;
        info!(
            "[Memory::Config] Created memory root folder: {} ({})",
            title, folder.id
        );
        Ok(folder.id)
    }

    pub fn get_root_folder_title(&self) -> VfsResult<Option<String>> {
        if let Some(folder_id) = self.get_root_folder_id()? {
            if let Some(folder) = VfsFolderRepo::get_folder(&self.db, &folder_id)? {
                return Ok(Some(folder.title));
            }
        }
        Ok(None)
    }

    pub fn is_auto_create_subfolders(&self) -> VfsResult<bool> {
        Ok(self
            .get(CONFIG_KEY_AUTO_CREATE_SUBFOLDERS)?
            .map(|v| v == "true")
            .unwrap_or(true))
    }

    pub fn is_privacy_mode(&self) -> VfsResult<bool> {
        Ok(self
            .get(CONFIG_KEY_PRIVACY_MODE)?
            .map(|v| v == "true")
            .unwrap_or(false))
    }

    pub fn set_privacy_mode(&self, enabled: bool) -> VfsResult<()> {
        self.set(
            CONFIG_KEY_PRIVACY_MODE,
            if enabled { "true" } else { "false" },
        )
    }

    pub fn get_default_category(&self) -> VfsResult<String> {
        Ok(self
            .get(CONFIG_KEY_DEFAULT_CATEGORY)?
            .unwrap_or_else(|| "通用".to_string()))
    }

    pub fn set_auto_create_subfolders(&self, enabled: bool) -> VfsResult<()> {
        self.set(
            CONFIG_KEY_AUTO_CREATE_SUBFOLDERS,
            if enabled { "true" } else { "false" },
        )
    }

    pub fn set_default_category(&self, category: &str) -> VfsResult<()> {
        self.set(CONFIG_KEY_DEFAULT_CATEGORY, category)
    }

    /// 读取可解析配置值；缺失或解析失败时回退默认值（带 warn 日志）
    fn get_parsed_or<T: std::str::FromStr + Copy>(&self, key: &str, default: T) -> T {
        match self.get(key) {
            Ok(Some(raw)) => raw.trim().parse::<T>().unwrap_or_else(|_| {
                warn!(
                    "[Memory::Config] Invalid value '{}' for {}, using default",
                    raw, key
                );
                default
            }),
            _ => default,
        }
    }

    /// 加载 evolution 生命周期调优参数（每轮周期读一次，见各常量注释）
    pub fn get_evolution_tuning(&self) -> EvolutionTuning {
        EvolutionTuning {
            stale_hit_days: self
                .get_parsed_or(
                    CONFIG_KEY_EVOLUTION_STALE_HIT_DAYS,
                    DEFAULT_EVOLUTION_STALE_HIT_DAYS,
                )
                .max(1),
            stale_injected_days: self
                .get_parsed_or(
                    CONFIG_KEY_EVOLUTION_STALE_INJECTED_DAYS,
                    DEFAULT_EVOLUTION_STALE_INJECTED_DAYS,
                )
                .max(1),
            stale_min_hits: self.get_parsed_or(
                CONFIG_KEY_EVOLUTION_STALE_MIN_HITS,
                DEFAULT_EVOLUTION_STALE_MIN_HITS,
            ),
            archive_after_stale_days: self
                .get_parsed_or(
                    CONFIG_KEY_EVOLUTION_ARCHIVE_AFTER_STALE_DAYS,
                    DEFAULT_EVOLUTION_ARCHIVE_AFTER_STALE_DAYS,
                )
                .max(1),
            category_quota: self
                .get_parsed_or(
                    CONFIG_KEY_EVOLUTION_CATEGORY_QUOTA,
                    DEFAULT_EVOLUTION_CATEGORY_QUOTA,
                )
                .max(1),
            semantic_merge_max_pairs: self.get_parsed_or(
                CONFIG_KEY_EVOLUTION_SEMANTIC_MERGE_MAX_PAIRS,
                DEFAULT_EVOLUTION_SEMANTIC_MERGE_MAX_PAIRS,
            ),
            semantic_merge_min_score: self
                .get_parsed_or(
                    CONFIG_KEY_EVOLUTION_SEMANTIC_MERGE_MIN_SCORE,
                    DEFAULT_EVOLUTION_SEMANTIC_MERGE_MIN_SCORE,
                )
                .clamp(0.0, 1.0),
            semantic_dedup_interval_minutes: self
                .get_parsed_or(
                    CONFIG_KEY_EVOLUTION_SEMANTIC_DEDUP_INTERVAL_MINUTES,
                    DEFAULT_EVOLUTION_SEMANTIC_DEDUP_INTERVAL_MINUTES,
                )
                .max(30),
        }
    }

    pub fn get_auto_extract_frequency(&self) -> VfsResult<AutoExtractFrequency> {
        Ok(self
            .get(CONFIG_KEY_AUTO_EXTRACT_FREQUENCY)?
            .map(|v| AutoExtractFrequency::from_str_lossy(&v))
            .unwrap_or(AutoExtractFrequency::Balanced))
    }

    pub fn set_auto_extract_frequency(&self, frequency: AutoExtractFrequency) -> VfsResult<()> {
        self.set(CONFIG_KEY_AUTO_EXTRACT_FREQUENCY, frequency.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_key_constants() {
        assert_eq!(CONFIG_KEY_ROOT_FOLDER_ID, "memory_root_folder_id");
        assert_eq!(CONFIG_KEY_AUTO_CREATE_SUBFOLDERS, "auto_create_subfolders");
        assert_eq!(CONFIG_KEY_DEFAULT_CATEGORY, "default_category");
        assert_eq!(CONFIG_KEY_PRIVACY_MODE, "privacy_mode");
        assert_eq!(CONFIG_KEY_AUTO_EXTRACT_FREQUENCY, "auto_extract_frequency");
        assert_eq!(DEFAULT_FOLDER_TITLE, "记忆");
    }

    #[test]
    fn test_evolution_tuning_key_constants_and_defaults() {
        assert_eq!(
            CONFIG_KEY_EVOLUTION_STALE_HIT_DAYS,
            "evolution_stale_hit_days"
        );
        assert_eq!(
            CONFIG_KEY_EVOLUTION_STALE_INJECTED_DAYS,
            "evolution_stale_injected_days"
        );
        assert_eq!(
            CONFIG_KEY_EVOLUTION_ARCHIVE_AFTER_STALE_DAYS,
            "evolution_archive_after_stale_days"
        );
        assert_eq!(
            CONFIG_KEY_EVOLUTION_CATEGORY_QUOTA,
            "evolution_category_quota"
        );
        assert_eq!(
            CONFIG_KEY_EVOLUTION_SEMANTIC_MERGE_MAX_PAIRS,
            "evolution_semantic_merge_max_pairs"
        );
        assert_eq!(
            CONFIG_KEY_EVOLUTION_SEMANTIC_MERGE_MIN_SCORE,
            "evolution_semantic_merge_min_score"
        );
        assert_eq!(
            CONFIG_KEY_EVOLUTION_STALE_MIN_HITS,
            "evolution_stale_min_hits"
        );
        // 在场保护窗口必须长于命中活跃窗口（在场是弱信号，只给更宽限的保护期）
        assert!(DEFAULT_EVOLUTION_STALE_INJECTED_DAYS > DEFAULT_EVOLUTION_STALE_HIT_DAYS);
        assert_eq!(DEFAULT_EVOLUTION_STALE_MIN_HITS, 2);
        assert_eq!(DEFAULT_EVOLUTION_ARCHIVE_AFTER_STALE_DAYS, 90);
        assert_eq!(DEFAULT_EVOLUTION_CATEGORY_QUOTA, 50);
        assert_eq!(DEFAULT_EVOLUTION_SEMANTIC_MERGE_MAX_PAIRS, 3);
        assert!(DEFAULT_EVOLUTION_SEMANTIC_MERGE_MIN_SCORE > 0.0);
    }

    #[test]
    fn test_auto_extract_frequency() {
        assert_eq!(
            AutoExtractFrequency::from_str_lossy("off"),
            AutoExtractFrequency::Off
        );
        assert_eq!(
            AutoExtractFrequency::from_str_lossy("balanced"),
            AutoExtractFrequency::Balanced
        );
        assert_eq!(
            AutoExtractFrequency::from_str_lossy("aggressive"),
            AutoExtractFrequency::Aggressive
        );
        assert_eq!(
            AutoExtractFrequency::from_str_lossy("unknown"),
            AutoExtractFrequency::Balanced
        );
        assert_eq!(AutoExtractFrequency::Off.as_str(), "off");
        assert_eq!(AutoExtractFrequency::Balanced.content_min_chars(), 10);
        assert_eq!(AutoExtractFrequency::Aggressive.content_min_chars(), 4);
        // off 档只关自动提取，生命周期管理（evolution/晋升）按 24h 保守间隔运行
        assert_eq!(
            AutoExtractFrequency::Off.evolution_interval_ms(),
            24 * 60 * 60 * 1000
        );
        assert_eq!(
            AutoExtractFrequency::Balanced.evolution_interval_ms(),
            30 * 60 * 1000
        );
        assert!(AutoExtractFrequency::Aggressive.should_refresh_categories(3));
        assert!(!AutoExtractFrequency::Balanced.should_refresh_categories(7));
        assert!(AutoExtractFrequency::Balanced.should_refresh_categories(10));
    }
}

//! # 迁移脚本静态检查器
//!
//! 在编译/测试时对 SQL 迁移脚本进行反模式检测，
//! 确保脚本符合健壮性设计规范。
//!
//! ## 设计原则
//!
//! - **静态检查**：只分析 SQL 文本，不依赖数据库状态
//! - **一过性**：脚本修改通过后不会再阻塞
//! - **可配置**：支持跳过特定规则（通过注释标记）
//!
//! ## 检测的反模式
//!
//! 1. 表重建缺少中间状态清理
//! 2. 非幂等的 CREATE TABLE 语句
//! 3. 添加外键约束前未清理孤儿数据
//! 4. 非幂等的 DROP TABLE 语句
//! 5. 非幂等的 CREATE INDEX 语句
//! 6. 缺少必要的注释说明

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

// ============================================================================
// 预编译正则表达式（性能优化）
// ============================================================================

/// CREATE TABLE xxx_new 模式
static RE_CREATE_NEW_TABLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)CREATE\s+TABLE\s+(\w+_NEW)\s*\(").unwrap());

/// CREATE TABLE 语句（所有）
static RE_ALL_CREATES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"CREATE\s+TABLE\s+(\w+)\s*\(").unwrap());

/// CREATE TABLE IF NOT EXISTS
static RE_SAFE_CREATES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)").unwrap());

/// FOREIGN KEY 定义
static RE_FOREIGN_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"FOREIGN\s+KEY\s*\(\s*(\w+)\s*\)\s*REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)").unwrap()
});

/// DROP TABLE 语句（所有）
static RE_ALL_DROPS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"DROP\s+TABLE\s+(\w+)").unwrap());

/// DROP TABLE IF EXISTS
static RE_SAFE_DROPS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"DROP\s+TABLE\s+IF\s+EXISTS\s+(\w+)").unwrap());

/// CREATE INDEX 语句（所有）
static RE_ALL_INDEXES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)\s+ON").unwrap());

/// CREATE INDEX IF NOT EXISTS
static RE_SAFE_INDEXES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)").unwrap()
});

/// 检查结果
#[derive(Debug, Clone)]
pub struct CheckResult {
    /// 是否通过
    pub passed: bool,
    /// 警告列表
    pub warnings: Vec<CheckWarning>,
    /// 错误列表
    pub errors: Vec<CheckError>,
}

impl CheckResult {
    fn new() -> Self {
        Self {
            passed: true,
            warnings: Vec::new(),
            errors: Vec::new(),
        }
    }

    fn add_warning(&mut self, warning: CheckWarning) {
        self.warnings.push(warning);
    }

    fn add_error(&mut self, error: CheckError) {
        self.passed = false;
        self.errors.push(error);
    }
}

/// 检查警告
#[derive(Debug, Clone)]
pub struct CheckWarning {
    pub rule: &'static str,
    pub message: String,
    pub suggestion: String,
}

/// 检查错误
#[derive(Debug, Clone)]
pub struct CheckError {
    pub rule: &'static str,
    pub message: String,
    pub suggestion: String,
}

/// 迁移脚本检查器
pub struct MigrationScriptChecker {
    /// 跳过的规则（通过脚本中的 `-- @skip-check: rule_name` 标记）
    skipped_rules: HashSet<String>,
}

impl MigrationScriptChecker {
    /// 创建新的检查器
    pub fn new() -> Self {
        Self {
            skipped_rules: HashSet::new(),
        }
    }

    /// 检查迁移脚本
    ///
    /// ## 参数
    /// - `script_name`: 脚本名称（用于错误消息）
    /// - `sql`: SQL 脚本内容
    ///
    /// ## 返回
    /// - `CheckResult`: 检查结果
    pub fn check(&mut self, script_name: &str, sql: &str) -> CheckResult {
        let mut result = CheckResult::new();

        // 解析跳过规则标记
        self.parse_skip_markers(sql);

        // 标准化 SQL（移除注释用于模式匹配）
        let normalized = self.normalize_sql(sql);

        // 检测是否是 init 脚本（初始化脚本创建全新数据库，规则不同）
        // 精确匹配：必须以 __init 结尾或包含 :init（如 vfs:init）
        let is_init_script = script_name.ends_with("__init")
            || script_name.ends_with("__init.sql")
            || script_name.contains(":init");

        // 规则 1: 表重建必须先清理中间状态
        // 注意：init 脚本是创建全新数据库，不需要此检查
        if !self.is_skipped("table_rebuild_cleanup") && !is_init_script {
            self.check_table_rebuild_cleanup(script_name, &normalized, sql, &mut result);
        }

        // 规则 2: CREATE TABLE 应使用 IF NOT EXISTS（临时表除外）
        // 注意：init 脚本是创建全新数据库，不需要幂等（只会执行一次）
        if !self.is_skipped("idempotent_create") && !is_init_script {
            self.check_idempotent_create(script_name, &normalized, &mut result);
        }

        // 规则 3: 添加外键约束前应清理孤儿数据
        // 注意：init 脚本是创建全新数据库，不存在孤儿数据问题
        if !self.is_skipped("fk_orphan_cleanup") && !is_init_script {
            self.check_fk_orphan_cleanup(script_name, &normalized, sql, &mut result);
        }

        // 规则 4: DROP TABLE 应使用 IF EXISTS
        // 注意：init 脚本是创建全新数据库，不需要幂等
        if !self.is_skipped("idempotent_drop") && !is_init_script {
            self.check_idempotent_drop(script_name, &normalized, &mut result);
        }

        // 规则 5: CREATE INDEX 应使用 IF NOT EXISTS
        // 注意：init 脚本是创建全新数据库，不需要幂等
        if !self.is_skipped("idempotent_index") && !is_init_script {
            self.check_idempotent_index(script_name, &normalized, &mut result);
        }

        result
    }

    /// 解析跳过规则标记
    fn parse_skip_markers(&mut self, sql: &str) {
        self.skipped_rules.clear();
        for line in sql.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("-- @skip-check:") {
                let rule = trimmed.trim_start_matches("-- @skip-check:").trim();
                self.skipped_rules.insert(rule.to_string());
            }
        }
    }

    /// 检查规则是否被跳过
    fn is_skipped(&self, rule: &str) -> bool {
        self.skipped_rules.contains(rule) || self.skipped_rules.contains("all")
    }

    /// 标准化 SQL（移除注释，转为大写）
    fn normalize_sql(&self, sql: &str) -> String {
        let mut result = String::new();
        let mut in_block_comment = false;

        for line in sql.lines() {
            let mut chars = line.chars().peekable();
            let mut line_result = String::new();

            while let Some(c) = chars.next() {
                if in_block_comment {
                    if c == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        in_block_comment = false;
                    }
                } else if c == '-' && chars.peek() == Some(&'-') {
                    // 单行注释，跳过剩余行
                    break;
                } else if c == '/' && chars.peek() == Some(&'*') {
                    chars.next();
                    in_block_comment = true;
                } else {
                    line_result.push(c);
                }
            }

            if !line_result.trim().is_empty() {
                result.push_str(&line_result);
                result.push('\n');
            }
        }

        result.to_uppercase()
    }

    /// 规则 1: 表重建必须先清理中间状态
    ///
    /// 检测模式：如果有 `CREATE TABLE xxx_new`，必须先有 `DROP TABLE IF EXISTS xxx_new`
    fn check_table_rebuild_cleanup(
        &self,
        script_name: &str,
        normalized: &str,
        original: &str,
        result: &mut CheckResult,
    ) {
        // 使用预编译正则表达式查找所有 CREATE TABLE xxx_new 模式
        for cap in RE_CREATE_NEW_TABLE.captures_iter(normalized) {
            let table_name = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let table_name_lower = table_name.to_lowercase(); // 用于显示更友好的错误消息

            // 检查是否有对应的 DROP TABLE IF EXISTS
            // 使用字符串匹配而非动态编译正则（性能优化）
            let drop_pattern_upper = format!("DROP TABLE IF EXISTS {}", table_name);
            let has_cleanup = normalized.contains(&drop_pattern_upper);

            if !has_cleanup {
                // 检查原始脚本中是否已有 STEP 0 注释说明
                let has_step0_comment =
                    original.contains("STEP 0") || original.contains("中间状态清理");

                if has_step0_comment {
                    result.add_warning(CheckWarning {
                        rule: "table_rebuild_cleanup",
                        message: format!(
                            "[{}] 创建了临时表 {} 但未找到对应的 DROP TABLE IF EXISTS",
                            script_name, table_name_lower
                        ),
                        suggestion: format!(
                            "在脚本开头添加: DROP TABLE IF EXISTS {};",
                            table_name_lower
                        ),
                    });
                } else {
                    result.add_error(CheckError {
                        rule: "table_rebuild_cleanup",
                        message: format!(
                            "[{}] 创建了临时表 {} 但未先清理中间状态",
                            script_name, table_name_lower
                        ),
                        suggestion: format!(
                            "在脚本开头添加:\n-- STEP 0: 中间状态清理\nDROP TABLE IF EXISTS {};",
                            table_name_lower
                        ),
                    });
                }
            }
        }
    }

    /// 规则 2: CREATE TABLE 应使用 IF NOT EXISTS
    ///
    /// 例外：用于表重建的 `xxx_new` 表可以使用普通 CREATE TABLE
    /// （因为前面已经有 DROP TABLE IF EXISTS）
    fn check_idempotent_create(
        &self,
        script_name: &str,
        normalized: &str,
        result: &mut CheckResult,
    ) {
        // 使用预编译正则表达式收集安全的表名
        let safe_tables: HashSet<String> = RE_SAFE_CREATES
            .captures_iter(normalized)
            .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
            .collect();

        for cap in RE_ALL_CREATES.captures_iter(normalized) {
            let table_name = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let table_name_lower = table_name.to_lowercase();

            // 跳过 _new 结尾的临时表（表重建模式）
            if table_name.ends_with("_NEW") {
                continue;
            }

            // 跳过已经使用 IF NOT EXISTS 的表
            if safe_tables.contains(table_name) {
                continue;
            }

            result.add_warning(CheckWarning {
                rule: "idempotent_create",
                message: format!(
                    "[{}] CREATE TABLE {} 未使用 IF NOT EXISTS，可能导致重复执行失败",
                    script_name, table_name_lower
                ),
                suggestion: format!(
                    "改为: CREATE TABLE IF NOT EXISTS {} (...)",
                    table_name_lower
                ),
            });
        }
    }

    /// 规则 3: 添加外键约束前应清理孤儿数据
    ///
    /// 检测模式：如果有 `FOREIGN KEY (col) REFERENCES parent(id)`，
    /// 应该在前面有清理孤儿数据的逻辑，支持多种写法：
    /// - `DELETE FROM ... WHERE col NOT IN (SELECT ...)`
    /// - `DELETE FROM ... WHERE NOT EXISTS (...)`
    /// - 或者有明确的注释说明
    ///
    /// 例外：**全新表**（非 `xxx_new` 重建表）的内联外键不需要孤儿清理——
    /// 表刚创建时没有任何数据，不存在孤儿。该规则只对表重建
    /// （给已有数据补加外键约束）场景有意义。
    fn check_fk_orphan_cleanup(
        &self,
        script_name: &str,
        normalized: &str,
        original: &str,
        result: &mut CheckResult,
    ) {
        // 收集所有 CREATE TABLE 语句的（列定义体起止位置, 表名），
        // 用于把每个 FOREIGN KEY 归属到**包含它的** CREATE TABLE 体内。
        // 注意 RE_ALL_CREATES 不匹配 IF NOT EXISTS 形式，需两个正则合并。
        // 仅按"最近的前一个 CREATE"归属是不够的：FK 文本可能出现在表体
        // 之外（如后续 ALTER/触发器/独立语句），那种情况不应被当作
        // 全新表内联 FK 而误豁免孤儿清理检查。
        let mut creates: Vec<(usize, usize, String)> = RE_ALL_CREATES
            .captures_iter(normalized)
            .chain(RE_SAFE_CREATES.captures_iter(normalized))
            .filter_map(|cap| {
                let m = cap.get(0)?;
                let name = cap.get(1)?.as_str().to_string();
                // 定位表体起始的左括号（RE_SAFE_CREATES 不含括号，需向后找）
                let open = normalized[m.start()..].find('(')? + m.start();
                let body_end =
                    Self::find_matching_paren(normalized, open).unwrap_or(normalized.len());
                Some((open, body_end, name))
            })
            .collect();
        creates.sort_by_key(|(open, _, _)| *open);

        // 使用预编译正则表达式查找外键定义
        for cap in RE_FOREIGN_KEY.captures_iter(normalized) {
            // 找到表体真正包含该 FK 的 CREATE TABLE（取最内层/最近者）
            let fk_pos = cap.get(0).map(|m| m.start()).unwrap_or(0);
            let owner_table = creates
                .iter()
                .filter(|(open, end, _)| fk_pos > *open && fk_pos < *end)
                .last()
                .map(|(_, _, name)| name.as_str());

            // 全新表（非 _NEW 重建表）的内联 FK：无孤儿数据风险，跳过。
            // 未归属到任何表体的 FK 不豁免，继续走清理检查（fail-close）。
            if let Some(owner) = owner_table {
                if !owner.ends_with("_NEW") {
                    continue;
                }
            }

            let child_col = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let parent_table = cap.get(2).map(|m| m.as_str()).unwrap_or("");
            let child_col_lower = child_col.to_lowercase();
            let parent_table_lower = parent_table.to_lowercase();

            // 检查是否有清理孤儿数据的逻辑（支持多种写法）
            // 1. DELETE ... WHERE col NOT IN (SELECT ... FROM parent)
            let has_not_in_cleanup = normalized.contains(&format!("{} NOT IN", child_col))
                && normalized.contains(&format!("FROM {}", parent_table));

            // 2. DELETE ... WHERE NOT EXISTS (SELECT ... FROM parent WHERE ...)
            let has_not_exists_cleanup = normalized.contains("NOT EXISTS")
                && normalized.contains(&format!("FROM {}", parent_table));

            // 3. 检查是否有明确的数据完整性修复注释
            let has_cleanup_comment = original.contains("STEP 1")
                || original.contains("数据完整性")
                || original.contains("孤儿")
                || original.contains("orphan");

            if has_not_in_cleanup || has_not_exists_cleanup {
                // 找到了清理逻辑，通过
                continue;
            }

            if has_cleanup_comment {
                // 有注释但没找到对应的清理逻辑，可能是其他方式处理
                result.add_warning(CheckWarning {
                    rule: "fk_orphan_cleanup",
                    message: format!(
                        "[{}] 添加了外键约束 {}.{} -> {}，请确保已清理孤儿数据",
                        script_name, "table", child_col_lower, parent_table_lower
                    ),
                    suggestion: "确保在 STEP 1 中有清理孤儿数据的逻辑".to_string(),
                });
            } else {
                result.add_error(CheckError {
                    rule: "fk_orphan_cleanup",
                    message: format!(
                        "[{}] 添加了外键约束但未清理可能存在的孤儿数据",
                        script_name
                    ),
                    suggestion: format!(
                        "在创建表之前添加:\n-- STEP 1: 数据完整性修复\nDELETE FROM <child_table> WHERE {} NOT IN (SELECT id FROM {});",
                        child_col_lower, parent_table_lower
                    ),
                });
            }
        }
    }

    /// 从 `open` 处的 `(` 起做括号配平，返回匹配的 `)` 位置。
    /// 用于界定 CREATE TABLE 列定义体的范围（normalized 已去除注释）。
    fn find_matching_paren(text: &str, open: usize) -> Option<usize> {
        let bytes = text.as_bytes();
        if bytes.get(open) != Some(&b'(') {
            return None;
        }
        let mut depth = 0usize;
        for (i, &b) in bytes.iter().enumerate().skip(open) {
            match b {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// 规则 4: DROP TABLE 应使用 IF EXISTS
    ///
    /// 例外：在表重建流程中，DROP 原表（非 _new 表）通常是安全的
    fn check_idempotent_drop(&self, script_name: &str, normalized: &str, result: &mut CheckResult) {
        // 使用预编译正则表达式收集安全的表名
        let safe_tables: HashSet<String> = RE_SAFE_DROPS
            .captures_iter(normalized)
            .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
            .collect();

        for cap in RE_ALL_DROPS.captures_iter(normalized) {
            let table_name = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let table_name_lower = table_name.to_lowercase();

            // 跳过 "IF" （因为 "DROP TABLE IF EXISTS" 会匹配到 "IF"）
            if table_name == "IF" {
                continue;
            }

            // 跳过已经使用 IF EXISTS 的表
            if safe_tables.contains(table_name) {
                continue;
            }

            // 跳过表重建模式中删除原表的情况
            // 检查是否存在对应的 _new 表创建和重命名
            let new_table = format!("{}_NEW", table_name);
            let has_rebuild_pattern = normalized.contains(&format!("CREATE TABLE {}", new_table))
                || normalized.contains(&format!("RENAME TO {}", table_name));

            if has_rebuild_pattern {
                // 表重建模式，DROP 原表是预期的
                continue;
            }

            result.add_warning(CheckWarning {
                rule: "idempotent_drop",
                message: format!(
                    "[{}] DROP TABLE {} 未使用 IF EXISTS",
                    script_name, table_name_lower
                ),
                suggestion: format!("改为: DROP TABLE IF EXISTS {}", table_name_lower),
            });
        }
    }

    /// 规则 5: CREATE INDEX 应使用 IF NOT EXISTS
    ///
    /// 例外：在表重建流程中，重建索引通常在 DROP TABLE 之后，此时索引已不存在
    fn check_idempotent_index(
        &self,
        script_name: &str,
        normalized: &str,
        result: &mut CheckResult,
    ) {
        // 使用预编译正则表达式收集安全的索引名
        let safe_indexes: HashSet<String> = RE_SAFE_INDEXES
            .captures_iter(normalized)
            .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
            .collect();

        for cap in RE_ALL_INDEXES.captures_iter(normalized) {
            let index_name = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let index_name_lower = index_name.to_lowercase();

            // 跳过 "IF"
            if index_name == "IF" {
                continue;
            }

            // 跳过已经使用 IF NOT EXISTS 的索引
            if safe_indexes.contains(index_name) {
                continue;
            }

            // 跳过表重建模式：如果脚本中有 DROP TABLE 和 RENAME TO，
            // 说明是表重建，索引会随表一起被删除
            let has_rebuild_pattern =
                normalized.contains("DROP TABLE") && normalized.contains("RENAME TO");

            if has_rebuild_pattern {
                continue;
            }

            result.add_warning(CheckWarning {
                rule: "idempotent_index",
                message: format!(
                    "[{}] CREATE INDEX {} 未使用 IF NOT EXISTS",
                    script_name, index_name_lower
                ),
                suggestion: format!(
                    "改为: CREATE INDEX IF NOT EXISTS {} ON ...",
                    index_name_lower
                ),
            });
        }
    }
}

impl Default for MigrationScriptChecker {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 便捷函数
// ============================================================================

/// 检查单个迁移脚本
pub fn check_migration_script(script_name: &str, sql: &str) -> CheckResult {
    let mut checker = MigrationScriptChecker::new();
    checker.check(script_name, sql)
}

/// 检查迁移脚本并在有错误时 panic（用于测试）
///
/// ## Panics
/// 如果脚本检查发现错误
pub fn assert_migration_script_valid(script_name: &str, sql: &str) {
    let result = check_migration_script(script_name, sql);

    if !result.passed {
        let mut msg = format!("\n\n❌ 迁移脚本 {} 检查失败:\n", script_name);
        msg.push_str("═".repeat(60).as_str());
        msg.push('\n');

        for error in &result.errors {
            msg.push_str(&format!("\n[{}] {}\n", error.rule, error.message));
            msg.push_str(&format!("   💡 建议: {}\n", error.suggestion));
        }

        if !result.warnings.is_empty() {
            msg.push_str("\n⚠️ 警告:\n");
            for warning in &result.warnings {
                msg.push_str(&format!("   [{}] {}\n", warning.rule, warning.message));
            }
        }

        msg.push_str("\n");
        msg.push_str("═".repeat(60).as_str());
        msg.push_str("\n\n如果确认无问题，可在脚本中添加: -- @skip-check: <rule_name>\n");

        panic!("{}", msg);
    }

    // 打印警告（但不失败）
    if !result.warnings.is_empty() {
        eprintln!("\n⚠️ 迁移脚本 {} 检查警告:", script_name);
        for warning in &result.warnings {
            eprintln!("   [{}] {}", warning.rule, warning.message);
            eprintln!("   💡 {}", warning.suggestion);
        }
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_check_missing_cleanup() {
        let sql = r#"
            CREATE TABLE foo_new (id TEXT PRIMARY KEY);
            INSERT INTO foo_new SELECT * FROM foo;
            DROP TABLE foo;
            ALTER TABLE foo_new RENAME TO foo;
        "#;

        let result = check_migration_script("test.sql", sql);
        assert!(!result.passed, "应该检测到缺少中间状态清理");
        assert!(result
            .errors
            .iter()
            .any(|e| e.rule == "table_rebuild_cleanup"));
    }

    #[test]
    fn test_check_with_cleanup() {
        let sql = r#"
            -- STEP 0: 中间状态清理
            DROP TABLE IF EXISTS foo_new;

            CREATE TABLE foo_new (id TEXT PRIMARY KEY);
            INSERT INTO foo_new SELECT * FROM foo;
            DROP TABLE foo;
            ALTER TABLE foo_new RENAME TO foo;
        "#;

        let result = check_migration_script("test.sql", sql);
        assert!(result.passed, "有中间状态清理应该通过: {:?}", result.errors);
    }

    #[test]
    fn test_check_fk_without_cleanup() {
        let sql = r#"
            CREATE TABLE child_new (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        "#;

        let result = check_migration_script("test.sql", sql);
        assert!(!result.passed, "应该检测到缺少孤儿数据清理");
        assert!(result.errors.iter().any(|e| e.rule == "fk_orphan_cleanup"));
    }

    #[test]
    fn test_check_fk_with_cleanup() {
        let sql = r#"
            -- STEP 0: 中间状态清理
            DROP TABLE IF EXISTS child_new;

            -- STEP 1: 数据完整性修复
            DELETE FROM child WHERE parent_id NOT IN (SELECT id FROM parent);

            CREATE TABLE child_new (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        "#;

        let result = check_migration_script("test.sql", sql);
        assert!(result.passed, "有孤儿数据清理应该通过: {:?}", result.errors);
    }

    #[test]
    fn test_check_fk_in_brand_new_table_passes() {
        // 全新表（非 _new 重建表）的内联外键：表内尚无数据，不存在孤儿，
        // 不应要求孤儿清理
        let sql = r#"
            CREATE TABLE IF NOT EXISTS todo_items (
                id TEXT PRIMARY KEY,
                todo_list_id TEXT NOT NULL,
                parent_id TEXT,
                FOREIGN KEY (todo_list_id) REFERENCES todo_lists(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_id) REFERENCES todo_items(id) ON DELETE SET NULL
            );
        "#;

        let result = check_migration_script("V20260308__add_todo_tables.sql", sql);
        assert!(
            result.passed,
            "全新表的内联外键不应要求孤儿清理: {:?}",
            result.errors
        );
    }

    #[test]
    fn test_check_fk_outside_table_body_not_exempted() {
        // FK 文本位于全新表列定义体**之外**（独立语句区域）：
        // 旧实现按"最近的前一个 CREATE"归属，会把它算作 settings 表的
        // 内联 FK 而误豁免；边界感知后应 fail-close，照常要求孤儿清理
        let sql = r#"
            DROP TABLE IF EXISTS child_new;
            CREATE TABLE IF NOT EXISTS settings (
                k TEXT PRIMARY KEY,
                v TEXT
            );

            INSERT INTO schema_notes(txt)
            VALUES ('FOREIGN KEY (parent_id) REFERENCES parent(id)');
        "#;

        let result = check_migration_script("test.sql", sql);
        assert!(
            result.errors.iter().any(|e| e.rule == "fk_orphan_cleanup"),
            "表体之外的 FK 不应被归属到前面的全新表而误豁免: {:?}",
            result.errors
        );
    }

    #[test]
    fn test_check_fk_rebuild_after_brand_new_table_still_checked() {
        // 全新表之后的 _new 重建表：FK 必须正确归属到 _new 表并要求清理
        let sql = r#"
            CREATE TABLE IF NOT EXISTS settings (
                k TEXT PRIMARY KEY
            );

            CREATE TABLE legacy_new (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        "#;

        let result = check_migration_script("test.sql", sql);
        assert!(
            result.errors.iter().any(|e| e.rule == "fk_orphan_cleanup"),
            "重建表 FK 不应因前面存在全新表而被误豁免: {:?}",
            result.errors
        );
    }

    #[test]
    fn test_skip_check_marker() {
        let sql = r#"
            -- @skip-check: table_rebuild_cleanup
            CREATE TABLE foo_new (id TEXT PRIMARY KEY);
        "#;

        let result = check_migration_script("test.sql", sql);
        assert!(result.passed, "跳过检查应该通过");
    }

    #[test]
    fn test_skip_all_checks() {
        let sql = r#"
            -- @skip-check: all
            CREATE TABLE foo_new (id TEXT PRIMARY KEY);
            CREATE TABLE bar (id TEXT);
        "#;

        let result = check_migration_script("test.sql", sql);
        assert!(result.passed, "跳过所有检查应该通过");
    }

    #[test]
    fn test_idempotent_create_warning() {
        let sql = r#"
            CREATE TABLE foo (id TEXT PRIMARY KEY);
        "#;

        let result = check_migration_script("test.sql", sql);
        // 这是警告，不是错误
        assert!(result.passed);
        assert!(!result.warnings.is_empty());
        assert!(result
            .warnings
            .iter()
            .any(|w| w.rule == "idempotent_create"));
    }

    #[test]
    fn test_real_migration_script() {
        // 测试符合规范的真实迁移脚本
        let sql = r#"
            -- ============================================================================
            -- V20260202: 为 vfs_index_segments 添加 unit_id 外键约束
            -- ============================================================================

            -- STEP 0: 中间状态清理
            DROP TABLE IF EXISTS vfs_index_segments_new;

            -- STEP 1: 数据完整性修复
            DELETE FROM vfs_index_segments
            WHERE unit_id NOT IN (SELECT id FROM vfs_index_units);

            -- STEP 2: 创建新表
            CREATE TABLE vfs_index_segments_new (
                id TEXT PRIMARY KEY,
                unit_id TEXT NOT NULL,
                FOREIGN KEY (unit_id) REFERENCES vfs_index_units(id) ON DELETE CASCADE
            );

            -- STEP 3: 复制数据
            INSERT INTO vfs_index_segments_new SELECT * FROM vfs_index_segments;

            -- STEP 4: 替换表
            DROP TABLE vfs_index_segments;
            ALTER TABLE vfs_index_segments_new RENAME TO vfs_index_segments;
        "#;

        let result = check_migration_script("V20260202__add_segments_fk.sql", sql);
        assert!(result.passed, "符合规范的脚本应该通过: {:?}", result.errors);
    }

    #[test]
    fn test_init_script_skips_checks() {
        // init 脚本应该跳过大部分检查，因为是创建全新数据库
        let sql = r#"
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE posts (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
            CREATE INDEX idx_posts_user ON posts(user_id);
        "#;

        // 使用 __init 后缀的脚本名
        let result = check_migration_script("V20260130__init.sql", sql);
        assert!(result.passed, "init 脚本应该通过: {:?}", result.errors);

        // 使用 :init 格式的脚本名（如 vfs:init）
        let result2 = check_migration_script("vfs:init", sql);
        assert!(result2.passed, "init 脚本应该通过: {:?}", result2.errors);
    }

    #[test]
    fn test_reinitialize_not_treated_as_init() {
        // 包含 "init" 但不是以 __init 结尾的脚本不应被跳过
        let sql = r#"
            CREATE TABLE foo_new (id TEXT PRIMARY KEY);
        "#;

        let result = check_migration_script("V20260201__reinitialize_cache.sql", sql);
        // 应该检测到缺少中间状态清理（因为不是 init 脚本）
        assert!(!result.passed, "reinitialize 脚本不应被跳过检查");
    }

    #[test]
    fn test_create_index_warning() {
        let sql = r#"
            CREATE INDEX idx_foo ON bar(col);
            CREATE UNIQUE INDEX idx_bar ON baz(col);
        "#;

        let result = check_migration_script("test.sql", sql);
        // 应该有警告（非 init 脚本）
        assert!(result.warnings.iter().any(|w| w.rule == "idempotent_index"));
    }

    #[test]
    fn test_create_index_with_if_not_exists() {
        let sql = r#"
            CREATE INDEX IF NOT EXISTS idx_foo ON bar(col);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_bar ON baz(col);
        "#;

        let result = check_migration_script("test.sql", sql);
        // 使用 IF NOT EXISTS 的索引不应产生警告
        assert!(
            !result.warnings.iter().any(|w| w.rule == "idempotent_index"),
            "使用 IF NOT EXISTS 的索引不应产生警告"
        );
    }

    #[test]
    fn test_fk_cleanup_with_not_exists() {
        // 使用 NOT EXISTS 方式清理孤儿数据也应该被接受
        let sql = r#"
            -- STEP 0: 中间状态清理
            DROP TABLE IF EXISTS child_new;

            -- STEP 1: 数据完整性修复
            DELETE FROM child WHERE NOT EXISTS (SELECT 1 FROM parent WHERE parent.id = child.parent_id);

            CREATE TABLE child_new (
                id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES parent(id)
            );
        "#;

        let result = check_migration_script("test.sql", sql);
        assert!(
            result.passed,
            "使用 NOT EXISTS 清理孤儿数据应该通过: {:?}",
            result.errors
        );
    }
}

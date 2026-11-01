//! # Migration Definitions (迁移定义)
//!
//! 每个迁移的元数据定义，包含验证配置。
//!
//! ## 设计原则
//!
//! - 每个迁移必须声明预期结果（表、列、索引）
//! - 迁移后自动验证，确保 SQL 正确执行
//! - 版本由 Refinery 从文件名解析，此处仅作本地辅助
//!
//! ## 版本号说明
//!
//! Refinery 从文件名解析版本（如 `V20260130_001__init.sql` -> 版本 20260130）。
//! `MigrationDef.refinery_version` 应与 Refinery 解析结果一致，用于本地验证辅助。
//! 权威版本以 `refinery_schema_history` 表为准。

/// 迁移定义
///
/// 注意：此结构主要用于**迁移后验证**，版本由 Refinery 管理。
#[derive(Debug, Clone)]
pub struct MigrationDef {
    /// Refinery 解析的版本号（如文件名 V20260130_001__init.sql -> 20260130）
    /// 此字段仅用于本地校验辅助，权威版本以 refinery_schema_history 表为准
    pub refinery_version: i32,
    /// 迁移名称（如 "20260130_001__init"，与文件名中 __ 后的部分对应）
    pub name: &'static str,
    /// SQL 内容（使用 include_str! 嵌入，仅用于本地参考）
    pub sql: &'static str,
    /// 迁移后必须存在的表
    pub expected_tables: &'static [&'static str],
    /// 迁移后必须存在的列 (table, column)
    pub expected_columns: &'static [(&'static str, &'static str)],
    /// 迁移后必须存在的索引
    pub expected_indexes: &'static [&'static str],
    /// 迁移后必须能成功执行的关键查询（用于语义 smoke test）
    pub expected_queries: &'static [&'static str],
    /// 是否为幂等迁移（可重复执行）
    pub idempotent: bool,
}

impl MigrationDef {
    /// 创建新的迁移定义
    ///
    /// # Arguments
    /// * `refinery_version` - Refinery 从文件名解析的版本号（如 20260130）
    /// * `name` - 迁移名称（如 "init"）
    /// * `sql` - SQL 内容
    pub const fn new(refinery_version: i32, name: &'static str, sql: &'static str) -> Self {
        Self {
            refinery_version,
            name,
            sql,
            expected_tables: &[],
            expected_columns: &[],
            expected_indexes: &[],
            expected_queries: &[],
            idempotent: false,
        }
    }

    /// 设置预期表
    pub const fn with_expected_tables(mut self, tables: &'static [&'static str]) -> Self {
        self.expected_tables = tables;
        self
    }

    /// 设置预期列
    pub const fn with_expected_columns(
        mut self,
        columns: &'static [(&'static str, &'static str)],
    ) -> Self {
        self.expected_columns = columns;
        self
    }

    /// 设置预期索引
    pub const fn with_expected_indexes(mut self, indexes: &'static [&'static str]) -> Self {
        self.expected_indexes = indexes;
        self
    }

    /// 设置关键查询（语义验证）
    pub const fn with_expected_queries(mut self, queries: &'static [&'static str]) -> Self {
        self.expected_queries = queries;
        self
    }

    /// 标记为幂等迁移
    pub const fn idempotent(mut self) -> Self {
        self.idempotent = true;
        self
    }
}

/// 迁移定义集合（每个数据库一个）
///
/// 注意：此结构主要用于**迁移后验证**配置，Refinery 独立管理实际迁移执行。
pub struct MigrationSet {
    /// 数据库名称
    pub database_name: &'static str,
    /// 迁移定义列表（用于验证配置，按 refinery_version 排序）
    pub migrations: &'static [MigrationDef],
}

impl MigrationSet {
    /// 获取指定 Refinery 版本的迁移验证配置
    ///
    /// # Arguments
    /// * `refinery_version` - Refinery 记录的版本号（从 refinery_schema_history 表读取）
    pub fn get(&self, refinery_version: i32) -> Option<&MigrationDef> {
        self.migrations
            .iter()
            .find(|m| m.refinery_version == refinery_version)
    }

    /// 获取所有待验证的迁移（refinery_version > current_version）
    ///
    /// 注意：此方法用于确定哪些迁移需要验证，不用于执行迁移（Refinery 处理执行）。
    pub fn pending(&self, current_version: i32) -> impl Iterator<Item = &MigrationDef> {
        self.migrations
            .iter()
            .filter(move |m| m.refinery_version > current_version)
    }

    /// 获取最新的 refinery_version
    pub fn latest_version(&self) -> i32 {
        self.migrations
            .last()
            .map(|m| m.refinery_version)
            .unwrap_or(0)
    }

    /// 获取迁移数量
    pub const fn count(&self) -> usize {
        self.migrations.len()
    }
}

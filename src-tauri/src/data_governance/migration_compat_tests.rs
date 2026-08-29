//! # Migration Compatibility Tests (历史 fixture 生产升级 harness)
//!
//! 数据库迁移 CI 的历史 fixture 升级测试。与 `migration_tests.rs`（空库 → HEAD）
//! 互补，本模块验证 **历史/病态用户数据库** 通过生产 `MigrationCoordinator::run_all()`
//! 升级到 HEAD 的正确性。
//!
//! ## Fixture 体系
//!
//! Fixture 清单位于 `src-tauri/tests/fixtures/migrations/manifest.json`：
//!
//! - **bootstrap_sql**（当前唯一实现）：确定性 fixture。harness 通过生产 refinery
//!   runner 把真实（不可变的）历史迁移脚本重放到 `schema_tuple` 指定的版本，
//!   再执行 seed SQL（内容由 manifest 中 sha256 锚定）与 history_ops
//!   （删史/伪造 legacy 标记表/篡改 checksum 等病态注入）。
//! - **release_binary**（预留）：未来从打包发行版捕获的真实二进制 .db fixture。
//!   当前不存在此类 fixture；loader 遇到该 kind 会显式失败，绝不伪装下载。
//!
//! ## 每个 case 的校验流水线
//!
//! 1. 构建 fixture（全部 4 个核心库：vfs / chat_v2 / mistakes / llm_usage）
//! 2. 生产 `MigrationCoordinator::run_all()` 升级到 HEAD
//! 3. `PRAGMA integrity_check` / `PRAGMA foreign_key_check`
//! 4. refinery 迁移历史与嵌入迁移集完全一致（版本/名称/checksum 非空）
//! 5. manifest 中的数据语义 oracle 逐条断言
//! 6. 语义 schema snapshot（table_xinfo / index_list / index_xinfo /
//!    foreign_key_list + trigger/view 定义）：fixture→HEAD 必须与 fresh→HEAD 一致
//! 7. 幂等重跑 `run_all()`（0 applied）+ 重新打开连接
//! 8. 真实生产路径读写 smoke：VFS 走真实 `VfsDatabase` 连接池 + `VfsNoteRepo`，
//!    其余库走生产 PRAGMA 配置的连接直接读写
//!
//! ## 运行方式
//!
//! ```bash
//! cargo test --features data_governance migration_compat -- --nocapture
//! ```

#[cfg(test)]
#[cfg(feature = "data_governance")]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::{Path, PathBuf};

    use rusqlite::Connection;
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;

    use crate::data_governance::migration::MigrationCoordinator;

    /// 4 个核心数据库（与 DatabaseId::all_ordered 一致的名称）
    const CORE_DATABASES: [&str; 4] = ["vfs", "chat_v2", "mistakes", "llm_usage"];

    // ========================================================================
    // Manifest 数据模型
    // ========================================================================

    #[derive(Debug, serde::Deserialize)]
    struct FixtureManifest {
        format_version: u32,
        #[serde(default)]
        cases: Vec<FixtureCase>,
    }

    #[derive(Debug, serde::Deserialize)]
    struct FixtureCase {
        id: String,
        kind: String,
        #[serde(default)]
        source_release: String,
        schema_tuple: BTreeMap<String, u32>,
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default)]
        expected_semantics: String,
        #[serde(default)]
        history_ops: Vec<HistoryOp>,
        #[serde(default)]
        allowed_extra_tables: BTreeMap<String, Vec<String>>,
        #[serde(default)]
        seeds: BTreeMap<String, SeedFile>,
        #[serde(default)]
        oracles: Vec<Oracle>,
    }

    #[derive(Debug, serde::Deserialize)]
    struct SeedFile {
        file: String,
        sha256: String,
    }

    #[derive(Debug, serde::Deserialize)]
    struct HistoryOp {
        database: String,
        op: String,
        #[serde(default)]
        table: Option<String>,
        #[serde(default)]
        version: Option<u32>,
    }

    #[derive(Debug, serde::Deserialize)]
    struct Oracle {
        database: String,
        query: String,
        expected: String,
    }

    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("migrations")
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    /// 解析并校验 manifest。空清单 / 0 cases / 未落地的 fixture kind /
    /// seed 文件缺失或哈希漂移都会返回 Err —— CI 必须显式失败而非静默跳过。
    fn parse_and_validate_manifest(json: &str, root: &Path) -> Result<FixtureManifest, String> {
        let manifest: FixtureManifest =
            serde_json::from_str(json).map_err(|e| format!("manifest JSON 解析失败: {e}"))?;

        if manifest.format_version != 1 {
            return Err(format!(
                "不支持的 manifest format_version: {}",
                manifest.format_version
            ));
        }
        if manifest.cases.is_empty() {
            return Err(
                "fixture manifest 为空（0 cases）：迁移兼容性 CI 必须至少包含一个历史 fixture"
                    .to_string(),
            );
        }

        let mut seen_ids = BTreeSet::new();
        for case in &manifest.cases {
            let ctx = format!("case '{}'", case.id);
            if !seen_ids.insert(case.id.clone()) {
                return Err(format!("{ctx}: id 重复"));
            }
            match case.kind.as_str() {
                "bootstrap_sql" => {}
                "release_binary" => {
                    return Err(format!(
                        "{ctx}: release_binary fixture 尚未落地（不存在可用的二进制 artifact，harness 拒绝伪装下载）"
                    ));
                }
                other => return Err(format!("{ctx}: 未知 fixture kind '{other}'")),
            }
            if case.expected_semantics.trim().is_empty() {
                return Err(format!("{ctx}: expected_semantics 不能为空"));
            }
            if case.tags.is_empty() {
                return Err(format!("{ctx}: 场景标签 tags 不能为空"));
            }
            if case.source_release.trim().is_empty() {
                return Err(format!("{ctx}: source_release 不能为空"));
            }
            // 完整 slot 覆盖：4 个核心库必须全部给出来源版本
            for db in CORE_DATABASES {
                if !case.schema_tuple.contains_key(db) {
                    return Err(format!("{ctx}: schema_tuple 缺少核心库 '{db}'"));
                }
            }
            for db in case.schema_tuple.keys() {
                if !CORE_DATABASES.contains(&db.as_str()) {
                    return Err(format!("{ctx}: schema_tuple 引用未知数据库 '{db}'"));
                }
            }
            if case.seeds.is_empty() {
                return Err(format!(
                    "{ctx}: bootstrap_sql fixture 必须至少包含一个 seed 文件（不允许空 fixture）"
                ));
            }
            for (db, seed) in &case.seeds {
                if !CORE_DATABASES.contains(&db.as_str()) {
                    return Err(format!("{ctx}: seed 引用未知数据库 '{db}'"));
                }
                let path = root.join(&seed.file);
                let bytes = std::fs::read(&path)
                    .map_err(|e| format!("{ctx}: seed 文件 {} 不可读: {e}", path.display()))?;
                let actual = sha256_hex(&bytes);
                if actual != seed.sha256 {
                    return Err(format!(
                        "{ctx}: seed 文件 {} 哈希漂移: manifest={} 实际={}（seed 变更后请同步更新 manifest）",
                        seed.file, seed.sha256, actual
                    ));
                }
            }
            if case.oracles.is_empty() {
                return Err(format!("{ctx}: 必须至少定义一个数据语义 oracle"));
            }
            for oracle in &case.oracles {
                if !CORE_DATABASES.contains(&oracle.database.as_str()) {
                    return Err(format!(
                        "{ctx}: oracle 引用未知数据库 '{}'",
                        oracle.database
                    ));
                }
            }
            for op in &case.history_ops {
                if !CORE_DATABASES.contains(&op.database.as_str()) {
                    return Err(format!(
                        "{ctx}: history_op 引用未知数据库 '{}'",
                        op.database
                    ));
                }
                match op.op.as_str() {
                    "drop_refinery_history" | "insert_malformed_history_rows" => {}
                    "create_legacy_marker_table" | "create_orphan_intermediate_table" => {
                        if op.table.is_none() {
                            return Err(format!("{ctx}: op '{}' 缺少 table 参数", op.op));
                        }
                    }
                    "corrupt_checksum" | "delete_history_row" => {
                        if op.version.is_none() {
                            return Err(format!("{ctx}: op '{}' 缺少 version 参数", op.op));
                        }
                    }
                    other => return Err(format!("{ctx}: 未知 history_op '{other}'")),
                }
            }
        }
        Ok(manifest)
    }

    fn load_manifest() -> Result<FixtureManifest, String> {
        let root = fixture_root();
        let path = root.join("manifest.json");
        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("无法读取 fixture manifest {}: {e}", path.display()))?;
        parse_and_validate_manifest(&json, &root)
    }

    // ========================================================================
    // Fixture 构建（生产 refinery runner 重放真实历史迁移脚本）
    // ========================================================================

    /// 与 MigrationCoordinator::get_database_path 一致的库文件布局
    fn database_path(data_dir: &Path, db: &str) -> PathBuf {
        match db {
            "vfs" => data_dir.join("databases").join("vfs.db"),
            "chat_v2" => data_dir.join("chat_v2.db"),
            "mistakes" => data_dir.join("mistakes.db"),
            "llm_usage" => data_dir.join("llm_usage.db"),
            other => panic!("未知数据库: {other}"),
        }
    }

    /// 与生产完全相同的嵌入迁移集（同一批 migrations/*.sql 文件）
    fn runner_for(db: &str) -> refinery::Runner {
        match db {
            "vfs" => {
                mod m {
                    refinery::embed_migrations!("migrations/vfs");
                }
                m::migrations::runner()
            }
            "chat_v2" => {
                mod m {
                    refinery::embed_migrations!("migrations/chat_v2");
                }
                m::migrations::runner()
            }
            "mistakes" => {
                mod m {
                    refinery::embed_migrations!("migrations/mistakes");
                }
                m::migrations::runner()
            }
            "llm_usage" => {
                mod m {
                    refinery::embed_migrations!("migrations/llm_usage");
                }
                m::migrations::runner()
            }
            other => panic!("未知数据库: {other}"),
        }
    }

    fn open_conn(path: &Path) -> Connection {
        let conn = Connection::open(path)
            .unwrap_or_else(|e| panic!("打开数据库失败 {}: {e}", path.display()));
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    fn apply_history_op(conn: &Connection, op: &HistoryOp, ctx: &str) {
        match op.op.as_str() {
            "drop_refinery_history" => {
                conn.execute("DROP TABLE IF EXISTS refinery_schema_history", [])
                    .unwrap_or_else(|e| panic!("{ctx}: drop_refinery_history 失败: {e}"));
            }
            "create_legacy_marker_table" => {
                let table = op.table.as_deref().unwrap();
                conn.execute_batch(&format!(
                    "CREATE TABLE IF NOT EXISTS \"{table}\" (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);\n\
                     INSERT OR IGNORE INTO \"{table}\" (version, name, applied_at) VALUES (1, 'legacy_init', '2026-01-30T00:00:00Z');"
                ))
                .unwrap_or_else(|e| panic!("{ctx}: create_legacy_marker_table({table}) 失败: {e}"));
            }
            "create_orphan_intermediate_table" => {
                let table = op.table.as_deref().unwrap();
                conn.execute_batch(&format!(
                    "CREATE TABLE IF NOT EXISTS \"{table}\" (id TEXT PRIMARY KEY, leftover TEXT);\n\
                     INSERT OR IGNORE INTO \"{table}\" (id, leftover) VALUES ('orphan_1', 'from failed migration');"
                ))
                .unwrap_or_else(|e| {
                    panic!("{ctx}: create_orphan_intermediate_table({table}) 失败: {e}")
                });
            }
            "insert_malformed_history_rows" => {
                conn.execute_batch(
                    "INSERT OR IGNORE INTO refinery_schema_history (version, name, applied_on, checksum)\n\
                     VALUES (0, 'ghost_zero_version', 'not-a-timestamp', '12345');\n\
                     INSERT OR IGNORE INTO refinery_schema_history (version, name, applied_on, checksum)\n\
                     VALUES (20260101, 'ghost_empty_checksum', '2026-01-01T00:00:00Z', '');",
                )
                .unwrap_or_else(|e| panic!("{ctx}: insert_malformed_history_rows 失败: {e}"));
            }
            "corrupt_checksum" => {
                let version = op.version.unwrap();
                let updated = conn
                    .execute(
                        "UPDATE refinery_schema_history SET checksum = '999999999' WHERE version = ?1",
                        [version],
                    )
                    .unwrap_or_else(|e| panic!("{ctx}: corrupt_checksum({version}) 失败: {e}"));
                assert_eq!(
                    updated, 1,
                    "{ctx}: corrupt_checksum({version}) 未命中任何历史记录"
                );
            }
            "delete_history_row" => {
                let version = op.version.unwrap();
                let deleted = conn
                    .execute(
                        "DELETE FROM refinery_schema_history WHERE version = ?1",
                        [version],
                    )
                    .unwrap_or_else(|e| panic!("{ctx}: delete_history_row({version}) 失败: {e}"));
                assert_eq!(
                    deleted, 1,
                    "{ctx}: delete_history_row({version}) 未命中任何历史记录"
                );
            }
            other => panic!("{ctx}: 未知 history_op '{other}'"),
        }
    }

    /// 构建一个 case 的完整 slot（4 库）：迁移到目标版本 → seed → history_ops
    fn build_fixture_slot(case: &FixtureCase, data_dir: &Path) {
        let root = fixture_root();
        for db in CORE_DATABASES {
            let target = *case.schema_tuple.get(db).unwrap();
            let db_path = database_path(data_dir, db);
            std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();

            let mut conn = open_conn(&db_path);
            let runner = runner_for(db)
                .set_target(refinery::Target::Version(target as _))
                .set_grouped(false);
            runner.run(&mut conn).unwrap_or_else(|e| {
                panic!(
                    "case '{}': 构建 {db} fixture（目标 V{target}）失败: {e}",
                    case.id
                )
            });

            if let Some(seed) = case.seeds.get(db) {
                let sql = std::fs::read_to_string(root.join(&seed.file)).unwrap();
                conn.execute_batch(&sql).unwrap_or_else(|e| {
                    panic!("case '{}': {db} seed {} 执行失败: {e}", case.id, seed.file)
                });
            }

            for op in case.history_ops.iter().filter(|op| op.database == db) {
                apply_history_op(&conn, op, &format!("case '{}' {db}", case.id));
            }
        }
    }

    // ========================================================================
    // 语义 schema snapshot
    // ========================================================================

    fn quote_ident(name: &str) -> String {
        format!("\"{}\"", name.replace('"', "\"\""))
    }

    fn value_to_string(v: rusqlite::types::Value) -> String {
        use rusqlite::types::Value;
        match v {
            Value::Null => "NULL".to_string(),
            Value::Integer(i) => i.to_string(),
            Value::Real(f) => f.to_string(),
            Value::Text(s) => s,
            Value::Blob(b) => format!("blob:{}", sha256_hex(&b)),
        }
    }

    /// 基于 PRAGMA table_xinfo / index_list / index_xinfo / foreign_key_list
    /// 的语义 schema 快照，另附 trigger/view 的规范化定义。
    ///
    /// 排除 `sqlite_*` 内部表与 `refinery_schema_history`：后者在
    /// legacy-baseline 路径下由 ensure_legacy_baseline 以 TEXT 列重建，与
    /// refinery 自建 DDL 的类型亲和性合法地不同；其内容由
    /// `assert_history_consistent` 单独精确校验。
    fn semantic_schema_snapshot(conn: &Connection) -> BTreeMap<String, String> {
        let mut snapshot = BTreeMap::new();

        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' \
                 AND name NOT LIKE 'sqlite_%' AND name <> 'refinery_schema_history' \
                 ORDER BY name",
            )
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        for table in &tables {
            let mut desc = String::new();
            let quoted = quote_ident(table);

            desc.push_str("columns:\n");
            let mut cstmt = conn
                .prepare(&format!("PRAGMA table_xinfo({quoted})"))
                .unwrap();
            let mut rows = cstmt.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                let cid: i64 = row.get("cid").unwrap();
                let name: String = row.get("name").unwrap();
                let col_type: String = row.get("type").unwrap();
                let notnull: i64 = row.get("notnull").unwrap();
                let dflt: Option<String> = row
                    .get::<_, rusqlite::types::Value>("dflt_value")
                    .map(|v| match v {
                        rusqlite::types::Value::Null => None,
                        other => Some(value_to_string(other)),
                    })
                    .unwrap();
                let pk: i64 = row.get("pk").unwrap();
                let hidden: i64 = row.get("hidden").unwrap();
                desc.push_str(&format!(
                    "  [{cid}] {name} type={col_type} notnull={notnull} default={} pk={pk} hidden={hidden}\n",
                    dflt.unwrap_or_else(|| "<none>".to_string())
                ));
            }

            desc.push_str("indexes:\n");
            let mut istmt = conn
                .prepare(&format!("PRAGMA index_list({quoted})"))
                .unwrap();
            let mut index_entries: Vec<(String, String)> = Vec::new();
            let mut irows = istmt.query([]).unwrap();
            while let Some(row) = irows.next().unwrap() {
                let idx_name: String = row.get("name").unwrap();
                let unique: i64 = row.get("unique").unwrap();
                let origin: String = row.get("origin").unwrap();
                let partial: i64 = row.get("partial").unwrap();

                let mut idx_desc =
                    format!("  {idx_name} unique={unique} origin={origin} partial={partial}\n");
                let mut xstmt = conn
                    .prepare(&format!("PRAGMA index_xinfo({})", quote_ident(&idx_name)))
                    .unwrap();
                let mut xrows = xstmt.query([]).unwrap();
                while let Some(xrow) = xrows.next().unwrap() {
                    let seqno: i64 = xrow.get("seqno").unwrap();
                    let cid: i64 = xrow.get("cid").unwrap();
                    let col: Option<String> = xrow.get("name").unwrap();
                    let desc_flag: i64 = xrow.get("desc").unwrap();
                    let coll: String = xrow.get("coll").unwrap();
                    let key: i64 = xrow.get("key").unwrap();
                    idx_desc.push_str(&format!(
                        "    seq={seqno} cid={cid} col={} desc={desc_flag} coll={coll} key={key}\n",
                        col.unwrap_or_else(|| "<expr-or-rowid>".to_string())
                    ));
                }
                index_entries.push((idx_name, idx_desc));
            }
            index_entries.sort();
            for (_, idx_desc) in index_entries {
                desc.push_str(&idx_desc);
            }

            desc.push_str("foreign_keys:\n");
            let mut fstmt = conn
                .prepare(&format!("PRAGMA foreign_key_list({quoted})"))
                .unwrap();
            let mut frows = fstmt.query([]).unwrap();
            while let Some(row) = frows.next().unwrap() {
                let id: i64 = row.get("id").unwrap();
                let seq: i64 = row.get("seq").unwrap();
                let ref_table: String = row.get("table").unwrap();
                let from: String = row.get("from").unwrap();
                let to: Option<String> = row.get("to").unwrap();
                let on_update: String = row.get("on_update").unwrap();
                let on_delete: String = row.get("on_delete").unwrap();
                desc.push_str(&format!(
                    "  [{id}.{seq}] {from} -> {ref_table}({}) on_update={on_update} on_delete={on_delete}\n",
                    to.unwrap_or_else(|| "<implicit-pk>".to_string())
                ));
            }

            snapshot.insert(format!("table:{table}"), desc);
        }

        let mut tstmt = conn
            .prepare(
                "SELECT type, name, sql FROM sqlite_master \
                 WHERE type IN ('trigger', 'view') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY type, name",
            )
            .unwrap();
        let mut trows = tstmt.query([]).unwrap();
        while let Some(row) = trows.next().unwrap() {
            let obj_type: String = row.get(0).unwrap();
            let name: String = row.get(1).unwrap();
            let sql: Option<String> = row.get(2).unwrap();
            let normalized = sql
                .unwrap_or_default()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            snapshot.insert(format!("{obj_type}:{name}"), normalized);
        }

        snapshot
    }

    fn diff_snapshots(
        fresh: &BTreeMap<String, String>,
        fixture: &BTreeMap<String, String>,
    ) -> Vec<String> {
        let mut diffs = Vec::new();
        for (key, fresh_val) in fresh {
            match fixture.get(key) {
                None => diffs.push(format!("fixture 缺少对象 {key}")),
                Some(fixture_val) if fixture_val != fresh_val => diffs.push(format!(
                    "对象 {key} 定义不一致:\n--- fresh ---\n{fresh_val}\n--- fixture ---\n{fixture_val}"
                )),
                _ => {}
            }
        }
        for key in fixture.keys() {
            if !fresh.contains_key(key) {
                diffs.push(format!("fixture 存在 fresh 没有的对象 {key}"));
            }
        }
        diffs
    }

    // ========================================================================
    // 升级后校验
    // ========================================================================

    fn assert_integrity(conn: &Connection, ctx: &str) {
        let result: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(result, "ok", "{ctx}: integrity_check 失败: {result}");

        let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
        let violations: Vec<String> = stmt
            .query_map([], |row| {
                let table: String = row.get(0)?;
                let rowid: Option<i64> = row.get(1)?;
                let parent: String = row.get(2)?;
                Ok(format!("{table} rowid={rowid:?} -> {parent}"))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            violations.is_empty(),
            "{ctx}: foreign_key_check 发现违规: {violations:?}"
        );
    }

    /// 迁移历史必须与嵌入迁移集完全一致：版本集合精确相等、名称匹配、
    /// checksum 非空且不是 baseline 占位 "0"、按版本严格递增。
    fn assert_history_consistent(conn: &Connection, db: &str, ctx: &str) {
        let mut stmt = conn
            .prepare("SELECT version, name, checksum FROM refinery_schema_history ORDER BY version")
            .unwrap();
        let rows: Vec<(i64, String, Option<String>)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        let runner = runner_for(db);
        let mut expected: Vec<(i64, String)> = runner
            .get_migrations()
            .iter()
            .map(|m| (m.version() as i64, m.name().to_string()))
            .collect();
        expected.sort();

        let actual_versions: Vec<i64> = rows.iter().map(|(v, _, _)| *v).collect();
        let expected_versions: Vec<i64> = expected.iter().map(|(v, _)| *v).collect();
        assert_eq!(
            actual_versions, expected_versions,
            "{ctx}: 迁移历史版本集合与嵌入迁移集不一致"
        );

        for ((version, name, checksum), (_, expected_name)) in rows.iter().zip(expected.iter()) {
            assert_eq!(
                name, expected_name,
                "{ctx}: v{version} 迁移名称不一致（history='{name}', embedded='{expected_name}'）"
            );
            let checksum = checksum.as_deref().unwrap_or("");
            assert!(
                !checksum.is_empty() && checksum != "0",
                "{ctx}: v{version} checksum 非法（'{checksum}'），应已被生产修复逻辑对齐"
            );
        }
    }

    fn run_oracles(data_dir: &Path, case: &FixtureCase) {
        for oracle in &case.oracles {
            let conn = open_conn(&database_path(data_dir, &oracle.database));
            let actual = conn
                .query_row(&oracle.query, [], |row| {
                    let v: rusqlite::types::Value = row.get(0)?;
                    Ok(value_to_string(v))
                })
                .unwrap_or_else(|e| {
                    panic!(
                        "case '{}' {}: oracle 查询失败: {e}\n  query: {}",
                        case.id, oracle.database, oracle.query
                    )
                });
            assert_eq!(
                actual, oracle.expected,
                "case '{}' {}: 数据语义 oracle 失败\n  query: {}\n  expected: {}\n  actual: {}",
                case.id, oracle.database, oracle.query, oracle.expected, actual
            );
        }
    }

    // ========================================================================
    // 生产升级 + fresh 基线
    // ========================================================================

    fn run_production_upgrade(
        data_dir: &Path,
    ) -> crate::data_governance::migration::MigrationReport {
        let mut coordinator = MigrationCoordinator::new(data_dir.to_path_buf()).with_audit_db(None);
        coordinator
            .run_all()
            .unwrap_or_else(|e| panic!("生产 run_all() 失败 ({}): {e}", data_dir.display()))
    }

    /// fresh(空目录) → HEAD 的基线快照
    fn fresh_head_snapshots() -> (TempDir, BTreeMap<String, BTreeMap<String, String>>) {
        let temp = TempDir::new().unwrap();
        let report = run_production_upgrade(temp.path());
        assert!(report.success, "fresh 基线迁移失败: {:?}", report.error);

        let mut snapshots = BTreeMap::new();
        for db in CORE_DATABASES {
            let conn = open_conn(&database_path(temp.path(), db));
            snapshots.insert(db.to_string(), semantic_schema_snapshot(&conn));
        }
        (temp, snapshots)
    }

    // ========================================================================
    // 真实生产路径读写 smoke
    // ========================================================================

    /// VFS 走真实生产 repository（VfsDatabase 连接池 + VfsNoteRepo），
    /// 其余 3 库走生产 PRAGMA 配置的连接做读写 smoke。
    fn production_readwrite_smoke(data_dir: &Path, ctx: &str) {
        // ---- VFS：真实 repository 路径 ----
        let vfs_db = crate::vfs::database::VfsDatabase::new(data_dir)
            .unwrap_or_else(|e| panic!("{ctx}: VfsDatabase 初始化失败: {e:?}"));
        let note = crate::vfs::repos::note_repo::VfsNoteRepo::create_note(
            &vfs_db,
            crate::vfs::types::VfsCreateNoteParams {
                title: "升级后冒烟笔记".to_string(),
                content: "迁移完成后通过真实仓储写入的正文，验证生产读写路径。".to_string(),
                tags: vec!["migration".to_string(), "冒烟".to_string()],
            },
        )
        .unwrap_or_else(|e| panic!("{ctx}: VfsNoteRepo::create_note 失败: {e:?}"));

        let hits = crate::vfs::repos::note_repo::VfsNoteRepo::search_notes_with_snippets(
            &vfs_db,
            "冒烟笔记",
            10,
        )
        .unwrap_or_else(|e| panic!("{ctx}: 笔记搜索失败: {e:?}"));
        assert!(
            hits.iter().any(|(n, _)| n.id == note.id),
            "{ctx}: 升级后通过真实 repository 写入的笔记无法被搜索到"
        );

        // note_tags 触发器（HEAD 新增 schema 对象）应对生产写路径生效
        {
            let conn = vfs_db.get_conn_safe().unwrap();
            let tag_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM note_tags WHERE note_id = ?1",
                    [&note.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(tag_count, 2, "{ctx}: note_tags 触发器未跟随生产写路径生效");
        }
        drop(vfs_db);

        // ---- 其余核心库：生产 PRAGMA 连接读写 smoke ----
        let now = "2026-07-21T00:00:00.000Z";

        let chat = open_conn(&database_path(data_dir, "chat_v2"));
        chat.execute(
            "INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at)
             VALUES ('sess_smoke_0001', 'general_chat', '升级冒烟会话', 'active', ?1, ?1)",
            [now],
        )
        .unwrap_or_else(|e| panic!("{ctx}: chat_v2 写入 smoke 失败: {e}"));
        let session_count: i64 = chat
            .query_row(
                "SELECT COUNT(*) FROM chat_v2_sessions WHERE id = 'sess_smoke_0001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(session_count, 1, "{ctx}: chat_v2 读回 smoke 失败");

        let mistakes = open_conn(&database_path(data_dir, "mistakes"));
        mistakes
            .execute(
                "INSERT INTO mistakes (id, created_at, question_images, analysis_images, user_question,
                                       ocr_text, tags, mistake_type, status, updated_at)
                 VALUES ('mistake_smoke_1', ?1, '[]', '[]', '升级冒烟错题', 'ocr', '[\"smoke\"]',
                         'other', 'pending', ?1)",
                [now],
            )
            .unwrap_or_else(|e| panic!("{ctx}: mistakes 写入 smoke 失败: {e}"));
        let mistake_count: i64 = mistakes
            .query_row(
                "SELECT COUNT(*) FROM mistakes WHERE id = 'mistake_smoke_1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mistake_count, 1, "{ctx}: mistakes 读回 smoke 失败");

        let llm = open_conn(&database_path(data_dir, "llm_usage"));
        llm.execute(
            "INSERT INTO llm_usage_logs (id, timestamp, provider, model, caller_type,
                                         prompt_tokens, completion_tokens, total_tokens)
             VALUES ('usage_smoke_001', ?1, 'anthropic', 'claude-sonnet-5', 'chat', 10, 5, 15)",
            [now],
        )
        .unwrap_or_else(|e| panic!("{ctx}: llm_usage 写入 smoke 失败: {e}"));
        let usage_count: i64 = llm
            .query_row(
                "SELECT COUNT(*) FROM llm_usage_logs WHERE id = 'usage_smoke_001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(usage_count, 1, "{ctx}: llm_usage 读回 smoke 失败");
        let cache_write: Option<i64> = llm
            .query_row(
                "SELECT cache_write_tokens FROM llm_usage_logs WHERE id = 'usage_smoke_001'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            cache_write, None,
            "{ctx}: 未携带新列的旧式 INSERT 必须保持 NULL（无测量）"
        );
    }

    // ========================================================================
    // 测试入口
    // ========================================================================

    /// 空 fixture 清单（0 cases）必须被拒绝——CI 不允许静默变成 no-op。
    #[test]
    fn manifest_with_zero_cases_is_rejected() {
        let root = fixture_root();
        let err = parse_and_validate_manifest(r#"{"format_version":1,"cases":[]}"#, &root)
            .expect_err("空 fixture 清单必须报错");
        assert!(err.contains("0 cases"), "错误信息应指明 0 cases: {err}");

        let err = parse_and_validate_manifest(r#"{"format_version":1}"#, &root)
            .expect_err("缺少 cases 字段的清单必须报错");
        assert!(err.contains("0 cases"), "错误信息应指明 0 cases: {err}");
    }

    /// release_binary fixture 在没有真实 artifact 之前必须显式失败，不允许伪装。
    #[test]
    fn release_binary_fixture_kind_fails_loudly_until_provisioned() {
        let root = fixture_root();
        let json = r#"{
            "format_version": 1,
            "cases": [{
                "id": "future_release",
                "kind": "release_binary",
                "source_release": "v9.9.9",
                "tags": ["release"],
                "expected_semantics": "n/a",
                "schema_tuple": {"vfs": 1, "chat_v2": 1, "mistakes": 1, "llm_usage": 1},
                "seeds": {},
                "oracles": []
            }]
        }"#;
        let err = parse_and_validate_manifest(json, &root)
            .expect_err("未落地的 release_binary fixture 必须报错");
        assert!(
            err.contains("release_binary"),
            "错误信息应指明 release_binary 未落地: {err}"
        );
    }

    /// manifest 本体健康：非空、seed 哈希锚定、oracle/标签/schema tuple 齐全。
    #[test]
    fn manifest_is_valid_and_non_trivial() {
        let manifest = load_manifest().unwrap_or_else(|e| panic!("fixture manifest 无效: {e}"));
        assert!(
            manifest.cases.len() >= 3,
            "迁移兼容性 CI 至少需要 3 个历史 fixture 场景，当前 {}",
            manifest.cases.len()
        );
        // 至少覆盖最老 epoch 与近期 epoch
        let all_tags: BTreeSet<&str> = manifest
            .cases
            .iter()
            .flat_map(|c| c.tags.iter().map(|t| t.as_str()))
            .collect();
        assert!(
            all_tags.contains("oldest_legacy"),
            "缺少最老 legacy epoch 场景（tag: oldest_legacy）"
        );
        assert!(
            all_tags.contains("recent_epoch") || all_tags.contains("partial_history"),
            "缺少近期 schema epoch / 病态历史场景"
        );
    }

    /// 核心 harness：每个历史 fixture 通过生产 run_all() 升级到 HEAD 并全量校验。
    #[test]
    fn historical_fixtures_upgrade_to_head_via_production_coordinator() {
        let manifest = load_manifest().unwrap_or_else(|e| panic!("fixture manifest 无效: {e}"));
        assert!(!manifest.cases.is_empty(), "0 fixture cases");

        // fresh → HEAD 语义 schema 基线
        let (_fresh_dir, fresh_snapshots) = fresh_head_snapshots();

        for case in &manifest.cases {
            let ctx = format!("case '{}'", case.id);
            let temp = TempDir::new().unwrap();
            let data_dir = temp.path();

            // 1. 构建历史 fixture（完整 slot：4 核心库）
            build_fixture_slot(case, data_dir);

            // 2. 生产升级
            let report = run_production_upgrade(data_dir);
            assert!(
                report.success,
                "{ctx}: run_all 报告失败: {:?}",
                report.error
            );
            assert_eq!(
                report.databases.len(),
                CORE_DATABASES.len(),
                "{ctx}: 迁移报告应覆盖全部核心库"
            );
            for db_report in &report.databases {
                assert!(
                    db_report.success,
                    "{ctx}: {} 迁移失败: {:?}",
                    db_report.id.as_str(),
                    db_report.error
                );
            }

            // 3~6. 每库校验：完整性 / 历史 / snapshot
            for db in CORE_DATABASES {
                let db_ctx = format!("{ctx} {db}");
                let conn = open_conn(&database_path(data_dir, db));

                assert_integrity(&conn, &db_ctx);
                assert_history_consistent(&conn, db, &db_ctx);

                let mut fixture_snapshot = semantic_schema_snapshot(&conn);
                if let Some(extra_tables) = case.allowed_extra_tables.get(db) {
                    for table in extra_tables {
                        let key = format!("table:{table}");
                        assert!(
                            fixture_snapshot.remove(&key).is_some(),
                            "{db_ctx}: manifest 声明的遗留表 {table} 实际不存在"
                        );
                    }
                }
                let diffs = diff_snapshots(&fresh_snapshots[db], &fixture_snapshot);
                assert!(
                    diffs.is_empty(),
                    "{db_ctx}: fixture→HEAD 与 fresh→HEAD 语义 schema 不一致 ({} 处):\n{}",
                    diffs.len(),
                    diffs.join("\n")
                );
            }

            // 数据语义 oracle
            run_oracles(data_dir, case);

            // 7a. 幂等重跑：0 applied、版本不变、依旧成功
            let rerun = run_production_upgrade(data_dir);
            assert!(rerun.success, "{ctx}: 幂等重跑失败: {:?}", rerun.error);
            for db_report in &rerun.databases {
                assert_eq!(
                    db_report.applied_count,
                    0,
                    "{ctx}: 幂等重跑不应再应用迁移（{} 应用了 {} 个）",
                    db_report.id.as_str(),
                    db_report.applied_count
                );
                assert_eq!(
                    db_report.from_version,
                    db_report.to_version,
                    "{ctx}: 幂等重跑版本发生变化（{}）",
                    db_report.id.as_str()
                );
            }

            // 7b. reopen：重新打开连接后完整性与历史仍然一致
            for db in CORE_DATABASES {
                let conn = open_conn(&database_path(data_dir, db));
                assert_integrity(&conn, &format!("{ctx} {db} (reopen)"));
                assert_history_consistent(&conn, db, &format!("{ctx} {db} (reopen)"));
            }

            // oracle 在重跑后必须依旧成立（迁移不可重复变更数据）
            run_oracles(data_dir, case);

            // 8. 真实生产路径读写 smoke
            production_readwrite_smoke(data_dir, &ctx);
        }
    }
}

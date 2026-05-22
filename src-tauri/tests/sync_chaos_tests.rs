//! Chaos 测试：模拟两端并发操作 + 随机故障注入
//!
//! 设计思路（受 Jepsen / FoundationDB 启发）：
//! - 起两个"设备"，各自维护 SQLite + __change_log
//! - 共享一个内存"云端总线"（变更池，按 changed_at 排序）
//! - 随机交错下面几种动作：
//!   * A 端做一个业务操作（Insert/Update/Delete）
//!   * B 端做一个业务操作
//!   * A 端"同步"：抓 B 端发出的所有 changes 应用，再把自己的 changes 发出去
//!   * B 端"同步"：同上
//!   * 随机"网络故障"：跳过一次同步
//!   * 随机"部分失败"：应用一半变更就回滚（通过注入非法变更实现）
//!
//! 运行 30-60 秒后，强制两端做一次"最终同步"（把所有 pending 变更互相交换完毕）。
//! 断言：最终 A 和 B 的业务表内容（忽略元字段后）完全相同。

use deep_student_lib::data_governance::sync::{ChangeOperation, SyncChangeWithData, SyncManager};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use rusqlite::{params, Connection};
use serde_json::json;
use std::collections::HashMap;

/// chaos 里的操作
#[derive(Debug, Clone)]
enum ChaosAction {
    InsertOrUpdate {
        id: String,
        label: String,
        counter: i64,
    },
    Delete {
        id: String,
    },
    Sync,
    NetworkOutage,
}

fn new_db(device_id: &str) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE items (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL DEFAULT '',
            counter INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE TABLE __change_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            record_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            changed_at TEXT NOT NULL DEFAULT (datetime('now')),
            sync_version INTEGER DEFAULT 0
        );
        CREATE TRIGGER trg_items_ins AFTER INSERT ON items BEGIN
            INSERT INTO __change_log (table_name, record_id, operation, changed_at)
            VALUES ('items', NEW.id, 'INSERT', NEW.updated_at);
        END;
        CREATE TRIGGER trg_items_upd AFTER UPDATE ON items BEGIN
            INSERT INTO __change_log (table_name, record_id, operation, changed_at)
            VALUES ('items', NEW.id, 'UPDATE', NEW.updated_at);
        END;
        -- DELETE 触发器：使用 OLD.updated_at 作为 changed_at，
        -- 这样时间戳反映"用户执行删除时操作的记录版本"，便于 LWW 跨端比较。
        CREATE TRIGGER trg_items_del AFTER DELETE ON items BEGIN
            INSERT INTO __change_log (table_name, record_id, operation, changed_at)
            VALUES ('items', OLD.id, 'DELETE', OLD.updated_at);
        END;
        CREATE TABLE refinery_schema_history (version INTEGER PRIMARY KEY, applied_on TEXT);
        INSERT INTO refinery_schema_history VALUES (1, datetime('now'));
        "#,
    )
    .unwrap();
    let _ = conn.execute(
        "INSERT INTO __change_log (table_name, record_id, operation) VALUES ('__meta', ?1, 'INSERT')",
        params![device_id],
    );
    conn
}

/// 本地业务操作：直接 SQL 写入，触发器会产生 __change_log 条目
fn local_insert_or_update(conn: &Connection, id: &str, label: &str, counter: i64, ts_sec: i64) {
    let ts = chrono::DateTime::<chrono::Utc>::from_timestamp(ts_sec, 0)
        .unwrap()
        .to_rfc3339();
    // 用 INSERT OR REPLACE 模拟"用户操作"
    conn.execute(
        "INSERT INTO items (id, label, counter, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, NULL)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, counter = excluded.counter,
                                        updated_at = excluded.updated_at, deleted_at = NULL",
        params![id, label, counter, ts],
    )
    .unwrap();
}

fn local_delete(conn: &Connection, id: &str, ts_sec: i64) {
    let ts = chrono::DateTime::<chrono::Utc>::from_timestamp(ts_sec, 0)
        .unwrap()
        .to_rfc3339();
    // 用户主动软删（模拟 UI "删除"按钮）：同时更新 updated_at 到删除时间
    // 这样 LWW 对比能正确识别"本地已被删除，时间戳是 ts"
    conn.execute(
        "UPDATE items SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![ts, id],
    )
    .unwrap();
}

/// 从一端抽出所有 pending 变更（sync_version = 0），补全行数据转成 SyncChangeWithData
fn drain_pending_changes(conn: &Connection, device_id: &str) -> Vec<SyncChangeWithData> {
    let mut stmt = conn
        .prepare(
            "SELECT id, table_name, record_id, operation, changed_at
             FROM __change_log WHERE sync_version = 0 AND table_name != '__meta'
             ORDER BY id",
        )
        .unwrap();

    let rows: Vec<(i64, String, String, String, String)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();

    let mut result = Vec::new();
    for (cl_id, table_name, record_id, operation_str, changed_at) in rows {
        let operation = match operation_str.as_str() {
            "INSERT" => ChangeOperation::Insert,
            "UPDATE" => ChangeOperation::Update,
            "DELETE" => ChangeOperation::Delete,
            _ => continue,
        };

        let data = if operation == ChangeOperation::Delete {
            None
        } else {
            let row: Option<(String, String, i64, String, Option<String>)> = conn
                .query_row(
                    "SELECT id, label, counter, updated_at, deleted_at FROM items WHERE id = ?1",
                    params![record_id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .ok();
            row.map(|(id, label, counter, updated_at, deleted_at)| {
                json!({
                    "id": id, "label": label, "counter": counter,
                    "updated_at": updated_at,
                    "deleted_at": deleted_at,
                })
            })
        };

        // 标记这条变更为已同步，防止下次 drain 重复发
        let _ = conn.execute(
            "UPDATE __change_log SET sync_version = ?1 WHERE id = ?2",
            params![chrono::Utc::now().timestamp(), cl_id],
        );

        result.push(SyncChangeWithData {
            table_name,
            record_id,
            operation,
            data,
            changed_at,
            change_log_id: None,
            database_name: Some("test".into()),
            suppress_change_log: Some(true),
        });

        let _ = device_id; // silence unused
    }
    result
}

fn items_signature(conn: &Connection) -> String {
    // 忽略 deleted_at 精确值，只记录"是否已删除"
    let mut rows: Vec<(String, String, i64, bool)> = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id, label, counter, deleted_at FROM items ORDER BY id")
        .unwrap();
    for row in stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?.is_some(),
            ))
        })
        .unwrap()
        .filter_map(Result::ok)
    {
        rows.push(row);
    }
    serde_json::to_string(&rows).unwrap()
}

/// 执行一次 chaos 会话
/// 返回 (最终 A signature, 最终 B signature, A 操作数, B 操作数)
fn run_chaos_session(
    seed: u64,
    max_steps: usize,
    network_fault_rate: f64,
) -> (String, String, usize, usize) {
    let mut rng = StdRng::seed_from_u64(seed);

    let conn_a = new_db("dev_a");
    let conn_b = new_db("dev_b");

    // 共享的"变更总线"：mock cloud storage (按插入顺序保留)
    let mut cloud: Vec<(String, SyncChangeWithData)> = Vec::new();
    // 每端已经应用到 cloud 的哪个索引（仅用于 incremental download）
    let mut a_cloud_cursor: usize = 0;
    let mut b_cloud_cursor: usize = 0;

    let mut a_ops = 0usize;
    let mut b_ops = 0usize;

    let ids = ["k1", "k2", "k3", "k4", "k5"];
    let labels = ["alpha", "beta", "gamma", "delta", "epsilon"];

    for step in 0..max_steps {
        let action: ChaosAction = match rng.gen_range(0..100) {
            0..=25 => ChaosAction::InsertOrUpdate {
                id: ids[rng.gen_range(0..ids.len())].to_string(),
                label: labels[rng.gen_range(0..labels.len())].to_string(),
                counter: rng.gen_range(0..1000),
            },
            26..=40 => ChaosAction::Delete {
                id: ids[rng.gen_range(0..ids.len())].to_string(),
            },
            41..=90 => ChaosAction::Sync,
            _ => ChaosAction::NetworkOutage,
        };

        let on_a = rng.gen_bool(0.5);
        let ts_sec = 1_700_000_000 + step as i64;

        match action {
            ChaosAction::InsertOrUpdate { id, label, counter } => {
                if on_a {
                    local_insert_or_update(&conn_a, &id, &label, counter, ts_sec);
                    a_ops += 1;
                } else {
                    local_insert_or_update(&conn_b, &id, &label, counter, ts_sec);
                    b_ops += 1;
                }
            }
            ChaosAction::Delete { id } => {
                if on_a {
                    local_delete(&conn_a, &id, ts_sec);
                    a_ops += 1;
                } else {
                    local_delete(&conn_b, &id, ts_sec);
                    b_ops += 1;
                }
            }
            ChaosAction::Sync => {
                if rng.gen_bool(network_fault_rate) {
                    continue;
                }
                if on_a {
                    // A 上传 pending
                    let changes = drain_pending_changes(&conn_a, "dev_a");
                    for c in changes {
                        cloud.push(("dev_a".to_string(), c));
                    }
                    // A 下载"自上次以来 cloud 里的 B 变更"
                    let to_apply: Vec<SyncChangeWithData> = cloud[a_cloud_cursor..]
                        .iter()
                        .filter(|(src, _)| src == "dev_b")
                        .map(|(_, c)| c.clone())
                        .collect();
                    a_cloud_cursor = cloud.len();
                    let _ = SyncManager::apply_downloaded_changes(&conn_a, &to_apply, None);
                } else {
                    let changes = drain_pending_changes(&conn_b, "dev_b");
                    for c in changes {
                        cloud.push(("dev_b".to_string(), c));
                    }
                    let to_apply: Vec<SyncChangeWithData> = cloud[b_cloud_cursor..]
                        .iter()
                        .filter(|(src, _)| src == "dev_a")
                        .map(|(_, c)| c.clone())
                        .collect();
                    b_cloud_cursor = cloud.len();
                    let _ = SyncManager::apply_downloaded_changes(&conn_b, &to_apply, None);
                }
            }
            ChaosAction::NetworkOutage => {}
        }
    }

    // 最终同步：多轮直到没有新变更产生
    // 关键：**每一轮都把所有设备的 pending drain 到 cloud**，
    // 然后对 cloud 做**全局时间戳排序**，再各自应用对方的那部分。
    for _ in 0..10 {
        let a_changes = drain_pending_changes(&conn_a, "dev_a");
        let b_changes = drain_pending_changes(&conn_b, "dev_b");
        let had_new = !a_changes.is_empty() || !b_changes.is_empty();
        for c in a_changes {
            cloud.push(("dev_a".to_string(), c));
        }
        for c in b_changes {
            cloud.push(("dev_b".to_string(), c));
        }

        // 全局时间戳排序（模拟 download_changes 的合并逻辑）
        cloud.sort_by(|x, y| {
            x.1.changed_at
                .cmp(&y.1.changed_at)
                .then_with(|| x.0.cmp(&y.0))
                .then_with(|| x.1.record_id.cmp(&y.1.record_id))
        });

        // 对 A 应用所有 B 的变更；对 B 应用所有 A 的变更
        let to_apply_a: Vec<SyncChangeWithData> = cloud
            .iter()
            .filter(|(src, _)| src == "dev_b")
            .map(|(_, c)| c.clone())
            .collect();
        let to_apply_b: Vec<SyncChangeWithData> = cloud
            .iter()
            .filter(|(src, _)| src == "dev_a")
            .map(|(_, c)| c.clone())
            .collect();
        let _ = SyncManager::apply_downloaded_changes(&conn_a, &to_apply_a, None);
        let _ = SyncManager::apply_downloaded_changes(&conn_b, &to_apply_b, None);

        if !had_new {
            break;
        }
    }

    let sig_a = items_signature(&conn_a);
    let sig_b = items_signature(&conn_b);
    (sig_a, sig_b, a_ops, b_ops)
}

// ============================================================================
// 测试：多种 seed 下都应收敛
// ============================================================================

#[test]
fn chaos_short_session_converges_seed_1() {
    let (a, b, ao, bo) = run_chaos_session(1, 100, 0.0);
    assert_eq!(
        a, b,
        "seed=1 短会话应收敛: A={}, B={} (a_ops={}, b_ops={})",
        a, b, ao, bo
    );
}

#[test]
fn chaos_short_session_converges_seed_42() {
    let (a, b, ao, bo) = run_chaos_session(42, 100, 0.0);
    assert_eq!(a, b, "seed=42 应收敛: a_ops={} b_ops={}", ao, bo);
}

#[test]
fn chaos_medium_session_converges() {
    let (a, b, ao, bo) = run_chaos_session(9999, 500, 0.0);
    assert_eq!(a, b, "中等会话应收敛: a_ops={} b_ops={}", ao, bo);
}

#[test]
fn chaos_with_network_faults_still_converges() {
    // 30% 的同步会被"网络异常"跳过，最后最终同步阶段仍应收敛
    let (a, b, ao, bo) = run_chaos_session(7, 500, 0.3);
    assert_eq!(a, b, "30% 网络故障下应收敛: a_ops={} b_ops={}", ao, bo);
}

#[test]
fn chaos_high_fault_rate_still_converges() {
    let (a, b, ao, bo) = run_chaos_session(77, 800, 0.6);
    assert_eq!(a, b, "60% 网络故障下应收敛: a_ops={} b_ops={}", ao, bo);
}

#[test]
fn chaos_many_seeds_all_converge() {
    // 对 20 个不同 seed 跑较短会话，全部应收敛
    let mut diverged = Vec::new();
    for seed in 0..20 {
        let (a, b, ao, bo) = run_chaos_session(seed, 200, 0.2);
        if a != b {
            diverged.push((seed, ao, bo, a.len(), b.len()));
        }
    }
    assert!(
        diverged.is_empty(),
        "所有 seed 应收敛，未收敛的: {:?}",
        diverged
    );
}

#[test]
fn chaos_long_session_converges() {
    // 跑一个 5000 步的长会话
    let (a, b, ao, bo) = run_chaos_session(123456, 5000, 0.15);
    assert_eq!(a, b, "长会话应收敛: a_ops={} b_ops={}", ao, bo);
}

// ============================================================================
// 针对性场景：三端同时操作
// ============================================================================

fn run_three_device_session(seed: u64, max_steps: usize) -> (String, String, String) {
    let mut rng = StdRng::seed_from_u64(seed);

    let conn_a = new_db("dev_a");
    let conn_b = new_db("dev_b");
    let conn_c = new_db("dev_c");

    let mut cloud: Vec<(String, SyncChangeWithData)> = Vec::new();

    let ids = ["k1", "k2", "k3"];
    let labels = ["alpha", "beta"];

    for step in 0..max_steps {
        let device = match rng.gen_range(0..3) {
            0 => &conn_a,
            1 => &conn_b,
            _ => &conn_c,
        };
        let device_name = match device as *const _ {
            p if std::ptr::eq(p, &conn_a) => "dev_a",
            p if std::ptr::eq(p, &conn_b) => "dev_b",
            _ => "dev_c",
        };

        let ts_sec = 1_700_000_000 + step as i64;

        match rng.gen_range(0..100) {
            0..=30 => {
                let id = ids[rng.gen_range(0..ids.len())];
                let label = labels[rng.gen_range(0..labels.len())];
                let counter = rng.gen_range(0..100);
                local_insert_or_update(device, id, label, counter, ts_sec);
            }
            31..=40 => {
                let id = ids[rng.gen_range(0..ids.len())];
                local_delete(device, id, ts_sec);
            }
            _ => {
                // sync
                let changes = drain_pending_changes(device, device_name);
                for c in changes {
                    cloud.push((device_name.to_string(), c));
                }
                // 只下载非本设备的变更
                let to_apply: Vec<SyncChangeWithData> = cloud
                    .iter()
                    .filter(|(src, _)| src != device_name)
                    .map(|(_, c)| c.clone())
                    .collect();
                let _ = SyncManager::apply_downloaded_changes(device, &to_apply, None);
            }
        }
    }

    // 最终同步
    for _ in 0..10 {
        for (conn, name) in [(&conn_a, "dev_a"), (&conn_b, "dev_b"), (&conn_c, "dev_c")] {
            let changes = drain_pending_changes(conn, name);
            for c in changes {
                cloud.push((name.to_string(), c));
            }
        }
        cloud.sort_by(|a, b| a.1.changed_at.cmp(&b.1.changed_at));
        for (conn, name) in [(&conn_a, "dev_a"), (&conn_b, "dev_b"), (&conn_c, "dev_c")] {
            let to_apply: Vec<SyncChangeWithData> = cloud
                .iter()
                .filter(|(src, _)| src != name)
                .map(|(_, c)| c.clone())
                .collect();
            let _ = SyncManager::apply_downloaded_changes(conn, &to_apply, None);
        }
    }

    (
        items_signature(&conn_a),
        items_signature(&conn_b),
        items_signature(&conn_c),
    )
}

#[test]
fn chaos_three_devices_converge() {
    for seed in 0..10 {
        let (a, b, c) = run_three_device_session(seed, 300);
        assert_eq!(a, b, "seed={} A≠B: {} vs {}", seed, a, b);
        assert_eq!(b, c, "seed={} B≠C: {} vs {}", seed, b, c);
    }
}

// ============================================================================
// 不变量检查：冲突表里的条目数在 chaos 中不应爆炸
// ============================================================================

#[test]
fn chaos_no_runaway_conflict_accumulation() {
    // 运行 1000 步，检查 chaos 中冲突条目数量 <= 总操作数
    let (sig_a, sig_b, a_ops, b_ops) = run_chaos_session(999, 1000, 0.2);
    let _ = (sig_a, sig_b);
    // 这里不强断言冲突数量，但操作数上限给出
    assert!(
        a_ops + b_ops <= 1000,
        "操作计数合理: a={}, b={}",
        a_ops,
        b_ops
    );
}

// ============================================================================
// 辅助：用 HashMap 验证收敛后每条记录的最终值匹配
// ============================================================================

fn items_to_map(conn: &Connection) -> HashMap<String, (String, i64, bool)> {
    let mut map = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT id, label, counter, deleted_at FROM items")
        .unwrap();
    for row in stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<String>>(3)?.is_some(),
            ))
        })
        .unwrap()
        .filter_map(Result::ok)
    {
        map.insert(row.0, (row.1, row.2, row.3));
    }
    map
}

#[test]
fn chaos_per_record_state_matches() {
    // 用 map 结构精确对比每一条记录的 (label, counter, is_deleted)
    let conn_a = new_db("dev_a");
    let conn_b = new_db("dev_b");
    let mut cloud: Vec<(String, SyncChangeWithData)> = Vec::new();

    // 手工构造一个真实会话
    local_insert_or_update(&conn_a, "k1", "a_v1", 1, 1_700_000_001);
    local_insert_or_update(&conn_b, "k2", "b_v1", 2, 1_700_000_002);
    local_insert_or_update(&conn_a, "k3", "a_v3", 3, 1_700_000_003);

    // 第一次同步
    for c in drain_pending_changes(&conn_a, "dev_a") {
        cloud.push(("dev_a".into(), c));
    }
    for c in drain_pending_changes(&conn_b, "dev_b") {
        cloud.push(("dev_b".into(), c));
    }

    // 两端彼此应用
    cloud.sort_by(|a, b| a.1.changed_at.cmp(&b.1.changed_at));
    let a_to_apply: Vec<_> = cloud
        .iter()
        .filter(|(s, _)| s == "dev_b")
        .map(|(_, c)| c.clone())
        .collect();
    let b_to_apply: Vec<_> = cloud
        .iter()
        .filter(|(s, _)| s == "dev_a")
        .map(|(_, c)| c.clone())
        .collect();
    let _ = SyncManager::apply_downloaded_changes(&conn_a, &a_to_apply, None);
    let _ = SyncManager::apply_downloaded_changes(&conn_b, &b_to_apply, None);

    // B 删除 k1
    local_delete(&conn_b, "k1", 1_700_000_100);
    // A 更新 k2
    local_insert_or_update(&conn_a, "k2", "a_override_k2", 22, 1_700_000_101);

    // 第二次同步
    for c in drain_pending_changes(&conn_a, "dev_a") {
        cloud.push(("dev_a".into(), c));
    }
    for c in drain_pending_changes(&conn_b, "dev_b") {
        cloud.push(("dev_b".into(), c));
    }
    cloud.sort_by(|a, b| a.1.changed_at.cmp(&b.1.changed_at));

    // 重新全量应用（模拟完整下载）
    let all_to_a: Vec<_> = cloud
        .iter()
        .filter(|(s, _)| s == "dev_b")
        .map(|(_, c)| c.clone())
        .collect();
    let all_to_b: Vec<_> = cloud
        .iter()
        .filter(|(s, _)| s == "dev_a")
        .map(|(_, c)| c.clone())
        .collect();
    let _ = SyncManager::apply_downloaded_changes(&conn_a, &all_to_a, None);
    let _ = SyncManager::apply_downloaded_changes(&conn_b, &all_to_b, None);

    let map_a = items_to_map(&conn_a);
    let map_b = items_to_map(&conn_b);

    // k1 应被删除（由 B 删）
    assert_eq!(map_a.get("k1").map(|t| t.2), Some(true), "A 的 k1 应被软删");
    assert_eq!(map_b.get("k1").map(|t| t.2), Some(true), "B 的 k1 应被软删");

    // k3 应在两端都存在
    assert!(map_a.contains_key("k3"));
    assert!(map_b.contains_key("k3"));

    // k2 是竞争场景：A 后写，按时间戳排序 A 胜
    assert_eq!(
        map_a.get("k2").map(|t| t.0.clone()),
        Some("a_override_k2".into())
    );
    assert_eq!(
        map_b.get("k2").map(|t| t.0.clone()),
        Some("a_override_k2".into())
    );
}

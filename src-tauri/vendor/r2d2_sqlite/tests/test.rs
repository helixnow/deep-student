extern crate r2d2;
extern crate r2d2_sqlite;
extern crate rusqlite;
extern crate tempfile;

use std::sync::mpsc;
use std::thread;

use r2d2::ManageConnection;
use tempfile::TempDir;

use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;

#[test]
fn test_basic() {
    let manager = SqliteConnectionManager::file("file.db");
    let pool = r2d2::Pool::builder().max_size(2).build(manager).unwrap();

    let (s1, r1) = mpsc::channel();
    let (s2, r2) = mpsc::channel();

    let pool1 = pool.clone();
    let t1 = thread::spawn(move || {
        let conn = pool1.get().unwrap();
        s1.send(()).unwrap();
        r2.recv().unwrap();
        drop(conn);
    });

    let pool2 = pool.clone();
    let t2 = thread::spawn(move || {
        let conn = pool2.get().unwrap();
        s2.send(()).unwrap();
        r1.recv().unwrap();
        drop(conn);
    });

    t1.join().unwrap();
    t2.join().unwrap();

    pool.get().unwrap();
}

#[test]
fn test_file() {
    let manager = SqliteConnectionManager::file("file.db");
    let pool = r2d2::Pool::builder().max_size(2).build(manager).unwrap();

    let (s1, r1) = mpsc::channel();
    let (s2, r2) = mpsc::channel();

    let pool1 = pool.clone();
    let t1 = thread::spawn(move || {
        let conn = pool1.get().unwrap();
        let _: &Connection = &*conn;
        s1.send(()).unwrap();
        r2.recv().unwrap();
    });

    let pool2 = pool.clone();
    let t2 = thread::spawn(move || {
        let conn = pool2.get().unwrap();
        s2.send(()).unwrap();
        r1.recv().unwrap();
        drop(conn);
    });

    t1.join().unwrap();
    t2.join().unwrap();

    pool.get().unwrap();
}

#[test]
fn test_is_valid() {
    let manager = SqliteConnectionManager::file("file.db");
    let pool = r2d2::Pool::builder()
        .max_size(1)
        .test_on_check_out(true)
        .build(manager)
        .unwrap();

    pool.get().unwrap();
}

#[test]
fn test_error_handling() {
    //! We specify a directory as a database. This is bound to fail.
    let dir = TempDir::new().expect("Could not create temporary directory");
    let dirpath = dir.path().to_str().unwrap();
    let manager = SqliteConnectionManager::file(dirpath);
    assert!(manager.connect().is_err());
}

#[test]
fn test_with_flags() {
    // Open db as read only and try to modify it, it should fail
    let manager = SqliteConnectionManager::file("file.db")
        .with_flags(rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY);
    let pool = r2d2::Pool::builder().max_size(2).build(manager).unwrap();
    let conn = pool.get().unwrap();
    let result = conn.execute_batch("CREATE TABLE hello(world)");
    assert!(result.is_err());
}

#[test]
fn test_with_init() {
    fn trace_sql(sql: &str) {
        println!("{}", sql)
    }

    // Set user_version in init, then read it back to check that it was set
    let manager = SqliteConnectionManager::file("file.db").with_init(|c| {
        c.trace(Some(trace_sql));
        c.execute_batch("PRAGMA user_version=123")
    });
    let pool = r2d2::Pool::builder().max_size(2).build(manager).unwrap();
    let conn = pool.get().unwrap();
    let db_version = conn
        .query_row(
            "PRAGMA user_version",
            &[] as &[&dyn rusqlite::types::ToSql],
            |r| r.get::<_, i32>(0),
        )
        .unwrap();
    assert_eq!(db_version, 123);
}

#[test]
fn test_in_memory_db_is_shared() {
    let manager = SqliteConnectionManager::memory();
    let pool = r2d2::Pool::builder().max_size(10).build(manager).unwrap();

    pool.get()
        .unwrap()
        .execute("CREATE TABLE IF NOT EXISTS foo (bar INTEGER)", [])
        .unwrap();

    (0..10)
        .map(|i: i32| {
            let pool = pool.clone();
            std::thread::spawn(move || {
                let conn = pool.get().unwrap();
                conn.execute("INSERT INTO foo (bar) VALUES (?)", [i])
                    .unwrap();
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .try_for_each(std::thread::JoinHandle::join)
        .unwrap();

    let conn = pool.get().unwrap();
    let mut stmt = conn.prepare("SELECT bar from foo").unwrap();
    let mut rows: Vec<i32> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .into_iter()
        .flatten()
        .collect();
    rows.sort_unstable();
    assert_eq!(rows, (0..10).collect::<Vec<_>>());
}

#[test]
fn test_different_in_memory_dbs_are_not_shared() {
    let manager1 = SqliteConnectionManager::memory();
    let pool1 = r2d2::Pool::new(manager1).unwrap();
    let manager2 = SqliteConnectionManager::memory();
    let pool2 = r2d2::Pool::new(manager2).unwrap();

    pool1
        .get()
        .unwrap()
        .execute_batch("CREATE TABLE foo (bar INTEGER)")
        .unwrap();
    let result = pool2
        .get()
        .unwrap()
        .execute_batch("CREATE TABLE foo (bar INTEGER)");

    assert!(result.is_ok());
}

#[test]
fn test_in_memory_db_persists() {
    let manager = SqliteConnectionManager::memory();

    {
        // Normally, `r2d2::Pool` won't drop connection unless timed-out or broken.
        // So let's drop managed connection instead.
        let conn = manager.connect().unwrap();
        conn.execute_batch("CREATE TABLE foo (bar INTEGER)")
            .unwrap();
    }

    let conn = manager.connect().unwrap();
    let mut stmt = conn.prepare("SELECT * from foo").unwrap();
    let result = stmt.execute([]);
    assert!(result.is_ok());
}

#![deny(warnings)]
//! # Sqlite support for the `r2d2` connection pool.
//!
//! Library crate: [r2d2-sqlite](https://crates.io/crates/r2d2-sqlite/)
//!
//! Integrated with: [r2d2](https://crates.io/crates/r2d2)
//! and [rusqlite](https://crates.io/crates/rusqlite)
//!
//! ## Example
//!
//! ```rust,no_run
//! extern crate r2d2;
//! extern crate r2d2_sqlite;
//! extern crate rusqlite;
//!
//! use std::thread;
//! use r2d2_sqlite::SqliteConnectionManager;
//! use rusqlite::params;
//!
//! fn main() {
//!     let manager = SqliteConnectionManager::file("file.db");
//!     let pool = r2d2::Pool::new(manager).unwrap();
//!     pool.get()
//!         .unwrap()
//!         .execute("CREATE TABLE IF NOT EXISTS foo (bar INTEGER)", params![])
//!         .unwrap();
//!
//!     (0..10)
//!         .map(|i| {
//!             let pool = pool.clone();
//!             thread::spawn(move || {
//!                 let conn = pool.get().unwrap();
//!                 conn.execute("INSERT INTO foo (bar) VALUES (?)", &[&i])
//!                     .unwrap();
//!             })
//!         })
//!         .collect::<Vec<_>>()
//!         .into_iter()
//!         .map(thread::JoinHandle::join)
//!         .collect::<Result<_, _>>()
//!         .unwrap()
//! }
//! ```
pub use rusqlite;
use rusqlite::{Connection, Error, OpenFlags};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

#[derive(Debug)]
enum Source {
    File(PathBuf),
    Memory(String),
}

type InitFn = dyn Fn(&mut Connection) -> Result<(), rusqlite::Error> + Send + Sync + 'static;

/// An `r2d2::ManageConnection` for `rusqlite::Connection`s.
pub struct SqliteConnectionManager {
    source: Source,
    flags: OpenFlags,
    init: Option<Box<InitFn>>,
    _persist: Mutex<Option<Connection>>,
}

impl fmt::Debug for SqliteConnectionManager {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let mut builder = f.debug_struct("SqliteConnectionManager");
        let _ = builder.field("source", &self.source);
        let _ = builder.field("flags", &self.source);
        let _ = builder.field("init", &self.init.as_ref().map(|_| "InitFn"));
        builder.finish()
    }
}

impl SqliteConnectionManager {
    /// Creates a new `SqliteConnectionManager` from file.
    ///
    /// See `rusqlite::Connection::open`
    pub fn file<P: AsRef<Path>>(path: P) -> Self {
        Self {
            source: Source::File(path.as_ref().to_path_buf()),
            flags: OpenFlags::default(),
            init: None,
            _persist: Mutex::new(None),
        }
    }

    /// Creates a new `SqliteConnectionManager` from memory.
    pub fn memory() -> Self {
        Self {
            source: Source::Memory(Uuid::new_v4().to_string()),
            flags: OpenFlags::default(),
            init: None,
            _persist: Mutex::new(None),
        }
    }

    /// Converts `SqliteConnectionManager` into one that sets OpenFlags upon
    /// connection creation.
    ///
    /// See `rustqlite::OpenFlags` for a list of available flags.
    pub fn with_flags(self, flags: OpenFlags) -> Self {
        Self { flags, ..self }
    }

    /// Converts `SqliteConnectionManager` into one that calls an initialization
    /// function upon connection creation. Could be used to set PRAGMAs, for
    /// example.
    ///
    /// ### Example
    ///
    /// Make a `SqliteConnectionManager` that sets the `foreign_keys` pragma to
    /// true for every connection.
    ///
    /// ```rust,no_run
    /// # use r2d2_sqlite::{SqliteConnectionManager};
    /// let manager = SqliteConnectionManager::file("app.db")
    ///     .with_init(|c| c.execute_batch("PRAGMA foreign_keys=1;"));
    /// ```
    pub fn with_init<F>(self, init: F) -> Self
    where
        F: Fn(&mut Connection) -> Result<(), rusqlite::Error> + Send + Sync + 'static,
    {
        let init: Option<Box<InitFn>> = Some(Box::new(init));
        Self { init, ..self }
    }
}

impl r2d2::ManageConnection for SqliteConnectionManager {
    type Connection = Connection;
    type Error = rusqlite::Error;

    fn connect(&self) -> Result<Connection, Error> {
        match self.source {
            Source::File(ref path) => Connection::open_with_flags(path, self.flags),
            Source::Memory(ref id) => {
                let connection = || {
                    Connection::open_with_flags(
                        format!("file:{}?mode=memory&cache=shared", id),
                        self.flags,
                    )
                };

                {
                    let mut persist = self._persist.lock().unwrap();
                    if persist.is_none() {
                        *persist = Some(connection()?);
                    }
                }

                connection()
            }
        }
        .and_then(|mut c| match self.init {
            None => Ok(c),
            Some(ref init) => init(&mut c).map(|_| c),
        })
    }

    fn is_valid(&self, conn: &mut Connection) -> Result<(), Error> {
        conn.execute_batch(
            #[cfg(feature = "is-valid")]
            "SELECT 1;", // This query can cause performance issues and also may cause errors on non-standard SQLite implementations.
            #[cfg(not(feature = "is-valid"))]
            "",
        )
    }

    fn has_broken(&self, _: &mut Connection) -> bool {
        false
    }
}

//! Anki 领域薄封装：卡片 CRUD 单一入口，行为委托现有 `Database` 方法。

pub mod repository;

pub use repository::AnkiCardRepository;

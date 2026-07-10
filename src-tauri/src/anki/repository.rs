//! Anki 卡片仓库：对 `Database` Anki 卡片 API 的薄委托层。
//!
//! 目标是提供单一入口，便于后续迁移/加缓存/换存储，而不改变现有 SQL 行为。

use anyhow::Result;

use crate::database::Database;
use crate::models::AnkiCard;

/// Anki 卡片 CRUD 的统一入口（当前全部等价委托 `Database`）。
pub struct AnkiCardRepository;

impl AnkiCardRepository {
    /// 按文档 ID 列出卡片（委托 `Database::get_cards_for_document`）。
    pub fn list_by_document(db: &Database, document_id: &str) -> Result<Vec<AnkiCard>> {
        db.get_cards_for_document(document_id)
    }

    /// 按任务 ID 列出卡片（委托 `Database::get_cards_for_task`）。
    pub fn list_by_task(db: &Database, task_id: &str) -> Result<Vec<AnkiCard>> {
        db.get_cards_for_task(task_id)
    }

    /// 插入卡片（委托 `Database::insert_anki_card`，返回是否实际插入）。
    pub fn insert(db: &Database, card: &AnkiCard) -> Result<bool> {
        db.insert_anki_card(card)
    }

    /// 更新卡片（委托 `Database::update_anki_card`）。
    pub fn update(db: &Database, card: &AnkiCard) -> Result<()> {
        db.update_anki_card(card)
    }

    /// 删除卡片（委托 `Database::delete_anki_card`）。
    pub fn delete(db: &Database, card_id: &str) -> Result<()> {
        db.delete_anki_card(card_id)
    }
}

#[cfg(test)]
mod tests {
    //! 用法说明：生产路径传入 `&Database`（或 `Arc<Database>` 解引用）即可。
    //!
    //! ```ignore
    //! use crate::anki::AnkiCardRepository;
    //!
    //! let cards = AnkiCardRepository::list_by_document(&db, document_id)?;
    //! AnkiCardRepository::update(&db, &card)?;
    //! AnkiCardRepository::delete(&db, &card_id)?;
    //! let inserted = AnkiCardRepository::insert(&db, &card)?;
    //! ```

    use super::AnkiCardRepository;

    #[test]
    fn repository_is_stateless_entry_point() {
        // 无状态类型：仅作为命名空间入口，不持有连接。
        let _ = std::mem::size_of::<AnkiCardRepository>();
        assert_eq!(std::mem::size_of::<AnkiCardRepository>(), 0);
    }
}

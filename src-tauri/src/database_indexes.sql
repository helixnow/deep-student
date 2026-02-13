-- 🎯 SOTA级别的索引优化方案

-- 1. 标签层级查询优化
CREATE INDEX IF NOT EXISTS idx_tags_parent_level ON kg_tags(parent_id, level);
CREATE INDEX IF NOT EXISTS idx_tags_level_type ON kg_tags(level, tag_type);

-- 2. 标签搜索优化
CREATE INDEX IF NOT EXISTS idx_tags_name_trgm ON kg_tags(name); -- 支持模糊搜索
CREATE INDEX IF NOT EXISTS idx_tags_vector_status ON kg_tags(vector_generated) WHERE vector_generated = 0; -- 部分索引

-- 3. 卡片标签关联优化
CREATE INDEX IF NOT EXISTS idx_card_tags_composite ON kg_card_tags(tag_id, card_id, confidence);
CREATE INDEX IF NOT EXISTS idx_card_tags_confidence ON kg_card_tags(confidence) WHERE confidence > 0.5; -- 高置信度索引

-- 4. 向量搜索优化（虽然SQLite不支持向量索引，但可以优化扫描）
CREATE INDEX IF NOT EXISTS idx_cards_created_desc ON kg_problem_cards(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_embeddings_card ON kg_card_embeddings(card_id);

-- 5. 全文搜索优化
-- FTS5已经自带索引，但可以优化触发器
DROP TRIGGER IF EXISTS kg_cards_fts_update;
CREATE TRIGGER kg_cards_fts_update 
AFTER UPDATE OF content_problem, content_insight ON kg_problem_cards
BEGIN
    UPDATE kg_cards_fts SET 
        content_problem = new.content_problem,
        content_insight = new.content_insight
    WHERE id = new.id;
END;

-- 6. 分析表统计信息
ANALYZE kg_tags;
ANALYZE kg_card_tags;
ANALYZE kg_problem_cards;

-- 7. 查询计划提示（用于验证索引使用）
-- EXPLAIN QUERY PLAN 
-- WITH RECURSIVE subtree AS (
--     SELECT * FROM kg_tags WHERE id = ?1
--     UNION ALL
--     SELECT t.* FROM kg_tags t JOIN subtree ON t.parent_id = subtree.id
-- )
-- SELECT * FROM subtree;
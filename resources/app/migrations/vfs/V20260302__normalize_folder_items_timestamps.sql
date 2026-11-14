-- ============================================================================
-- V20260302: 规范化 folder_items 时间戳列类型
-- ============================================================================
--
-- 背景：
-- 部分历史代码路径将 ISO 时间字符串写入 folder_items.created_at / updated_at，
-- 但这两个列语义上应为毫秒时间戳（INTEGER）。
-- 在严格类型读取（rusqlite row.get::<i64>）时会触发
-- "Invalid column type Text ... created_at" 异常。
--
-- 目标：
-- 1) 将 created_at 的 TEXT/REAL 值统一转换为 INTEGER(毫秒)
-- 2) 将 updated_at 的 TEXT/REAL 值统一转换为 INTEGER(毫秒)
--
-- 说明：
-- - created_at 为 NOT NULL，转换失败时回退到当前时间
-- - updated_at 允许 NULL，转换失败时回退到 created_at
-- ============================================================================

UPDATE folder_items
SET created_at = COALESCE(
    CASE
        WHEN typeof(created_at) = 'integer' THEN created_at
        WHEN typeof(created_at) = 'real' THEN CAST(created_at AS INTEGER)
        WHEN typeof(created_at) = 'text' THEN COALESCE(
            CASE
                -- 纯数字：长度<=10 视为秒，其他视为毫秒
                WHEN TRIM(created_at) GLOB '[0-9]*'
                     AND TRIM(created_at) NOT GLOB '*[^0-9]*'
                THEN CASE
                    WHEN LENGTH(TRIM(created_at)) <= 10
                    THEN CAST(TRIM(created_at) AS INTEGER) * 1000
                    ELSE CAST(TRIM(created_at) AS INTEGER)
                END
                ELSE NULL
            END,
            -- ISO / SQLite datetime 字符串
            CAST(strftime('%s', created_at) AS INTEGER) * 1000
        )
        ELSE NULL
    END,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
WHERE typeof(created_at) <> 'integer';

UPDATE folder_items
SET updated_at = CASE
    WHEN updated_at IS NULL THEN NULL
    ELSE COALESCE(
        CASE
            WHEN typeof(updated_at) = 'integer' THEN updated_at
            WHEN typeof(updated_at) = 'real' THEN CAST(updated_at AS INTEGER)
            WHEN typeof(updated_at) = 'text' THEN COALESCE(
                CASE
                    WHEN TRIM(updated_at) GLOB '[0-9]*'
                         AND TRIM(updated_at) NOT GLOB '*[^0-9]*'
                    THEN CASE
                        WHEN LENGTH(TRIM(updated_at)) <= 10
                        THEN CAST(TRIM(updated_at) AS INTEGER) * 1000
                        ELSE CAST(TRIM(updated_at) AS INTEGER)
                    END
                    ELSE NULL
                END,
                CAST(strftime('%s', updated_at) AS INTEGER) * 1000
            )
            ELSE NULL
        END,
        created_at
    )
END
WHERE updated_at IS NOT NULL
  AND typeof(updated_at) <> 'integer';

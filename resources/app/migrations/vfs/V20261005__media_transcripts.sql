-- 音视频学习：带秒数的字幕段 + 断点续播进度
-- 设计契约：docs/dev/media-learning/README.md §1.1
--
-- resource_id 是 VFS File 资源 ID（files.id，file_* / att_*）。
-- 段按 start_ms 升序编号（idx 0 起）；status 0 待转写 / 1 完成 / 2 失败；
-- source 'asr'（流水线转写）| 'import'（字幕文件导入）。
-- 续做：status=1 的段跳过；新 VAD 计划段数偏差 > 20% 时整表重建并 plan_version+1。

CREATE TABLE IF NOT EXISTS media_transcript_segments (
    resource_id   TEXT    NOT NULL,
    idx           INTEGER NOT NULL,
    start_ms      INTEGER NOT NULL,
    end_ms        INTEGER NOT NULL,
    text          TEXT    NOT NULL DEFAULT '',
    status        INTEGER NOT NULL DEFAULT 0,
    source        TEXT    NOT NULL DEFAULT 'asr',
    plan_version  INTEGER NOT NULL DEFAULT 1,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (resource_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_media_segments_status
    ON media_transcript_segments(resource_id, status);

CREATE TABLE IF NOT EXISTS media_progress (
    resource_id      TEXT PRIMARY KEY,
    last_position_ms INTEGER NOT NULL DEFAULT 0,
    duration_ms      INTEGER,
    watched_ms       INTEGER NOT NULL DEFAULT 0,
    finished         INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL
);

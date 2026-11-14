-- 学习时长：每日累计秒数（设计契约 docs/dev/media-learning/README.md §1.1 / §3）
--
-- 前端追踪器只在「页面可见且人在场（近期有输入或媒体播放中）」时计时，
-- 按本地零点切分后以 (date, seconds) 上报，后端按日累加（单日封顶 86400）。
-- 设备本地计数：累加型计数器无法按行 LWW 合并，不参与行同步（LocalRuntime）。
CREATE TABLE IF NOT EXISTS study_time_daily (
    date       TEXT    PRIMARY KEY,                 -- 本地日期 YYYY-MM-DD
    seconds    INTEGER NOT NULL DEFAULT 0 CHECK (seconds >= 0),
    updated_at INTEGER NOT NULL                     -- 毫秒时间戳
);

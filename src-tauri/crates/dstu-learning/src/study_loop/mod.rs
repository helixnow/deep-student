//! 学习闭环胶水层（docs/dev/media-learning/README.md §3）
//!
//! - [`media_source`]：音视频转写作为制卡 / 出题材料时的切片与出处锚点；
//! - [`study_time`]：学习时长按日累加与查询（`study_time_add` / `study_time_range`）。

pub mod media_source;
pub mod study_time;
